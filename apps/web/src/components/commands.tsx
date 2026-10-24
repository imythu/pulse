// 指令终端与指令记录（设计文档 3.5、8.3）：只能选指令模板、填参数，不能输入任意命令。
import type { CommandInfo, CommandStatus, CommandTemplate } from '@pulse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Ban, Check, Loader2, Play, ShieldAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { keys, useCommand, useCommands, useCommandTemplates, useMe } from '@/lib/queries';
import { Badge, Button, EmptyState, ErrorNote, Skeleton, StatusDot } from './ui';

const STATUS: Record<CommandStatus, { label: string; tone: 'ok' | 'warn' | 'crit' | 'off' | 'run' }> = {
  pending_approval: { label: '待审批', tone: 'warn' },
  queued: { label: '排队中', tone: 'run' },
  sent: { label: '已下发', tone: 'run' },
  running: { label: '执行中', tone: 'run' },
  succeeded: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'crit' },
  timeout: { label: '超时', tone: 'crit' },
  rejected: { label: '已拒绝', tone: 'crit' },
  canceled: { label: '已取消', tone: 'off' },
  expired: { label: '已过期', tone: 'off' },
};

export function CommandStatusBadge({ status }: { status: CommandStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        s.tone === 'ok' && 'text-ok',
        s.tone === 'warn' && 'text-warn',
        s.tone === 'crit' && 'text-crit',
        s.tone === 'off' && 'text-faint',
        s.tone === 'run' && 'text-brand',
      )}
    >
      {s.tone === 'run' ? <Loader2 className="size-3 animate-spin" /> : <StatusDot tone={s.tone} />}
      {s.label}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: 'read' | 'write' }) {
  return risk === 'write' ? (
    <Badge className="border-warn/40 bg-warn/10 text-warn">
      <ShieldAlert className="size-3" />
      写操作
    </Badge>
  ) : (
    <Badge>只读</Badge>
  );
}

/** 指令的一行文字表示：模板名 + 参数，如 log.tail source=/var/log/app.log n=200。 */
export function commandText(c: Pick<CommandInfo, 'template' | 'args'>) {
  const args = Object.entries(c.args)
    .map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`)
    .join(' ');
  return `${c.template}${args ? ` ${args}` : ''}`;
}

export function CommandOutput({ command, className }: { command: CommandInfo; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const running = command.status === 'running' || command.status === 'sent' || command.status === 'queued';
  useEffect(() => {
    const el = ref.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [command.output, running]);
  const text = command.output ?? '';
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <pre ref={ref} className="max-h-[420px] min-h-24 overflow-auto rounded-lg border border-line bg-black/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink/90">
        {text || (running ? '等待输出…' : command.status === 'pending_approval' ? '审批通过后才会下发执行。' : '（没有输出）')}
      </pre>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <CommandStatusBadge status={command.status} />
        {command.exitCode != null && <span className="num">退出码 {command.exitCode}</span>}
        {command.durationMs != null && <span className="num">耗时 {(command.durationMs / 1000).toFixed(2)} 秒</span>}
        {command.truncated && <span className="text-warn">输出超过 1 MB，已截断</span>}
        {command.error && <span className="text-crit">{command.error}</span>}
      </div>
    </div>
  );
}

function ParamInput({ p, value, onChange }: { p: CommandTemplate['params'][number]; value: string; onChange: (v: string) => void }) {
  const cls = 'h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none focus:border-brand/60';
  return (
    <label className="flex min-w-[160px] flex-1 flex-col gap-1">
      <span className="text-xs text-muted">
        {p.label || p.name}
        {p.required && <span className="text-crit"> *</span>}
      </span>
      {p.type === 'enum' ? (
        <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
          {p.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={cn(cls, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={p.hint ?? p.default ?? ''}
          inputMode={p.type === 'int' ? 'numeric' : undefined}
          spellCheck={false}
        />
      )}
    </label>
  );
}

/** 主机详情页的指令终端：选模板 → 填参数 → 执行，下方实时显示输出。 */
export function CommandConsole({ hostId, offline }: { hostId: string; offline: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const templates = useCommandTemplates(hostId);
  const recent = useCommands('all', hostId, 10);
  const all = useMemo(() => [...(templates.data?.builtin ?? []), ...(templates.data?.custom ?? [])], [templates.data]);
  const [name, setName] = useState('proc.top');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const tpl = all.find((t) => t.name === name);
  const command = useCommand(selected);
  const canRun = me.data && me.data.role !== 'viewer';

  useEffect(() => {
    if (!tpl) return;
    setArgs(Object.fromEntries(tpl.params.map((p) => [p.name, p.type === 'enum' ? (p.default ?? p.options?.[0] ?? '') : ''])));
  }, [tpl]);

  const run = useMutation({
    mutationFn: () => api.post<CommandInfo>('/api/v1/commands', { hostId, template: name, args, reason }),
    onSuccess: (c) => {
      qc.setQueryData(keys.command(c.id), c);
      setSelected(c.id);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['commands'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };

  const items = recent.data?.pages[0]?.items ?? [];
  return (
    <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {!templates.data ? (
          <Skeleton className="h-20" />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[200px] flex-col gap-1">
                <span className="text-xs text-muted">指令模板</span>
                <select
                  className="h-9 rounded-lg border border-line bg-surface-2 px-3 font-mono text-sm outline-none focus:border-brand/60"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                >
                  <optgroup label="内置">
                    {templates.data.builtin.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                        {t.risk === 'write' ? '（写操作）' : ''}
                      </option>
                    ))}
                  </optgroup>
                  {templates.data.custom.length > 0 && (
                    <optgroup label="本机自定义">
                      {templates.data.custom.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              {tpl?.params.map((p) => (
                <ParamInput key={p.name} p={p} value={args[p.name] ?? ''} onChange={(v) => setArgs((a) => ({ ...a, [p.name]: v }))} />
              ))}
            </div>
            {tpl && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
                <RiskBadge risk={tpl.risk} />
                <span>{tpl.description}</span>
                <span className="num">· 超时 {tpl.timeoutSeconds} 秒</span>
              </div>
            )}
            {tpl?.risk === 'write' && (
              <input
                className="h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none focus:border-brand/60"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="执行原因（审批人会看到）"
              />
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" size="sm" disabled={!canRun || run.isPending || !tpl}>
                <Play className="size-3.5" />
                {tpl?.risk === 'write' ? '提交审批' : '执行'}
              </Button>
              {!canRun && <span className="text-xs text-faint">只读账号不能下发指令</span>}
              {offline && canRun && <span className="text-xs text-warn">主机离线：指令会排队，5 分钟内连上才会执行</span>}
            </div>
            {run.error && <ErrorNote error={run.error} />}
          </form>
        )}
        {command.data ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <code className="truncate font-mono text-muted">$ {commandText(command.data)}</code>
              <Link to="/commands/$id" params={{ id: command.data.id }} className="shrink-0 text-faint hover:text-brand">
                #{command.data.no} 详情
              </Link>
            </div>
            <CommandOutput command={command.data} />
          </div>
        ) : (
          <p className="text-xs text-faint">输出会在这里实时显示。所有指令都由服务器签名后下发，Agent 验签、校验参数后直接执行，不经过 shell。</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs font-medium text-muted">最近的指令</p>
        {items.length === 0 ? (
          <p className="text-xs text-faint">还没有在这台主机上执行过指令。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={cn('flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.04]', selected === c.id && 'bg-white/[0.06]')}
                >
                  <code className="truncate font-mono text-xs">{commandText(c)}</code>
                  <span className="flex items-center gap-2 text-[11px] text-faint">
                    <CommandStatusBadge status={c.status} />
                    <span title={formatTime(c.createdAt)}>{formatRelative(c.createdAt)}</span>
                    <span>· {c.requestedByName}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 审批按钮：只对管理员显示；发起人自审时提示会在审计中标记。 */
export function ApprovalActions({ command, compact }: { command: CommandInfo; compact?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: (op: 'approve' | 'reject' | 'cancel') => api.post<CommandInfo>(`/api/v1/commands/${command.id}/${op}`, op === 'reject' ? { reason } : {}),
    onSuccess: (c) => {
      qc.setQueryData(keys.command(c.id), c);
      void qc.invalidateQueries({ queryKey: ['commands'] });
      void qc.invalidateQueries({ queryKey: keys.overview });
      setRejecting(false);
    },
  });
  if (command.status !== 'pending_approval') return null;
  const isAdmin = me.data?.role === 'admin';
  const own = me.data && command.requestedBy === `user:${me.data.id}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <>
            <Button size="sm" variant="primary" onClick={() => act.mutate('approve')} disabled={act.isPending}>
              <Check className="size-3.5" />
              批准{own ? '（自审）' : ''}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setRejecting((v) => !v)} disabled={act.isPending}>
              <X className="size-3.5" />
              拒绝
            </Button>
          </>
        )}
        {(isAdmin || own) && !compact && (
          <Button size="sm" variant="ghost" onClick={() => act.mutate('cancel')} disabled={act.isPending}>
            <Ban className="size-3.5" />
            撤回
          </Button>
        )}
        {!isAdmin && <span className="text-xs text-faint">等待管理员审批</span>}
      </div>
      {own && isAdmin && <p className="text-xs text-faint">只有一位管理员时允许自审，审计中会标记为自审。</p>}
      {rejecting && (
        <div className="flex gap-2">
          <input
            className="h-8 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-xs outline-none focus:border-brand/60"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="拒绝原因"
            autoFocus
          />
          <Button size="sm" variant="danger" onClick={() => act.mutate('reject')} disabled={act.isPending}>
            确认拒绝
          </Button>
        </div>
      )}
      {act.error && <ErrorNote error={act.error} />}
    </div>
  );
}

export function CommandListEmpty({ pending }: { pending?: boolean }) {
  return <EmptyState title={pending ? '没有待审批的写操作' : '还没有执行过指令'}>{pending ? '运维发起的写操作（如重启服务）会出现在这里。' : '在主机详情页的指令终端里选择模板执行。'}</EmptyState>;
}
