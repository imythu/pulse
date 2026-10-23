import type { HostSummary } from '@pulse/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Cpu, MemoryStick, Radio, ServerOff, Siren } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import AnimatedList from '@/components/bits/AnimatedList';
import CountUp from '@/components/bits/CountUp';
import SpotlightCard from '@/components/bits/SpotlightCard';
import { Boundary, Card, CardHeader, EmptyState, ErrorNote, Meter, Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatPct, formatRelative, formatTime, level } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useHosts, useOverview } from '@/lib/queries';

/** 首次加载时滚动到真实值，之后的实时更新直接跳变，不再播放动画（设计文档 8.2）。 */
function StatNumber({ value, decimals = 0, suffix }: { value: number | null; decimals?: number; suffix?: string }) {
  const [played, setPlayed] = useState(false);
  if (value == null) return <span className="text-faint">—</span>;
  if (played) return <span className="num">{`${value.toFixed(decimals)}${suffix ?? ''}`}</span>;
  return <CountUp to={value} decimals={decimals} suffix={suffix} duration={1.2} trigger="load" className="num" onEnd={() => setPlayed(true)} />;
}

function StatCard({ icon, label, children, hint }: { icon: ReactNode; label: string; children: ReactNode; hint: ReactNode }) {
  return (
    <SpotlightCard theme="dark" spotlightColor="rgba(94, 234, 212, 0.16)" className="rounded-xl border border-line !bg-surface p-5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight">{children}</div>
      <div className="mt-1.5 text-xs text-faint">{hint}</div>
    </SpotlightCard>
  );
}

function hostTone(h: HostSummary) {
  if (h.status === 'offline') return 'off' as const;
  const tones = [level(h.snapshot.cpuPct, 80, 90), level(h.snapshot.memPct, 80, 90), level(h.snapshot.diskPct, 80, 85)];
  return tones.includes('crit') ? 'crit' : tones.includes('warn') ? 'warn' : 'ok';
}

const TILE = { ok: 'bg-ok/70 hover:bg-ok', warn: 'bg-warn/80 hover:bg-warn', crit: 'bg-crit/80 hover:bg-crit', off: 'bg-off/40 hover:bg-off/60' };

/** 主机健康热力格：每台一格，颜色 = 最严重的状态。 */
function HealthGrid({ hosts }: { hosts: HostSummary[] }) {
  const navigate = useNavigate();
  const counts = { ok: 0, warn: 0, crit: 0, off: 0 };
  hosts.forEach((h) => counts[hostTone(h)]++);
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap gap-1.5">
        {hosts.map((h) => (
          <button
            key={h.id}
            onClick={() => navigate({ to: '/hosts/$id', params: { id: h.id } })}
            className={cn('size-7 rounded-md transition-colors', TILE[hostTone(h)])}
            title={`${h.hostname}\nCPU ${formatPct(h.snapshot.cpuPct)} · 内存 ${formatPct(h.snapshot.memPct)} · 磁盘 ${formatPct(h.snapshot.diskPct)}${h.status === 'offline' ? `\n离线，最后上报 ${formatTime(h.lastSeenAt)}` : ''}`}
            aria-label={h.hostname}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><StatusDot tone="ok" />正常 {counts.ok}</span>
        <span className="flex items-center gap-1.5"><StatusDot tone="warn" />偏高 {counts.warn}</span>
        <span className="flex items-center gap-1.5"><StatusDot tone="crit" />严重 {counts.crit}</span>
        <span className="flex items-center gap-1.5"><StatusDot tone="off" />离线 {counts.off}</span>
      </div>
    </div>
  );
}

interface FeedItem {
  id: string;
  title: string;
  description: string;
  at: number;
}

/** 实时事件流：只展示打开页面之后发生的变化。M2 接入告警后会改为读取事件表。 */
function LiveFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  useLive('overview', (e) => {
    if (e.type !== 'host.status' && e.type !== 'host.enrolled') return;
    const title =
      e.type === 'host.enrolled' ? `${e.host.hostname} 已注册` : e.host.status === 'online' ? `${e.host.hostname} 上线` : `${e.host.hostname} 离线`;
    setItems((prev) => [{ id: `${e.host.id}-${e.at}`, title, description: e.host.ips[0] ?? '', at: e.at }, ...prev].slice(0, 50));
  });
  if (!items.length) {
    return (
      <EmptyState icon={<Radio className="size-6" />} title="正在监听">
        主机上线、离线和新注册会实时出现在这里。
      </EmptyState>
    );
  }
  return (
    <div className="p-3">
      <AnimatedList
        items={items.map((i) => ({ id: i.id, title: i.title, description: i.description, meta: formatRelative(i.at) }))}
        animation="slide"
        showGradients
        displayScrollbar={false}
        theme="dark"
        accentColor="#5eead4"
        maxHeight={320}
        width="100%"
      />
    </div>
  );
}

function BusiestHosts({ hosts }: { hosts: HostSummary[] }) {
  const top = hosts
    .filter((h) => h.status === 'online' && h.snapshot.cpuPct != null)
    .sort((a, b) => (b.snapshot.cpuPct ?? 0) - (a.snapshot.cpuPct ?? 0))
    .slice(0, 6);
  if (!top.length) return <EmptyState title="暂无在线主机的指标" />;
  return (
    <ul className="divide-y divide-line">
      {top.map((h) => (
        <li key={h.id}>
          <Link to="/hosts/$id" params={{ id: h.id }} className="grid grid-cols-[1fr_120px_120px] items-center gap-4 px-5 py-3 text-sm hover:bg-white/[0.02]">
            <span className="truncate font-medium">{h.hostname}</span>
            <span className="flex flex-col gap-1">
              <span className="num text-xs text-muted">CPU {formatPct(h.snapshot.cpuPct)}</span>
              <Meter value={h.snapshot.cpuPct} tone={level(h.snapshot.cpuPct)} />
            </span>
            <span className="flex flex-col gap-1">
              <span className="num text-xs text-muted">内存 {formatPct(h.snapshot.memPct)}</span>
              <Meter value={h.snapshot.memPct} tone={level(h.snapshot.memPct)} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  const hosts = useHosts();
  // 主机数和平均值从主机列表算出：它由实时事件持续更新，和下方列表永远一致
  const o = useMemo(() => {
    if (!hosts.data || !overview.data) return undefined;
    const online = hosts.data.filter((h) => h.status === 'online');
    const avg = (pick: (h: HostSummary) => number | null) => {
      const vals = online.map(pick).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    return {
      hostsTotal: hosts.data.length,
      hostsOnline: online.length,
      avgCpuPct: avg((h) => h.snapshot.cpuPct),
      avgMemPct: avg((h) => h.snapshot.memPct),
      openIncidents: overview.data.openIncidents,
    };
  }, [hosts.data, overview.data]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">总览</h1>
        <p className="mt-1 text-sm text-muted">所有主机的实时状态。指标按 1 分钟窗口聚合，CPU 与内存为在线主机的平均值。</p>
      </div>

      {overview.error ? (
        <ErrorNote error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {!o ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[126px] rounded-xl" />)
          ) : (
            <>
              <StatCard icon={<Radio className="size-3.5" />} label="在线主机" hint={`共 ${o.hostsTotal} 台，离线 ${o.hostsTotal - o.hostsOnline} 台`}>
                <StatNumber value={o.hostsOnline} />
                <span className="text-lg text-faint"> / {o.hostsTotal}</span>
              </StatCard>
              <StatCard icon={<Cpu className="size-3.5" />} label="平均 CPU" hint="最近一个窗口">
                <StatNumber value={o.avgCpuPct} decimals={1} suffix="%" />
              </StatCard>
              <StatCard icon={<MemoryStick className="size-3.5" />} label="平均内存" hint="按 available 计算">
                <StatNumber value={o.avgMemPct} decimals={1} suffix="%" />
              </StatCard>
              <StatCard icon={<Siren className="size-3.5" />} label="打开的 Incident" hint="告警与去重将在 M2 启用">
                <StatNumber value={o.openIncidents} />
              </StatCard>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="主机健康" hint="每格一台主机，颜色为 CPU、内存、磁盘中最严重的状态；点击进入详情" />
          <Boundary>
            {hosts.isLoading ? (
              <div className="p-5"><Skeleton className="h-20" /></div>
            ) : hosts.error ? (
              <div className="p-5"><ErrorNote error={hosts.error} onRetry={() => hosts.refetch()} /></div>
            ) : hosts.data?.length ? (
              <HealthGrid hosts={hosts.data} />
            ) : (
              <EmptyState icon={<ServerOff className="size-6" />} title="还没有主机">
                点击右上角“添加主机”，在目标机器上执行一条安装命令即可接入。
              </EmptyState>
            )}
          </Boundary>
        </Card>
        <Card>
          <CardHeader title="实时事件" hint="主机状态变化" />
          <Boundary>
            <LiveFeed />
          </Boundary>
        </Card>
      </div>

      <Card>
        <CardHeader title="CPU 占用最高的主机" hint="最近一个窗口的平均值" />
        <Boundary>{hosts.data ? <BusiestHosts hosts={hosts.data} /> : <div className="p-5"><Skeleton className="h-32" /></div>}</Boundary>
      </Card>
    </div>
  );
}
