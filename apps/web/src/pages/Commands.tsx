import type { CommandInfo } from '@pulse/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ShieldAlert, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApprovalActions, CommandListEmpty, CommandOutput, commandText, CommandStatusBadge, RiskBadge } from '@/components/commands';
import { Badge, Boundary, Button, Card, CardHeader, ErrorNote, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative, formatTime } from '@/lib/format';
import { useCommand, useCommands, type CommandFilter } from '@/lib/queries';

const FILTERS: { value: CommandFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '执行中' },
  { value: 'pending_approval', label: '待审批' },
];

function PendingApprovals() {
  const pending = useCommands('pending_approval', undefined, 100);
  const items = pending.data?.pages.flatMap((p) => p.items) ?? [];
  if (!pending.data || items.length === 0) return null;
  return (
    <Card className="border-warn/30">
      <CardHeader title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-warn" />待审批的写操作</span>} hint="写操作需要管理员批准后才会签名下发，批准后 5 分钟内有效" />
      <ul className="divide-y divide-line">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <Link to="/commands/$id" params={{ id: c.id }} className="font-mono text-sm hover:text-brand">
                {commandText(c)}
              </Link>
              <p className="mt-1 text-xs text-faint">
                {c.hostname} · {c.requestedByName} 发起于 {formatRelative(c.createdAt)}
                {c.reason && <> · 原因：<span className="text-muted">{c.reason}</span></>}
              </p>
            </div>
            <ApprovalActions command={c} compact />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function CommandsPage() {
  const [filter, setFilter] = useState<CommandFilter>('all');
  const list = useCommands(filter);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">指令</h1>
        <p className="mt-1 text-sm text-muted">在主机上执行的排查指令。只读指令直接执行，写操作需要管理员审批；所有指令都经服务器签名，由 Agent 验签后执行。</p>
      </div>

      <Boundary>
        <PendingApprovals />
      </Boundary>

      <div className="flex self-start rounded-lg border border-line bg-surface p-0.5 text-xs">
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
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <CommandListEmpty pending={filter === 'pending_approval'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-faint">
                  <th className="px-5 py-3 font-medium">#</th>
                  <th className="px-3 py-3 font-medium">指令</th>
                  <th className="px-3 py-3 font-medium">主机</th>
                  <th className="px-3 py-3 font-medium">状态</th>
                  <th className="px-3 py-3 font-medium">发起人</th>
                  <th className="px-5 py-3 text-right font-medium">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-white/[0.02]" onClick={() => navigate({ to: '/commands/$id', params: { id: c.id } })}>
                    <td className="num px-5 py-3 text-faint">{c.no}</td>
                    <td className="max-w-[420px] px-3 py-3">
                      <div className="flex items-center gap-2">
                        <code className="truncate font-mono text-xs">{commandText(c)}</code>
                        {c.risk === 'write' && <RiskBadge risk="write" />}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted">{c.hostname ?? '已删除'}</td>
                    <td className="px-3 py-3">
                      <CommandStatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-3 text-muted">{c.requestedByName}</td>
                    <td className="px-5 py-3 text-right text-xs text-faint" title={formatTime(c.createdAt)}>
                      {formatRelative(c.createdAt)}
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
              加载更多
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function Timeline({ c }: { c: CommandInfo }) {
  const rows: [string, number | null][] = [
    ['发起', c.createdAt],
    ['开始执行', c.startedAt],
    ['结束', c.finishedAt],
  ];
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {rows.map(([label, t]) => (
        <Field key={label} label={label}>
          {t ? (
            <span title={formatRelative(t)} className="num">
              {formatTime(t)}
            </span>
          ) : (
            <span className="text-faint">—</span>
          )}
        </Field>
      ))}
    </dl>
  );
}

export function CommandDetailPage() {
  const { id } = useParams({ from: '/app/commands/$id' });
  const command = useCommand(id);
  const c = command.data;
  return (
    <div className="flex flex-col gap-6">
      <Link to="/commands" className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        指令
      </Link>
      {command.error && <ErrorNote error={command.error} onRetry={() => command.refetch()} />}
      {!c ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-faint">
                  <Terminal className="size-3.5" />
                  指令 #{c.no}
                </div>
                <h1 className="mt-1 font-mono text-lg break-all">{commandText(c)}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <CommandStatusBadge status={c.status} />
                  <RiskBadge risk={c.risk} />
                  {c.selfApproved && <Badge className="border-warn/40 text-warn">自审</Badge>}
                </div>
              </div>
              <ApprovalActions command={c} />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 md:grid-cols-4">
              <Field label="主机">
                {c.hostname ? (
                  <Link to="/hosts/$id" params={{ id: c.hostId }} className="hover:text-brand">
                    {c.hostname}
                  </Link>
                ) : (
                  '已删除'
                )}
              </Field>
              <Field label="发起人">{c.requestedByName}</Field>
              <Field label="审批">
                {c.approvalStatus === 'none'
                  ? '只读，无需审批'
                  : c.approvalStatus === 'pending'
                    ? '等待审批'
                    : `${c.approvedByName ?? '—'} ${c.approvalStatus === 'approved' ? '批准' : '拒绝'}${c.rejectReason ? `：${c.rejectReason}` : ''}`}
              </Field>
              <Field label="关联">
                {c.incidentId ? (
                  <Link to="/incidents/$id" params={{ id: c.incidentId }} className="hover:text-brand">
                    Incident
                  </Link>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Field>
              {c.reason && (
                <div className="col-span-2 md:col-span-4">
                  <Field label="原因">{c.reason}</Field>
                </div>
              )}
            </dl>
            <div className="mt-5 border-t border-line pt-5">
              <Timeline c={c} />
            </div>
          </Card>
          <Card>
            <CardHeader title="输出" hint="执行中实时追加；完整输出以 Agent 回报的结果为准" />
            <div className="p-5">
              <CommandOutput command={c} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
