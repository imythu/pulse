import { Metric, type AlertInfo, type MetricSeries, type MetricsResponse, type ProcessInfo, type RuleInfo } from '@pulse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AlertTags, alertValueText, incidentDuration, SeverityBadge, Sparkline } from '@/components/alerting';
import { MetricChart, type ChartBand } from '@/components/MetricChart';
import { Badge, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorNote, Skeleton, StatusDot } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, formatPct, formatRelative, formatTime } from '@/lib/format';
import { useLive } from '@/lib/live';
import { keys, useHost, useHostAlerts, useIncidents, useLogGroups, useMe, useMetrics, useRules } from '@/lib/queries';

const RANGES = [
  { label: '1 小时', ms: 3600_000 },
  { label: '6 小时', ms: 6 * 3600_000 },
  { label: '24 小时', ms: 24 * 3600_000 },
  { label: '7 天', ms: 7 * 24 * 3600_000 },
];
const LIVE_RANGE = RANGES[0]!.ms;

const C = { teal: '#5eead4', indigo: '#818cf8', amber: '#fbbf24', pink: '#f472b6', sky: '#38bdf8' };
const PALETTE = [C.teal, C.indigo, C.amber, C.pink, C.sky];

function pick(series: MetricSeries[] | undefined, name: string, tag = '') {
  return series?.find((s) => s.name === name && s.tag === tag);
}

/** 把一个窗口的新数据合并进 1 小时视图的缓存；同一窗口的提前推送会被完整数据替换。 */
function mergeWindow(prev: MetricsResponse | undefined, incoming: MetricSeries[]): MetricsResponse | undefined {
  if (!prev) return prev;
  const series = prev.series.map((s) => ({ ...s, points: s.points.slice() }));
  for (const inc of incoming) {
    let s = series.find((x) => x.name === inc.name && x.tag === inc.tag);
    if (!s) series.push((s = { name: inc.name, tag: inc.tag, points: [] }));
    for (const p of inc.points) {
      const i = s.points.findIndex((q) => q[0] === p[0]);
      if (i >= 0) s.points[i] = p;
      else s.points.push(p);
    }
    const cutoff = Date.now() - LIVE_RANGE;
    s.points = s.points.filter((q) => q[0] >= cutoff);
  }
  return { ...prev, to: Date.now(), series };
}

/** 图表的告警阈值取自对应规则，规则停用时不画。 */
function thresholdOf(rules: RuleInfo[] | undefined, metric: string): number | undefined {
  const r = rules?.find((x) => x.kind === 'threshold' && x.metric === metric && x.enabled);
  return r?.params.threshold;
}

/** 某个指标相关规则的告警区间，未恢复的画到现在。 */
function bandsOf(alerts: AlertInfo[] | undefined, rules: RuleInfo[] | undefined, metric: string): ChartBand[] {
  const ids = new Set(rules?.filter((r) => r.metric === metric).map((r) => r.id));
  return (alerts ?? [])
    .filter((a) => a.ruleId && ids.has(a.ruleId))
    .map((a) => ({ from: a.startedAt, to: a.resolvedAt ?? Date.now(), severity: a.severity }));
}

function HostAlerts({ hostId, alerts, rules }: { hostId: string; alerts: AlertInfo[] | undefined; rules: RuleInfo[] | undefined }) {
  const incidents = useIncidents('all', hostId, 5);
  const firing = alerts?.filter((a) => a.state === 'firing') ?? [];
  const recent = incidents.data?.pages[0]?.items;
  return (
    <Card>
      <CardHeader title="告警" hint={firing.length ? `${firing.length} 条未恢复` : '当前没有未恢复的告警'} />
      <Boundary>
        {firing.length > 0 && (
          <ul className="divide-y divide-line border-b border-line">
            {firing.map((a) => (
              <li key={a.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <SeverityBadge severity={a.severity} />
                  {a.incidentId ? (
                    <Link to="/incidents/$id" params={{ id: a.incidentId }} className="font-medium hover:text-brand">
                      {a.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{a.title}</span>
                  )}
                  <AlertTags alert={a} />
                </div>
                <p className="num mt-1 text-xs text-muted">
                  {[alertValueText(a, rules?.find((r) => r.id === a.ruleId)?.metric ?? null), `${formatRelative(a.startedAt)}开始`].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="px-5 pt-3 pb-1 text-xs text-faint">最近的 Incident</div>
        {!recent ? (
          <Skeleton className="mx-5 my-3 h-16" />
        ) : !recent.length ? (
          <p className="px-5 pb-4 text-sm text-muted">这台主机还没有产生过 Incident。</p>
        ) : (
          <ul className="pb-2">
            {recent.map((i) => (
              <li key={i.id}>
                <Link to="/incidents/$id" params={{ id: i.id }} className="flex items-center gap-3 px-5 py-2 text-sm hover:bg-white/[0.02]">
                  <StatusDot tone={i.status === 'resolved' ? 'ok' : i.severity === 'critical' ? 'crit' : 'warn'} />
                  <span className="num text-xs text-faint">#{i.no}</span>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="shrink-0 text-xs text-faint">
                    {formatRelative(i.openedAt)} · {incidentDuration(i)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Boundary>
    </Card>
  );
}

function HostLogs({ hostId }: { hostId: string }) {
  const groups = useLogGroups({ status: 'active', hostId });
  const items = groups.data?.items.slice(0, 6);
  return (
    <Card>
      <CardHeader
        title="日志指纹"
        hint="这台主机出现过的异常日志"
        action={
          <Link to="/logs" className="text-xs text-brand hover:underline">
            全部
          </Link>
        }
      />
      <Boundary>
        {!items ? (
          <Skeleton className="m-5 h-16" />
        ) : !items.length ? (
          <p className="px-5 py-4 text-sm text-muted">没有活跃的异常日志。</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((g) => (
              <li key={g.id}>
                <Link to="/logs/$id" params={{ id: g.id }} className="flex items-center gap-3 px-5 py-2.5 hover:bg-white/[0.02]">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted">{g.service}</div>
                    <div className="truncate font-mono text-xs">{g.template.split('\n')[0]}</div>
                  </div>
                  <Sparkline values={g.hourly} tone={g.level === 'fatal' ? 'crit' : 'brand'} />
                  <span className="num w-16 text-right text-xs text-muted">{g.count24h.toLocaleString('zh-CN')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Boundary>
    </Card>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-1 truncate text-sm">{children}</dd>
    </div>
  );
}

function ProcsTable({ procs }: { procs: ProcessInfo[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-faint">
            <th className="px-5 py-2.5 font-medium">PID</th>
            <th className="px-3 py-2.5 font-medium">进程</th>
            <th className="px-3 py-2.5 font-medium">用户</th>
            <th className="px-3 py-2.5 text-right font-medium">CPU（单核 %）</th>
            <th className="px-3 py-2.5 text-right font-medium">内存</th>
            <th className="px-5 py-2.5 text-right font-medium">RSS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {procs.map((p) => (
            <tr key={p.pid}>
              <td className="num px-5 py-2 text-xs text-faint">{p.pid}</td>
              <td className="max-w-md px-3 py-2">
                <div className="font-medium">{p.name}</div>
                <div className="truncate font-mono text-[11px] text-faint" title={p.cmdline}>
                  {p.cmdline || '—'}
                </div>
              </td>
              <td className="px-3 py-2 text-xs text-muted">{p.user || '—'}</td>
              <td className="num px-3 py-2 text-right text-xs">{p.cpuPct.toFixed(1)}</td>
              <td className="num px-3 py-2 text-right text-xs">{formatPct(p.memPct)}</td>
              <td className="num px-5 py-2 text-right text-xs">{formatBytes(p.rssBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HostDetailPage() {
  const { id } = useParams({ from: '/app/hosts/$id' });
  const host = useHost(id);
  const me = useMe();
  const [range, setRange] = useState(LIVE_RANGE);
  const metrics = useMetrics(id, range);
  const rules = useRules();
  const alerts = useHostAlerts(id, range);
  const [procTab, setProcTab] = useState<'byCpu' | 'byMem'>('byCpu');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useLive(`host:${id}`, (e) => {
    if (e.type === 'metrics') {
      qc.setQueryData<MetricsResponse>(keys.metrics(id, LIVE_RANGE), (prev) => mergeWindow(prev, e.series));
    } else if (e.type === 'procs') {
      qc.setQueryData(keys.host(id), (prev: typeof host.data) => (prev ? { ...prev, procs: e.procs } : prev));
    }
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/v1/hosts/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.hosts });
      await navigate({ to: '/hosts' });
    },
  });

  if (host.error) return <ErrorNote error={host.error} onRetry={() => host.refetch()} />;
  const h = host.data;
  const s = metrics.data?.series;
  const disks = s?.filter((x) => x.name === Metric.diskUsed) ?? [];
  const off = h?.status === 'offline';

  return (
    <div className="flex flex-col gap-6">
      <Link to="/hosts" className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        主机
      </Link>

      {!h ? (
        <Skeleton className="h-36 rounded-xl" />
      ) : (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold tracking-tight">{h.hostname}</h1>
                <span className={cn('flex items-center gap-1.5 text-xs', off ? 'text-faint' : 'text-ok')}>
                  <StatusDot tone={off ? 'off' : 'ok'} pulse={!off} />
                  {off ? `离线 · 最后上报 ${formatTime(h.lastSeenAt)}` : `在线 · ${formatRelative(h.lastSeenAt)}上报`}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {h.ips.map((ip) => (
                  <Badge key={ip} className="font-mono">
                    {ip}
                  </Badge>
                ))}
                {Object.entries(h.labels).map(([k, v]) => (
                  <Badge key={k}>
                    {k}={v}
                  </Badge>
                ))}
              </div>
            </div>
            {me.data?.role === 'admin' && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" />
                移除主机
              </Button>
            )}
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 md:grid-cols-3 xl:grid-cols-6">
            <InfoItem label="系统">{h.platform || h.os}</InfoItem>
            <InfoItem label="内核">{h.info?.kernel ?? '—'}</InfoItem>
            <InfoItem label="CPU">
              <span title={h.info?.cpuModel}>
                {h.info?.cpuCores} 核 · {h.info?.cpuModel ?? '—'}
              </span>
            </InfoItem>
            <InfoItem label="内存">{h.info ? formatBytes(h.info.memTotal) : '—'}</InfoItem>
            <InfoItem label="开机时长">{h.info?.bootTime ? formatDuration((Date.now() - h.info.bootTime) / 1000) : '—'}</InfoItem>
            <InfoItem label="Agent">
              <span className="num">
                {h.agentVersion} · {h.arch}
              </span>
            </InfoItem>
          </dl>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <HostAlerts hostId={id} alerts={alerts.data} rules={rules.data} />
        <HostLogs hostId={id} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint">
          {metrics.data ? `聚合粒度 ${metrics.data.stepSeconds >= 3600 ? `${metrics.data.stepSeconds / 3600} 小时` : `${metrics.data.stepSeconds / 60} 分钟`} · 曲线为窗口平均值` : '加载指标…'}
          {range === LIVE_RANGE && ' · 实时追加'}
          {' · 红黄色带为告警区间'}
        </p>
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          {RANGES.map((r) => (
            <button key={r.ms} onClick={() => setRange(r.ms)} className={cn('rounded-md px-3 py-1.5 text-muted', range === r.ms && 'bg-white/[0.08] text-ink')}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {metrics.error && <ErrorNote error={metrics.error} onRetry={() => metrics.refetch()} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {[
          {
            title: 'CPU',
            threshold: thresholdOf(rules.data, Metric.cpuUsage),
            bands: bandsOf(alerts.data, rules.data, Metric.cpuUsage),
            max: 100,
            lines: [
              { label: '使用率', metric: Metric.cpuUsage, series: pick(s, Metric.cpuUsage), color: C.teal },
              { label: 'iowait', metric: Metric.cpuIowait, series: pick(s, Metric.cpuIowait), color: C.amber },
            ],
          },
          {
            title: '内存',
            threshold: thresholdOf(rules.data, Metric.memUsed),
            bands: bandsOf(alerts.data, rules.data, Metric.memUsed),
            max: 100,
            lines: [
              { label: '内存', metric: Metric.memUsed, series: pick(s, Metric.memUsed), color: C.indigo },
              { label: 'Swap', metric: Metric.swapUsed, series: pick(s, Metric.swapUsed), color: C.pink },
            ],
          },
          {
            title: '磁盘使用率',
            threshold: thresholdOf(rules.data, Metric.diskUsed),
            bands: bandsOf(alerts.data, rules.data, Metric.diskUsed),
            max: 100,
            lines: disks.map((d, i) => ({ label: d.tag, metric: Metric.diskUsed, series: d, color: PALETTE[i % PALETTE.length]! })),
          },
          {
            title: 'Load',
            lines: [
              { label: '1m', metric: Metric.load1, series: pick(s, Metric.load1), color: C.teal },
              { label: '5m', metric: Metric.load5, series: pick(s, Metric.load5), color: C.indigo },
              { label: '15m', metric: Metric.load15, series: pick(s, Metric.load15), color: C.amber },
            ],
          },
          {
            title: '网络',
            lines: [
              { label: '入', metric: Metric.netRxBps, series: pick(s, Metric.netRxBps), color: C.sky },
              { label: '出', metric: Metric.netTxBps, series: pick(s, Metric.netTxBps), color: C.pink },
            ],
          },
          {
            title: '磁盘 IO',
            lines: [
              { label: '读', metric: Metric.diskReadBps, series: pick(s, Metric.diskReadBps), color: C.teal },
              { label: '写', metric: Metric.diskWriteBps, series: pick(s, Metric.diskWriteBps), color: C.amber },
            ],
          },
          {
            title: 'TCP 连接',
            lines: [
              { label: 'ESTABLISHED', metric: Metric.tcpEstablished, series: pick(s, Metric.tcpEstablished), color: C.indigo },
              { label: 'TIME_WAIT', metric: Metric.tcpTimeWait, series: pick(s, Metric.tcpTimeWait), color: C.amber },
            ],
          },
        ].map((chart) => (
          <Card key={chart.title}>
            <CardHeader title={chart.title} />
            <div className="px-3 pt-2 pb-3">
              <Boundary>
                {!metrics.data ? (
                  <Skeleton className="h-[200px]" />
                ) : chart.lines.every((l) => !l.series?.points.length) ? (
                  <EmptyState title="该时间范围内没有数据">{off ? '主机离线中。' : 'Agent 每分钟上报一次，稍等片刻。'}</EmptyState>
                ) : (
                  <MetricChart group={`host-${id}`} lines={chart.lines} threshold={chart.threshold} bands={chart.bands} max={chart.max} />
                )}
              </Boundary>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Top 进程"
          hint={h?.procs ? `快照时间 ${formatTime(h.procs.at)}（${formatRelative(h.procs.at)}）` : 'Agent 每 30 秒上报一次'}
          action={
            <div className="flex rounded-lg border border-line bg-surface-2 p-0.5 text-xs">
              {(['byCpu', 'byMem'] as const).map((t) => (
                <button key={t} onClick={() => setProcTab(t)} className={cn('rounded-md px-3 py-1 text-muted', procTab === t && 'bg-white/[0.08] text-ink')}>
                  {t === 'byCpu' ? '按 CPU' : '按内存'}
                </button>
              ))}
            </div>
          }
        />
        <Boundary>{h?.procs ? <ProcsTable procs={h.procs[procTab]} /> : <EmptyState title="暂无进程快照" />}</Boundary>
      </Card>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="移除主机">
        <p className="text-sm text-muted">
          将吊销 <b className="text-ink">{h?.hostname}</b> 的 Agent 凭证并删除它的所有记录。Agent 会立即断开且不再重连；如需重新接入，请卸载后重新安装。
        </p>
        {remove.error && <div className="mt-4"><ErrorNote error={remove.error} /></div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            取消
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            确认移除
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
