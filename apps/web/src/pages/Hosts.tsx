import type { HostSummary } from '@pulse/shared';
import { useNavigate } from '@tanstack/react-router';
import { Search, ServerOff } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Badge, Card, EmptyState, ErrorNote, Meter, Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatPct, formatRelative, formatTime, level } from '@/lib/format';
import { useHosts } from '@/lib/queries';

function matches(h: HostSummary, q: string) {
  if (!q) return true;
  const hay = [h.hostname, ...h.ips, ...Object.entries(h.labels).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

function UsageCell({ value, crit = 90 }: { value: number | null; crit?: number }) {
  return (
    <div className="flex w-28 flex-col gap-1">
      <span className="num text-xs">{formatPct(value)}</span>
      <Meter value={value} tone={level(value, crit - 10, crit)} />
    </div>
  );
}

export function HostsPage() {
  const hosts = useHosts();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const [status, setStatus] = useState<'all' | 'online' | 'offline'>('all');

  const rows = useMemo(
    () => (hosts.data ?? []).filter((h) => (status === 'all' || h.status === status) && matches(h, q)),
    [hosts.data, q, status],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">主机</h1>
          <p className="mt-1 text-sm text-muted">
            {hosts.data ? `共 ${hosts.data.length} 台，在线 ${hosts.data.filter((h) => h.status === 'online').length} 台` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="主机名、IP 或标签 env=prod"
              className="h-9 w-72 rounded-lg border border-line bg-surface pr-3 pl-9 text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            {(['all', 'online', 'offline'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn('rounded-md px-3 py-1.5 text-muted', status === s && 'bg-white/[0.08] text-ink')}
              >
                {{ all: '全部', online: '在线', offline: '离线' }[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {hosts.error && <ErrorNote error={hosts.error} onRetry={() => hosts.refetch()} />}

      <Card className="overflow-hidden">
        {hosts.isLoading ? (
          <div className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ServerOff className="size-6" />} title={hosts.data?.length ? '没有匹配的主机' : '还没有主机'}>
            {hosts.data?.length ? '换个关键词试试。' : '点击右上角“添加主机”接入第一台机器。'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-faint">
                  <th className="px-5 py-3 font-medium">主机</th>
                  <th className="px-3 py-3 font-medium">CPU</th>
                  <th className="px-3 py-3 font-medium">内存</th>
                  <th className="px-3 py-3 font-medium">磁盘（最高）</th>
                  <th className="px-3 py-3 font-medium">Load 1m</th>
                  <th className="px-3 py-3 font-medium">最后上报</th>
                  <th className="px-5 py-3 font-medium">Agent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((h) => {
                  const off = h.status === 'offline';
                  return (
                    <tr
                      key={h.id}
                      onClick={() => navigate({ to: '/hosts/$id', params: { id: h.id } })}
                      className={cn('cursor-pointer transition-colors hover:bg-white/[0.02]', off && 'opacity-55')}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <StatusDot tone={off ? 'off' : 'ok'} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{h.hostname}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <span className="num text-xs text-faint">{h.ips[0] ?? '—'}</span>
                              {Object.entries(h.labels).map(([k, v]) => (
                                <Badge key={k}>
                                  {k}={v}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3"><UsageCell value={h.snapshot.cpuPct} /></td>
                      <td className="px-3 py-3"><UsageCell value={h.snapshot.memPct} /></td>
                      <td className="px-3 py-3"><UsageCell value={h.snapshot.diskPct} crit={85} /></td>
                      <td className="num px-3 py-3 text-xs">{h.snapshot.load1?.toFixed(2) ?? '—'}</td>
                      <td className="px-3 py-3 text-xs" title={formatTime(h.lastSeenAt)}>
                        <span className={off ? 'text-warn' : 'text-muted'}>{formatRelative(h.lastSeenAt)}</span>
                      </td>
                      <td className="num px-5 py-3 text-xs text-faint">{h.agentVersion}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
