import { useNavigate } from '@tanstack/react-router';
import { FileWarning, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Sparkline } from '@/components/alerting';
import { Badge, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { useLogGroups, type LogGroupFilter } from '@/lib/queries';

const STATUSES: { value: LogGroupFilter['status']; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'resolved', label: '已解决' },
  { value: 'ignored', label: '已忽略' },
  { value: 'all', label: '全部' },
];

export function LogsPage() {
  const [status, setStatus] = useState<LogGroupFilter['status']>('active');
  const [service, setService] = useState('');
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const groups = useLogGroups({ status, service: service || undefined, q: q || undefined });
  const navigate = useNavigate();
  const items = groups.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">日志指纹</h1>
          <p className="mt-1 text-sm text-muted">同类异常日志去掉时间、ID、数字等变量后归为一个指纹；只有新指纹、复发、突增和扩散会产生告警。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模板或指纹"
              className="h-9 w-64 rounded-lg border border-line bg-surface pr-3 pl-9 text-sm outline-none focus:border-brand"
            />
          </div>
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-brand"
            aria-label="服务"
          >
            <option value="">全部服务</option>
            {groups.data?.services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            {STATUSES.map((s) => (
              <button key={s.value} onClick={() => setStatus(s.value)} className={cn('rounded-md px-3 py-1.5 text-muted', status === s.value && 'bg-white/[0.08] text-ink')}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {groups.error && <ErrorNote error={groups.error} onRetry={() => groups.refetch()} />}

      <Card className="overflow-hidden">
        {groups.isLoading ? (
          <div className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<FileWarning className="size-6" />} title={q || service ? '没有匹配的指纹' : '暂无异常日志'}>
            Agent 默认采集 journald；应用日志文件需要在 /etc/pulse/agent.yaml 的 logs.files 中配置。
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((g) => (
              <li key={g.id}>
                <button onClick={() => navigate({ to: '/logs/$id', params: { id: g.id } })} className="grid w-full grid-cols-[1fr_auto] gap-6 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.02]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge className={g.level === 'fatal' ? 'border-crit/40 text-crit' : 'border-warn/30 text-warn'}>{g.level === 'fatal' ? 'FATAL' : 'ERROR'}</Badge>
                      <span className="font-medium text-ink">{g.service}</span>
                      <span className="num text-faint">{g.fingerprint}</span>
                      {g.status !== 'active' && <Badge>{g.status === 'ignored' ? '已忽略' : '已解决'}</Badge>}
                    </div>
                    <pre className="mt-2 line-clamp-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink/85">{g.template}</pre>
                  </div>
                  <div className="flex items-center gap-5 text-xs">
                    <div className="hidden flex-col items-end gap-1 sm:flex">
                      <Sparkline values={g.hourly} tone={g.level === 'fatal' ? 'crit' : 'brand'} />
                      <span className="text-faint">24 小时</span>
                    </div>
                    <dl className="grid w-44 grid-cols-2 gap-x-3 gap-y-1">
                      <dt className="text-faint">24h</dt>
                      <dd className="num text-right">{g.count24h.toLocaleString('zh-CN')}</dd>
                      <dt className="text-faint">累计</dt>
                      <dd className="num text-right">{g.totalCount.toLocaleString('zh-CN')}</dd>
                      <dt className="text-faint">主机</dt>
                      <dd className="num text-right">{g.hostCount}</dd>
                      <dt className="text-faint">最近</dt>
                      <dd className="text-right" title={formatTime(g.lastSeen)}>
                        {formatRelative(g.lastSeen)}
                      </dd>
                    </dl>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
