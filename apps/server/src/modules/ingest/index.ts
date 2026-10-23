import type { HostSnapshot, MetricSeries, MetricsPayload, ProcsPayload } from '@pulse/shared';
import type { Sql } from '../../db/index.js';
import { snapshotFromPoints } from '../hosts/repo.js';

/**
 * 写入一个窗口的指标。同一窗口可能先收到提前推送的部分数据，再收到完整数据，
 * 所以按 (host, name, tag, time) upsert，后到的覆盖先到的。
 */
export async function ingestMetrics(sql: Sql, hostId: string, payload: MetricsPayload): Promise<HostSnapshot> {
  const time = new Date(payload.windowStart);
  if (payload.points.length > 0) {
    const rows = payload.points.map((p) => ({
      time,
      host_id: hostId,
      name: p.name,
      tag: p.tag,
      min: p.min,
      max: p.max,
      avg: p.avg,
      p95: p.p95,
    }));
    await sql`
      INSERT INTO metrics ${sql(rows, 'time', 'host_id', 'name', 'tag', 'min', 'max', 'avg', 'p95')}
      ON CONFLICT (host_id, name, tag, time) DO UPDATE
      SET min = excluded.min, max = excluded.max, avg = excluded.avg, p95 = excluded.p95`;
  }
  const snapshot = snapshotFromPoints(payload.points, payload.windowStart);
  await sql`UPDATE hosts SET snapshot = ${sql.json(snapshot as never)} WHERE id = ${hostId}`;
  return snapshot;
}

export async function ingestProcs(sql: Sql, hostId: string, payload: ProcsPayload, at: number) {
  const procs = { ...payload, at };
  await sql`UPDATE hosts SET procs = ${sql.json(procs as never)} WHERE id = ${hostId}`;
  return procs;
}

/** 把一个窗口的指标转成前端增量追加用的序列。 */
export function toLiveSeries(payload: MetricsPayload): MetricSeries[] {
  return payload.points.map((p) => ({ name: p.name, tag: p.tag, points: [[payload.windowStart, p.avg, p.max]] }));
}
