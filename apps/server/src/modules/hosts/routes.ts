import { MetricsQuery, type HostDetail, type MetricSeries, type MetricsResponse, type OverviewStats } from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-error.js';
import { audit, requireRole } from '../auth/index.js';
import type { AlertEngine } from '../alerting/engine.js';
import type { Gateway } from '../gateway/index.js';
import { getHostRow, listHosts, toDetail } from './repo.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_POINTS = 360;
const STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];

/** 按时间范围选聚合粒度：每条曲线不超过 360 个点；超过 7 天走小时聚合表。 */
export function chooseStep(from: number, to: number): { stepSeconds: number; source: 'metrics' | 'metrics_1h' } {
  const range = to - from;
  const minStep = Math.ceil(range / 1000 / MAX_POINTS);
  const stepSeconds = STEPS.find((s) => s >= minStep) ?? STEPS[STEPS.length - 1]!;
  return { stepSeconds, source: range > 7 * DAY ? 'metrics_1h' : 'metrics' };
}

export function registerHostRoutes(app: FastifyInstance, sql: Sql, gateway: Gateway, engine: AlertEngine) {
  const viewer = { preHandler: requireRole(sql, 'viewer') };

  app.get('/api/v1/overview', viewer, async (): Promise<OverviewStats> => {
    const [row] = await sql<{ total: number; online: number; cpu: number | null; mem: number | null; incidents: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'online')::int AS online,
             avg((snapshot->>'cpuPct')::float) FILTER (WHERE status = 'online') AS cpu,
             avg((snapshot->>'memPct')::float) FILTER (WHERE status = 'online') AS mem,
             (SELECT count(*) FROM incidents WHERE status <> 'resolved')::int AS incidents
      FROM hosts`;
    return { hostsTotal: row!.total, hostsOnline: row!.online, avgCpuPct: row!.cpu, avgMemPct: row!.mem, openIncidents: row!.incidents };
  });

  app.get('/api/v1/hosts', viewer, async () => ({ items: await listHosts(sql) }));

  app.get<{ Params: { id: string } }>('/api/v1/hosts/:id', viewer, async (req): Promise<HostDetail> => {
    const row = await getHostRow(sql, req.params.id);
    if (!row) throw notFound('主机不存在');
    return toDetail(row);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/hosts/:id', { preHandler: requireRole(sql, 'admin') }, async (req) => {
    const row = await getHostRow(sql, req.params.id);
    if (!row) throw notFound('主机不存在');
    await gateway.revoke(row.id, `user:${req.user!.id}`);
    await sql`DELETE FROM hosts WHERE id = ${row.id}`;
    await engine.forgetHost(row.id);
    await audit(sql, `user:${req.user!.id}`, 'host.deleted', row.id, { hostname: row.hostname });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/hosts/:id/metrics', viewer, async (req): Promise<MetricsResponse> => {
    const q = MetricsQuery.safeParse(req.query);
    if (!q.success) throw badRequest('查询参数错误');
    const row = await getHostRow(sql, req.params.id);
    if (!row) throw notFound('主机不存在');

    const to = q.data.to ?? Date.now();
    const from = q.data.from ?? to - HOUR;
    if (from >= to || to - from > 90 * DAY) throw badRequest('时间范围需在 90 天内');
    const names = q.data.names?.split(',').filter(Boolean) ?? [];
    const { stepSeconds, source } = chooseStep(from, to);

    const table = sql(source);
    const timeCol = sql(source === 'metrics' ? 'time' : 'bucket');
    const rows = await sql<{ name: string; tag: string; t: Date; avg: number; max: number }[]>`
      SELECT name, tag, time_bucket(make_interval(secs => ${stepSeconds}), ${timeCol}) AS t,
             avg(avg) AS avg, max(max) AS max
      FROM ${table}
      WHERE host_id = ${row.id} AND ${timeCol} >= ${new Date(from)} AND ${timeCol} <= ${new Date(to)}
        ${names.length ? sql`AND name = ANY(${names})` : sql``}
      GROUP BY name, tag, t
      ORDER BY name, tag, t`;

    const byKey = new Map<string, MetricSeries>();
    for (const r of rows) {
      const key = `${r.name}\u0000${r.tag}`;
      let s = byKey.get(key);
      if (!s) byKey.set(key, (s = { name: r.name, tag: r.tag, points: [] }));
      s.points.push([r.t.getTime(), r.avg, r.max]);
    }
    return { hostId: row.id, from, to, stepSeconds, series: [...byKey.values()] };
  });
}
