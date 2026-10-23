// 告警管线集成测试：需要带 TimescaleDB 的 PostgreSQL，通过 TEST_DATABASE_URL 指定（会清空数据）。
// 用假时钟驱动告警引擎，覆盖设计文档 12.3 中 M2 的验收场景。
import type { LogEvent, MetricPoint } from '@pulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { migrationsDir } from '../src/db/paths.js';
import type { HostCtx } from '../src/modules/alerting/engine.js';
import { ingestLogs } from '../src/modules/logs/ingest.js';

const url = process.env.TEST_DATABASE_URL;
const SEC = 1000;
const MIN = 60 * SEC;

interface Sent {
  event: string;
  incident: { id: string; no: number; severity: string };
}

describe.skipIf(!url)('告警管线', () => {
  let sql: Sql;
  let app: App;
  let now = Date.now() - 6 * 3600 * SEC;
  let cookie = '';
  const sent: Sent[] = [];

  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Sent);
    return new Response('{"code":0}');
  }) as typeof fetch;

  beforeAll(async () => {
    sql = createDb(url!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql, migrationsDir());
    app = await buildApp(loadConfig({ DATABASE_URL: url! }), sql, {
      logger: false,
      engine: { clock: () => now },
      notifier: { fetch: fakeFetch, retryDelaysMs: [] },
    });
    await app.engine.reload();
    await sql`INSERT INTO notification_channels (name, kind, url) VALUES ('测试', 'webhook', 'https://hooks.example.com/pulse')`;
    const res = await app.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'admin', password: 'admin-password-1' } });
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  });

  afterAll(async () => {
    await app?.engine.idle();
    await app?.app.close();
    await sql?.end();
  });

  async function host(hostname: string, labels: Record<string, string> = {}): Promise<HostCtx> {
    const info = { hostname, os: 'linux', platform: 'ubuntu', platformVersion: '24.04', arch: 'amd64', ips: [], labels };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hosts (hostname, info, labels, agent_version, status, last_seen_at)
      VALUES (${hostname}, ${sql.json(info)}, ${sql.json(labels)}, 'test', 'online', now()) RETURNING id`;
    return { id: row!.id, hostname, labels };
  }

  function point(name: string, v: number, tag = ''): MetricPoint {
    return { name, tag, min: v, max: v, avg: v, p95: v };
  }

  async function metrics(h: HostCtx, points: MetricPoint[]) {
    await app.engine.onMetrics(h, { windowStart: now - MIN, windowSeconds: 60, early: false, points });
  }

  async function logs(h: HostCtx, events: Partial<LogEvent>[]) {
    const full = events.map(
      (e): LogEvent => ({
        fingerprint: 'agent-fp',
        service: 'svc',
        level: 'error',
        source: '/var/log/app.log',
        message: 'ERROR boom',
        context: [],
        count: 1,
        firstTs: now - 10 * SEC,
        lastTs: now,
        ...e,
      }),
    );
    await app.engine.onLogSignals(await ingestLogs(sql, h, { rulesVersion: 1, events: full, dropped: 0 }, now));
  }

  async function settle() {
    await app.engine.idle();
  }

  const incidentsOf = (hostId: string) =>
    sql<{ id: string; no: string; status: string; severity: string }[]>`SELECT * FROM incidents WHERE ${hostId}::uuid = ANY(host_ids) ORDER BY no`;
  const alertsOf = (hostId: string) =>
    sql<{ key: string; state: string; severity: string; reasons: string[]; count: string; flaps: Date[]; flapping_until: Date | null }[]>`
      SELECT * FROM alerts WHERE host_id = ${hostId} ORDER BY started_at`;
  const sentFor = (incidentId: string) => sent.filter((s) => s.incident.id === incidentId).map((s) => s.event);

  it('验收：10 万条同类报错 + 30 分钟 CPU 满载只产生 1 个 Incident', async () => {
    const h = await host('load-01');
    // Agent 每 10 秒上报一次同一指纹的汇总，30 分钟共 180 个窗口，每个窗口 556 次
    for (let step = 0; step < 180; step++) {
      now += 10 * SEC;
      await logs(h, [{ service: 'order-api', message: `2026-10-23 10:00:00 ERROR Order ${step * 7} failed after ${step}ms`, count: 556 }]);
      if (step % 6 === 5) await metrics(h, [point('cpu.usage_pct', 100)]);
      if (step % 3 === 2) await app.engine.tick();
    }
    await settle();

    const [group] = await sql<{ total_count: string }[]>`SELECT total_count FROM log_groups WHERE service = 'order-api'`;
    expect(Number(group!.total_count)).toBe(100_080);
    const [samples] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM log_samples`;
    expect(samples!.n).toBeLessThanOrEqual(21);

    const incidents = await incidentsOf(h.id);
    expect(incidents).toHaveLength(1);
    const alerts = await alertsOf(h.id);
    expect(alerts.map((a) => [a.key.split(':')[0], a.state, a.severity])).toEqual([
      ['log', 'firing', 'warning'],
      ['cpu-high', 'firing', 'critical'],
    ]);

    // CPU 恢复 5 分钟、日志安静 30 分钟后，Incident 自动关闭
    for (let m = 0; m < 35; m++) {
      now += MIN;
      await metrics(h, [point('cpu.usage_pct', 20)]);
      await app.engine.tick();
    }
    await app.engine.idle();
    const [inc] = await incidentsOf(h.id);
    expect(inc!.status).toBe('resolved');
    expect(inc!.severity).toBe('critical');
    // 只通知 3 次：打开、CPU 严重告警加入后升级、恢复
    expect(sentFor(inc!.id)).toEqual(['opened', 'escalated', 'resolved']);
  });

  it('阈值附近反复触发：重开原告警，第 3 次重开后判定抖动并暂停通知', async () => {
    const h = await host('flap-01');
    // 每 10 分钟一个周期：4 分钟 95%（第 3 分钟触发），6 分钟 50%（5 分钟后恢复）
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let m = 0; m < 10; m++) {
        now += MIN;
        await metrics(h, [point('cpu.usage_pct', m < 4 ? 95 : 50)]);
      }
    }
    await settle();
    const alerts = await alertsOf(h.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.flaps).toHaveLength(4);
    expect(alerts[0]!.flapping_until!.getTime()).toBeGreaterThan(now);

    const incidents = await incidentsOf(h.id);
    expect(incidents).toHaveLength(1);
    const events = await sql<{ type: string }[]>`SELECT type FROM incident_events WHERE incident_id = ${incidents[0]!.id} AND type = 'flapping'`;
    expect(events).toHaveLength(1);
    // 第 4 次触发（第 3 次重开）起不再通知
    expect(sentFor(incidents[0]!.id)).toEqual(['opened', 'resolved', 'reopened', 'resolved', 'reopened', 'resolved']);
  });

  it('同一主机 5 分钟内的告警合并，超过 5 分钟没有新变化则另开', async () => {
    const h = await host('merge-01');
    now += MIN;
    await metrics(h, [point('disk.used_pct', 90, '/data')]);
    now += 2 * MIN;
    await metrics(h, [point('disk.used_pct', 90, '/data'), point('disk.used_pct', 88, '/var')]);
    await settle();
    expect(await incidentsOf(h.id)).toHaveLength(1);

    now += 20 * MIN;
    await metrics(h, [point('disk.used_pct', 90, '/data'), point('disk.used_pct', 88, '/var'), point('disk.inode_used_pct', 90, '/')]);
    await settle();
    expect(await incidentsOf(h.id)).toHaveLength(2);
  });

  it('主机离线告警，上线后恢复', async () => {
    const h = await host('offline-01');
    now += MIN;
    await app.engine.onHostStatus(h, 'offline');
    await app.engine.onHostStatus(h, 'offline'); // 重复的离线事件不会产生新告警
    let alerts = await alertsOf(h.id);
    expect(alerts.map((a) => [a.state, a.severity])).toEqual([['firing', 'critical']]);
    now += MIN;
    await app.engine.onHostStatus(h, 'online');
    alerts = await alertsOf(h.id);
    expect(alerts[0]!.state).toBe('resolved');
  });

  it('日志指纹：标记已解决后复发会再次告警，标记忽略后不再告警', async () => {
    const h = await host('logs-01');
    const msg = { service: 'billing', message: 'ERROR invoice 3f2c1a9e-7b44-4c1e-9d3a-2b8f6e1c0a11 checksum mismatch' };
    now += MIN;
    await logs(h, [msg]);
    const [group] = await sql<{ id: string }[]>`SELECT id FROM log_groups WHERE service = 'billing'`;
    const patch = (status: string) =>
      app.app.inject({ method: 'PATCH', url: `/api/v1/log-groups/${group!.id}`, headers: { cookie }, payload: { status, resolvedCommit: 'abc123' } });

    expect((await patch('resolved')).statusCode).toBe(200);
    expect((await alertsOf(h.id))[0]!.state).toBe('resolved');

    now += 60 * MIN;
    await logs(h, [{ ...msg, message: 'ERROR invoice 0b7c1a9e-7b44-4c1e-9d3a-2b8f6e1c0a99 checksum mismatch' }]);
    let alerts = await alertsOf(h.id);
    expect(alerts.map((a) => [a.state, a.reasons])).toEqual([
      ['resolved', ['new']],
      ['firing', ['recur']],
    ]);

    expect((await patch('ignored')).statusCode).toBe(200);
    now += 60 * MIN;
    await logs(h, [msg]);
    alerts = await alertsOf(h.id);
    expect(alerts.every((a) => a.state === 'resolved')).toBe(true);
  });

  it('日志突增与扩散：升级为严重', async () => {
    const hosts = [await host('spike-01'), await host('spike-02'), await host('spike-03')];
    const msg = { service: 'pay', message: 'ERROR charge timeout after 3000ms' };
    // 2 小时前出现过几次，作为基线
    now += MIN;
    await logs(hosts[0]!, [{ ...msg, firstTs: now - 2 * 3600 * SEC, lastTs: now - 2 * 3600 * SEC }]);
    // 安静 30 分钟后告警恢复；再等足 30 分钟，之后的突增算新告警而不是重开
    for (let m = 0; m < 70; m++) {
      now += MIN;
      await app.engine.tick();
    }
    await settle();
    expect((await alertsOf(hosts[0]!.id)).every((a) => a.state === 'resolved')).toBe(true);

    // 3 分钟内 3 台主机共出现 300 次
    for (let m = 0; m < 3; m++) {
      now += MIN;
      for (const h of hosts) await logs(h, [{ ...msg, count: 34 }]);
    }
    now += 30 * SEC;
    await app.engine.tick();
    await settle();
    const [alert] = await sql<{ state: string; severity: string; reasons: string[] }[]>`
      SELECT a.* FROM alerts a JOIN log_groups g ON g.id = a.log_group_id WHERE g.service = 'pay' AND a.state = 'firing'`;
    expect(alert).toMatchObject({ severity: 'critical' });
    expect(alert!.reasons.sort()).toEqual(['spike', 'spread']);
  });

  it('趋势：磁盘预计 24 小时内写满、内存持续上涨', async () => {
    const h = await host('trend-01');
    now += 10 * MIN;
    // 最近 6 小时每分钟一个点：/data 每小时涨 2%（当前 80%，约 10 小时写满），内存 2 小时涨 30%
    await sql`
      INSERT INTO metrics (time, host_id, name, tag, min, max, avg, p95)
      SELECT t, ${h.id}, 'disk.used_pct', '/data', v, v, v, v
      FROM (SELECT ${new Date(now)}::timestamptz - make_interval(mins => i) AS t, 80 - i * 2.0 / 60 AS v
            FROM generate_series(1, 360) i) s`;
    await sql`
      INSERT INTO metrics (time, host_id, name, tag, min, max, avg, p95)
      SELECT t, ${h.id}, 'mem.used_pct', '', v, v, v, v
      FROM (SELECT ${new Date(now)}::timestamptz - make_interval(mins => i) AS t, 85 - i * 30.0 / 120 + (i % 2) * 0.3 AS v
            FROM generate_series(1, 120) i) s`;
    await app.engine.tick();
    await settle();
    const alerts = await alertsOf(h.id);
    expect(alerts.map((a) => a.key.split(':')[0]).sort()).toEqual(['disk-fill', 'mem-leak']);

    // 停用规则后对应告警恢复
    const res = await app.app.inject({ method: 'PATCH', url: '/api/v1/rules/disk-fill', headers: { cookie }, payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    const after = await alertsOf(h.id);
    expect(after.find((a) => a.key.startsWith('disk-fill'))!.state).toBe('resolved');
  });

  it('控制台接口：Incident 列表与详情、主机告警数、日志指纹、规则校验', async () => {
    const list = await app.app.inject({ url: '/api/v1/incidents?status=all&limit=2', headers: { cookie } });
    const page = list.json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1].no);

    const [first] = await sql<{ no: string }[]>`SELECT no FROM incidents ORDER BY no LIMIT 1`;
    const detail = (await app.app.inject({ url: `/api/v1/incidents/${first!.no}`, headers: { cookie } })).json();
    expect(detail.hosts[0].hostname).toBe('load-01');
    expect(detail.alerts).toHaveLength(2);
    expect(detail.logGroups[0].service).toBe('order-api');
    expect(detail.events[0].type).toBe('opened');

    const hosts = (await app.app.inject({ url: '/api/v1/hosts', headers: { cookie } })).json();
    // 日志告警挂在最近出现该指纹的主机上
    const spike = hosts.items.find((x: { hostname: string }) => x.hostname === 'spike-03');
    expect(spike.alerts).toEqual({ warning: 0, critical: 1 });

    const groups = (await app.app.inject({ url: '/api/v1/log-groups?status=all&q=charge', headers: { cookie } })).json();
    expect(groups.items).toHaveLength(1);
    expect(groups.items[0].count24h).toBeGreaterThan(300);

    const bad = await app.app.inject({ method: 'PATCH', url: '/api/v1/rules/cpu-high', headers: { cookie }, payload: { params: { recover: 95 } } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.app.inject({ method: 'PATCH', url: '/api/v1/rules/cpu-high', headers: { cookie }, payload: { params: { foo: 1 } } });
    expect(unknown.statusCode).toBe(400);
  });
});
