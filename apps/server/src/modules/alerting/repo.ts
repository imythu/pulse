import type { AlertInfo, IncidentEvent, IncidentEventType, IncidentSummary, RuleKind, Severity } from '@pulse/shared';
import type { Fragment, Sql } from '../../db/index.js';

export interface AlertRow {
  id: string;
  key: string;
  rule_id: string | null;
  host_id: string | null;
  log_group_id: string | null;
  tag: string;
  title: string;
  state: 'firing' | 'resolved';
  severity: Severity;
  escalated: boolean;
  reasons: string[];
  value: number | null;
  peak_value: number | null;
  threshold: number | null;
  count: string;
  started_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  recover_since: Date | null;
  flaps: Date[];
  flapping_until: Date | null;
  incident_id: string | null;
}

export interface IncidentRow {
  id: string;
  no: string;
  title: string;
  severity: Severity;
  status: 'open' | 'analyzing' | 'resolved';
  service: string | null;
  host_ids: string[];
  opened_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

type AlertJoined = AlertRow & { rule_name: string | null; rule_kind: RuleKind | null; hostname: string | null };
type IncidentJoined = IncidentRow & { hosts: { id: string; hostname: string }[]; alert_count: number; firing_count: number };

export const SEVERITY_RANK: Record<Severity, number> = { warning: 0, critical: 1 };

export function isFlapping(a: Pick<AlertRow, 'flapping_until'>, now = Date.now()): boolean {
  return !!a.flapping_until && a.flapping_until.getTime() > now;
}

export function toAlertInfo(a: AlertJoined): AlertInfo {
  return {
    id: a.id,
    ruleId: a.rule_id,
    ruleName: a.rule_name ?? '已删除的规则',
    kind: a.rule_kind ?? (a.log_group_id ? 'log' : 'threshold'),
    hostId: a.host_id,
    hostname: a.hostname,
    logGroupId: a.log_group_id,
    tag: a.tag,
    title: a.title,
    state: a.state,
    severity: a.severity,
    escalated: a.escalated,
    flapping: isFlapping(a),
    value: a.value,
    peakValue: a.peak_value,
    threshold: a.threshold,
    count: Number(a.count),
    reasons: a.reasons,
    startedAt: a.started_at.getTime(),
    lastSeenAt: a.last_seen_at.getTime(),
    resolvedAt: a.resolved_at?.getTime() ?? null,
    incidentId: a.incident_id,
  };
}

export function toIncidentSummary(i: IncidentJoined): IncidentSummary {
  return {
    id: i.id,
    no: Number(i.no),
    title: i.title,
    severity: i.severity,
    status: i.status === 'resolved' ? 'resolved' : 'open',
    service: i.service,
    hosts: i.hosts,
    alertCount: i.alert_count,
    firingCount: i.firing_count,
    openedAt: i.opened_at.getTime(),
    updatedAt: i.updated_at.getTime(),
    resolvedAt: i.resolved_at?.getTime() ?? null,
  };
}

const alertSelect = (sql: Sql) => sql`
  SELECT a.*, r.name AS rule_name, r.kind AS rule_kind, h.hostname
  FROM alerts a LEFT JOIN rules r ON r.id = a.rule_id LEFT JOIN hosts h ON h.id = a.host_id`;

export async function alertsWhere(sql: Sql, where: Fragment, limit = 500): Promise<AlertInfo[]> {
  const rows = await sql<AlertJoined[]>`${alertSelect(sql)} WHERE ${where} ORDER BY a.started_at DESC LIMIT ${limit}`;
  return rows.map(toAlertInfo);
}

const incidentSelect = (sql: Sql) => sql`
  SELECT i.*,
    (SELECT coalesce(json_agg(json_build_object('id', h.id, 'hostname', h.hostname) ORDER BY h.hostname), '[]'::json)
       FROM hosts h WHERE h.id = ANY(i.host_ids)) AS hosts,
    (SELECT count(*) FROM alerts a WHERE a.incident_id = i.id)::int AS alert_count,
    (SELECT count(*) FROM alerts a WHERE a.incident_id = i.id AND a.state = 'firing')::int AS firing_count
  FROM incidents i`;

export async function incidentsWhere(sql: Sql, where: Fragment, limit = 50): Promise<IncidentSummary[]> {
  const rows = await sql<IncidentJoined[]>`${incidentSelect(sql)} WHERE ${where} ORDER BY i.no DESC LIMIT ${limit}`;
  return rows.map(toIncidentSummary);
}

export async function getIncidentSummary(sql: Sql, id: string): Promise<IncidentSummary | undefined> {
  const [row] = await incidentsWhere(sql, sql`i.id = ${id}`, 1);
  return row;
}

export async function incidentEvents(sql: Sql, incidentId: string): Promise<IncidentEvent[]> {
  const rows = await sql<{ id: string; at: Date; type: IncidentEventType; alert_id: string | null; message: string }[]>`
    SELECT id, at, type, alert_id, message FROM incident_events WHERE incident_id = ${incidentId} ORDER BY id`;
  return rows.map((r) => ({ id: Number(r.id), at: r.at.getTime(), type: r.type, alertId: r.alert_id, message: r.message }));
}

export async function addIncidentEvent(
  sql: Sql,
  incidentId: string,
  type: IncidentEventType,
  message: string,
  opts: { alertId?: string | null; at?: Date; detail?: object } = {},
) {
  await sql`
    INSERT INTO incident_events (incident_id, at, type, alert_id, message, detail)
    VALUES (${incidentId}, ${opts.at ?? new Date()}, ${type}, ${opts.alertId ?? null}, ${message}, ${sql.json((opts.detail ?? {}) as never)})`;
}

export async function hostAlertCounts(sql: Sql, hostId: string) {
  const [row] = await sql<{ warning: number; critical: number }[]>`
    SELECT count(*) FILTER (WHERE severity = 'warning')::int AS warning,
           count(*) FILTER (WHERE severity = 'critical')::int AS critical
    FROM alerts WHERE host_id = ${hostId} AND state = 'firing'`;
  return row ?? { warning: 0, critical: 0 };
}
