import type { LogGroupStatus, LogSample } from '@pulse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, BellOff, CheckCircle2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { HostLinks } from '@/components/alerting';
import { MetricChart } from '@/components/MetricChart';
import { Badge, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { keys, useLogGroup, useMe } from '@/lib/queries';

function Sample({ s, first }: { s: LogSample; first: boolean }) {
  const [showContext, setShowContext] = useState(false);
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span title={formatTime(s.time)}>{formatTime(s.time)}</span>
        {s.hostId ? (
          <Link to="/hosts/$id" params={{ id: s.hostId }} className="hover:text-brand">
            {s.hostname}
          </Link>
        ) : (
          <span className="text-faint">已删除的主机</span>
        )}
        <span className="truncate font-mono text-faint">{s.source}</span>
        {first && <Badge>首条样本</Badge>}
        {s.context.length > 0 && (
          <button onClick={() => setShowContext((v) => !v)} className="ml-auto text-brand hover:underline">
            {showContext ? '收起上下文' : `前 ${s.context.length} 行上下文`}
          </button>
        )}
      </div>
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-xs leading-relaxed">
        {showContext && <span className="block text-faint">{s.context.join('\n')}</span>}
        <span className="text-ink/90">{s.message}</span>
      </pre>
    </li>
  );
}

export function LogGroupDetailPage() {
  const { id } = useParams({ from: '/app/logs/$id' });
  const group = useLogGroup(id);
  const me = useMe();
  const qc = useQueryClient();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [commit, setCommit] = useState('');
  const canEdit = me.data?.role === 'operator' || me.data?.role === 'admin';

  const update = useMutation({
    mutationFn: (body: { status: LogGroupStatus; resolvedCommit?: string }) => api.patch(`/api/v1/log-groups/${id}`, body),
    onSuccess: async () => {
      setResolveOpen(false);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.logGroup(id) }), qc.invalidateQueries({ queryKey: ['log-groups'] })]);
    },
  });

  if (group.error) return <ErrorNote error={group.error} onRetry={() => group.refetch()} />;
  const g = group.data;
  const firstSampleId = g?.samples.length ? Math.min(...g.samples.map((s) => s.id)) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/logs" className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        日志指纹
      </Link>

      {!g ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge className={g.level === 'fatal' ? 'border-crit/40 text-crit' : 'border-warn/30 text-warn'}>{g.level === 'fatal' ? 'FATAL' : 'ERROR'}</Badge>
              <span className="font-semibold">{g.service}</span>
              <span className="num text-xs text-faint">指纹 {g.fingerprint}</span>
              <Badge className={cn(g.status === 'active' && 'border-brand/30 text-brand')}>
                {g.status === 'active' ? '活跃' : g.status === 'ignored' ? '已忽略' : `已解决${g.resolvedCommit ? ` · ${g.resolvedCommit}` : ''}`}
              </Badge>
              {g.activeAlertId && <Badge className="border-crit/40 text-crit">告警中</Badge>}
            </div>
            {canEdit && (
              <div className="flex gap-2">
                {g.status !== 'active' ? (
                  <Button size="sm" onClick={() => update.mutate({ status: 'active' })} disabled={update.isPending}>
                    <RotateCcw className="size-4" />
                    恢复为活跃
                  </Button>
                ) : (
                  <>
                    <Button size="sm" onClick={() => setResolveOpen(true)}>
                      <CheckCircle2 className="size-4" />
                      标记已解决
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => update.mutate({ status: 'ignored' })} disabled={update.isPending}>
                      <BellOff className="size-4" />
                      忽略
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{g.template}</pre>
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm md:grid-cols-5">
            <div>
              <dt className="text-xs text-faint">首次出现</dt>
              <dd className="mt-1">{formatTime(g.firstSeen)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">最近出现</dt>
              <dd className="mt-1">
                {formatTime(g.lastSeen)} <span className="text-faint">（{formatRelative(g.lastSeen)}）</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">24 小时 / 累计</dt>
              <dd className="num mt-1">
                {g.count24h.toLocaleString('zh-CN')} / {g.totalCount.toLocaleString('zh-CN')}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-faint">影响主机（{g.hosts.length}）</dt>
              <dd className="mt-1">
                <HostLinks hosts={g.hosts} />
              </dd>
            </div>
          </dl>
          {update.error && (
            <div className="mt-4">
              <ErrorNote error={update.error} />
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="出现次数" hint="最近 24 小时，每 10 分钟" />
        <div className="px-3 pt-2 pb-3">
          <Boundary>
            {!g ? (
              <Skeleton className="h-[180px]" />
            ) : g.count24h === 0 ? (
              <EmptyState title="最近 24 小时没有出现" />
            ) : (
              <MetricChart
                group={`log-${id}`}
                height={180}
                lines={[{ label: '次数', metric: 'log.count', color: g.level === 'fatal' ? '#ef4444' : '#5eead4', series: { name: 'log.count', tag: '', points: g.series.map(([t, n]) => [t, n, n]) } }]}
              />
            )}
          </Boundary>
        </div>
      </Card>

      <Card>
        <CardHeader title="样本" hint="保留首条和最近 20 条；同一指纹每 30 秒最多记录一条。已在 Agent 上打码手机号、邮箱和密钥" />
        <Boundary>
          {!g ? (
            <Skeleton className="m-5 h-32" />
          ) : (
            <ul className="divide-y divide-line">
              {g.samples.map((s) => (
                <Sample key={s.id} s={s} first={s.id === firstSampleId && g.samples.length > 1} />
              ))}
            </ul>
          )}
        </Boundary>
      </Card>

      <Dialog open={resolveOpen} onClose={() => setResolveOpen(false)} title="标记为已解决">
        <p className="text-sm text-muted">当前告警会恢复。之后这个指纹再出现时会按“复发”重新告警。</p>
        <label className="mt-4 block text-xs text-muted" htmlFor="commit">
          修复提交（可选）
        </label>
        <input
          id="commit"
          value={commit}
          onChange={(e) => setCommit(e.target.value)}
          placeholder="如 3f2c1a9"
          maxLength={64}
          className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-sm outline-none focus:border-brand"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResolveOpen(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={() => update.mutate({ status: 'resolved', resolvedCommit: commit.trim() || undefined })} disabled={update.isPending}>
            确认
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
