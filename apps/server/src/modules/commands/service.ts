// 指令（设计文档 3.5、10.2）：模板校验、策略与审批、签名下发、结果收集。
// 只读指令直接执行；写操作需要 admin 审批；AI 分析只能执行只读指令，单次分析最多 10 条。
import {
  BUILTIN_TEMPLATES,
  COMMAND_OUTPUT_LIMIT,
  COMMAND_TTL_MS,
  CommandTemplate,
  FINAL_COMMAND_STATUSES,
  findBuiltin,
  validateArgs,
  type CmdDonePayload,
  type CommandInfo,
  type CommandStatus,
  type Me,
  type ServerMessage,
  type SignedCommand,
} from '@pulse/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Fragment, Sql } from '../../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-error.js';
import type { LiveBus } from '../../lib/live.js';
import type { Signer } from '../../lib/signing.js';
import { audit } from '../auth/index.js';
import { isUuid } from '../hosts/repo.js';

export const MAX_COMMANDS_PER_ANALYSIS = 10;
/** 已下发但 Agent 迟迟不回报结果时，超过模板超时多久判定失败 */
const LOST_GRACE_MS = 2 * 60_000;

export type Requester = { kind: 'user'; user: Me } | { kind: 'analysis'; analysisId: string; incidentId?: string | null };

export interface CommandTransport {
  send(hostId: string, msg: ServerMessage): boolean;
}

interface CommandRow {
  id: string;
  no: string;
  host_id: string;
  hostname: string | null;
  template: string;
  args: Record<string, string>;
  risk: 'read' | 'write';
  reason: string;
  requested_by: string;
  requested_name: string | null;
  approval_status: CommandInfo['approvalStatus'];
  approved_by: string | null;
  approved_name: string | null;
  self_approved: boolean;
  reject_reason: string | null;
  status: CommandStatus;
  timeout_seconds: number;
  exit_code: number | null;
  output?: string;
  truncated: boolean;
  error: string;
  duration_ms: number | null;
  incident_id: string | null;
  analysis_id: string | null;
  created_at: Date;
  expires_at: Date;
  sent_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

function actorName(id: string, username: string | null): string {
  if (id.startsWith('analysis:')) return 'AI 分析';
  return username ?? id;
}

function toInfo(r: CommandRow, live?: string): CommandInfo {
  return {
    id: r.id,
    no: Number(r.no),
    hostId: r.host_id,
    hostname: r.hostname,
    template: r.template,
    args: r.args,
    risk: r.risk,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedByName: actorName(r.requested_by, r.requested_name),
    approvalStatus: r.approval_status,
    approvedBy: r.approved_by,
    approvedByName: r.approved_by ? actorName(r.approved_by, r.approved_name) : null,
    selfApproved: r.self_approved,
    rejectReason: r.reject_reason,
    status: r.status,
    exitCode: r.exit_code,
    output: r.output === undefined ? undefined : r.output || live || '',
    truncated: r.truncated,
    error: r.error,
    durationMs: r.duration_ms,
    incidentId: r.incident_id,
    analysisId: r.analysis_id,
    createdAt: r.created_at.getTime(),
    expiresAt: r.expires_at.getTime(),
    startedAt: r.started_at?.getTime() ?? null,
    finishedAt: r.finished_at?.getTime() ?? null,
  };
}

const userIdOf = (actor: string) => (actor.startsWith('user:') ? actor.slice(5) : null);

export class CommandService {
  private transport?: CommandTransport;
  /** 执行中指令的实时输出，Agent 回报完成后清掉 */
  private readonly liveOutput = new Map<string, string>();
  /** 已下发指令所属的主机，只接受这台主机回传的输出分片 */
  private readonly dispatched = new Map<string, string>();
  private readonly waiters = new Map<string, Set<(c: CommandInfo) => void>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly sql: Sql,
    private readonly live: LiveBus,
    private readonly log: FastifyBaseLogger,
    private readonly signer: Signer,
  ) {}

  attach(transport: CommandTransport) {
    this.transport = transport;
  }

  start() {
    this.timer = setInterval(() => void this.sweep().catch((err) => this.log.error({ err }, '指令超时检查失败')), 10_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  // ---------- 查询 ----------

  private select(withOutput: boolean, where: Fragment, limit = 1) {
    return this.sql<CommandRow[]>`
      SELECT c.id, c.no, c.host_id, h.hostname, c.template, c.args, c.risk, c.reason, c.requested_by,
             ru.username AS requested_name, c.approval_status, c.approved_by, au.username AS approved_name,
             c.self_approved, c.reject_reason, c.status, c.timeout_seconds, c.exit_code,
             ${withOutput ? this.sql`c.output,` : this.sql``} c.truncated, c.error, c.duration_ms,
             c.incident_id, c.analysis_id, c.created_at, c.expires_at, c.sent_at, c.started_at, c.finished_at
      FROM commands c
      LEFT JOIN hosts h ON h.id = c.host_id
      LEFT JOIN users ru ON c.requested_by LIKE 'user:%' AND ru.id::text = substr(c.requested_by, 6)
      LEFT JOIN users au ON c.approved_by LIKE 'user:%' AND au.id::text = substr(c.approved_by, 6)
      WHERE ${where}
      ORDER BY c.no DESC LIMIT ${limit}`;
  }

  async get(id: string, withOutput = true): Promise<CommandInfo | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.select(withOutput, this.sql`c.id = ${id}`);
    return row && toInfo(row, this.liveOutput.get(id));
  }

  async list(where: Fragment, limit: number): Promise<CommandInfo[]> {
    return (await this.select(false, where, limit)).map((r) => toInfo(r));
  }

  async pendingApprovals(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE status = 'pending_approval'`;
    return row!.n;
  }

  /** 内置模板 + 这台主机 Agent 上报的 custom.* 模板。 */
  async templatesFor(hostId: string): Promise<{ builtin: CommandTemplate[]; custom: CommandTemplate[] }> {
    const [host] = isUuid(hostId) ? await this.sql<{ commands: unknown[] }[]>`SELECT commands FROM hosts WHERE id = ${hostId}` : [];
    if (!host) throw notFound('主机不存在');
    const custom = host.commands.flatMap((c) => {
      const t = CommandTemplate.safeParse(c);
      return t.success && t.data.name.startsWith('custom.') ? [t.data] : [];
    });
    return { builtin: BUILTIN_TEMPLATES, custom };
  }

  private async resolveTemplate(hostId: string, name: string): Promise<CommandTemplate> {
    if (!name.startsWith('custom.')) {
      const t = findBuiltin(name);
      if (!t) throw badRequest(`没有指令模板 ${name}`);
      return t;
    }
    const { custom } = await this.templatesFor(hostId);
    const t = custom.find((c) => c.name === name);
    if (!t) throw badRequest(`这台主机的 Agent 没有配置模板 ${name}`);
    return t;
  }

  // ---------- 发起与审批 ----------

  async create(
    who: Requester,
    input: { hostId: string; template: string; args: Record<string, string | number>; reason?: string; incidentId?: string | null },
  ): Promise<CommandInfo> {
    const [host] = isUuid(input.hostId) ? await this.sql<{ id: string }[]>`SELECT id FROM hosts WHERE id = ${input.hostId}` : [];
    if (!host) throw notFound('主机不存在');
    const tpl = await this.resolveTemplate(host.id, input.template);
    const checked = validateArgs(tpl, input.args);
    if ('error' in checked) throw badRequest(checked.error);

    const actor = who.kind === 'user' ? `user:${who.user.id}` : `analysis:${who.analysisId}`;
    if (who.kind === 'user' && who.user.role === 'viewer') throw forbidden('只读账号不能下发指令');
    if (who.kind === 'analysis') {
      if (tpl.risk !== 'read') throw forbidden('AI 分析不能执行写操作，请用 propose_action 生成待审批建议');
      const [used] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE analysis_id = ${who.analysisId}`;
      if (used!.n >= MAX_COMMANDS_PER_ANALYSIS) throw forbidden(`单次分析最多执行 ${MAX_COMMANDS_PER_ANALYSIS} 条指令`);
    }

    const needsApproval = tpl.risk === 'write';
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO commands (host_id, template, args, risk, reason, requested_by, approval_status, status, timeout_seconds,
                            incident_id, analysis_id, expires_at)
      VALUES (${host.id}, ${tpl.name}, ${this.sql.json(checked.args)}, ${tpl.risk}, ${input.reason ?? ''}, ${actor},
              ${needsApproval ? 'pending' : 'none'}, ${needsApproval ? 'pending_approval' : 'queued'}, ${tpl.timeoutSeconds},
              ${input.incidentId ?? (who.kind === 'analysis' ? (who.incidentId ?? null) : null)},
              ${who.kind === 'analysis' ? who.analysisId : null},
              ${new Date(Date.now() + (needsApproval ? 24 * 3600_000 : COMMAND_TTL_MS))})
      RETURNING id`;
    await audit(this.sql, actor, 'command.created', row!.id, { hostId: host.id, template: tpl.name, args: checked.args, risk: tpl.risk });
    if (!needsApproval) await this.dispatch(row!.id);
    return this.publish(row!.id);
  }

  async approve(id: string, user: Me): Promise<CommandInfo> {
    const cmd = await this.get(id, false);
    if (!cmd) throw notFound('指令不存在');
    if (cmd.status !== 'pending_approval') throw conflict('该指令不在待审批状态');
    if (user.role !== 'admin') throw forbidden('只有管理员可以审批写操作');

    let selfApproved = false;
    if (userIdOf(cmd.requestedBy) === user.id) {
      // 只有一位 admin 时允许自审，并在审计中标记（设计文档 10.2）
      const [admins] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`;
      if (admins!.n > 1) throw forbidden('需要另一位管理员审批');
      selfApproved = true;
    }
    const [updated] = await this.sql`
      UPDATE commands SET approval_status = 'approved', approved_by = ${`user:${user.id}`}, approved_at = now(),
        self_approved = ${selfApproved}, status = 'queued', expires_at = now() + make_interval(secs => ${COMMAND_TTL_MS / 1000})
      WHERE id = ${id} AND status = 'pending_approval' RETURNING id`;
    if (!updated) throw conflict('该指令不在待审批状态');
    await audit(this.sql, `user:${user.id}`, 'command.approved', id, { selfApproved, template: cmd.template, hostId: cmd.hostId });
    await this.dispatch(id);
    return this.publish(id);
  }

  async reject(id: string, user: Me, reason: string): Promise<CommandInfo> {
    if (user.role !== 'admin') throw forbidden('只有管理员可以审批写操作');
    const [updated] = await this.sql`
      UPDATE commands SET approval_status = 'rejected', approved_by = ${`user:${user.id}`}, approved_at = now(),
        reject_reason = ${reason}, status = 'rejected', finished_at = now()
      WHERE id = ${id} AND status = 'pending_approval' RETURNING id`;
    if (!updated) throw conflict('该指令不在待审批状态');
    await audit(this.sql, `user:${user.id}`, 'command.rejected', id, { reason });
    return this.publish(id);
  }

  async cancel(id: string, user: Me): Promise<CommandInfo> {
    const cmd = await this.get(id, false);
    if (!cmd) throw notFound('指令不存在');
    if (user.role !== 'admin' && userIdOf(cmd.requestedBy) !== user.id) throw forbidden('只能取消自己发起的指令');
    if (cmd.status === 'sent' || cmd.status === 'running') {
      // 已下发的交给 Agent 中断，结果以 Agent 回报的为准
      this.transport?.send(cmd.hostId, { type: 'cmd.cancel', seq: 0, ts: Date.now(), payload: { id } });
    } else {
      const [updated] = await this.sql`
        UPDATE commands SET status = 'canceled', finished_at = now()
        WHERE id = ${id} AND status IN ('pending_approval', 'queued') RETURNING id`;
      if (!updated) throw conflict('指令已结束');
    }
    await audit(this.sql, `user:${user.id}`, 'command.canceled', id);
    return this.publish(id);
  }

  // ---------- 下发 ----------

  /** 签名并发给在线的 Agent；不在线时保持 queued，等 Agent 连上后补发，过期未发的标记 expired。 */
  private async dispatch(id: string): Promise<void> {
    const [c] = await this.sql<CommandRow[]>`SELECT * FROM commands WHERE id = ${id} AND status = 'queued'`;
    if (!c || !this.transport) return;
    if (c.expires_at.getTime() <= Date.now()) return;
    const body: SignedCommand = {
      v: 1,
      kind: 'pulse-command',
      id: c.id,
      hostId: c.host_id,
      template: c.template,
      args: c.args,
      expiresAt: c.expires_at.getTime(),
      timeoutSeconds: c.timeout_seconds,
    };
    const text = JSON.stringify(body);
    const sent = this.transport.send(c.host_id, { type: 'cmd.run', seq: 0, ts: Date.now(), payload: { body: text, signature: this.signer.sign(text) } });
    if (!sent) return;
    this.dispatched.set(c.id, c.host_id);
    await this.sql`UPDATE commands SET status = 'sent', sent_at = now() WHERE id = ${id} AND status = 'queued'`;
  }

  /** Agent 连上（或重连）后补发排队中的指令，并重发已下发但还没开始执行的（Agent 按 ID 去重）。 */
  async onHostConnected(hostId: string): Promise<void> {
    const rows = await this.sql<{ id: string; status: CommandStatus }[]>`
      SELECT id, status FROM commands WHERE host_id = ${hostId} AND status IN ('queued', 'sent') AND expires_at > now() ORDER BY no`;
    for (const r of rows) {
      if (r.status === 'sent') await this.sql`UPDATE commands SET status = 'queued' WHERE id = ${r.id} AND status = 'sent'`;
      await this.dispatch(r.id);
      await this.publish(r.id);
    }
  }

  async onStatus(hostId: string, id: string): Promise<void> {
    const [row] = await this.sql`
      UPDATE commands SET status = 'running', started_at = now()
      WHERE id = ${id} AND host_id = ${hostId} AND status IN ('queued', 'sent') RETURNING id`;
    if (row) await this.publish(id);
  }

  onOutput(hostId: string, id: string, data: string): void {
    if (this.dispatched.get(id) !== hostId) return;
    const cur = this.liveOutput.get(id) ?? '';
    if (cur.length >= COMMAND_OUTPUT_LIMIT) return;
    this.liveOutput.set(id, cur + data);
    this.live.publish({ channel: `command:${id}`, type: 'command.output', id, data });
  }

  async onDone(hostId: string, p: CmdDonePayload): Promise<void> {
    this.liveOutput.delete(p.id);
    this.dispatched.delete(p.id);
    const [row] = await this.sql<{ id: string; requested_by: string; template: string }[]>`
      UPDATE commands SET status = ${p.status}, exit_code = ${p.exitCode}, output = ${p.output}, truncated = ${p.truncated},
        error = ${p.error}, duration_ms = ${Math.round(p.durationMs)}, finished_at = now(),
        started_at = coalesce(started_at, now() - make_interval(secs => ${p.durationMs / 1000}))
      WHERE id = ${p.id} AND host_id = ${hostId} AND status NOT IN ('succeeded', 'failed', 'timeout', 'rejected', 'canceled')
      RETURNING id, requested_by, template`;
    if (!row) return;
    await audit(this.sql, `agent:${hostId}`, 'command.finished', p.id, {
      status: p.status,
      exitCode: p.exitCode,
      error: p.error || undefined,
      template: row.template,
      requestedBy: row.requested_by,
    });
    await this.publish(p.id);
  }

  /** 等待指令结束（AI 分析的 run_command 用），超时返回当前状态。 */
  async wait(id: string, timeoutMs: number): Promise<CommandInfo | undefined> {
    const cur = await this.get(id);
    if (!cur || FINAL_COMMAND_STATUSES.has(cur.status)) return cur;
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (c: CommandInfo) => {
        clearTimeout(t);
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve(c);
      };
      const t = setTimeout(async () => {
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve(await this.get(id));
      }, timeoutMs);
      set.add(done);
    });
  }

  async sweep(): Promise<void> {
    const expired = await this.sql<{ id: string }[]>`
      UPDATE commands SET status = 'expired', finished_at = now(), error = '超过有效期仍未送达 Agent'
      WHERE status IN ('queued', 'sent') AND expires_at < now() - interval '30 seconds' RETURNING id`;
    const lost = await this.sql<{ id: string }[]>`
      UPDATE commands SET status = 'failed', finished_at = now(), error = 'Agent 没有回报执行结果'
      WHERE status = 'running' AND started_at < now() - make_interval(secs => timeout_seconds) - make_interval(secs => ${LOST_GRACE_MS / 1000})
      RETURNING id`;
    for (const { id } of [...expired, ...lost]) {
      this.liveOutput.delete(id);
      this.dispatched.delete(id);
      await this.publish(id);
    }
  }

  private async publish(id: string): Promise<CommandInfo> {
    const info = (await this.get(id, true))!;
    const { output: _output, ...summary } = info;
    this.live.publish({ channel: `command:${id}`, type: 'command.changed', command: info });
    this.live.publish({ channel: `host:${info.hostId}`, type: 'command.changed', command: summary });
    this.live.publish({ channel: 'overview', type: 'command.changed', command: summary, pendingApprovals: await this.pendingApprovals() });
    if (FINAL_COMMAND_STATUSES.has(info.status)) this.waiters.get(id)?.forEach((fn) => fn(info));
    return info;
  }
}
