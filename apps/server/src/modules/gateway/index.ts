import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  AGENT_AUTH_MAX_SKEW_MS,
  AGENT_AUTH_SCHEME,
  AgentMessage,
  DEFAULT_AGENT_CONFIG,
  RELIABLE_TYPES,
  agentAuthMessage,
  type ServerMessage,
} from '@pulse/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Sql } from '../../db/index.js';
import { verifyEd25519 } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/http-error.js';
import type { LiveBus } from '../../lib/live.js';
import { audit } from '../auth/index.js';
import type { AlertEngine } from '../alerting/engine.js';
import { hostCtx, isUuid, toSummary, type HostRow } from '../hosts/repo.js';
import { ingestMetrics, ingestProcs, toLiveSeries } from '../ingest/index.js';
import { ingestLogs } from '../logs/ingest.js';
import type { CommandService, CommandTransport } from '../commands/service.js';
import type { ServiceRegistry } from '../repos/services.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
  }
}

/** 校验 `Authorization: Pulse <agentId>.<ts>.<sig>`，返回 agentId。 */
export async function authenticateAgent(sql: Sql, header: string | undefined, now = Date.now()): Promise<string> {
  const [scheme, value] = header?.split(' ') ?? [];
  if (scheme !== AGENT_AUTH_SCHEME || !value) throw unauthorized('缺少 Agent 凭证');
  const [agentId, tsText, sigText] = value.split('.');
  const ts = Number(tsText);
  if (!agentId || !isUuid(agentId) || !Number.isFinite(ts) || !sigText) throw unauthorized('Agent 凭证格式错误');
  if (Math.abs(now - ts) > AGENT_AUTH_MAX_SKEW_MS) throw unauthorized('Agent 时钟偏差超过 5 分钟');
  const [cred] = await sql<{ public_key: Buffer }[]>`
    SELECT public_key FROM agent_credentials WHERE host_id = ${agentId} AND revoked_at IS NULL`;
  if (!cred || !verifyEd25519(cred.public_key, agentAuthMessage(agentId, ts), Buffer.from(sigText, 'base64url'))) {
    throw unauthorized('Agent 凭证无效或已吊销');
  }
  return agentId;
}

export function encodeServerMessage(msg: ServerMessage): Buffer {
  return zstdCompressSync(Buffer.from(JSON.stringify(msg)));
}

export function decodeAgentFrame(data: Buffer): unknown {
  return JSON.parse(zstdDecompressSync(data, { maxOutputLength: MAX_FRAME_BYTES }).toString('utf8'));
}

export interface GatewayOptions {
  offlineAfterSeconds: number;
}

export class Gateway {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly chains = new Set<Promise<void>>();
  private sweeper?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly sql: Sql,
    private readonly live: LiveBus,
    private readonly log: FastifyBaseLogger,
    private readonly engine: AlertEngine,
    private readonly commands: CommandService,
    private readonly services: ServiceRegistry,
    private readonly opts: GatewayOptions,
  ) {
    commands.attach({ send: (hostId, msg) => this.sendTo(hostId, msg) } satisfies CommandTransport);
  }

  /** 告警处理是异步排队的，失败只记日志，不影响 Agent 消息的确认。 */
  private signal(p: Promise<void>) {
    p.catch((err) => this.log.error({ err }, '告警处理失败'));
  }

  register(app: FastifyInstance) {
    app.get(
      '/agent/ws',
      {
        websocket: true,
        preValidation: async (req: FastifyRequest) => {
          req.agentId = await authenticateAgent(this.sql, req.headers.authorization);
        },
      },
      (socket, req) => this.onConnection(socket, req.agentId!, req.ip),
    );
  }

  start() {
    this.sweeper = setInterval(() => void this.sweepOffline().catch((err) => this.log.error({ err }, '离线检测失败')), 5000);
  }

  /** 关闭所有连接并等待正在处理的消息完成。停机不算主机离线，重启后各主机有一个心跳周期的宽限期重连。 */
  async stop() {
    this.stopping = true;
    clearInterval(this.sweeper);
    for (const ws of this.sockets.values()) ws.close(1001, 'server shutting down');
    await Promise.all(this.chains);
  }

  isConnected(hostId: string) {
    return this.sockets.has(hostId);
  }

  private onConnection(ws: WebSocket, hostId: string, ip: string) {
    const log = this.log.child({ hostId });
    // 同一 Agent 的旧连接（如网络切换后未及时断开）直接关闭，只保留最新的
    this.sockets.get(hostId)?.close(4000, 'replaced by new connection');
    this.sockets.set(hostId, ws);
    log.info({ ip }, 'Agent 已连接');

    // 消息按到达顺序串行处理，保证 seq 判重和 ack 的顺序正确
    let chain = Promise.resolve();
    this.chains.add(chain);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.stopping) return;
      this.chains.delete(chain);
      chain = chain
        .then(() => this.onMessage(ws, hostId, isBinary ? data : Buffer.from(data)))
        .catch((err) => {
          log.warn({ err }, '处理 Agent 消息失败');
          ws.close(4400, 'bad message');
        });
      this.chains.add(chain);
    });

    ws.on('close', () => {
      if (this.stopping) return;
      this.chains.delete(chain);
      if (this.sockets.get(hostId) !== ws) return;
      this.sockets.delete(hostId);
      log.info('Agent 已断开');
      void chain.then(() => this.markOffline([hostId])).catch((err) => log.error({ err }, '标记离线失败'));
    });
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(encodeServerMessage(msg));
  }

  /** 发给在线的 Agent，不在线返回 false。 */
  sendTo(hostId: string, msg: ServerMessage): boolean {
    const ws = this.sockets.get(hostId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(encodeServerMessage(msg));
    return true;
  }

  private async onMessage(ws: WebSocket, hostId: string, data: Buffer) {
    const parsed = AgentMessage.safeParse(decodeAgentFrame(data));
    if (!parsed.success) throw new Error(`消息格式错误：${parsed.error.issues[0]?.message}`);
    const msg = parsed.data;

    const [host] = await this.sql<(HostRow & { prev_status: string })[]>`
      WITH prev AS (SELECT status FROM hosts WHERE id = ${hostId})
      UPDATE hosts SET last_seen_at = now(), status = 'online' WHERE id = ${hostId}
      RETURNING hosts.*, (SELECT status FROM prev) AS prev_status`;
    if (!host) {
      ws.close(4401, 'host removed');
      return;
    }
    if (host.prev_status !== 'online') {
      this.live.publish({ channel: 'overview', type: 'host.status', host: toSummary(host), at: Date.now() });
      this.signal(this.engine.onHostStatus(hostCtx(host), 'online'));
    }

    if (msg.type === 'hello') {
      await this.sql`
        UPDATE hosts SET info = ${this.sql.json(msg.payload.host as never)}, hostname = ${msg.payload.host.hostname},
          agent_version = ${msg.payload.agentVersion},
          labels = labels || ${this.sql.json(msg.payload.host.labels)},
          commands = ${this.sql.json(msg.payload.commands as never)}
        WHERE id = ${hostId}`;
      this.send(ws, { type: 'config', seq: 0, ts: Date.now(), payload: DEFAULT_AGENT_CONFIG });
      this.send(ws, { type: 'ack', seq: 0, ts: Date.now(), payload: { maxSeq: Number(host.last_seq) } });
      await this.services.recordVersions(hostId, msg.payload.versions);
      await this.commands.onHostConnected(hostId);
      return;
    }
    if (msg.type === 'heartbeat') {
      if (msg.payload.versions.length) await this.services.recordVersions(hostId, msg.payload.versions);
      return;
    }
    if (msg.type === 'cmd.status') return this.commands.onStatus(hostId, msg.payload.id);
    if (msg.type === 'cmd.output') return this.commands.onOutput(hostId, msg.payload.id, msg.payload.data);
    if (!RELIABLE_TYPES.has(msg.type)) return;

    // 断线补传时可能收到已处理过的消息：只回 ack，不重复写入
    const lastSeq = Number(host.last_seq);
    if (msg.seq <= lastSeq) {
      this.send(ws, { type: 'ack', seq: 0, ts: Date.now(), payload: { maxSeq: lastSeq } });
      return;
    }

    if (msg.type === 'metrics') {
      const snapshot = await ingestMetrics(this.sql, hostId, msg.payload);
      this.live.publish({ channel: 'overview', type: 'host.snapshot', hostId, snapshot });
      this.live.publish({
        channel: `host:${hostId}`,
        type: 'metrics',
        hostId,
        windowStart: msg.payload.windowStart,
        series: toLiveSeries(msg.payload),
      });
      this.signal(this.engine.onMetrics(hostCtx(host), msg.payload));
    } else if (msg.type === 'logs') {
      if (msg.payload.dropped > 0) this.log.warn({ hostId, dropped: msg.payload.dropped }, 'Agent 日志窗口内指纹过多，部分记录只计数');
      this.signal(this.engine.onLogSignals(await ingestLogs(this.sql, hostCtx(host), msg.payload)));
    } else if (msg.type === 'procs') {
      const procs = await ingestProcs(this.sql, hostId, msg.payload, msg.ts);
      this.live.publish({ channel: `host:${hostId}`, type: 'procs', hostId, procs });
    } else if (msg.type === 'cmd.done') {
      await this.commands.onDone(hostId, msg.payload);
    }

    await this.sql`UPDATE hosts SET last_seq = ${msg.seq} WHERE id = ${hostId} AND last_seq < ${msg.seq}`;
    this.send(ws, { type: 'ack', seq: 0, ts: Date.now(), payload: { maxSeq: msg.seq } });
  }

  private async sweepOffline() {
    const rows = await this.sql<HostRow[]>`
      UPDATE hosts SET status = 'offline'
      WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => ${this.opts.offlineAfterSeconds}))
      RETURNING *`;
    for (const row of rows) {
      this.sockets.get(row.id)?.close(4408, 'heartbeat timeout');
      this.publishStatus(row);
    }
  }

  async markOffline(hostIds: string[]) {
    const ids = hostIds.filter((id) => !this.sockets.has(id));
    if (!ids.length) return;
    const rows = await this.sql<HostRow[]>`
      UPDATE hosts SET status = 'offline' WHERE id = ANY(${ids}::uuid[]) AND status = 'online' RETURNING *`;
    rows.forEach((row) => this.publishStatus(row));
  }

  async revoke(hostId: string, actor: string) {
    this.sockets.get(hostId)?.close(4401, 'revoked');
    await audit(this.sql, actor, 'agent.revoked', hostId);
  }

  private publishStatus(row: HostRow) {
    this.live.publish({ channel: 'overview', type: 'host.status', host: toSummary(row), at: Date.now() });
    if (row.status === 'offline') this.signal(this.engine.onHostStatus(hostCtx(row), 'offline'));
  }
}
