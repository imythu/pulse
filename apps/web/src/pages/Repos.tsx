// 仓库页（设计文档 7、8.3）：gh 引导向导、已绑定仓库、服务绑定与部署版本。
import type { GhStatus, GhStep, RepoInfo, ServiceInfo } from '@pulse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, ExternalLink, GitBranch, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Boundary, Button, Card, CardHeader, EmptyState, ErrorNote, Skeleton, StatusDot } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatRelative, formatTime } from '@/lib/format';
import { keys, useAvailableRepos, useGhOwners, useGhStatus, useMe, useRepos, useServices } from '@/lib/queries';

function CopyCode({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-xs">
      <code className="min-w-0 flex-1 break-all">{children}</code>
      <button
        className="shrink-0 text-faint hover:text-ink"
        onClick={async () => {
          await navigator.clipboard?.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label="复制"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function StepLog({ step }: { step: GhStep | undefined }) {
  const [open, setOpen] = useState(false);
  if (!step) return null;
  return (
    <div className="text-xs">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-faint hover:text-muted">
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
        实际执行：<code className="font-mono">{step.command}</code>
        <span className={step.ok ? 'text-ok' : 'text-crit'}>{step.ok ? '成功' : '失败'}</span>
      </button>
      {open && <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-black/30 p-3 font-mono whitespace-pre-wrap text-muted">{step.output || '（没有输出）'}</pre>}
    </div>
  );
}

interface WizardStep {
  title: string;
  done: boolean;
  body: ReactNode;
}

/** 分步引导：已完成的步骤收起显示对勾，当前步骤展开（设计文档 7.1、8.2 Stepper）。 */
function Stepper({ steps }: { steps: WizardStep[] }) {
  const current = steps.findIndex((s) => !s.done);
  const [opened, setOpened] = useState<number | null>(null);
  const active = opened ?? (current < 0 ? steps.length - 1 : current);
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.title} className="relative flex gap-4 pb-6 last:pb-0">
          {i < steps.length - 1 && <span className={cn('absolute top-8 left-[15px] h-[calc(100%-2rem)] w-px', s.done ? 'bg-ok/40' : 'bg-line')} />}
          <button
            onClick={() => setOpened(i)}
            className={cn(
              'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              s.done ? 'border-ok/40 bg-ok/10 text-ok' : i === current ? 'border-brand/60 bg-brand/10 text-brand' : 'border-line text-faint',
            )}
            aria-label={`第 ${i + 1} 步：${s.title}`}
          >
            {s.done ? <Check className="size-4" /> : i + 1}
          </button>
          <div className="min-w-0 flex-1 pt-1">
            <button onClick={() => setOpened(i)} className={cn('text-sm font-medium', i !== active && 'text-muted')}>
              {s.title}
            </button>
            {i === active && <div className="mt-3 flex flex-col gap-3">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RepoPicker({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const owners = useGhOwners(isAdmin);
  const [owner, setOwner] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!owner && owners.data?.[0]) setOwner(owners.data[0]);
  }, [owners.data, owner]);
  const repos = useAvailableRepos(owner);
  const add = useMutation({
    mutationFn: (fullName: string) => api.post<RepoInfo>('/api/v1/repos', { fullName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.repos });
      void qc.invalidateQueries({ queryKey: ['available-repos'] });
    },
  });
  if (!isAdmin) return <p className="text-sm text-faint">只有管理员可以绑定仓库。</p>;
  if (owners.error) return <ErrorNote error={owners.error} onRetry={() => owners.refetch()} />;
  const list = (repos.data ?? []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none"
          value={owner ?? ''}
          onChange={(e) => setOwner(e.target.value)}
          disabled={!owners.data}
        >
          {owners.data?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <input
          className="h-9 min-w-[200px] flex-1 rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none focus:border-brand/60"
          placeholder="筛选仓库"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {repos.error && <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />}
      {add.error && <ErrorNote error={add.error} />}
      {repos.isLoading || owners.isLoading ? (
        <Skeleton className="h-32" />
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {list.map((r) => (
            <li key={r.fullName} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm">
                  {r.isPrivate && <Lock className="size-3 text-faint" />}
                  {r.fullName}
                  <span className="text-xs text-faint">· {r.defaultBranch}</span>
                </p>
                <p className="truncate text-xs text-faint">
                  {r.description || '没有描述'}
                  {r.diskUsage != null && ` · ${formatBytes(r.diskUsage * 1024)}`}
                  {r.pushedAt && ` · ${formatRelative(r.pushedAt)}推送`}
                </p>
              </div>
              {r.bound ? (
                <Badge className="text-ok">已绑定</Badge>
              ) : (
                <Button size="sm" onClick={() => add.mutate(r.fullName)} disabled={add.isPending}>
                  绑定
                </Button>
              )}
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-6 text-center text-xs text-faint">没有匹配的仓库</li>}
        </ul>
      )}
      <p className="text-xs text-faint">绑定后在后台部分克隆（只取提交和目录结构，文件内容按需拉取），之后每 5 分钟同步一次。</p>
    </div>
  );
}

function GhWizard({ status, isAdmin }: { status: GhStatus; isAdmin: boolean }) {
  const qc = useQueryClient();
  const recheck = useMutation({
    mutationFn: () => api.get<GhStatus>('/api/v1/repos/gh-status?refresh=1'),
    onSuccess: (s) => qc.setQueryData(keys.ghStatus, s),
  });
  const setupGit = useMutation({
    mutationFn: () => api.post<GhStep>('/api/v1/repos/gh-setup-git'),
    onSuccess: () => recheck.mutate(),
  });
  const [s1, s2, s3] = status.steps;
  const RecheckButton = (
    <Button size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending} className="self-start">
      <RefreshCw className={cn('size-3.5', recheck.isPending && 'animate-spin')} />
      重新检测
    </Button>
  );
  const steps: WizardStep[] = [
    {
      title: status.installed ? `已安装 gh ${status.version}` : '安装 gh 命令行',
      done: status.installed,
      body: (
        <>
          <p className="text-sm text-muted">Pulse 不保存 GitHub 凭据，所有访问都通过服务器上的 gh 完成。在运行 Pulse 的服务器上安装：</p>
          {status.installHints.map((h) => (
            <div key={h.label} className="flex flex-col gap-1">
              <span className="text-xs text-faint">{h.label}</span>
              {h.command.startsWith('sudo') || h.command.startsWith('brew') ? <CopyCode>{h.command}</CopyCode> : <p className="text-xs text-muted">{h.command}</p>}
            </div>
          ))}
          <StepLog step={s1} />
          {RecheckButton}
        </>
      ),
    },
    {
      title: status.loggedIn ? `已登录 ${status.account}${status.tokenSource ? `（${status.tokenSource}）` : ''}` : '登录 GitHub',
      done: status.loggedIn,
      body: (
        <>
          {status.problem && !status.loggedIn && <p className="text-sm text-warn">{status.problem}</p>}
          <p className="text-sm text-muted">任选一种方式：</p>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-faint">方式一：在服务器终端运行，按提示在浏览器中授权</span>
            <CopyCode>gh auth login --hostname github.com --git-protocol https</CopyCode>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-faint">方式二（适合 Docker 部署）：把 Fine-grained PAT 写进环境变量 GH_TOKEN 后重启 Pulse</span>
            <CopyCode>GH_TOKEN=github_pat_xxx docker compose up -d</CopyCode>
            <p className="text-xs text-faint">
              最小权限：<b className="text-muted">Contents 只读</b>、<b className="text-muted">Metadata 只读</b>；需要从 Incident 创建 Issue 时再加 Issues 读写。
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-brand">
                创建令牌 <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
          <StepLog step={s2} />
          {RecheckButton}
        </>
      ),
    },
    {
      title: status.gitConfigured ? '已配置 git 凭据' : '配置 git 凭据',
      done: status.gitConfigured,
      body: (
        <>
          <p className="text-sm text-muted">
            让 <code className="font-mono">git fetch</code> 复用 gh 的登录，Pulse 才能定时同步仓库。将执行 <code className="font-mono">gh auth setup-git</code>。
          </p>
          {isAdmin ? (
            <Button size="sm" variant="primary" className="self-start" onClick={() => setupGit.mutate()} disabled={setupGit.isPending || !status.loggedIn}>
              配置 git 凭据
            </Button>
          ) : (
            <p className="text-xs text-faint">需要管理员操作。</p>
          )}
          {setupGit.data && !setupGit.data.ok && <ErrorNote error={new Error(setupGit.data.output || '配置失败')} />}
          <StepLog step={setupGit.data ?? s3} />
        </>
      ),
    },
    { title: '选择仓库', done: false, body: status.gitConfigured ? <RepoPicker isAdmin={isAdmin} /> : <p className="text-sm text-faint">完成前面的步骤后可以选择仓库。</p> },
  ];
  return (
    <>
      <Stepper steps={steps} />
      {recheck.error && <ErrorNote error={recheck.error} />}
    </>
  );
}

function RepoList({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const repos = useRepos();
  const sync = useMutation({
    mutationFn: (id: string) => api.post<RepoInfo>(`/api/v1/repos/${id}/sync`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.repos }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/repos/${id}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.repos });
      void qc.invalidateQueries({ queryKey: keys.services });
    },
  });
  if (repos.error) return <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />;
  if (!repos.data) return <Skeleton className="m-5 h-24" />;
  if (!repos.data.length) return <EmptyState icon={<GitBranch className="size-6" />} title="还没有绑定仓库">完成上面的引导后选择仓库。</EmptyState>;
  return (
    <ul className="divide-y divide-line">
      {repos.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              {r.isPrivate && <Lock className="size-3 text-faint" />}
              {r.fullName}
              <span
                className={cn('flex items-center gap-1 text-xs font-normal', r.status === 'ready' ? 'text-ok' : r.status === 'error' ? 'text-crit' : 'text-brand')}
              >
                <StatusDot tone={r.status === 'ready' ? 'ok' : r.status === 'error' ? 'crit' : 'warn'} pulse={r.status === 'cloning'} />
                {r.status === 'ready' ? '已同步' : r.status === 'error' ? '出错' : '克隆中'}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-faint">
              {r.defaultBranch}
              {r.headCommit && <> · <code className="font-mono">{r.headCommit.slice(0, 8)}</code></>}
              {r.lastSyncedAt && <span title={formatTime(r.lastSyncedAt)}> · {formatRelative(r.lastSyncedAt)}同步</span>}
              {r.services.length > 0 && ` · 服务 ${r.services.join('、')}`}
            </p>
            {r.lastError && <p className="mt-1 text-xs text-crit">{r.lastError}</p>}
            {r.large && <p className="mt-1 text-xs text-warn">仓库超过 2 GB，建议在服务器上为该仓库配置 sparse-checkout，只保留服务相关目录。</p>}
          </div>
          {isAdmin && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => sync.mutate(r.id)} disabled={sync.isPending || r.status === 'cloning'}>
                <RefreshCw className={cn('size-3.5', sync.isPending && sync.variables === r.id && 'animate-spin')} />
                同步
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)} disabled={remove.isPending} aria-label={`解绑 ${r.fullName}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ServiceRow({ s, repos, isAdmin }: { s: ServiceInfo; repos: RepoInfo[]; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [repoId, setRepoId] = useState(s.binding?.repoId ?? '');
  const [subdir, setSubdir] = useState(s.binding?.subdir ?? '');
  const dirty = repoId !== (s.binding?.repoId ?? '') || subdir !== (s.binding?.subdir ?? '');
  const save = useMutation({
    mutationFn: () =>
      repoId ? api.put(`/api/v1/services/${encodeURIComponent(s.name)}/binding`, { repoId, subdir }) : api.del(`/api/v1/services/${encodeURIComponent(s.name)}/binding`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.services });
      void qc.invalidateQueries({ queryKey: keys.repos });
    },
  });
  const commits = [...new Set(s.versions.map((v) => v.commit))];
  return (
    <tr className="align-top">
      <td className="px-5 py-3">
        <p className="font-medium">{s.name}</p>
        <p className="text-xs text-faint">{s.hostCount} 台主机</p>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-2">
          <select
            className="h-8 rounded-lg border border-line bg-surface-2 px-2 text-xs outline-none disabled:opacity-60"
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            disabled={!isAdmin}
          >
            <option value="">未绑定</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
          <input
            className="h-8 w-40 rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs outline-none focus:border-brand/60 disabled:opacity-60"
            value={subdir}
            onChange={(e) => setSubdir(e.target.value)}
            placeholder="子目录（monorepo）"
            disabled={!isAdmin || !repoId}
          />
          {isAdmin && dirty && (
            <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              保存
            </Button>
          )}
        </div>
        {save.error && <p className="mt-1 text-xs text-crit">{(save.error as Error).message}</p>}
      </td>
      <td className="px-3 py-3 text-xs">
        {commits.length === 0 ? (
          <span className="text-faint" title="Agent 配置 services[].version_file 或 container 后上报">
            版本未上报，分析时用默认分支最新提交
          </span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {commits.map((c) => (
              <span key={c}>
                <code className="font-mono">{c.slice(0, 8)}</code>
                <span className="text-faint"> · {s.versions.filter((v) => v.commit === c).length} 台</span>
              </span>
            ))}
            {commits.length > 1 && <span className="text-warn">多个版本并存</span>}
          </div>
        )}
      </td>
      <td className="px-5 py-3 text-right text-xs text-faint" title={formatTime(s.lastDeployAt)}>
        {s.lastDeployAt ? formatRelative(s.lastDeployAt) : '—'}
      </td>
    </tr>
  );
}

export function ReposPage() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const status = useGhStatus();
  const services = useServices();
  const repos = useRepos();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">仓库</h1>
        <p className="mt-1 text-sm text-muted">把服务绑定到 GitHub 仓库后，AI 分析会在对应部署版本的只读代码上工作。</p>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="GitHub 接入"
            hint={status.data ? `上次检测 ${formatRelative(status.data.checkedAt)}${status.data.account ? ` · 账号 ${status.data.account}` : ''}` : '检测服务器上的 gh 状态'}
          />
          <div className="p-5">
            <Boundary>
              {status.error ? <ErrorNote error={status.error} onRetry={() => status.refetch()} /> : !status.data ? <Skeleton className="h-48" /> : <GhWizard status={status.data} isAdmin={isAdmin} />}
            </Boundary>
          </div>
        </Card>
        <Card>
          <CardHeader title="已绑定的仓库" />
          <Boundary>
            <RepoList isAdmin={isAdmin} />
          </Boundary>
        </Card>
      </div>
      <Card>
        <CardHeader title="服务" hint="服务来自主机标签 service=<名称> 和日志源配置；当前版本由 Agent 读取版本文件或容器镜像 label 上报，变化即记一次部署" />
        <Boundary>
          {!services.data ? (
            <Skeleton className="m-5 h-24" />
          ) : services.data.length === 0 ? (
            <EmptyState title="还没有服务">给主机加上 service=&lt;名称&gt; 标签，或在 Agent 日志采集配置中指定 service。</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-faint">
                    <th className="px-5 py-3 font-medium">服务</th>
                    <th className="px-3 py-3 font-medium">仓库 / 子目录</th>
                    <th className="px-3 py-3 font-medium">当前版本</th>
                    <th className="px-5 py-3 text-right font-medium">最近部署</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {services.data.map((s) => (
                    <ServiceRow key={`${s.name}:${s.binding?.repoId ?? ''}:${s.binding?.subdir ?? ''}`} s={s} repos={(repos.data ?? []).filter((r) => r.status !== 'error')} isAdmin={isAdmin} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Boundary>
      </Card>
    </div>
  );
}
