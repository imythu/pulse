import type { RuleInfo, RuleKind, Severity } from '@pulse/shared';
import type { Sql } from '../../db/index.js';
import type { ThresholdParams } from './machine.js';

export interface RuleRow {
  id: string;
  name: string;
  description: string;
  kind: RuleKind;
  metric: string | null;
  params: Record<string, number>;
  severity: Severity;
  scope: { labels?: Record<string, string> };
  enabled: boolean;
  updated_at: Date;
}

export interface LogRuleParams {
  quietMinutes: number;
  spikeFactor: number;
  spikeMin: number;
  spreadHosts: number;
  spreadMinutes: number;
}

export const DEFAULT_LOG_PARAMS: LogRuleParams = { quietMinutes: 30, spikeFactor: 5, spikeMin: 50, spreadHosts: 3, spreadMinutes: 10 };

/** 每种规则允许修改的参数，PATCH 时只接受这些键。 */
export const PARAM_KEYS: Record<RuleKind, string[]> = {
  threshold: ['threshold', 'forSeconds', 'recover', 'recoverForSeconds', 'critical'],
  disk_fill: ['windowHours', 'horizonHours', 'recoverHours'],
  mem_leak: ['windowHours', 'minIncrease', 'minCorr'],
  offline: [],
  log: ['quietMinutes', 'spikeFactor', 'spikeMin', 'spreadHosts', 'spreadMinutes'],
};

export function toRuleInfo(r: RuleRow): RuleInfo {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    metric: r.metric,
    params: r.params,
    severity: r.severity,
    scope: { labels: r.scope.labels ?? {} },
    enabled: r.enabled,
    updatedAt: r.updated_at.getTime(),
  };
}

export async function loadRules(sql: Sql): Promise<RuleRow[]> {
  return sql<RuleRow[]>`SELECT * FROM rules ORDER BY id`;
}

/** 标签选择器：规则的每个标签都要与主机标签相同。 */
export function inScope(rule: RuleRow, labels: Record<string, string>): boolean {
  return Object.entries(rule.scope.labels ?? {}).every(([k, v]) => labels[k] === v);
}

export function thresholdParams(rule: RuleRow): ThresholdParams {
  const p = rule.params;
  return {
    threshold: p.threshold ?? 90,
    forSeconds: p.forSeconds ?? 0,
    recover: p.recover ?? p.threshold ?? 90,
    recoverForSeconds: p.recoverForSeconds ?? 0,
    critical: p.critical,
  };
}

/** 磁盘写满预测：值是“预计多少小时后写满”，越小越糟。 */
export function diskFillParams(rule: RuleRow): ThresholdParams & { windowHours: number } {
  const p = rule.params;
  return {
    threshold: p.horizonHours ?? 24,
    recover: p.recoverHours ?? 48,
    forSeconds: 0,
    recoverForSeconds: 0,
    direction: 'below',
    windowHours: p.windowHours ?? 6,
  };
}

/** 内存泄漏：值是窗口内线性拟合的涨幅（百分点），只在相关系数足够高时计算。 */
export function memLeakParams(rule: RuleRow): ThresholdParams & { windowHours: number; minCorr: number } {
  const p = rule.params;
  const minIncrease = p.minIncrease ?? 20;
  return {
    threshold: minIncrease,
    recover: minIncrease / 2,
    forSeconds: 0,
    recoverForSeconds: 0,
    windowHours: p.windowHours ?? 2,
    minCorr: p.minCorr ?? 0.9,
  };
}

export function logParams(rule: RuleRow | undefined): LogRuleParams {
  return { ...DEFAULT_LOG_PARAMS, ...(rule?.params as Partial<LogRuleParams> | undefined) };
}
