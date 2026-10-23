import { Component, useEffect, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { level } from '@/lib/format';

type Level = ReturnType<typeof level>;

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-brand text-bg hover:brightness-110',
        variant === 'default' && 'border border-line bg-surface-2 text-ink hover:bg-white/5',
        variant === 'ghost' && 'text-muted hover:bg-white/5 hover:text-ink',
        variant === 'danger' && 'border border-crit/40 bg-crit/10 text-crit hover:bg-crit/20',
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-surface', className)}>{children}</div>;
}

export function CardHeader({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

const DOT: Record<Level | 'off', string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  none: 'bg-off',
  off: 'bg-off',
};

export function StatusDot({ tone, pulse }: { tone: Level | 'off'; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2">
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted', className)}>
      {children}
    </span>
  );
}

/** 使用率条：颜色只表达状态，不做装饰。 */
export function Meter({ value, tone, className }: { value: number | null; tone: Level; className?: string }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', none: 'bg-off' }[tone];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${Math.min(100, value ?? 0)}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-white/[0.05]', className)} />;
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-sm text-xs leading-relaxed text-faint">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-crit/30 bg-crit/5 px-4 py-3 text-sm">
      <span className="text-crit">{error instanceof Error ? error.message : '加载失败'}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

/** 每个卡片独立的错误边界：局部失败不拖垮整页（设计文档 8.4）。 */
export class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return <ErrorNote error={this.state.error} onRetry={() => this.setState({ error: undefined })} />;
    }
    return this.props.children;
  }
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className="relative w-full max-w-xl rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-faint hover:bg-white/5 hover:text-ink" aria-label="关闭">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
