import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, LayoutDashboard, LogOut, Plus, Server } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { live, useLiveStatus } from '@/lib/live';
import { useMe, useOverviewLiveSync } from '@/lib/queries';
import GradientText from './bits/GradientText';
import { EnrollDialog } from './EnrollDialog';
import { Button, StatusDot } from './ui';

const NAV = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/hosts', label: '主机', icon: Server },
] as const;

/** 顶栏常驻实时连接状态，数据是否新鲜一眼可见（设计文档 8.4）。 */
function LivePill() {
  const status = useLiveStatus();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const label =
    status === 'open'
      ? `实时 · ${live.lastMessageAt ? `${formatRelative(live.lastMessageAt)}更新` : '已连接'}`
      : status === 'connecting'
        ? '正在连接…'
        : '连接中断，正在重连';
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
        status === 'open' ? 'border-ok/25 bg-ok/5 text-ok' : 'border-warn/30 bg-warn/5 text-warn',
      )}
      role="status"
    >
      <StatusDot tone={status === 'open' ? 'ok' : 'warn'} pulse={status === 'open'} />
      {label}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [enrollOpen, setEnrollOpen] = useState(false);
  useOverviewLiveSync();

  useEffect(() => {
    live.start();
    return () => live.stop();
  }, []);

  const logout = async () => {
    await api.post('/api/v1/auth/logout');
    qc.clear();
    await navigate({ to: '/login' });
  };

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/60 md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <Activity className="size-5 text-brand" strokeWidth={2.5} />
          <GradientText colors={['#5eead4', '#818cf8', '#5eead4']} animationSpeed={8} className="text-lg font-bold tracking-tight">
            Pulse
          </GradientText>
        </div>
        <nav className="flex flex-col gap-0.5 px-3 py-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === '/' }}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
              activeProps={{ className: 'bg-white/[0.06] !text-ink' }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-line p-3">
          <div className="flex items-center justify-between rounded-lg px-2 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{me.data?.username ?? '…'}</p>
              <p className="text-xs text-faint">{me.data?.role === 'admin' ? '管理员' : me.data?.role === 'operator' ? '运维' : '只读'}</p>
            </div>
            <button onClick={logout} className="rounded-md p-1.5 text-faint hover:bg-white/5 hover:text-ink" aria-label="退出登录" title="退出登录">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line px-6">
          <LivePill />
          {me.data?.role === 'admin' && (
            <Button variant="primary" size="sm" onClick={() => setEnrollOpen(true)}>
              <Plus className="size-4" />
              添加主机
            </Button>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] p-6">{children}</div>
        </main>
      </div>

      <EnrollDialog open={enrollOpen} onClose={() => setEnrollOpen(false)} />
    </div>
  );
}
