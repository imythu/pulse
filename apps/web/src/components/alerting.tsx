import type { AlertInfo, IncidentSummary, Severity } from '@pulse/shared';
import { Link } from '@tanstack/react-router';
import { Repeat, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDuration, formatMetric } from '@/lib/format';
import { Badge, StatusDot } from './ui';

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        severity === 'critical' ? 'border-crit/40 bg-crit/10 text-crit' : 'border-warn/40 bg-warn/10 text-warn',
        className,
      )}
    >
      <StatusDot tone={severity === 'critical' ? 'crit' : 'warn'} />
      {severity === 'critical' ? '严重' : '警告'}
    </span>
  );
}

export function IncidentStatus({ incident }: { incident: Pick<IncidentSummary, 'status' | 'severity'> }) {
  if (incident.status === 'resolved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
        <StatusDot tone="ok" />
        已恢复
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', incident.severity === 'critical' ? 'text-crit' : 'text-warn')}>
      <StatusDot tone={incident.severity === 'critical' ? 'crit' : 'warn'} pulse />
      处理中
    </span>
  );
}

/** Incident 的持续时长：未恢复的算到现在。 */
export function incidentDuration(i: Pick<IncidentSummary, 'openedAt' | 'resolvedAt'>, now = Date.now()) {
  return formatDuration(Math.max(60, ((i.resolvedAt ?? now) - i.openedAt) / 1000));
}

const REASON_TEXT: Record<string, string> = {
  new: '新指纹',
  recur: '复发',
  spike: '突增',
  spread: '扩散',
  critical: '达到严重阈值',
  offline: '离线',
};

/** 告警的数值说明：指标类显示当前 / 峰值 / 阈值，日志类显示次数。 */
export function alertValueText(a: AlertInfo, metric: string | null): string {
  if (a.kind === 'log') return `${a.count.toLocaleString('zh-CN')} 次`;
  if (a.kind === 'offline') return '';
  if (a.kind === 'disk_fill') return a.value != null ? `预计 ${a.value.toFixed(1)} 小时后写满` : '';
  if (a.kind === 'mem_leak') return a.value != null ? `窗口内上涨 ${a.value.toFixed(1)} 个百分点` : '';
  if (a.value == null || !metric) return '';
  const parts = [`当前 ${formatMetric(metric, a.value)}`];
  if (a.peakValue != null) parts.push(`峰值 ${formatMetric(metric, a.peakValue)}`);
  if (a.threshold != null) parts.push(`阈值 ${formatMetric(metric, a.threshold)}`);
  return parts.join(' · ');
}

export function AlertTags({ alert }: { alert: AlertInfo }) {
  return (
    <>
      {alert.reasons.map((r) => (
        <Badge key={r} className={r === 'spike' || r === 'spread' || r === 'critical' ? 'border-crit/30 text-crit' : undefined}>
          {r === 'spike' || r === 'spread' ? <TrendingUp className="size-3" /> : null}
          {REASON_TEXT[r] ?? r}
        </Badge>
      ))}
      {alert.flapping && (
        <Badge className="border-warn/40 text-warn">
          <Repeat className="size-3" />
          抖动 · 已暂停通知
        </Badge>
      )}
    </>
  );
}

export function HostLinks({ hosts }: { hosts: { id: string; hostname: string }[] }) {
  if (!hosts.length) return <span className="text-faint">—</span>;
  const shown = hosts.slice(0, 3);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {shown.map((h) => (
        <Link key={h.id} to="/hosts/$id" params={{ id: h.id }} className="hover:text-brand" onClick={(e) => e.stopPropagation()}>
          {h.hostname}
        </Link>
      ))}
      {hosts.length > shown.length && <span className="text-faint">等 {hosts.length} 台</span>}
    </span>
  );
}

/** 24 小时计数的迷你柱状图，纯 SVG，不加载图表库。 */
export function Sparkline({ values, className, tone = 'brand' }: { values: number[]; className?: string; tone?: 'brand' | 'crit' }) {
  const max = Math.max(1, ...values);
  const w = 96;
  const h = 24;
  const bw = w / values.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-6 w-24', className)} aria-hidden>
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max(1.5, (v / max) * h) : 0.75;
        return (
          <rect
            key={i}
            x={i * bw + 0.5}
            y={h - bh}
            width={Math.max(1, bw - 1)}
            height={bh}
            rx={0.5}
            className={v > 0 ? (tone === 'crit' ? 'fill-crit/80' : 'fill-brand/80') : 'fill-white/10'}
          />
        );
      })}
    </svg>
  );
}
