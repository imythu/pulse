import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Activity, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import Aurora from '@/components/bits/Aurora';
import BlurText from '@/components/bits/BlurText';
import GradientText from '@/components/bits/GradientText';
import { Button, ErrorNote } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { useReducedMotion } from '@/lib/useReducedMotion';

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        required
        className="h-11 rounded-lg border border-line bg-black/30 px-3 text-sm outline-none backdrop-blur transition-colors focus:border-brand"
      />
      {props.hint && <span className="text-[11px] text-faint">{props.hint}</span>}
    </label>
  );
}

/** 登录页与首次初始化页共用：Aurora 只在这里出现（设计文档 8.2、8.4）。 */
export function AuthPage({ mode }: { mode: 'login' | 'setup' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const reduced = useReducedMotion();

  const submit = useMutation({
    mutationFn: () => api.post(mode === 'login' ? '/api/v1/auth/login' : '/api/v1/setup', { username, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.me });
      qc.setQueryData(keys.setup, { needsSetup: false });
      await navigate({ to: '/' });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-bg px-4">
      <div className="pointer-events-none absolute inset-0">
        {reduced ? (
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(94,234,212,0.18),transparent_60%)]" />
        ) : (
          <Aurora colorStops={['#0d9488', '#6366f1', '#5eead4']} amplitude={1.1} blend={0.6} speed={0.6} />
        )}
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2.5">
            <Activity className="size-7 text-brand" strokeWidth={2.5} />
            <GradientText colors={['#5eead4', '#818cf8', '#5eead4']} animationSpeed={8} className="text-3xl font-bold tracking-tight">
              Pulse
            </GradientText>
          </div>
          <BlurText
            text={mode === 'login' ? '机器在说话，Pulse 帮你听懂' : '欢迎使用 Pulse，先创建管理员账号'}
            animateBy="letters"
            delay={30}
            direction="top"
            trigger="load"
            className="text-sm text-muted"
          />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-surface/70 p-6 shadow-2xl backdrop-blur-xl">
          <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" hint={mode === 'setup' ? '3–64 位字母、数字、._-' : undefined} />
          <Field
            label="密码"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            hint={mode === 'setup' ? '至少 10 位' : undefined}
          />
          {submit.error && <ErrorNote error={submit.error} />}
          <Button type="submit" variant="primary" className="mt-1 h-11" disabled={submit.isPending}>
            {submit.isPending && <Loader2 className="size-4 animate-spin" />}
            {mode === 'login' ? '登录' : '创建管理员并进入'}
          </Button>
        </form>
      </div>
    </div>
  );
}
