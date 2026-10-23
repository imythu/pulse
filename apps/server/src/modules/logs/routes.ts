import {
  LogGroupListQuery,
  LogGroupPatch,
  type HostRef,
  type LogGroupDetail,
  type LogGroupStatus,
  type LogGroupSummary,
  type LogSample,
} from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-error.js';
import type { AlertEngine } from '../alerting/engine.js';
import { audit, requireRole } from '../auth/index.js';
import { isUuid } from '../hosts/repo.js';

interface LogGroupRow {
  id: string;
  service: string;
  fingerprint: string;
  level: 'error' | 'fatal';
  template: string;
  first_seen: Date;
  last_seen: Date;
  total_count: string;
  host_ids: string[];
  status: LogGroupStatus;
  resolved_commit: string | null;
}

const HOUR = 3600_000;

/** 给一批指纹补上最近 24 小时的计数，按整点对齐。 */
export async function withHourly(sql: Sql, rows: LogGroupRow[], now = Date.now()): Promise<LogGroupSummary[]> {
  const end = Math.floor(now / HOUR) * HOUR;
  const start = end - 23 * HOUR;
  const counts = rows.length
    ? await sql<{ id: string; h: Date; n: number }[]>`
        SELECT log_group_id AS id, time_bucket(INTERVAL '1 hour', time) AS h, sum(count)::float8 AS n
        FROM log_counts WHERE log_group_id = ANY(${rows.map((r) => r.id)}::uuid[]) AND time >= ${new Date(start)}
        GROUP BY 1, 2`
    : [];
  const byId = new Map<string, number[]>();
  for (const c of counts) {
    const arr = byId.get(c.id) ?? Array<number>(24).fill(0);
    const i = Math.round((c.h.getTime() - start) / HOUR);
    if (i >= 0 && i < 24) arr[i] = c.n;
    byId.set(c.id, arr);
  }
  return rows.map((r) => {
    const hourly = byId.get(r.id) ?? Array<number>(24).fill(0);
    return {
      id: r.id,
      service: r.service,
      fingerprint: r.fingerprint,
      level: r.level,
      template: r.template,
      firstSeen: r.first_seen.getTime(),
      lastSeen: r.last_seen.getTime(),
      totalCount: Number(r.total_count),
      hostCount: r.host_ids.length,
      status: r.status,
      resolvedCommit: r.resolved_commit,
      count24h: hourly.reduce((a, b) => a + b, 0),
      hourly,
    };
  });
}

export async function logGroupsByIds(sql: Sql, ids: string[]): Promise<LogGroupSummary[]> {
  if (!ids.length) return [];
  const rows = await sql<LogGroupRow[]>`SELECT * FROM log_groups WHERE id = ANY(${ids}::uuid[]) ORDER BY last_seen DESC`;
  return withHourly(sql, rows);
}

export function registerLogRoutes(app: FastifyInstance, sql: Sql, engine: AlertEngine) {
  const viewer = { preHandler: requireRole(sql, 'viewer') };

  app.get('/api/v1/log-groups', viewer, async (req) => {
    const q = LogGroupListQuery.safeParse(req.query);
    if (!q.success) throw badRequest('查询参数错误');
    const { status, service, hostId, limit } = q.data;
    const text = q.data.q?.trim();
    const rows = await sql<LogGroupRow[]>`
      SELECT * FROM log_groups
      WHERE true
        ${status !== 'all' ? sql`AND status = ${status}` : sql``}
        ${service ? sql`AND service = ${service}` : sql``}
        ${hostId ? sql`AND ${hostId}::uuid = ANY(host_ids)` : sql``}
        ${text ? sql`AND (template ILIKE ${'%' + text.replace(/[\\%_]/g, '\\$&') + '%'} OR fingerprint = ${text})` : sql``}
      ORDER BY last_seen DESC LIMIT ${limit}`;
    const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM log_groups ORDER BY service`;
    return { items: await withHourly(sql, rows), services: services.map((s) => s.service) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/log-groups/:id', viewer, async (req): Promise<LogGroupDetail> => {
    if (!isUuid(req.params.id)) throw notFound('日志指纹不存在');
    const [row] = await sql<LogGroupRow[]>`SELECT * FROM log_groups WHERE id = ${req.params.id}`;
    if (!row) throw notFound('日志指纹不存在');
    const [summary] = await withHourly(sql, [row]);

    const hosts = await sql<HostRef[]>`SELECT id, hostname FROM hosts WHERE id = ANY(${row.host_ids}::uuid[]) ORDER BY hostname`;
    const samples = await sql<{ id: string; host_id: string | null; hostname: string | null; time: Date; source: string; message: string; context: string[] }[]>`
      SELECT s.id, s.host_id, h.hostname, s.time, s.source, s.message, s.context
      FROM log_samples s LEFT JOIN hosts h ON h.id = s.host_id
      WHERE s.log_group_id = ${row.id} ORDER BY s.id DESC`;
    // 补齐 24 小时内每个 10 分钟桶，没有出现的记 0，曲线才连续
    const BUCKET = 10 * 60_000;
    const end = Math.floor(Date.now() / BUCKET) * BUCKET;
    const start = end - 143 * BUCKET;
    const rows = await sql<{ t: Date; n: number }[]>`
      SELECT time_bucket(INTERVAL '10 minutes', time) AS t, sum(count)::float8 AS n
      FROM log_counts WHERE log_group_id = ${row.id} AND time >= ${new Date(start)} GROUP BY 1`;
    const byT = new Map(rows.map((r) => [r.t.getTime(), r.n]));
    const series: [number, number][] = Array.from({ length: 144 }, (_, i) => {
      const t = start + i * BUCKET;
      return [t, byT.get(t) ?? 0];
    });
    const [alert] = await sql<{ id: string }[]>`SELECT id FROM alerts WHERE log_group_id = ${row.id} AND state = 'firing'`;

    return {
      ...summary!,
      hosts,
      samples: samples.map(
        (s): LogSample => ({
          id: Number(s.id),
          hostId: s.host_id,
          hostname: s.hostname,
          time: s.time.getTime(),
          source: s.source,
          message: s.message,
          context: s.context,
        }),
      ),
      series,
      activeAlertId: alert?.id ?? null,
    };
  });

  // 标记为忽略（已知噪音）或已解决；已解决的指纹再次出现会触发“复发”告警
  app.patch<{ Params: { id: string } }>('/api/v1/log-groups/:id', { preHandler: requireRole(sql, 'operator') }, async (req) => {
    if (!isUuid(req.params.id)) throw notFound('日志指纹不存在');
    const body = LogGroupPatch.safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    const { status, resolvedCommit } = body.data;
    const actor = `user:${req.user!.id}`;
    const [row] = await sql<LogGroupRow[]>`
      UPDATE log_groups SET status = ${status}, status_by = ${actor}, status_at = now(),
        resolved_commit = ${status === 'resolved' ? resolvedCommit || null : null}
      WHERE id = ${req.params.id} RETURNING *`;
    if (!row) throw notFound('日志指纹不存在');
    await audit(sql, actor, `log_group.${status}`, row.id, { service: row.service, resolvedCommit });
    if (status !== 'active') {
      await engine.closeLogGroup(row.id, status === 'ignored' ? `被 ${req.user!.username} 标记为忽略` : `被 ${req.user!.username} 标记为已解决`);
    }
    const [summary] = await withHourly(sql, [row]);
    return summary;
  });
}
