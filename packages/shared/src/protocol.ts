// Agent <-> Server 协议（设计文档 9.2）。
// 每条消息都是一个信封 { type, seq, ts, payload }，WebSocket 二进制帧 = zstd(JSON)。
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** 单个指标在一个聚合窗口内的统计值。tag 用来区分同名指标的不同对象，如挂载点、网卡。 */
export const MetricPoint = z.object({
  name: z.string().min(1).max(128),
  tag: z.string().max(256).default(''),
  min: z.number(),
  max: z.number(),
  avg: z.number(),
  p95: z.number(),
});
export type MetricPoint = z.infer<typeof MetricPoint>;

export const ProcessInfo = z.object({
  pid: z.number().int(),
  name: z.string(),
  cmdline: z.string(),
  user: z.string(),
  cpuPct: z.number(),
  memPct: z.number(),
  rssBytes: z.number(),
});
export type ProcessInfo = z.infer<typeof ProcessInfo>;

export const HostInfo = z.object({
  hostname: z.string().min(1).max(255),
  os: z.string(),
  platform: z.string(),
  platformVersion: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpuCores: z.number().int().nonnegative(),
  cpuModel: z.string(),
  memTotal: z.number().nonnegative(),
  ips: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  bootTime: z.number(),
});
export type HostInfo = z.infer<typeof HostInfo>;

// ---------- Agent -> Server ----------

export const HelloPayload = z.object({
  protocol: z.number().int(),
  agentVersion: z.string(),
  host: HostInfo,
});

export const MetricsPayload = z.object({
  /** 窗口起点，毫秒时间戳 */
  windowStart: z.number(),
  windowSeconds: z.number().int().positive(),
  /** true 表示超本地阈值后提前推送，窗口不完整 */
  early: z.boolean().default(false),
  points: z.array(MetricPoint).max(2000),
});
export type MetricsPayload = z.infer<typeof MetricsPayload>;

export const ProcsPayload = z.object({
  byCpu: z.array(ProcessInfo).max(20),
  byMem: z.array(ProcessInfo).max(20),
});
export type ProcsPayload = z.infer<typeof ProcsPayload>;

export const HeartbeatPayload = z.object({
  queueDepth: z.number().int().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
  cpuPct: z.number(),
  memPct: z.number(),
});

/** 一个日志指纹在 Agent 10 秒窗口内的汇总：首条完整样本 + 次数（设计文档 4.1）。 */
export const LogEvent = z.object({
  /** Agent 算出的指纹，只用于本地去重；服务器会用同一套规则重新计算 */
  fingerprint: z.string().max(64),
  service: z.string().min(1).max(128),
  level: z.enum(['error', 'fatal']),
  source: z.string().max(512),
  /** 打码后的完整记录，多行堆栈用 \n 连接 */
  message: z.string().max(32 * 1024),
  context: z.array(z.string().max(1024)).max(50).nullish().transform((v) => v ?? []), // Go 的空切片编码为 null
  count: z.number().int().positive(),
  firstTs: z.number(),
  lastTs: z.number(),
});
export type LogEvent = z.infer<typeof LogEvent>;

export const LogsPayload = z.object({
  rulesVersion: z.number().int(),
  events: z.array(LogEvent).max(1000).nullish().transform((v) => v ?? []),
  dropped: z.number().int().nonnegative().default(0),
});
export type LogsPayload = z.infer<typeof LogsPayload>;

export const AgentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), seq: z.number().int(), ts: z.number(), payload: HelloPayload }),
  z.object({ type: z.literal('metrics'), seq: z.number().int(), ts: z.number(), payload: MetricsPayload }),
  z.object({ type: z.literal('procs'), seq: z.number().int(), ts: z.number(), payload: ProcsPayload }),
  z.object({ type: z.literal('heartbeat'), seq: z.number().int(), ts: z.number(), payload: HeartbeatPayload }),
  z.object({ type: z.literal('logs'), seq: z.number().int(), ts: z.number(), payload: LogsPayload }),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/** 需要可靠送达（落本地队列、按 seq 去重补传）的消息类型。hello / heartbeat 的 seq 为 0。 */
export const RELIABLE_TYPES = new Set<AgentMessage['type']>(['metrics', 'procs', 'logs']);

// ---------- Server -> Agent ----------

export const AgentConfig = z.object({
  sampleIntervalSeconds: z.number().int().min(1),
  windowSeconds: z.number().int().min(10),
  procsIntervalSeconds: z.number().int().min(5),
  heartbeatSeconds: z.number().int().min(5),
  /** 本地简化阈值：超过即提前推送当前窗口 */
  earlyPush: z.object({ cpuPct: z.number(), memPct: z.number(), diskPct: z.number() }),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  sampleIntervalSeconds: 10,
  windowSeconds: 60,
  procsIntervalSeconds: 30,
  heartbeatSeconds: 15,
  earlyPush: { cpuPct: 90, memPct: 90, diskPct: 85 },
};

export type ServerMessage =
  | { type: 'ack'; seq: number; ts: number; payload: { maxSeq: number } }
  | { type: 'config'; seq: number; ts: number; payload: AgentConfig };

// ---------- 注册 ----------

export const EnrollRequest = z.object({
  token: z.string().min(16),
  /** Ed25519 公钥，32 字节原始值的 base64 */
  publicKey: z.string(),
  host: HostInfo,
  agentVersion: z.string(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  agentId: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

/**
 * WebSocket 握手认证：Authorization: Pulse <agentId>.<unixMillis>.<base64 签名>
 * 签名内容为 `pulse-agent-auth:<agentId>:<unixMillis>`，时间偏差需在 5 分钟内。
 */
export const AGENT_AUTH_SCHEME = 'Pulse';
export const AGENT_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;
export function agentAuthMessage(agentId: string, ts: number): string {
  return `pulse-agent-auth:${agentId}:${ts}`;
}
