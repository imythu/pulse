import { Metric, type HostDetail, type HostInfo, type HostSnapshot, type HostSummary, type MetricPoint, type ProcsPayload } from '@pulse/shared';
import type { Sql } from '../../db/index.js';

export interface HostRow {
  id: string;
  hostname: string;
  info: HostInfo;
  labels: Record<string, string>;
  agent_version: string;
  status: 'online' | 'offline';
  last_seen_at: Date | null;
  last_seq: string;
  snapshot: Partial<HostSnapshot>;
  procs: (ProcsPayload & { at: number }) | null;
  created_at: Date;
}

const EMPTY_SNAPSHOT: HostSnapshot = { cpuPct: null, memPct: null, diskPct: null, load1: null, at: null };

export function toSummary(row: HostRow): HostSummary {
  return {
    id: row.id,
    hostname: row.hostname,
    os: row.info.os,
    platform: `${row.info.platform} ${row.info.platformVersion}`.trim(),
    arch: row.info.arch,
    ips: row.info.ips,
    labels: row.labels,
    agentVersion: row.agent_version,
    status: row.status,
    lastSeenAt: row.last_seen_at?.getTime() ?? null,
    createdAt: row.created_at.getTime(),
    snapshot: { ...EMPTY_SNAPSHOT, ...row.snapshot },
  };
}

export function toDetail(row: HostRow): HostDetail {
  return { ...toSummary(row), info: row.info, procs: row.procs };
}

/** 从一个窗口的指标里取出列表和总览要展示的关键值。磁盘取所有挂载点中最高的使用率。 */
export function snapshotFromPoints(points: MetricPoint[], at: number): HostSnapshot {
  const avgOf = (name: string) => points.find((p) => p.name === name)?.avg ?? null;
  const disks = points.filter((p) => p.name === Metric.diskUsed).map((p) => p.avg);
  return {
    cpuPct: avgOf(Metric.cpuUsage),
    memPct: avgOf(Metric.memUsed),
    diskPct: disks.length ? Math.max(...disks) : null,
    load1: avgOf(Metric.load1),
    at,
  };
}

export async function listHosts(sql: Sql): Promise<HostSummary[]> {
  const rows = await sql<HostRow[]>`SELECT * FROM hosts ORDER BY hostname`;
  return rows.map(toSummary);
}

export async function getHostRow(sql: Sql, id: string): Promise<HostRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await sql<HostRow[]>`SELECT * FROM hosts WHERE id = ${id}`;
  return row;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
