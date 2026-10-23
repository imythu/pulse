import { METRIC_META, type MetricName } from '@pulse/shared';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(v: number, digits = 1): string {
  let i = 0;
  while (Math.abs(v) >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function formatPct(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : `${v.toFixed(digits)}%`;
}

export function formatMetric(name: string, v: number): string {
  const unit = METRIC_META[name as MetricName]?.unit;
  switch (unit) {
    case 'pct':
      return formatPct(v);
    case 'bytes':
      return formatBytes(v);
    case 'bps':
      return `${formatBytes(v)}/s`;
    case 'load':
      return v.toFixed(2);
    default:
      return Math.round(v).toLocaleString('zh-CN');
  }
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function formatRelative(ts: number | null, now = Date.now()): string {
  if (ts == null) return '从未';
  const s = Math.round((ts - now) / 1000);
  if (Math.abs(s) < 5) return '刚刚';
  if (Math.abs(s) < 60) return rtf.format(s, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/** 绝对时间，精确到秒。设计文档 8.4：时间同时给出绝对时间和相对时间。 */
export function formatTime(ts: number | null): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/** 使用率对应的状态色等级，与告警阈值默认值一致（设计文档 4.2）。 */
export function level(v: number | null | undefined, warn = 80, crit = 90): 'ok' | 'warn' | 'crit' | 'none' {
  if (v == null) return 'none';
  if (v >= crit) return 'crit';
  if (v >= warn) return 'warn';
  return 'ok';
}
