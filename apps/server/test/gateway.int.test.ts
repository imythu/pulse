// 网关集成测试：需要带 TimescaleDB 的 PostgreSQL，通过 TEST_DATABASE_URL 指定（会清空数据）。
import { generateKeyPairSync, sign } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { agentAuthMessage, type HostInfo } from '@pulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { migrationsDir } from '../src/db/paths.js';
import { hashToken } from '../src/lib/crypto.js';

const url = process.env.TEST_DATABASE_URL;

const host: HostInfo = {
  hostname: 'it-host',
  os: 'linux',
  platform: 'ubuntu',
  platformVersion: '24.04',
  kernel: '6.8',
  arch: 'amd64',
  cpuCores: 4,
  cpuModel: 'test',
  memTotal: 8e9,
  ips: ['10.0.0.1'],
  labels: { env: 'test' },
  bootTime: 0,
};

describe.skipIf(!url)('gateway', () => {
  let sql: Sql;
  let app: App;
  let base: string;

  beforeAll(async () => {
    sql = createDb(url!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql, migrationsDir());
    app = await buildApp(loadConfig({ DATABASE_URL: url!, PULSE_OFFLINE_AFTER_SECONDS: '45' }), sql, { logger: false });
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.app.server.address();
    base = `127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await app?.gateway.stop();
    await app?.app.close();
    await sql?.end();
  });

  it('注册、连接、上报、按 seq 去重', async () => {
    await sql`INSERT INTO enroll_tokens (token_hash, labels, expires_at) VALUES (${hashToken('pe_test_token_1234567890')}, ${sql.json({ role: 'web' })}, now() + interval '1 hour')`;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

    const enroll = await app.app.inject({
      method: 'POST',
      url: '/agent/enroll',
      payload: { token: 'pe_test_token_1234567890', publicKey: raw.toString('base64'), host, agentVersion: 'test' },
    });
    expect(enroll.statusCode).toBe(200);
    const { agentId } = enroll.json();

    // 令牌只能用一次
    const again = await app.app.inject({
      method: 'POST',
      url: '/agent/enroll',
      payload: { token: 'pe_test_token_1234567890', publicKey: raw.toString('base64'), host, agentVersion: 'test' },
    });
    expect(again.statusCode).toBe(401);

    const ts = Date.now();
    const sig = sign(null, Buffer.from(agentAuthMessage(agentId, ts)), privateKey).toString('base64url');
    const ws = new WebSocket(`ws://${base}/agent/ws`, { headers: { authorization: `Pulse ${agentId}.${ts}.${sig}` } });
    const inbox: { type: string; payload: { maxSeq?: number } }[] = [];
    ws.on('message', (d: Buffer) => inbox.push(JSON.parse(zstdDecompressSync(d).toString())));
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    const send = (m: object) => ws.send(zstdCompressSync(Buffer.from(JSON.stringify(m))));
    const waitAck = async (n: number) => {
      for (let i = 0; i < 100 && inbox.filter((m) => m.type === 'ack').length < n; i++) await new Promise((r) => setTimeout(r, 20));
      return inbox.filter((m) => m.type === 'ack').at(-1)!.payload.maxSeq;
    };

    send({ type: 'hello', seq: 0, ts, payload: { protocol: 1, agentVersion: 'test', host } });
    expect(await waitAck(1)).toBe(0);
    expect(inbox.some((m) => m.type === 'config')).toBe(true);

    const window = Date.UTC(2030, 0, 1);
    const metrics = (seq: number, cpu: number) => ({
      type: 'metrics',
      seq,
      ts,
      payload: { windowStart: window, windowSeconds: 60, early: false, points: [{ name: 'cpu.usage_pct', tag: '', min: cpu, max: cpu, avg: cpu, p95: cpu }] },
    });
    send(metrics(1, 50));
    expect(await waitAck(2)).toBe(1);
    // 同一 seq 重发：只 ack，不覆盖
    send(metrics(1, 99));
    expect(await waitAck(3)).toBe(1);
    // 同一窗口的新 seq：覆盖（提前推送后补完整窗口）
    send(metrics(2, 70));
    expect(await waitAck(4)).toBe(2);

    const rows = await sql<{ avg: number }[]>`SELECT avg FROM metrics WHERE host_id = ${agentId}`;
    expect(rows.map((r) => r.avg)).toEqual([70]);
    const [h] = await sql<{ status: string; labels: Record<string, string>; last_seq: string }[]>`SELECT status, labels, last_seq FROM hosts WHERE id = ${agentId}`;
    expect(h).toMatchObject({ status: 'online', labels: { env: 'test', role: 'web' }, last_seq: '2' });

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const [after] = await sql<{ status: string }[]>`SELECT status FROM hosts WHERE id = ${agentId}`;
    expect(after?.status).toBe('offline');
  });

  it('拒绝错误签名和过期时间戳', async () => {
    const [row] = await sql<{ id: string }[]>`SELECT id FROM hosts LIMIT 1`;
    const id = row!.id;
    for (const header of [`Pulse ${id}.${Date.now()}.AAAA`, `Pulse ${id}.${Date.now() - 3600_000}.AAAA`, 'Bearer x']) {
      const res = await app.app.inject({ method: 'GET', url: '/agent/ws', headers: { authorization: header, connection: 'upgrade', upgrade: 'websocket' } });
      expect(res.statusCode).toBe(401);
    }
  });
});
