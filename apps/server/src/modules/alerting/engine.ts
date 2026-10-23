// 告警引擎（设计文档 4.2–4.4、5.3）：指标、离线、日志三类信号都在这里推进 Alert 状态机，
// 进入 firing 时合并到 Incident 并发送通知。所有状态变化经过同一个串行队列，避免竞态。
import { METRIC_META, type IncidentEventType, type MetricName, type MetricsPayload, type Severity } from '@pulse/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../../db/index.js';
import type { LiveBus } from '../../lib/live.js';
import { Serial } from '../../lib/serial.js';
import type { Notifier, NotifyKind } from '../notify/index.js';
import {
  evaluate,
  FLAP_MUTE_MS,
  MERGE_WINDOW_MS,
  recordFlap,
  REOPEN_WINDOW_MS,
  type ThresholdParams,
  type Track,
} from './machine.js';
import {
  addIncidentEvent,
  alertsWhere,
  getIncidentSummary,
  hostAlertCounts,
  isFlapping,
  SEVERITY_RANK,
  type AlertRow,
  type IncidentRow,
} from './repo.js';
import { diskFillParams, inScope, loadRules, logParams, memLeakParams, thresholdParams, type RuleRow } from './rules.js';

export interface HostCtx {
  id: string;
  hostname: string;
  labels: Record<string, string>;
}

export interface LogSignal {
  groupId: string;
  service: string;
  level: 'error' | 'fatal';
  template: string;
  host: HostCtx;
  /** new：从未见过的指纹；recur：标记为已解决后又出现；occurrence：其余情况，只累加次数 */
  kind: 'new' | 'recur' | 'occurrence';
  count: number;
  at: number;
}

interface FireInput {
  key: string;
  rule: RuleRow;
  hostId: string | null;
  logGroupId: string | null;
  service: string | null;
  tag: string;
  title: string;
  severity: Severity;
  value: number | null;
  threshold: number | null;
  reasons: string[];
  count: number;
}

export interface EngineOptions {
  clock?: () => number;
  tickMs?: number;
}

/** 回放的历史数据（如 Agent 离线很久后补传）不参与告警判断。 */
const STALE_MS = 10 * 60_000;
const SPIKE_CHECK_MS = 30_000;
const TREND_CHECK_MS = 5 * 60_000;
const BASELINE_MIN_MS = 3600_000;

function firstLine(s: string, max = 120): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function fmtValue(metric: string | null, v: number): string {
  const unit = METRIC_META[metric as MetricName]?.unit;
  return unit === 'pct' ? `${v.toFixed(1)}%` : Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export class AlertEngine {
  private readonly serial = new Serial();
  private readonly clock: () => number;
  private rules: RuleRow[] = [];
  /** 当前 firing 的告警，键为 alert.key */
  private readonly active = new Map<string, AlertRow>();
  /** pending 只在内存中（回落即丢弃，不留记录）；seen 用于清理不再上报的键 */
  private readonly pending = new Map<string, { since: number; seen: number }>();
  private timer?: NodeJS.Timeout;
  private lastSpikeCheck = 0;
  private lastTrendCheck = 0;

  constructor(
    private readonly sql: Sql,
    private readonly live: LiveBus,
    private readonly notifier: Notifier,
    private readonly log: FastifyBaseLogger,
    private readonly opts: EngineOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  async start() {
    await this.reload();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 10_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** 等待已排队的处理和通知全部完成。 */
  async idle() {
    await this.serial.idle();
    await this.notifier.idle();
  }

  reload(): Promise<void> {
    return this.serial.run(async () => {
      this.rules = await loadRules(this.sql);
      this.active.clear();
      for (const a of await this.sql<AlertRow[]>`SELECT * FROM alerts WHERE state = 'firing'`) this.active.set(a.key, a);
    });
  }

  private rule(kind: RuleRow['kind']): RuleRow[] {
    return this.rules.filter((r) => r.kind === kind && r.enabled);
  }

  // ---------- 信号入口 ----------

  onMetrics(host: HostCtx, payload: MetricsPayload): Promise<void> {
    return this.serial.run(async () => {
      const now = this.clock();
      if (payload.windowStart + payload.windowSeconds * 1000 < now - STALE_MS) return;
      for (const rule of this.rule('threshold')) {
        if (!inScope(rule, host.labels)) continue;
        const params = thresholdParams(rule);
        for (const p of payload.points) {
          if (p.name !== rule.metric) continue;
          await this.observe(`${rule.id}:${host.id}:${p.tag}`, rule, params, p.avg, now, host, p.tag);
        }
      }
    });
  }

  onHostStatus(host: HostCtx, status: 'online' | 'offline'): Promise<void> {
    return this.serial.run(async () => {
      const now = this.clock();
      for (const rule of this.rule('offline')) {
        const key = `${rule.id}:${host.id}`;
        const act = this.active.get(key);
        if (status === 'online' && act) await this.resolve(act, now, `${host.hostname} 重新上线`);
        if (status === 'offline' && !act && inScope(rule, host.labels)) {
          await this.fire(
            { key, rule, hostId: host.id, logGroupId: null, service: null, tag: '', title: `${host.hostname} ${rule.name}`, severity: rule.severity, value: null, threshold: null, reasons: ['offline'], count: 1 },
            now,
          );
        }
      }
    });
  }

  onLogSignals(signals: LogSignal[]): Promise<void> {
    if (!signals.length) return Promise.resolve();
    return this.serial.run(async () => {
      const rule = this.rule('log')[0];
      if (!rule) return;
      for (const s of signals) {
        const key = `log:${s.groupId}`;
        const act = this.active.get(key);
        if (act) {
          const [row] = await this.sql<AlertRow[]>`
            UPDATE alerts SET count = count + ${s.count}, last_seen_at = greatest(last_seen_at, ${new Date(s.at)})
            WHERE id = ${act.id} RETURNING *`;
          if (row) this.active.set(key, row);
          continue;
        }
        if (s.kind === 'occurrence' || !inScope(rule, s.host.labels)) continue;
        await this.fire(
          {
            key,
            rule,
            hostId: s.host.id,
            logGroupId: s.groupId,
            service: s.service,
            tag: '',
            title: `${s.service}：${firstLine(s.template)}`,
            severity: s.level === 'fatal' ? 'critical' : rule.severity,
            value: null,
            threshold: null,
            reasons: [s.kind],
            count: s.count,
          },
          this.clock(),
        );
      }
    });
  }

  /** 日志指纹被标记为忽略或已解决时，结束它当前的告警。 */
  closeLogGroup(groupId: string, message: string): Promise<void> {
    return this.serial.run(async () => {
      const act = this.active.get(`log:${groupId}`);
      if (act) await this.resolve(act, this.clock(), message);
    });
  }

  /** 规则修改后重新加载；停用的规则、不再匹配范围的主机，对应的告警直接恢复。 */
  rulesChanged(): Promise<void> {
    return this.serial.run(async () => {
      this.rules = await loadRules(this.sql);
      this.pending.clear();
      const labels = new Map(
        (await this.sql<{ id: string; labels: Record<string, string> }[]>`SELECT id, labels FROM hosts`).map((h) => [h.id, h.labels]),
      );
      const now = this.clock();
      for (const act of [...this.active.values()]) {
        const rule = this.rules.find((r) => r.id === act.rule_id);
        if (!rule?.enabled) await this.resolve(act, now, '规则已停用');
        else if (act.host_id && !act.log_group_id && !inScope(rule, labels.get(act.host_id) ?? {})) await this.resolve(act, now, '主机不在规则范围内');
      }
    });
  }

  /** 主机被删除：告警随主机级联删除，只剩已删除主机告警的 Incident 直接关闭。 */
  forgetHost(hostId: string): Promise<void> {
    return this.serial.run(async () => {
      for (const [key, a] of this.active) if (a.host_id === hostId) this.active.delete(key);
      for (const key of this.pending.keys()) if (key.includes(hostId)) this.pending.delete(key);
      const now = new Date(this.clock());
      const closed = await this.sql<{ id: string }[]>`
        UPDATE incidents i SET status = 'resolved', resolved_at = ${now}, updated_at = ${now}
        WHERE ${hostId} = ANY(i.host_ids) AND i.status <> 'resolved'
          AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND a.state = 'firing')
        RETURNING id`;
      for (const { id } of closed) {
        await addIncidentEvent(this.sql, id, 'resolved', '主机已删除，Incident 关闭', { at: now });
        await this.publishIncident(id, 'resolved', []);
      }
    });
  }

  // ---------- 定时任务 ----------

  tick(): Promise<void> {
    return this.serial
      .run(async () => {
        const now = this.clock();
        await this.resolveQuietLogs(now);
        if (now - this.lastSpikeCheck >= SPIKE_CHECK_MS) {
          this.lastSpikeCheck = now;
          await this.checkSpikeAndSpread(now);
        }
        if (now - this.lastTrendCheck >= TREND_CHECK_MS) {
          this.lastTrendCheck = now;
          await this.checkTrends(now);
        }
        for (const [key, p] of this.pending) if (now - p.seen > STALE_MS) this.pending.delete(key);
      })
      .catch((err) => this.log.error({ err }, '告警定时任务失败'));
  }

  private async resolveQuietLogs(now: number) {
    const quietMs = logParams(this.rule('log')[0]).quietMinutes * 60_000;
    for (const act of [...this.active.values()]) {
      if (act.log_group_id && now - act.last_seen_at.getTime() >= quietMs) {
        await this.resolve(act, now, `${quietMs / 60_000} 分钟内没有再出现`);
      }
    }
  }

  /** 突增：最近 5 分钟次数超过基线的 spikeFactor 倍且不少于 spikeMin；扩散：spreadMinutes 内影响 spreadHosts 台主机。 */
  private async checkSpikeAndSpread(now: number) {
    const rule = this.rule('log')[0];
    if (!rule) return;
    const p = logParams(rule);
    const t5 = new Date(now - 5 * 60_000);
    const tSpread = new Date(now - p.spreadMinutes * 60_000);
    const t24 = new Date(now - 24 * 3600_000);
    const rows = await this.sql<
      { id: string; service: string; level: 'error' | 'fatal'; template: string; first_seen: Date; host_ids: string[]; recent: number; base: number; hosts: number }[]
    >`
      SELECT g.id, g.service, g.level, g.template, g.first_seen, g.host_ids,
        coalesce(sum(c.count) FILTER (WHERE c.time >= ${t5}), 0)::float8 AS recent,
        coalesce(sum(c.count) FILTER (WHERE c.time < ${t5}), 0)::float8 AS base,
        count(DISTINCT c.host_id) FILTER (WHERE c.time >= ${tSpread})::int AS hosts
      FROM log_groups g JOIN log_counts c ON c.log_group_id = g.id AND c.time >= ${t24}
      WHERE g.status = 'active' AND g.last_seen >= ${new Date(now - 2 * 60_000)}
      GROUP BY g.id`;

    for (const g of rows) {
      const baselineMs = Math.min(24 * 3600_000, now - g.first_seen.getTime()) - 5 * 60_000;
      const baseRate = baselineMs > 0 ? g.base / (baselineMs / (5 * 60_000)) : 0;
      const spike = baselineMs >= BASELINE_MIN_MS && g.recent >= p.spikeMin && g.recent > p.spikeFactor * baseRate;
      const spread = g.hosts >= p.spreadHosts;
      const reasons: [string, string][] = [];
      if (spike) reasons.push(['spike', `5 分钟内出现 ${g.recent} 次，是基线的 ${baseRate > 0 ? (g.recent / baseRate).toFixed(0) : '∞'} 倍`]);
      if (spread) reasons.push(['spread', `${p.spreadMinutes} 分钟内影响 ${g.hosts} 台主机`]);

      for (const [reason, message] of reasons) {
        const key = `log:${g.id}`;
        const act = this.active.get(key);
        if (act) {
          if (!act.reasons.includes(reason)) await this.escalate(act, now, reason, message);
          continue;
        }
        const hostId = g.host_ids[g.host_ids.length - 1] ?? null;
        await this.fire(
          {
            key,
            rule,
            hostId,
            logGroupId: g.id,
            service: g.service,
            tag: '',
            title: `${g.service}：${firstLine(g.template)}`,
            severity: 'critical',
            value: g.recent,
            threshold: null,
            reasons: [reason],
            count: 0,
          },
          now,
        );
      }
    }
  }

  /** 趋势类规则：磁盘写满预测、内存泄漏（设计文档 4.2）。 */
  private async checkTrends(now: number) {
    const hosts = new Map(
      (await this.sql<HostCtx[]>`SELECT id, hostname, labels FROM hosts WHERE status = 'online'`).map((h) => [h.id, h]),
    );
    if (!hosts.size) return;

    for (const rule of this.rule('disk_fill')) {
      const p = diskFillParams(rule);
      const rows = await this.sql<{ host_id: string; tag: string; slope: number | null; last: number }[]>`
        SELECT host_id, tag, regr_slope(avg, extract(epoch FROM time)) AS slope,
               (array_agg(avg ORDER BY time DESC))[1] AS last
        FROM metrics
        WHERE name = ${rule.metric ?? 'disk.used_pct'} AND time >= ${new Date(now - p.windowHours * 3600_000)}
        GROUP BY host_id, tag HAVING count(*) >= ${Math.ceil(p.windowHours * 30)}`;
      for (const r of rows) {
        const host = hosts.get(r.host_id);
        if (!host || !inScope(rule, host.labels)) continue;
        const hours = r.slope && r.slope > 0 ? (100 - r.last) / r.slope / 3600 : 99_999;
        await this.observe(`${rule.id}:${host.id}:${r.tag}`, rule, p, Math.min(Math.round(hours * 10) / 10, 99_999), now, host, r.tag);
      }
    }

    for (const rule of this.rule('mem_leak')) {
      const p = memLeakParams(rule);
      const rows = await this.sql<{ host_id: string; slope: number | null; r: number | null }[]>`
        SELECT host_id, regr_slope(avg, extract(epoch FROM time)) AS slope, corr(avg, extract(epoch FROM time)) AS r
        FROM metrics
        WHERE name = ${rule.metric ?? 'mem.used_pct'} AND tag = '' AND time >= ${new Date(now - p.windowHours * 3600_000)}
        GROUP BY host_id HAVING count(*) >= ${Math.ceil(p.windowHours * 48)}`;
      for (const r of rows) {
        const host = hosts.get(r.host_id);
        if (!host || !inScope(rule, host.labels)) continue;
        const rise = r.slope && r.slope > 0 && (r.r ?? 0) >= p.minCorr ? r.slope * p.windowHours * 3600 : 0;
        await this.observe(`${rule.id}:${host.id}`, rule, p, Math.round(rise * 10) / 10, now, host, '');
      }
    }
  }

  // ---------- 状态机 ----------

  private async observe(key: string, rule: RuleRow, params: ThresholdParams, value: number, now: number, host: HostCtx, tag: string) {
    const act = this.active.get(key);
    const track: Track = {
      pendingSince: this.pending.get(key)?.since ?? null,
      firing: act ? { severity: act.severity, recoverSince: act.recover_since?.getTime() ?? null, peak: act.peak_value ?? value } : null,
    };
    const { track: next, transition } = evaluate(track, value, now, params, rule.severity);
    if (next.pendingSince != null) this.pending.set(key, { since: next.pendingSince, seen: now });
    else this.pending.delete(key);

    switch (transition) {
      case 'fire':
        await this.fire(
          {
            key,
            rule,
            hostId: host.id,
            logGroupId: null,
            service: null,
            tag,
            title: `${host.hostname} ${rule.name}${tag ? ` ${tag}` : ''}`,
            severity: next.firing!.severity,
            value,
            threshold: params.threshold,
            reasons: next.firing!.severity === 'critical' && rule.severity !== 'critical' ? ['critical'] : [],
            count: 1,
          },
          now,
        );
        break;
      case 'update': {
        const [row] = await this.sql<AlertRow[]>`
          UPDATE alerts SET value = ${value}, peak_value = ${next.firing!.peak}, count = count + 1, last_seen_at = ${new Date(now)},
            recover_since = ${next.firing!.recoverSince == null ? null : new Date(next.firing!.recoverSince)}
          WHERE id = ${act!.id} RETURNING *`;
        if (row) this.active.set(key, row);
        break;
      }
      case 'escalate':
        await this.escalate(act!, now, 'critical', `达到严重阈值 ${fmtValue(rule.metric, params.critical ?? value)}，当前 ${fmtValue(rule.metric, value)}`, {
          value,
          peak: next.firing!.peak,
        });
        break;
      case 'resolve':
        await this.resolve(act!, now, `已恢复，当前 ${fmtValue(rule.metric, value)}`);
        break;
    }
  }

  /** 触发告警：30 分钟内恢复过的同一个键重开原告警并记一次抖动，否则新建并合并到 Incident。 */
  private async fire(input: FireInput, now: number) {
    const at = new Date(now);
    const [prev] = await this.sql<AlertRow[]>`
      SELECT * FROM alerts WHERE key = ${input.key} AND state = 'resolved' AND resolved_at >= ${new Date(now - REOPEN_WINDOW_MS)}
      ORDER BY resolved_at DESC LIMIT 1`;

    if (prev) {
      const wasFlapping = isFlapping(prev, now);
      const { flaps, flapping } = recordFlap(prev.flaps.map((d) => d.getTime()), now);
      const flappingUntil = flapping ? new Date(now + FLAP_MUTE_MS) : prev.flapping_until;
      const reasons = [...new Set([...prev.reasons, ...input.reasons])];
      const [row] = await this.sql<AlertRow[]>`
        UPDATE alerts SET state = 'firing', resolved_at = NULL, recover_since = NULL, severity = ${input.severity},
          escalated = ${input.severity === 'critical' && input.rule.severity !== 'critical'}, reasons = ${reasons},
          value = ${input.value}, peak_value = ${input.value}, count = count + ${input.count}, last_seen_at = ${at},
          flaps = ${flaps.map((t) => new Date(t).toISOString())}::timestamptz[], flapping_until = ${flappingUntil}
        WHERE id = ${prev.id} RETURNING *`;
      this.active.set(input.key, row!);

      const [inc] = prev.incident_id ? await this.sql<IncidentRow[]>`SELECT * FROM incidents WHERE id = ${prev.incident_id}` : [];
      if (!inc) return this.attach(row!, input.service, now);

      const reopened = inc.status === 'resolved';
      const severity = SEVERITY_RANK[input.severity] > SEVERITY_RANK[inc.severity] ? input.severity : inc.severity;
      await this.sql`
        UPDATE incidents SET status = 'open', resolved_at = NULL, updated_at = ${at}, severity = ${severity}
        WHERE id = ${inc.id}`;
      if (reopened) await addIncidentEvent(this.sql, inc.id, 'reopened', `${input.title} 再次触发，Incident 重新打开`, { alertId: row!.id, at });
      await addIncidentEvent(this.sql, inc.id, 'alert_reopened', `${input.title} 在恢复后 30 分钟内再次触发（1 小时内第 ${flaps.length} 次）`, {
        alertId: row!.id,
        at,
      });
      if (flapping && !wasFlapping) {
        await addIncidentEvent(this.sql, inc.id, 'flapping', `${input.title} 1 小时内反复触发 ${flaps.length} 次，暂停通知 1 小时；阈值可能不合理`, {
          alertId: row!.id,
          at,
        });
      }
      const notify: NotifyKind | null = flapping ? null : reopened ? 'reopened' : severity !== inc.severity ? 'escalated' : null;
      await this.publishIncident(inc.id, reopened ? 'reopened' : 'alert_reopened', row!.host_id ? [row!.host_id] : [], notify);
      return;
    }

    const [row] = await this.sql<AlertRow[]>`
      INSERT INTO alerts (key, rule_id, host_id, log_group_id, tag, title, state, severity, escalated, reasons,
                          value, peak_value, threshold, count, started_at, last_seen_at)
      VALUES (${input.key}, ${input.rule.id}, ${input.hostId}, ${input.logGroupId}, ${input.tag}, ${input.title}, 'firing',
              ${input.severity}, ${input.severity === 'critical' && input.rule.severity !== 'critical'}, ${input.reasons},
              ${input.value}, ${input.value}, ${input.threshold}, ${input.count}, ${at}, ${at})
      RETURNING *`;
    this.active.set(input.key, row!);
    await this.attach(row!, input.service, now);
  }

  /** 合并到同一主机或同一服务最近 5 分钟内有变化的未恢复 Incident，否则新建（设计文档 4.4）。 */
  private async attach(alert: AlertRow, service: string | null, now: number) {
    const at = new Date(now);
    const [inc] = await this.sql<IncidentRow[]>`
      SELECT * FROM incidents
      WHERE status <> 'resolved' AND updated_at >= ${new Date(now - MERGE_WINDOW_MS)}
        AND ((${alert.host_id}::uuid IS NOT NULL AND ${alert.host_id}::uuid = ANY(host_ids))
          OR (${service}::text IS NOT NULL AND service = ${service}::text))
      ORDER BY opened_at DESC LIMIT 1`;
    const muted = isFlapping(alert, now);

    if (inc) {
      const hostIds = alert.host_id && !inc.host_ids.includes(alert.host_id) ? [...inc.host_ids, alert.host_id] : inc.host_ids;
      const severity = SEVERITY_RANK[alert.severity] > SEVERITY_RANK[inc.severity] ? alert.severity : inc.severity;
      await this.sql`
        UPDATE incidents SET host_ids = ${hostIds}::uuid[], severity = ${severity}, updated_at = ${at}, service = coalesce(service, ${service})
        WHERE id = ${inc.id}`;
      await this.sql`UPDATE alerts SET incident_id = ${inc.id} WHERE id = ${alert.id}`;
      this.active.set(alert.key, { ...alert, incident_id: inc.id });
      await addIncidentEvent(this.sql, inc.id, 'alert_joined', `${alert.title} 加入`, { alertId: alert.id, at });
      await this.publishIncident(inc.id, 'alert_joined', alert.host_id ? [alert.host_id] : [], severity !== inc.severity && !muted ? 'escalated' : null);
      return;
    }

    const [created] = await this.sql<{ id: string }[]>`
      INSERT INTO incidents (title, severity, service, host_ids, opened_at, updated_at)
      VALUES (${alert.title}, ${alert.severity}, ${service}, ${alert.host_id ? [alert.host_id] : []}::uuid[], ${at}, ${at})
      RETURNING id`;
    await this.sql`UPDATE alerts SET incident_id = ${created!.id} WHERE id = ${alert.id}`;
    this.active.set(alert.key, { ...alert, incident_id: created!.id });
    await addIncidentEvent(this.sql, created!.id, 'opened', `${alert.title} 触发，新建 Incident`, { alertId: alert.id, at });
    await this.publishIncident(created!.id, 'opened', alert.host_id ? [alert.host_id] : [], muted ? null : 'opened');
  }

  private async escalate(act: AlertRow, now: number, reason: string, message: string, v?: { value: number; peak: number }) {
    const at = new Date(now);
    const reasons = act.reasons.includes(reason) ? act.reasons : [...act.reasons, reason];
    const [row] = await this.sql<AlertRow[]>`
      UPDATE alerts SET severity = 'critical', escalated = true, reasons = ${reasons}, last_seen_at = ${at},
        value = ${v?.value ?? act.value}, peak_value = ${v?.peak ?? act.peak_value}, recover_since = NULL
      WHERE id = ${act.id} RETURNING *`;
    this.active.set(act.key, row!);
    if (!act.incident_id) return;
    const [inc] = await this.sql<IncidentRow[]>`SELECT * FROM incidents WHERE id = ${act.incident_id}`;
    if (!inc) return;
    await this.sql`UPDATE incidents SET severity = 'critical', updated_at = ${at} WHERE id = ${inc.id}`;
    await addIncidentEvent(this.sql, inc.id, 'alert_escalated', `${act.title} 升级：${message}`, { alertId: act.id, at });
    const notify = inc.severity !== 'critical' && !isFlapping(row!, now) ? 'escalated' : null;
    await this.publishIncident(inc.id, 'alert_escalated', act.host_id ? [act.host_id] : [], notify);
  }

  private async resolve(act: AlertRow, now: number, message: string) {
    const at = new Date(now);
    await this.sql`UPDATE alerts SET state = 'resolved', resolved_at = ${at}, recover_since = NULL WHERE id = ${act.id}`;
    this.active.delete(act.key);
    if (!act.incident_id) return;
    await addIncidentEvent(this.sql, act.incident_id, 'alert_resolved', `${act.title} ${message}`, { alertId: act.id, at });
    const [closed] = await this.sql<{ id: string }[]>`
      UPDATE incidents i SET status = 'resolved', resolved_at = ${at}
      WHERE id = ${act.incident_id} AND status <> 'resolved'
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND a.state = 'firing')
      RETURNING id`;
    if (closed) await addIncidentEvent(this.sql, closed.id, 'resolved', '所有告警均已恢复', { at });
    const notify = closed && !isFlapping(act, now) ? 'resolved' : null;
    await this.publishIncident(act.incident_id, closed ? 'resolved' : 'alert_resolved', act.host_id ? [act.host_id] : [], notify);
  }

  private async publishIncident(id: string, change: IncidentEventType, hostIds: string[], notify: NotifyKind | null = null) {
    const incident = await getIncidentSummary(this.sql, id);
    if (!incident) return;
    this.live.publish({ channel: 'overview', type: 'incident.changed', incident, change, at: this.clock() });
    for (const hostId of hostIds) {
      this.live.publish({ channel: 'overview', type: 'host.alerts', hostId, alerts: await hostAlertCounts(this.sql, hostId) });
    }
    if (notify) {
      const alerts = await alertsWhere(this.sql, this.sql`a.incident_id = ${id}`, 20);
      this.notifier.dispatch({ kind: notify, incident, alerts });
    }
  }
}
