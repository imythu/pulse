import type { EnrollTokenResponse, HostSummary } from '@pulse/shared';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useLive } from '@/lib/live';
import ShinyText from './bits/ShinyText';
import { Button, Dialog, ErrorNote, StatusDot } from './ui';

function parseLabels(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    const [k, ...rest] = line.split('=');
    if (!k || rest.length === 0) return `标签“${line}”格式应为 key=value`;
    out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

export function EnrollDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [labels, setLabels] = useState('');
  const [ttl, setTtl] = useState(24);
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState<HostSummary | null>(null);

  const gen = useMutation({
    mutationFn: (body: { ttlHours: number; labels: Record<string, string> }) => api.post<EnrollTokenResponse>('/api/v1/agents/enroll-tokens', body),
  });
  const parsed = parseLabels(labels);

  useLive(open && gen.data ? 'overview' : null, (e) => {
    if (e.type === 'host.enrolled') setJoined(e.host);
  });

  const close = () => {
    gen.reset();
    setJoined(null);
    setCopied(false);
    onClose();
  };

  const copy = async () => {
    if (!gen.data) return;
    await navigator.clipboard.writeText(gen.data.installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onClose={close} title="添加主机">
      {!gen.data ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (typeof parsed !== 'string') gen.mutate({ ttlHours: ttl, labels: parsed });
          }}
        >
          <p className="text-sm text-muted">生成一次性注册令牌和安装命令。在目标机器上以 root 执行命令即可完成安装、注册和启动。</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">标签（可选，每行一个 key=value）</span>
            <textarea
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              rows={3}
              placeholder={'env=prod\nservice=order-api'}
              className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm outline-none focus:border-brand"
            />
            {typeof parsed === 'string' && <span className="text-xs text-crit">{parsed}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">令牌有效期</span>
            <select
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm outline-none focus:border-brand"
            >
              <option value={1}>1 小时</option>
              <option value={24}>24 小时</option>
              <option value={168}>7 天</option>
            </select>
          </label>
          {gen.error && <ErrorNote error={gen.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={gen.isPending || typeof parsed === 'string'}>
              {gen.isPending && <Loader2 className="size-4 animate-spin" />}
              生成安装命令
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="relative rounded-lg border border-line bg-bg p-4 pr-12">
            <code className="block font-mono text-xs leading-relaxed break-all text-ink">{gen.data.installCommand}</code>
            <button onClick={copy} className="absolute top-3 right-3 rounded-md p-1.5 text-faint hover:bg-white/5 hover:text-ink" aria-label="复制命令">
              {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-faint">令牌只能使用一次，{formatTime(gen.data.expiresAt)} 过期。关闭此窗口后无法再次查看。</p>
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
            {joined ? (
              <>
                <StatusDot tone="ok" />
                <span>
                  <b>{joined.hostname}</b> 已注册。
                </span>
                <Link to="/hosts/$id" params={{ id: joined.id }} onClick={close} className="ml-auto text-brand hover:underline">
                  查看主机
                </Link>
              </>
            ) : (
              <>
                <StatusDot tone="warn" pulse />
                <ShinyText text="等待主机执行安装命令…" color="#9aa3b5" shineColor="#e7e9ef" speed={2.5} />
              </>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={close}>完成</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
