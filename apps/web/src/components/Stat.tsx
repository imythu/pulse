import { useState, type ReactNode } from 'react';
import CountUp from './bits/CountUp';
import SpotlightCard from './bits/SpotlightCard';

/** 首次加载时滚动到真实值，之后的实时更新直接跳变，不再播放动画（设计文档 8.2）。 */
export function StatNumber({ value, decimals = 0, suffix }: { value: number | null; decimals?: number; suffix?: string }) {
  const [played, setPlayed] = useState(false);
  if (value == null) return <span className="text-faint">—</span>;
  if (played) return <span className="num">{`${value.toFixed(decimals)}${suffix ?? ''}`}</span>;
  return <CountUp to={value} decimals={decimals} suffix={suffix} duration={1.2} trigger="load" className="num" onEnd={() => setPlayed(true)} />;
}

export function StatCard({ icon, label, children, hint }: { icon: ReactNode; label: string; children: ReactNode; hint: ReactNode }) {
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
