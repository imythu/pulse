import { execFile } from 'node:child_process';

export interface ExecResult {
  /** 展示用的命令行 */
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

/** 直接 exec，不经过 shell。失败不抛错，由调用方看退出码。 */
export function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<ExecResult> {
  const command = [bin, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        // gh 不要弹交互提示，git 不要等待输入凭据
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', ...opts.env },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        let code = 0;
        if (e) code = typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? 127 : e.killed ? 124 : 1;
        resolve({ command, code, stdout: String(stdout), stderr: String(stderr) || (e && typeof e.code !== 'number' ? e.message : '') });
      },
    );
  });
}
