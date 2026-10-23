import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2, Flame, Siren } from 'lucide-react';
import { useMemo, useState } from 'react';
import { HostLinks, IncidentStatus, incidentDuration, SeverityBadge } from '@/components/alerting';
import { StatCard, StatNumber } from '@/components/Stat';
import { Button, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { useIncidents, type IncidentFilter } from '@/lib/queries';

const FILTERS: { value: IncidentFilter; label: string }[] = [
  { value: 'open', label: '处理中' },
  { value: 'resolved', label: '已恢复' },
  { value: 'all', label: '全部' },
];

export function IncidentsPage() {
  const [filter, setFilter] = useState<IncidentFilter>('open');
  const list = useIncidents(filter);
  const open = useIncidents('open', undefined, 100);
  const recent = useIncidents('all', undefined, 100);
  const navigate = useNavigate();
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const openItems = useMemo(() => open.data?.pages.flatMap((p) => p.items) ?? [], [open.data]);
  const dayAgo = Date.now() - 24 * 3600_000;
  const recentItems = recent.data?.pages[0]?.items ?? [];
  const newToday = recentItems.filter((i) => i.openedAt >= dayAgo).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Incident</h1>
        <p className="mt-1 text-sm text-muted">同一主机或服务 5 分钟内的告警合并为一个 Incident；所有告警恢复后自动关闭。</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {!open.data || !recent.data ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[126px] rounded-xl" />)
        ) : (
          <>
            <StatCard icon={<Siren className="size-3.5" />} label="处理中" hint="仍有告警未恢复">
              <StatNumber value={openItems.length} />
            </StatCard>
            <StatCard icon={<Flame className="size-3.5" />} label="其中严重" hint="需要优先处理">
              <StatNumber value={openItems.filter((i) => i.severity === 'critical').length} />
            </StatCard>
            <StatCard icon={<CheckCircle2 className="size-3.5" />} label="24 小时内新增" hint={newToday >= 100 ? '含已恢复，超过 100 个只显示 100' : '含已恢复'}>
              <StatNumber value={newToday} />
            </StatCard>
          </>
        )}
      </div>

      <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs self-start">
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)} className={cn('rounded-md px-3 py-1.5 text-muted', filter === f.value && 'bg-white/[0.08] text-ink')}>
            {f.label}
          </button>
        ))}
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={() => list.refetch()} />}

      <Card className="overflow-hidden">
        {list.isLoading ? (
          <div className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-6" />} title={filter === 'open' ? '没有处理中的 Incident' : '暂无记录'}>
            {filter === 'open' ? '所有主机运行正常。告警触发后会出现在这里。' : undefined}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-faint">
                  <th className="px-5 py-3 font-medium">Incident</th>
                  <th className="px-3 py-3 font-medium">级别</th>
                  <th className="px-3 py-3 font-medium">状态</th>
                  <th className="px-3 py-3 font-medium">影响主机</th>
                  <th className="px-3 py-3 font-medium">告警</th>
                  <th className="px-3 py-3 font-medium">持续</th>
                  <th className="px-5 py-3 font-medium">开始时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((i) => (
                  <tr
                    key={i.id}
                    onClick={() => navigate({ to: '/incidents/$id', params: { id: i.id } })}
                    className={cn('cursor-pointer transition-colors hover:bg-white/[0.02]', i.status === 'resolved' && 'text-muted')}
                  >
                    <td className="max-w-md px-5 py-3">
                      <div className="flex items-baseline gap-2">
                        <span className="num shrink-0 text-xs text-faint">#{i.no}</span>
                        <span className="truncate font-medium" title={i.title}>
                          {i.title}
                        </span>
                      </div>
                      {i.service && <div className="mt-0.5 pl-7 text-xs text-faint">服务 {i.service}</div>}
                    </td>
                    <td className="px-3 py-3">
                      <SeverityBadge severity={i.severity} />
                    </td>
                    <td className="px-3 py-3">
                      <IncidentStatus incident={i} />
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <HostLinks hosts={i.hosts} />
                    </td>
                    <td className="num px-3 py-3 text-xs">
                      {i.status === 'resolved' ? i.alertCount : `${i.firingCount} / ${i.alertCount}`}
                    </td>
                    <td className="num px-3 py-3 text-xs">{incidentDuration(i)}</td>
                    <td className="px-5 py-3 text-xs text-muted" title={formatTime(i.openedAt)}>
                      {formatRelative(i.openedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button size="sm" variant="ghost" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? '加载中…' : '加载更多'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
