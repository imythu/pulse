import type { ChannelKind, NotificationChannel, RuleInfo, RuleKind, Severity } from '@pulse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { keys, useChannels, useMe, useRules } from '@/lib/queries';

const PARAM_LABELS: Record<RuleKind, Record<string, string>> = {
  threshold: {
    threshold: '触发阈值',
    forSeconds: '持续（秒）',
    recover: '恢复阈值',
    recoverForSeconds: '恢复持续（秒）',
    critical: '严重阈值（0 不升级）',
  },
  disk_fill: { windowHours: '拟合窗口（小时）', horizonHours: '预计多少小时内写满', recoverHours: '多少小时以上恢复' },
  mem_leak: { windowHours: '观察窗口（小时）', minIncrease: '最小涨幅（百分点）', minCorr: '最小相关系数' },
  offline: {},
  log: {
    quietMinutes: '多久不出现恢复（分钟）',
    spikeFactor: '突增倍数',
    spikeMin: '突增最少次数（5 分钟）',
    spreadHosts: '扩散主机数',
    spreadMinutes: '扩散窗口（分钟）',
  },
};

const KIND_TEXT: Record<RuleKind, string> = { threshold: '阈值', disk_fill: '趋势', mem_leak: '趋势', offline: '可用性', log: '日志' };

function parseLabels(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,，\s]+/).filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    if (!k || !rest.length) return null;
    out[k] = rest.join('=');
  }
  return out;
}

function RuleCard({ rule, editable }: { rule: RuleInfo; editable: boolean }) {
  const qc = useQueryClient();
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(rule.params).map(([k, v]) => [k, String(v)])));
  const [severity, setSeverity] = useState<Severity>(rule.severity);
  const [scope, setScope] = useState(() => Object.entries(rule.scope.labels).map(([k, v]) => `${k}=${v}`).join(', '));
  const labels = PARAM_LABELS[rule.kind];
  const scopeLabels = parseLabels(scope);
  const dirty =
    severity !== rule.severity ||
    Object.keys(labels).some((k) => Number(params[k]) !== rule.params[k]) ||
    JSON.stringify(scopeLabels) !== JSON.stringify(rule.scope.labels);

  const save = useMutation({
    mutationFn: (body: object) => api.patch<RuleInfo>(`/api/v1/rules/${rule.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.rules }),
  });

  const submit = () => {
    const numbers = Object.fromEntries(Object.keys(labels).map((k) => [k, Number(params[k])]));
    save.mutate({ severity, params: numbers, scope: { labels: scopeLabels ?? {} } });
  };

  return (
    <Card className={cn(!rule.enabled && 'opacity-60')}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{rule.name}</h3>
            <Badge>{KIND_TEXT[rule.kind]}</Badge>
            {rule.metric && <span className="num text-xs text-faint">{rule.metric}</span>}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-faint">{rule.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={!editable || save.isPending}
            onChange={(e) => save.mutate({ enabled: e.target.checked })}
            className="size-4 accent-[var(--color-brand)]"
          />
          启用
        </label>
      </div>
      <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-3 xl:grid-cols-6">
        {Object.entries(labels).map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1.5 text-xs text-muted">
            {label}
            <input
              type="number"
              min={0}
              step="any"
              value={params[k] ?? ''}
              disabled={!editable}
              onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))}
              className="num h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none focus:border-brand disabled:opacity-70"
            />
          </label>
        ))}
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          级别
          <select
            value={severity}
            disabled={!editable}
            onChange={(e) => setSeverity(e.target.value as Severity)}
            className="h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none focus:border-brand disabled:opacity-70"
          >
            <option value="warning">警告</option>
            <option value="critical">严重</option>
          </select>
        </label>
        <label className="col-span-2 flex flex-col gap-1.5 text-xs text-muted">
          适用主机（标签，留空为全部）
          <input
            value={scope}
            disabled={!editable}
            onChange={(e) => setScope(e.target.value)}
            placeholder="env=prod, role=web"
            className={cn(
              'h-9 rounded-lg border bg-surface-2 px-3 font-mono text-sm text-ink outline-none focus:border-brand disabled:opacity-70',
              scopeLabels ? 'border-line' : 'border-crit/60',
            )}
          />
        </label>
      </div>
      {(save.error || (editable && dirty)) && (
        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3">
          {save.error && <span className="mr-auto text-xs text-crit">{(save.error as Error).message}</span>}
          {dirty && (
            <Button size="sm" variant="primary" onClick={submit} disabled={save.isPending || !scopeLabels}>
              保存
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

const CHANNEL_TEXT: Record<ChannelKind, string> = { feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉', slack: 'Slack', webhook: 'Webhook' };
const CHANNEL_HINT: Record<ChannelKind, string> = {
  feishu: '群设置 → 机器人 → 自定义机器人的 Webhook 地址；开启签名校验时填写密钥',
  wecom: '群机器人的 Webhook 地址',
  dingtalk: '自定义机器人的 Webhook 地址；安全设置选“加签”时填写密钥',
  slack: 'Incoming Webhook 地址',
  webhook: 'POST JSON；填写密钥后带 X-Pulse-Signature: sha256=<HMAC> 头',
};

interface Draft {
  name: string;
  kind: ChannelKind;
  url: string;
  secret: string;
  minSeverity: Severity;
  enabled: boolean;
}

function ChannelDialog({ channel, onClose }: { channel: NotificationChannel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>({
    name: channel?.name ?? '',
    kind: channel?.kind ?? 'feishu',
    url: '',
    secret: '',
    minSeverity: channel?.minSeverity ?? 'warning',
    enabled: channel?.enabled ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: d.name, kind: d.kind, minSeverity: d.minSeverity, enabled: d.enabled, url: d.url || undefined, secret: d.secret || undefined };
      return channel ? api.patch(`/api/v1/notification-channels/${channel.id}`, body) : api.post('/api/v1/notification-channels', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.channels });
      onClose();
    },
  });
  const input = 'h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none focus:border-brand';

  return (
    <Dialog open onClose={onClose} title={channel ? `编辑「${channel.name}」` : '添加通知渠道'}>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          名称
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="运维值班群" className={input} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          类型
          <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ChannelKind })} className={input}>
            {Object.entries(CHANNEL_TEXT).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex flex-col gap-1.5 text-xs text-muted">
          Webhook 地址{channel && '（留空保持不变）'}
          <input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder={channel ? channel.urlHint + '/…' : 'https://'} className={cn(input, 'font-mono')} />
          <span className="text-faint">{CHANNEL_HINT[d.kind]}</span>
        </label>
        {d.kind !== 'wecom' && d.kind !== 'slack' && (
          <label className="col-span-2 flex flex-col gap-1.5 text-xs text-muted">
            签名密钥（可选{channel?.hasSecret ? '，已设置，留空保持不变' : ''}）
            <input type="password" value={d.secret} onChange={(e) => setD({ ...d, secret: e.target.value })} className={cn(input, 'font-mono')} autoComplete="off" />
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          通知级别
          <select value={d.minSeverity} onChange={(e) => setD({ ...d, minSeverity: e.target.value as Severity })} className={input}>
            <option value="warning">警告及以上</option>
            <option value="critical">仅严重</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-xs text-muted">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />
          启用
        </label>
      </div>
      {save.error && (
        <div className="mt-4">
          <ErrorNote error={save.error} />
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !d.name.trim() || (!channel && !d.url)}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}

function Channels() {
  const channels = useChannels();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<NotificationChannel | null | 'new'>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const test = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/notification-channels/${id}/test`),
    onMutate: (id) => setTestResult((r) => ({ ...r, [id]: '发送中…' })),
    onSuccess: (_, id) => setTestResult((r) => ({ ...r, [id]: '已发送，请到群里确认' })),
    onError: (err, id) => setTestResult((r) => ({ ...r, [id]: (err as Error).message })),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/notification-channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels }),
  });

  return (
    <Card>
      <CardHeader
        title="通知渠道"
        hint="Incident 打开、升级、重开和恢复时通知；抖动中的告警暂停通知"
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            添加
          </Button>
        }
      />
      <Boundary>
        {channels.isLoading ? (
          <Skeleton className="m-5 h-16" />
        ) : channels.error ? (
          <div className="p-5">
            <ErrorNote error={channels.error} onRetry={() => channels.refetch()} />
          </div>
        ) : !channels.data?.length ? (
          <EmptyState icon={<BellRing className="size-6" />} title="还没有通知渠道">
            支持飞书、企业微信、钉钉、Slack 和通用 Webhook。
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {channels.data.map((c) => (
              <li key={c.id} className={cn('flex flex-wrap items-center gap-3 px-5 py-3', !c.enabled && 'opacity-60')}>
                <Badge>{CHANNEL_TEXT[c.kind]}</Badge>
                <span className="font-medium">{c.name}</span>
                <span className="font-mono text-xs text-faint">{c.urlHint}</span>
                {c.hasSecret && <Badge>已签名</Badge>}
                <span className="text-xs text-muted">{c.minSeverity === 'critical' ? '仅严重' : '警告及以上'}</span>
                {!c.enabled && <span className="text-xs text-faint">已停用</span>}
                <div className="ml-auto flex items-center gap-1">
                  {testResult[c.id] && <span className={cn('mr-2 text-xs', test.isError && test.variables === c.id ? 'text-crit' : 'text-muted')}>{testResult[c.id]}</span>}
                  <Button size="sm" variant="ghost" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                    <Send className="size-3.5" />
                    测试
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)} aria-label="编辑">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`删除通知渠道「${c.name}」？`) && remove.mutate(c.id)} aria-label="删除">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Boundary>
      {editing && <ChannelDialog channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export function SettingsPage() {
  const me = useMe();
  const rules = useRules();
  const isAdmin = me.data?.role === 'admin';
  const [tab, setTab] = useState<'rules' | 'channels'>('rules');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">设置</h1>
          <p className="mt-1 text-sm text-muted">{isAdmin ? '修改立即生效；规则停用后对应的告警会直接恢复。' : '只有管理员可以修改设置。'}</p>
        </div>
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          {(['rules', 'channels'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1.5 text-muted', tab === t && 'bg-white/[0.08] text-ink')}>
              {t === 'rules' ? '告警规则' : '通知渠道'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'rules' ? (
        rules.error ? (
          <ErrorNote error={rules.error} onRetry={() => rules.refetch()} />
        ) : !rules.data ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <div className="flex flex-col gap-4">
            {rules.data.map((r) => (
              <RuleCard key={`${r.id}-${r.updatedAt}`} rule={r} editable={isAdmin} />
            ))}
          </div>
        )
      ) : isAdmin ? (
        <Channels />
      ) : (
        <Card>
          <EmptyState title="只有管理员可以查看和修改通知渠道" />
        </Card>
      )}
    </div>
  );
}
