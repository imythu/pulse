import { IncidentListQuery, RulePatch, type IncidentDetail, type Page, type IncidentSummary } from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-error.js';
import { audit, requireRole } from '../auth/index.js';
import { isUuid } from '../hosts/repo.js';
import { logGroupsByIds } from '../logs/routes.js';
import type { AlertEngine } from './engine.js';
import { alertsWhere, incidentEvents, incidentsWhere } from './repo.js';
import { PARAM_KEYS, toRuleInfo, type RuleRow } from './rules.js';

const DAY = 24 * 3600_000;

export function registerAlertingRoutes(app: FastifyInstance, sql: Sql, engine: AlertEngine) {
  const viewer = { preHandler: requireRole(sql, 'viewer') };

  app.get('/api/v1/incidents', viewer, async (req): Promise<Page<IncidentSummary>> => {
    const q = IncidentListQuery.safeParse(req.query);
    if (!q.success) throw badRequest('查询参数错误');
    const { status, hostId, cursor, limit } = q.data;
    const items = await incidentsWhere(
      sql,
      sql`true
        ${status === 'open' ? sql`AND i.status <> 'resolved'` : status === 'resolved' ? sql`AND i.status = 'resolved'` : sql``}
        ${hostId ? sql`AND ${hostId}::uuid = ANY(i.host_ids)` : sql``}
        ${cursor ? sql`AND i.no < ${cursor}` : sql``}`,
      limit,
    );
    return { items, nextCursor: items.length === limit ? items[items.length - 1]!.no : null };
  });

  // 支持用 UUID 或编号查询，方便在聊天里直接说 “#12”
  app.get<{ Params: { id: string } }>('/api/v1/incidents/:id', viewer, async (req): Promise<IncidentDetail> => {
    const id = req.params.id;
    const where = isUuid(id) ? sql`i.id = ${id}` : /^\d{1,12}$/.test(id) ? sql`i.no = ${id}` : undefined;
    const [incident] = where ? await incidentsWhere(sql, where, 1) : [];
    if (!incident) throw notFound('Incident 不存在');
    const alerts = await alertsWhere(sql, sql`a.incident_id = ${incident.id}`);
    const logGroupIds = [...new Set(alerts.map((a) => a.logGroupId).filter((x): x is string => !!x))];
    return {
      ...incident,
      alerts,
      events: await incidentEvents(sql, incident.id),
      logGroups: await logGroupsByIds(sql, logGroupIds),
    };
  });

  // 主机详情：时间范围内有交集的告警，用于在图表上标出告警区间
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/v1/hosts/:id/alerts', viewer, async (req) => {
    if (!isUuid(req.params.id)) throw notFound('主机不存在');
    const to = Number(req.query.to) || Date.now();
    const from = Number(req.query.from) || to - DAY;
    if (from >= to || to - from > 90 * DAY) throw badRequest('时间范围需在 90 天内');
    const items = await alertsWhere(
      sql,
      sql`a.host_id = ${req.params.id} AND a.started_at <= ${new Date(to)} AND (a.resolved_at IS NULL OR a.resolved_at >= ${new Date(from)})`,
    );
    return { items };
  });

  app.get('/api/v1/rules', viewer, async () => {
    const rows = await sql<RuleRow[]>`SELECT * FROM rules ORDER BY array_position(ARRAY['threshold','disk_fill','mem_leak','offline','log'], kind), id`;
    return { items: rows.map(toRuleInfo) };
  });

  app.patch<{ Params: { id: string } }>('/api/v1/rules/:id', { preHandler: requireRole(sql, 'admin') }, async (req) => {
    const body = RulePatch.safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    const [cur] = await sql<RuleRow[]>`SELECT * FROM rules WHERE id = ${req.params.id}`;
    if (!cur) throw notFound('规则不存在');

    const params = { ...cur.params };
    for (const [k, v] of Object.entries(body.data.params ?? {})) {
      if (!PARAM_KEYS[cur.kind].includes(k)) throw badRequest(`规则不支持参数 ${k}`);
      params[k] = v;
    }
    if (cur.kind === 'threshold' && params.recover! > params.threshold!) throw badRequest('恢复阈值不能高于触发阈值');
    if (cur.kind === 'threshold' && params.critical && params.critical < params.threshold!) throw badRequest('严重阈值不能低于触发阈值');

    const [row] = await sql<RuleRow[]>`
      UPDATE rules SET params = ${sql.json(params)},
        enabled = ${body.data.enabled ?? cur.enabled},
        severity = ${body.data.severity ?? cur.severity},
        scope = ${sql.json(body.data.scope ?? cur.scope)},
        updated_at = now()
      WHERE id = ${cur.id} RETURNING *`;
    await audit(sql, `user:${req.user!.id}`, 'rule.updated', cur.id, body.data);
    await engine.rulesChanged();
    return toRuleInfo(row!);
  });
}
