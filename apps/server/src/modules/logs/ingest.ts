// 日志接入（设计文档 4.1 服务器侧）：按指纹维护 LogGroup、每分钟计数和样本，并产生告警信号。
import type { LogsPayload } from '@pulse/shared';
import { fingerprint } from '@pulse/shared/fingerprint';
import type { Sql } from '../../db/index.js';
import type { HostCtx, LogSignal } from '../alerting/engine.js';

/** 同一指纹两条样本之间至少间隔多久，避免刷屏的报错把样本表写爆 */
const SAMPLE_INTERVAL_MS = 30_000;
const KEEP_SAMPLES = 20;

export async function ingestLogs(sql: Sql, host: HostCtx, payload: LogsPayload, now = Date.now()): Promise<LogSignal[]> {
  const signals: LogSignal[] = [];
  for (const e of payload.events) {
    // 以服务器算出的指纹为准；Agent 的指纹只用于它自己的窗口去重
    const fp = fingerprint(e.service, e.level, e.message);
    const first = new Date(e.firstTs);
    const last = new Date(e.lastTs);
    const [g] = await sql<{ id: string; status: string; inserted: boolean }[]>`
      INSERT INTO log_groups (service, fingerprint, level, template, first_seen, last_seen, total_count, host_ids)
      VALUES (${e.service}, ${fp.fingerprint}, ${e.level}, ${fp.template}, ${first}, ${last}, ${e.count}, ${[host.id]}::uuid[])
      ON CONFLICT (service, fingerprint) DO UPDATE SET
        last_seen = greatest(log_groups.last_seen, excluded.last_seen),
        total_count = log_groups.total_count + excluded.total_count,
        host_ids = CASE WHEN ${host.id}::uuid = ANY(log_groups.host_ids) THEN log_groups.host_ids
                        ELSE log_groups.host_ids || ${host.id}::uuid END
      RETURNING id, status, (xmax = 0) AS inserted`;
    if (!g) continue;

    await sql`
      INSERT INTO log_counts (time, log_group_id, host_id, count)
      VALUES (date_trunc('minute', ${last}::timestamptz), ${g.id}, ${host.id}, ${e.count})
      ON CONFLICT (log_group_id, host_id, time) DO UPDATE SET count = log_counts.count + excluded.count`;

    const [sampled] = await sql<{ id: string }[]>`
      UPDATE log_groups SET last_sample_at = ${new Date(now)}
      WHERE id = ${g.id} AND (last_sample_at IS NULL OR last_sample_at < ${new Date(now - SAMPLE_INTERVAL_MS)})
      RETURNING id`;
    if (sampled) {
      await sql`
        INSERT INTO log_samples (log_group_id, host_id, time, source, message, context)
        VALUES (${g.id}, ${host.id}, ${first}, ${e.source}, ${e.message}, ${e.context})`;
      // 保留首条和最近 20 条
      await sql`
        DELETE FROM log_samples s WHERE s.log_group_id = ${g.id}
          AND s.id <> (SELECT min(id) FROM log_samples WHERE log_group_id = ${g.id})
          AND s.id NOT IN (SELECT id FROM log_samples WHERE log_group_id = ${g.id} ORDER BY id DESC LIMIT ${KEEP_SAMPLES})`;
    }

    let kind: LogSignal['kind'] = g.inserted ? 'new' : 'occurrence';
    if (g.status === 'ignored') continue;
    if (g.status === 'resolved') {
      // 并发上报时只有一台主机能把它改回 active，复发信号只发一次
      const [reopened] = await sql`
        UPDATE log_groups SET status = 'active', status_by = 'system', status_at = ${new Date(now)}
        WHERE id = ${g.id} AND status = 'resolved' RETURNING id`;
      kind = reopened ? 'recur' : 'occurrence';
    }
    signals.push({ groupId: g.id, service: e.service, level: e.level, template: fp.template, host, kind, count: e.count, at: e.lastTs });
  }
  return signals;
}
