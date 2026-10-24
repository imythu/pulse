// 控制台 REST API 与实时推送的数据结构（设计文档 9.3、9.4）。
import { z } from 'zod';
import type { CommandRisk, CommandStatus, CommandTemplate } from './commands.js';
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
  /** 当前 firing 的告警数 */
  alerts: HostAlertCounts;
}

export interface HostAlertCounts {
  warning: number;
  critical: number;
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
  /** 等待审批的写操作指令数 */
  pendingApprovals: number;
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

// ---------- 告警与事件（设计文档 4） ----------

export type Severity = 'warning' | 'critical';
export type RuleKind = 'threshold' | 'disk_fill' | 'mem_leak' | 'offline' | 'log';

export interface HostRef {
  id: string;
  hostname: string;
}

export interface AlertInfo {
  id: string;
  ruleId: string | null;
  ruleName: string;
  kind: RuleKind;
  hostId: string | null;
  hostname: string | null;
  logGroupId: string | null;
  /** 磁盘挂载点等对象 */
  tag: string;
  title: string;
  state: 'firing' | 'resolved';
  severity: Severity;
  escalated: boolean;
  /** 1 小时内反复触发 3 次以上，暂停通知 */
  flapping: boolean;
  value: number | null;
  peakValue: number | null;
  threshold: number | null;
  /** 日志告警为出现次数，指标告警为评估次数 */
  count: number;
  /** 触发与升级原因，如 new、recur、spike、spread */
  reasons: string[];
  startedAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  incidentId: string | null;
}

export interface IncidentSummary {
  id: string;
  /** 便于口头沟通的递增编号 */
  no: number;
  title: string;
  severity: Severity;
  status: 'open' | 'resolved';
  service: string | null;
  hosts: HostRef[];
  alertCount: number;
  firingCount: number;
  openedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export type IncidentEventType =
  | 'opened'
  | 'alert_joined'
  | 'alert_escalated'
  | 'alert_resolved'
  | 'alert_reopened'
  | 'flapping'
  | 'resolved'
  | 'reopened'
  | 'notified'
  | 'notify_failed';

export interface IncidentEvent {
  id: number;
  at: number;
  type: IncidentEventType;
  alertId: string | null;
  message: string;
}

export interface IncidentDetail extends IncidentSummary {
  alerts: AlertInfo[];
  events: IncidentEvent[];
  logGroups: LogGroupSummary[];
}

export const IncidentListQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  hostId: z.string().uuid().optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export type LogGroupStatus = 'active' | 'ignored' | 'resolved';

export interface LogGroupSummary {
  id: string;
  service: string;
  fingerprint: string;
  level: 'error' | 'fatal';
  template: string;
  firstSeen: number;
  lastSeen: number;
  totalCount: number;
  hostCount: number;
  status: LogGroupStatus;
  resolvedCommit: string | null;
  /** 最近 24 小时的次数 */
  count24h: number;
  /** 最近 24 小时每小时的次数，最早的在前 */
  hourly: number[];
}

export interface LogSample {
  id: number;
  hostId: string | null;
  hostname: string | null;
  time: number;
  source: string;
  message: string;
  context: string[];
}

export interface LogGroupDetail extends LogGroupSummary {
  hosts: HostRef[];
  samples: LogSample[];
  /** 最近 24 小时每 10 分钟的次数：[时间戳毫秒, 次数] */
  series: [number, number][];
  activeAlertId: string | null;
}

export const LogGroupListQuery = z.object({
  status: z.enum(['active', 'ignored', 'resolved', 'all']).default('active'),
  service: z.string().max(128).optional(),
  hostId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const LogGroupPatch = z.object({
  status: z.enum(['active', 'ignored', 'resolved']),
  /** 标记已解决时可关联修复的提交 */
  resolvedCommit: z.string().trim().max(64).optional(),
});

export interface RuleInfo {
  id: string;
  name: string;
  description: string;
  kind: RuleKind;
  metric: string | null;
  params: Record<string, number>;
  severity: Severity;
  scope: { labels: Record<string, string> };
  enabled: boolean;
  updatedAt: number;
}

export const RulePatch = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(['warning', 'critical']).optional(),
  params: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  scope: z.object({ labels: z.record(z.string().min(1), z.string()) }).optional(),
});

export type ChannelKind = 'webhook' | 'feishu' | 'wecom' | 'dingtalk' | 'slack';

export interface NotificationChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** 只显示协议和主机名，完整地址含令牌，不回传 */
  urlHint: string;
  hasSecret: boolean;
  minSeverity: Severity;
  enabled: boolean;
  createdAt: number;
}

export const ChannelInput = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(['webhook', 'feishu', 'wecom', 'dingtalk', 'slack']),
  /** 编辑时留空表示不修改 */
  url: z.string().url().max(2048).optional(),
  secret: z.string().max(256).optional(),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  enabled: z.boolean().default(true),
});

// ---------- 指令（设计文档 3.5、10.2） ----------

export interface CommandInfo {
  id: string;
  no: number;
  hostId: string;
  hostname: string | null;
  template: string;
  args: Record<string, string>;
  risk: CommandRisk;
  reason: string;
  requestedBy: string;
  /** 发起人显示名：用户名或“AI 分析” */
  requestedByName: string;
  approvalStatus: 'none' | 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
  approvedByName: string | null;
  selfApproved: boolean;
  rejectReason: string | null;
  status: CommandStatus;
  exitCode: number | null;
  /** 列表接口不带输出，详情接口才有 */
  output?: string;
  truncated: boolean;
  error: string;
  durationMs: number | null;
  incidentId: string | null;
  analysisId: string | null;
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const CreateCommandRequest = z.object({
  hostId: z.string().uuid(),
  template: z.string().min(1).max(128),
  args: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  reason: z.string().trim().max(500).default(''),
  incidentId: z.string().uuid().optional(),
});

export const CommandListQuery = z.object({
  hostId: z.string().uuid().optional(),
  status: z.enum(['pending_approval', 'active', 'all']).default('all'),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const RejectCommandRequest = z.object({ reason: z.string().trim().max(500).default('') });

export interface HostCommandTemplates {
  builtin: CommandTemplate[];
  /** Agent 本地配置的 custom.* 模板 */
  custom: CommandTemplate[];
}

// ---------- GitHub 仓库与服务（设计文档 7） ----------

export interface GhStep {
  /** 实际执行的命令，原样展示给用户 */
  command: string;
  ok: boolean;
  output: string;
}

export interface GhStatus {
  installed: boolean;
  version: string | null;
  /** 按服务器系统给出的安装命令 */
  installHints: { label: string; command: string }[];
  loggedIn: boolean;
  account: string | null;
  /** 凭据来源：keyring / GH_TOKEN 环境变量 等 */
  tokenSource: string | null;
  scopes: string | null;
  gitConfigured: boolean;
  /** 未通过时的具体原因：未安装 / 未登录 / 网络不通 等 */
  problem: string | null;
  steps: GhStep[];
  checkedAt: number;
}

export interface AvailableRepo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string;
  pushedAt: number | null;
  /** KB */
  diskUsage: number | null;
  bound: boolean;
}

export interface RepoInfo {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  status: 'cloning' | 'ready' | 'error';
  lastError: string | null;
  headCommit: string | null;
  sizeBytes: number | null;
  /** 超过 2 GB 时提示配置 sparse-checkout */
  large: boolean;
  lastSyncedAt: number | null;
  services: string[];
  createdAt: number;
}

export const AddRepoRequest = z.object({ fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) });

export interface CommitInfo {
  sha: string;
  author: string;
  time: number;
  subject: string;
}

export interface ServiceHostVersion {
  hostId: string;
  hostname: string;
  commit: string;
  source: string;
  updatedAt: number;
}

export interface ServiceInfo {
  name: string;
  hostCount: number;
  binding: { repoId: string; fullName: string; subdir: string } | null;
  versions: ServiceHostVersion[];
  lastDeployAt: number | null;
}

export const ServiceBindingRequest = z.object({
  repoId: z.string().uuid(),
  subdir: z
    .string()
    .trim()
    .max(512)
    .regex(/^[^\0]*$/)
    .refine((s) => !s.split('/').includes('..'), '子目录不能包含 ..')
    .default(''),
});

export interface DeployInfo {
  id: number;
  service: string;
  hostId: string | null;
  hostname: string | null;
  commit: string;
  previousCommit: string | null;
  source: string;
  detectedAt: number;
}

// ---------- 实时推送 ----------

export type LiveChannel = 'overview' | `host:${string}` | `command:${string}`;

export type LiveEvent =
  | { channel: 'overview'; type: 'host.status'; host: HostSummary; at: number }
  | { channel: 'overview'; type: 'host.enrolled'; host: HostSummary; at: number }
  | { channel: 'overview'; type: 'host.snapshot'; hostId: string; snapshot: HostSnapshot }
  | { channel: 'overview'; type: 'host.alerts'; hostId: string; alerts: HostAlertCounts }
  | { channel: 'overview'; type: 'incident.changed'; incident: IncidentSummary; change: IncidentEventType; at: number }
  | { channel: `host:${string}`; type: 'metrics'; hostId: string; windowStart: number; series: MetricSeries[] }
  | { channel: `host:${string}`; type: 'procs'; hostId: string; procs: ProcsPayload & { at: number } }
  | { channel: 'overview'; type: 'command.changed'; command: CommandInfo; pendingApprovals: number }
  | { channel: `host:${string}`; type: 'command.changed'; command: CommandInfo }
  | { channel: `command:${string}`; type: 'command.changed'; command: CommandInfo }
  | { channel: `command:${string}`; type: 'command.output'; id: string; data: string };

export type LiveClientMessage =
  | { op: 'subscribe'; channels: LiveChannel[] }
  | { op: 'unsubscribe'; channels: LiveChannel[] };
