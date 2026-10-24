// 指令集成测试（设计文档 3.5、10.2、12.3 M3）：需要 TEST_DATABASE_URL（会清空数据）。
// 前半部分用协议级的模拟 Agent 覆盖策略、审批、离线补发和过期；
// 后半部分在 Agent 二进制已构建时（make build）启动真实 Agent，验证跨语言的签名链路。
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { agentAuthMessage, type CommandInfo, type HostInfo, type SignedCommand } from '@pulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { migrationsDir } from '../src/db/paths.js';
import { hashToken } from '../src/lib/crypto.js';
import { Signer } from '../src/lib/signing.js';

const url = process.env.TEST_DATABASE_URL;
const AGENT_BIN = process.env.PULSE_TEST_AGENT_BIN ?? fileURLToPath(new URL('../../agent/bin/pulse-agent-linux-amd64', import.meta.url));

const hostInfo = (hostname: string): HostInfo => ({
  hostname,
  os: 'linux',
  platform: 'ubuntu',
  platformVersion: '24.04',
  kernel: '6.8',
  arch: 'amd64',
  cpuCores: 4,
  cpuModel: 'test',
  memTotal: 8e9,
  ips: [],
  labels: {},
  bootTime: 0,
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!url)('指令', () => {
  let sql: Sql;
  let app: App;
  let base: string;
  let admin = '';
  let operator = '';
  let tokenNo = 0;

  const api = async <T = CommandInfo>(cookie: string, method: string, path: string, payload?: object) => {
    const res = await app.app.inject({ method: method as 'GET', url: path, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() as T };
  };

  async function enrollToken(): Promise<string> {
    const token = `pe_cmd_test_${++tokenNo}_abcdefghijkl`;
    await sql`INSERT INTO enroll_tokens (token_hash, expires_at) VALUES (${hashToken(token)}, now() + interval '1 hour')`;
    return token;
  }

  /** 协议级的模拟 Agent：注册、连接、收集服务器下发的消息。 */
  async function simAgent(hostname: string) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const res = await app.app.inject({
      method: 'POST',
      url: '/agent/enroll',
      payload: { token: await enrollToken(), publicKey: raw.toString('base64'), host: hostInfo(hostname), agentVersion: 'test' },
    });
    const { agentId, signingPublicKey } = res.json() as { agentId: string; signingPublicKey: string };
    const inbox: { type: string; payload: Record<string, unknown> }[] = [];
    let ws: WebSocket | undefined;
    let seq = 0;
    const agent = {
      id: agentId,
      signingPublicKey,
      inbox,
      async connect() {
        const ts = Date.now();
        const sig = sign(null, Buffer.from(agentAuthMessage(agentId, ts)), privateKey).toString('base64url');
        ws = new WebSocket(`ws://${base}/agent/ws`, { headers: { authorization: `Pulse ${agentId}.${ts}.${sig}` } });
        ws.on('message', (d: Buffer) => inbox.push(JSON.parse(zstdDecompressSync(d).toString())));
        await new Promise((r, j) => (ws!.once('open', r), ws!.once('error', j)));
        agent.send('hello', { protocol: 1, agentVersion: 'test', host: hostInfo(hostname), commands: [] }, 0);
        await until(() => inbox.some((m) => m.type === 'ack'));
      },
      send(type: string, payload: object, s = ++seq) {
        ws!.send(zstdCompressSync(Buffer.from(JSON.stringify({ type, seq: s, ts: Date.now(), payload }))));
      },
      runs: () => inbox.filter((m) => m.type === 'cmd.run').map((m) => m.payload as { body: string; signature: string }),
      close: () => ws?.close(),
    };
    return agent;
  }

  beforeAll(async () => {
    sql = createDb(url!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql, migrationsDir());
    app = await buildApp(loadConfig({ DATABASE_URL: url!, PULSE_DATA_DIR: mkdtempSync(join(tmpdir(), 'pulse-cmd-')) }), sql, { logger: false });
    await app.engine.reload();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.app.server.address();
    base = `127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const setup = await app.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'admin', password: 'admin-password-1' } });
    admin = String(setup.headers['set-cookie']).split(';')[0]!;
    const { hash } = await import('@node-rs/argon2');
    await sql`INSERT INTO users (username, password_hash, role) VALUES ('ops', ${await hash('ops-password-1')}, 'operator')`;
    const login = await app.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ops', password: 'ops-password-1' } });
    operator = String(login.headers['set-cookie']).split(';')[0]!;
  });

  afterAll(async () => {
    await app?.gateway.stop();
    await app?.app.close();
    await sql?.end();
  });

  it('只读指令：签名下发、实时输出、结果入库', async () => {
    const a = await simAgent('cmd-01');
    await a.connect();
    const created = await api(operator, 'POST', '/api/v1/commands', { hostId: a.id, template: 'log.tail', args: { source: '/var/log/app.log' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ status: 'sent', risk: 'read', args: { source: '/var/log/app.log', n: '200' }, requestedByName: 'ops' });

    await until(() => a.runs().length === 1);
    const run = a.runs()[0]!;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(a.signingPublicKey, 'base64')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(run.body), key, Buffer.from(run.signature, 'base64'))).toBe(true);
    const body = JSON.parse(run.body) as SignedCommand;
    expect(body).toMatchObject({ kind: 'pulse-command', id: created.body.id, hostId: a.id, template: 'log.tail' });
    expect(body.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);

    const events: string[] = [];
    const off = app.live.subscribe(`command:${body.id}`, (e) => events.push(e.type === 'command.output' ? `out:${e.data}` : e.type === 'command.changed' ? `status:${e.command.status}` : e.type));
    a.send('cmd.status', { id: body.id, status: 'running' }, 0);
    a.send('cmd.output', { id: body.id, data: 'line 1\n' }, 0);
    await until(async () => (await app.commands.get(body.id))?.output === 'line 1\n');
    a.send('cmd.done', { id: body.id, status: 'succeeded', exitCode: null, output: 'line 1\nline 2\n', truncated: false, error: '', durationMs: 12 });
    const done = await app.commands.wait(body.id, 3000);
    off();
    expect(done).toMatchObject({ status: 'succeeded', output: 'line 1\nline 2\n', durationMs: 12 });
    expect(events).toEqual(['status:running', 'out:line 1\n', 'status:succeeded']);

    // 重复的 cmd.done（断线补传）不会覆盖结果
    a.send('cmd.done', { id: body.id, status: 'failed', exitCode: 1, output: 'x', truncated: false, error: '', durationMs: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await app.commands.get(body.id))?.status).toBe('succeeded');
    a.close();
  });

  it('参数和模板在服务器校验；只读账号不能下发', async () => {
    const [h] = await sql<{ id: string }[]>`SELECT id FROM hosts WHERE hostname = 'cmd-01'`;
    const bad = [
      { template: 'log.tail', args: { source: '/var/log/../etc/shadow' } },
      { template: 'log.tail', args: { source: '/a.log', n: 99999 } },
      { template: 'rm.rf', args: {} },
      { template: 'custom.nope', args: {} },
    ];
    for (const b of bad) expect((await api(operator, 'POST', '/api/v1/commands', { hostId: h!.id, ...b })).status).toBe(400);
  });

  it('写操作：待审批 → 运维不能审批 → 唯一管理员自审并标记', async () => {
    const a = await simAgent('cmd-02');
    await a.connect();
    const req = await api(operator, 'POST', '/api/v1/commands', { hostId: a.id, template: 'svc.restart', args: { unit: 'nginx.service' }, reason: '内存泄漏' });
    expect(req.body).toMatchObject({ status: 'pending_approval', approvalStatus: 'pending' });
    expect(a.runs()).toHaveLength(0);
    expect((await api<{ pendingApprovals: number }>(admin, 'GET', '/api/v1/overview')).body.pendingApprovals).toBe(1);
    expect((await api(operator, 'POST', `/api/v1/commands/${req.body.id}/approve`)).status).toBe(403);

    const approved = await api(admin, 'POST', `/api/v1/commands/${req.body.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'sent', approvalStatus: 'approved', approvedByName: 'admin', selfApproved: false });
    await until(() => a.runs().length === 1);

    // 管理员自己发起的写操作：只有一位管理员时允许自审，并标记
    const own = await api(admin, 'POST', '/api/v1/commands', { hostId: a.id, template: 'svc.restart', args: { unit: 'redis' } });
    const self = await api(admin, 'POST', `/api/v1/commands/${own.body.id}/approve`);
    expect(self.body).toMatchObject({ approvalStatus: 'approved', selfApproved: true });
    const [audit] = await sql<{ detail: { selfApproved: boolean } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'command.approved' AND target = ${own.body.id}`;
    expect(audit!.detail.selfApproved).toBe(true);

    const third = await api(operator, 'POST', '/api/v1/commands', { hostId: a.id, template: 'svc.restart', args: { unit: 'x' } });
    const rejected = await api(admin, 'POST', `/api/v1/commands/${third.body.id}/reject`, { reason: '没必要' });
    expect(rejected.body).toMatchObject({ status: 'rejected', rejectReason: '没必要' });
    a.close();
  });

  it('主机离线时排队，连上后补发；过期未送达标记 expired', async () => {
    const a = await simAgent('cmd-03');
    const c = await api(operator, 'POST', '/api/v1/commands', { hostId: a.id, template: 'net.conns' });
    expect(c.body.status).toBe('queued');
    const stale = await api(operator, 'POST', '/api/v1/commands', { hostId: a.id, template: 'docker.ps' });
    await sql`UPDATE commands SET expires_at = now() - interval '1 minute' WHERE id = ${stale.body.id}`;

    await a.connect();
    await until(() => a.runs().length === 1);
    expect(JSON.parse(a.runs()[0]!.body).id).toBe(c.body.id);
    await app.commands.sweep();
    expect((await app.commands.get(stale.body.id))?.status).toBe('expired');
    a.close();
  });

  it('AI 分析：只能执行只读指令，单次最多 10 条', async () => {
    const [h] = await sql<{ id: string }[]>`SELECT id FROM hosts WHERE hostname = 'cmd-03'`;
    const who = { kind: 'analysis' as const, analysisId: '00000000-0000-4000-8000-000000000001' };
    await expect(app.commands.create(who, { hostId: h!.id, template: 'svc.restart', args: { unit: 'x' } })).rejects.toThrow(/propose_action/);
    for (let i = 0; i < 10; i++) await app.commands.create(who, { hostId: h!.id, template: 'proc.top', args: {} });
    await expect(app.commands.create(who, { hostId: h!.id, template: 'proc.top', args: {} })).rejects.toThrow(/最多/);
    const list = await api<{ items: CommandInfo[] }>(admin, 'GET', `/api/v1/commands?hostId=${h!.id}&limit=100`);
    expect(list.body.items.filter((c) => c.requestedByName === 'AI 分析')).toHaveLength(10);
  });

  describe.skipIf(!existsSync(AGENT_BIN))('真实 Agent', () => {
    let proc: ChildProcess;
    let hostId = '';
    const dir = mkdtempSync(join(tmpdir(), 'pulse-agent-'));
    const logFile = join(dir, 'app.log');

    beforeAll(async () => {
      writeFileSync(logFile, 'boot\n2026-10-24 10:00:00 ERROR payment timeout\n');
      writeFileSync(
        join(dir, 'agent.yaml'),
        `server: http://${base}\ndata_dir: ${dir}/data\nlogs:\n  journald:\n    enabled: false\n  files:\n    - service: app\n      paths: [${logFile}]\n` +
          `commands:\n  custom:\n    - name: hello\n      exec: [/bin/echo, "hello {who}"]\n      params: [{name: who, pattern: "^[a-z]+$", required: true}]\n`,
      );
      const env = { ...process.env, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' };
      const enroll = spawn(AGENT_BIN, ['enroll', '--config', join(dir, 'agent.yaml'), '--token', await enrollToken()], { env });
      await new Promise((r) => enroll.on('exit', r));
      proc = spawn(AGENT_BIN, ['run', '--config', join(dir, 'agent.yaml')], { env, stdio: 'ignore' });
      await until(async () => {
        const [h] = await sql<{ id: string; commands: unknown[] }[]>`SELECT id, commands FROM hosts WHERE info->>'hostname' IS NOT NULL AND agent_version <> 'test' AND status = 'online'`;
        hostId = h?.id ?? '';
        return !!h;
      }, 15_000);
    });

    afterAll(() => proc?.kill());

    it('执行服务器签名的指令，上报自定义模板', async () => {
      const tpl = await api<{ custom: { name: string }[] }>(operator, 'GET', `/api/v1/hosts/${hostId}/command-templates`);
      expect(tpl.body.custom.map((t) => t.name)).toEqual(['custom.hello']);

      const tail = await api(operator, 'POST', '/api/v1/commands', { hostId, template: 'log.tail', args: { source: logFile, n: 1 } });
      expect(await app.commands.wait(tail.body.id, 10_000)).toMatchObject({ status: 'succeeded', output: '2026-10-24 10:00:00 ERROR payment timeout\n' });

      const hello = await api(operator, 'POST', '/api/v1/commands', { hostId, template: 'custom.hello', args: { who: 'pulse' } });
      expect(await app.commands.wait(hello.body.id, 10_000)).toMatchObject({ status: 'succeeded', output: 'hello pulse\n', exitCode: 0 });

      // 配置范围外的文件：Agent 拒绝读取
      const outside = await api(operator, 'POST', '/api/v1/commands', { hostId, template: 'log.tail', args: { source: '/etc/passwd' } });
      expect(await app.commands.wait(outside.body.id, 10_000)).toMatchObject({ status: 'failed' });
    });

    it('验收：伪造签名、过期的指令被 Agent 拒绝', async () => {
      const forger = new Signer(Buffer.alloc(32, 7));
      const insert = async (expiresAt: Date) => {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO commands (host_id, template, args, risk, requested_by, status, timeout_seconds, expires_at, sent_at)
          VALUES (${hostId}, 'proc.top', '{}', 'read', 'user:test', 'sent', 15, ${expiresAt}, now()) RETURNING id`;
        return row!.id;
      };
      const send = (id: string, signer: Signer, expiresAt: number) => {
        const body = JSON.stringify({ v: 1, kind: 'pulse-command', id, hostId, template: 'proc.top', args: {}, expiresAt, timeoutSeconds: 15 } satisfies SignedCommand);
        app.gateway.sendTo(hostId, { type: 'cmd.run', seq: 0, ts: Date.now(), payload: { body, signature: signer.sign(body) } });
      };

      const forged = await insert(new Date(Date.now() + 60_000));
      send(forged, forger, Date.now() + 60_000);
      expect(await app.commands.wait(forged, 10_000)).toMatchObject({ status: 'rejected', error: '签名无效' });

      const unsigned = await insert(new Date(Date.now() + 60_000));
      const body = JSON.stringify({ v: 1, kind: 'pulse-command', id: unsigned, hostId, template: 'proc.top', args: {}, expiresAt: Date.now() + 60_000, timeoutSeconds: 15 });
      app.gateway.sendTo(hostId, { type: 'cmd.run', seq: 0, ts: Date.now(), payload: { body, signature: '' } });
      expect(await app.commands.wait(unsigned, 10_000)).toMatchObject({ status: 'rejected', error: '签名无效' });

      const expired = await insert(new Date(Date.now() + 60_000));
      send(expired, app.signer, Date.now() - 1000);
      expect(await app.commands.wait(expired, 10_000)).toMatchObject({ status: 'rejected', error: '指令已过期' });

      // 同一条合法指令重放两次：第二次被拒绝，结果不被覆盖
      const replay = await insert(new Date(Date.now() + 60_000));
      send(replay, app.signer, Date.now() + 60_000);
      expect(await app.commands.wait(replay, 10_000)).toMatchObject({ status: 'succeeded' });
    });
  });
});
