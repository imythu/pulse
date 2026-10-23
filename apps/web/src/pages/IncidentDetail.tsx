import type { IncidentEvent, IncidentEventType, LogGroupSummary } from '@pulse/shared';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Bell, BellOff, CircleCheck, CirclePlus, Flame, Repeat, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { AlertTags, alertValueText, HostLinks, IncidentStatus, incidentDuration, SeverityBadge, Sparkline } from '@/components/alerting';
import { Badge, Boundary, Card, CardHeader, EmptyState, ErrorNote, Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { useIncident, useRules } from '@/lib/queries';

const EVENT_STYLE: Record<IncidentEventType, { icon: ReactNode; tone: string }> = {
  opened: { icon: <CirclePlus className="size-3.5" />, tone: 'text-brand border-brand/40' },
  alert_joined: { icon: <CirclePlus className="size-3.5" />, tone: 'text-muted border-line' },
  alert_escalated: { icon: <Flame className="size-3.5" />, tone: 'text-crit border-crit/40' },
  alert_resolved: { icon: <CircleCheck className="size-3.5" />, tone: 'text-ok border-ok/40' },
  alert_reopened: { icon: <Repeat className="size-3.5" />, tone: 'text-warn border-warn/40' },
  flapping: { icon: <TriangleAlert className="size-3.5" />, tone: 'text-warn border-warn/40' },
  resolved: { icon: <CircleCheck className="size-3.5" />, tone: 'text-ok border-ok/40' },
  reopened: { icon: <Repeat className="size-3.5" />, tone: 'text-warn border-warn/40' },
  notified: { icon: <Bell className="size-3.5" />, tone: 'text-faint border-line' },
  notify_failed: { icon: <BellOff className="size-3.5" />, tone: 'text-crit border-crit/40' },
};

function Timeline({ events }: { events: IncidentEvent[] }) {
  return (
    <ol className="relative flex flex-col gap-4 p-5">
      <span className="absolute top-7 bottom-7 left-[33px] w-px bg-line" aria-hidden />
      {events.map((e) => {
        const style = EVENT_STYLE[e.type];
        return (
          <li key={e.id} className="relative flex gap-3">
            <span className={cn('z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface', style.tone)}>{style.icon}</span>
            <div className="min-w-0 pt-0.5">
              <p className={cn('text-sm leading-snug', e.type === 'notified' && 'text-muted')}>{e.message}</p>
              <p className="mt-0.5 text-xs text-faint" title={formatTime(e.at)}>
                {formatTime(e.at)} · {formatRelative(e.at)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LogGroupRow({ g }: { g: LogGroupSummary }) {
  return (
    <Link to="/logs/$id" params={{ id: g.id }} className="block px-5 py-3 hover:bg-white/[0.02]">
      <div className="flex items-center gap-2 text-xs">
        <Badge className={g.level === 'fatal' ? 'border-crit/40 text-crit' : undefined}>{g.level === 'fatal' ? 'FATAL' : 'ERROR'}</Badge>
        <span className="text-muted">{g.service}</span>
        <span className="ml-auto flex items-center gap-3 text-faint">
          <Sparkline values={g.hourly} />
          <span className="num">24h {g.count24h.toLocaleString('zh-CN')} 次</span>
        </span>
      </div>
      <pre className="mt-2 line-clamp-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink/90">{g.template}</pre>
    </Link>
  );
}

export function IncidentDetailPage() {
  const { id } = useParams({ from: '/app/incidents/$id' });
  const incident = useIncident(id);
  const rules = useRules();
  const metricOf = (ruleId: string | null) => rules.data?.find((r) => r.id === ruleId)?.metric ?? null;

  if (incident.error) return <ErrorNote error={incident.error} onRetry={() => incident.refetch()} />;
  const i = incident.data;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/incidents" className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Incident
      </Link>

      {!i ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="num text-lg text-faint">#{i.no}</span>
            <h1 className="text-xl font-semibold tracking-tight">{i.title}</h1>
            <SeverityBadge severity={i.severity} />
            <IncidentStatus incident={i} />
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm md:grid-cols-5">
            <div>
              <dt className="text-xs text-faint">开始</dt>
              <dd className="mt-1">{formatTime(i.openedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">{i.status === 'resolved' ? '恢复' : '最近变化'}</dt>
              <dd className="mt-1">{formatTime(i.resolvedAt ?? i.updatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">持续</dt>
              <dd className="num mt-1">{incidentDuration(i)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">影响主机</dt>
              <dd className="mt-1">
                <HostLinks hosts={i.hosts} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">服务</dt>
              <dd className="mt-1">{i.service ?? '—'}</dd>
            </div>
          </dl>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <Card>
            <CardHeader title="告警" hint="同一主机 + 规则（或同一日志指纹）只有一条告警，重复上报只更新它的数值和次数" />
            <Boundary>
              {!i ? (
                <div className="p-5">
                  <Skeleton className="h-24" />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {i.alerts.map((a) => {
                    const target = a.logGroupId ? (
                      <Link to="/logs/$id" params={{ id: a.logGroupId }} className="hover:text-brand">
                        {a.title}
                      </Link>
                    ) : a.hostId ? (
                      <Link to="/hosts/$id" params={{ id: a.hostId }} className="hover:text-brand">
                        {a.title}
                      </Link>
                    ) : (
                      a.title
                    );
                    return (
                      <li key={a.id} className={cn('px-5 py-3.5', a.state === 'resolved' && 'opacity-60')}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="relative -top-px shrink-0">
                              <StatusDot tone={a.state === 'resolved' ? 'ok' : a.severity === 'critical' ? 'crit' : 'warn'} pulse={a.state === 'firing'} />
                            </span>
                            <span className="font-medium break-all">{target}</span>
                          </span>
                          <SeverityBadge severity={a.severity} />
                          <AlertTags alert={a} />
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-4 text-xs text-muted">
                          <span>{a.ruleName}</span>
                          {alertValueText(a, metricOf(a.ruleId)) && <span className="num">{alertValueText(a, metricOf(a.ruleId))}</span>}
                          <span>
                            {formatTime(a.startedAt)} → {a.resolvedAt ? formatTime(a.resolvedAt) : '持续中'}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Boundary>
          </Card>

          {!!i?.logGroups.length && (
            <Card>
              <CardHeader title="相关日志指纹" hint="点击查看样本、上下文和计数曲线" />
              <Boundary>
                <div className="divide-y divide-line">
                  {i.logGroups.map((g) => (
                    <LogGroupRow key={g.id} g={g} />
                  ))}
                </div>
              </Boundary>
            </Card>
          )}

          <Card>
            <CardHeader title="AI 分析" hint="结论、置信度、证据与代码位置" />
            <EmptyState icon={<Sparkles className="size-6" />} title="尚未接入">
              AI 根因分析在 M4 里程碑实现。届时 Incident 打开 60 秒后会自动分析，也可以在这里手动触发。
            </EmptyState>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader title="时间线" hint="告警加入、升级、恢复与通知" />
          <Boundary>{!i ? <Skeleton className="m-5 h-40" /> : <Timeline events={i.events} />}</Boundary>
        </Card>
      </div>
    </div>
  );
}
