// 控制台 REST API 与实时推送的数据结构（设计文档 9.3、9.4）。
import { z } from 'zod';
import type { HostInfo, ProcsPayload } from './protocol.js';

export type HostStatus = 'online' | 'offline';

/** 主机最近一个窗口的关键指标，用于列表和总览。 */
export interface HostSnapshot {
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  load1: number | null;
  at: number | null;
}

export interface HostSummary {
  id: string;
  hostname: string;
  os: string;
  platform: string;
  arch: string;
  ips: string[];
  labels: Record<string, string>;
  agentVersion: string;
  status: HostStatus;
  lastSeenAt: number | null;
  createdAt: number;
  snapshot: HostSnapshot;
}

export interface HostDetail extends HostSummary {
  info: HostInfo | null;
  procs: (ProcsPayload & { at: number }) | null;
}

export interface MetricSeries {
  name: string;
  tag: string;
  /** [时间戳毫秒, avg, max] */
  points: [number, number, number][];
}

export interface MetricsResponse {
  hostId: string;
  from: number;
  to: number;
  stepSeconds: number;
  series: MetricSeries[];
}

export interface OverviewStats {
  hostsTotal: number;
  hostsOnline: number;
  avgCpuPct: number | null;
  avgMemPct: number | null;
  openIncidents: number;
}

export interface EnrollTokenResponse {
  token: string;
  expiresAt: number;
  installCommand: string;
}

export interface Me {
  id: string;
  username: string;
  role: 'viewer' | 'operator' | 'admin';
}

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const SetupRequest = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(10).max(256),
});

export const MetricsQuery = z.object({
  names: z.string().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export const EnrollTokenRequest = z.object({
  ttlHours: z.number().int().min(1).max(24 * 7).default(24),
  labels: z.record(z.string(), z.string()).default({}),
});

// ---------- 实时推送 ----------

export type LiveChannel = 'overview' | `host:${string}`;

export type LiveEvent =
  | { channel: 'overview'; type: 'host.status'; host: HostSummary; at: number }
  | { channel: 'overview'; type: 'host.enrolled'; host: HostSummary; at: number }
  | { channel: 'overview'; type: 'host.snapshot'; hostId: string; snapshot: HostSnapshot }
  | { channel: `host:${string}`; type: 'metrics'; hostId: string; windowStart: number; series: MetricSeries[] }
  | { channel: `host:${string}`; type: 'procs'; hostId: string; procs: ProcsPayload & { at: number } };

export type LiveClientMessage =
  | { op: 'subscribe'; channels: LiveChannel[] }
  | { op: 'unsubscribe'; channels: LiveChannel[] };
