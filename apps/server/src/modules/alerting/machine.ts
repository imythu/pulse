// 指标类告警的状态机（设计文档 4.2、4.3）：持续时间 + 滞回。纯函数，不读写数据库。
import type { Severity } from '@pulse/shared';

export interface ThresholdParams {
  threshold: number;
  /** 超阈值持续多久才触发 */
  forSeconds: number;
  /** 回到这个值以下（direction=below 时为以上）才算恢复，防止在阈值附近来回跳 */
  recover: number;
  recoverForSeconds: number;
  /** 达到这个值时升级为 critical；0 或不填表示不升级 */
  critical?: number;
  /** above：值越大越糟（默认）；below：值越小越糟，如“预计写满的小时数” */
  direction?: 'above' | 'below';
}

export interface Track {
  /** 首次超阈值的时间；pending 只在内存中，回落即丢弃，不留记录 */
  pendingSince: number | null;
  firing: { severity: Severity; recoverSince: number | null; peak: number } | null;
}

export type Transition = 'none' | 'pending' | 'dropped' | 'fire' | 'update' | 'escalate' | 'resolve';

export const IDLE: Track = { pendingSince: null, firing: null };

export function evaluate(
  track: Track,
  value: number,
  now: number,
  p: ThresholdParams,
  baseSeverity: Severity,
): { track: Track; transition: Transition } {
  const above = p.direction !== 'below';
  const breach = above ? value >= p.threshold : value <= p.threshold;
  const recovered = above ? value < p.recover : value > p.recover;
  const critical = !!p.critical && (above ? value >= p.critical : value <= p.critical);

  if (!track.firing) {
    if (!breach) return { track: IDLE, transition: track.pendingSince == null ? 'none' : 'dropped' };
    const since = track.pendingSince ?? now;
    if (now - since < p.forSeconds * 1000) return { track: { pendingSince: since, firing: null }, transition: 'pending' };
    const severity: Severity = critical ? 'critical' : baseSeverity;
    return { track: { pendingSince: null, firing: { severity, recoverSince: null, peak: value } }, transition: 'fire' };
  }

  const f = track.firing;
  const peak = above ? Math.max(f.peak, value) : Math.min(f.peak, value);
  if (critical && f.severity !== 'critical') {
    return { track: { pendingSince: null, firing: { severity: 'critical', recoverSince: null, peak } }, transition: 'escalate' };
  }
  if (recovered) {
    const recoverSince = f.recoverSince ?? now;
    if (now - recoverSince >= p.recoverForSeconds * 1000) return { track: IDLE, transition: 'resolve' };
    return { track: { pendingSince: null, firing: { ...f, recoverSince, peak } }, transition: 'update' };
  }
  return { track: { pendingSince: null, firing: { ...f, recoverSince: null, peak } }, transition: 'update' };
}

/** 抖动判定：1 小时内重新触发 >= 3 次，暂停通知 1 小时。 */
export const FLAP_WINDOW_MS = 3600_000;
export const FLAP_THRESHOLD = 3;
export const FLAP_MUTE_MS = 3600_000;
/** 恢复后多久内再次触发算“重开原告警” */
export const REOPEN_WINDOW_MS = 30 * 60_000;
/** 新告警加入同一主机或服务最近 5 分钟内有变化的 Incident */
export const MERGE_WINDOW_MS = 5 * 60_000;

export function recordFlap(flaps: number[], now: number): { flaps: number[]; flapping: boolean } {
  const recent = [...flaps.filter((t) => now - t < FLAP_WINDOW_MS), now];
  return { flaps: recent, flapping: recent.length >= FLAP_THRESHOLD };
}
