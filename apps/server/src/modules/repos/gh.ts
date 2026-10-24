// gh 引导（设计文档 7.1）：Pulse 不保存 GitHub token，所有访问都通过服务器上的 gh 完成。
// 每一步都把实际执行的命令和输出返回给控制台，失败时给出具体原因。
import { readFileSync } from 'node:fs';
import type { AvailableRepo, GhStatus, GhStep } from '@pulse/shared';
import { run, type ExecResult } from '../../lib/exec.js';

const HOST = 'github.com';

function step(r: ExecResult): GhStep {
  return { command: r.command, ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim().slice(0, 4000) };
}

function osId(): string {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const id = /^ID=("?)([^"\n]+)\1$/m.exec(text)?.[2] ?? '';
    const like = /^ID_LIKE=("?)([^"\n]+)\1$/m.exec(text)?.[2] ?? '';
    return `${id} ${like}`;
  } catch {
    return process.platform;
  }
}

export function installHints(): GhStatus['installHints'] {
  const os = osId();
  const hints: GhStatus['installHints'] = [];
  if (/debian|ubuntu/.test(os)) hints.push({ label: 'Debian / Ubuntu', command: 'sudo apt update && sudo apt install -y gh' });
  if (/rhel|fedora|centos|rocky|almalinux/.test(os)) hints.push({ label: 'RHEL / Fedora', command: 'sudo dnf install -y gh' });
  if (process.platform === 'darwin') hints.push({ label: 'macOS', command: 'brew install gh' });
  hints.push({ label: 'Docker 部署', command: 'pulse-server 镜像已内置 gh，无需安装' });
  hints.push({ label: '其他系统', command: '参考 https://github.com/cli/cli#installation' });
  return hints;
}

/** 把 gh / git 的报错归类成用户能处理的原因。 */
function diagnose(text: string): string {
  if (/could not resolve host|network is unreachable|timeout|connection refused|i\/o timeout/i.test(text)) return '网络不通：服务器无法访问 github.com';
  if (/not logged|no oauth token|gh auth login|authentication required/i.test(text)) return '未登录：gh 还没有可用的 GitHub 凭据';
  if (/bad credentials|token .*(invalid|expired)|HTTP 401/i.test(text)) return '凭据无效或已过期，请重新登录或更换 GH_TOKEN';
  if (/HTTP 403|resource not accessible|insufficient|scope/i.test(text)) return '权限不足：令牌缺少所需权限（Contents 只读、Metadata 只读）';
  if (/HTTP 404|not found|could not resolve to a repository/i.test(text)) return '仓库不存在，或当前账号没有访问权限';
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? '未知错误';
}

export class Gh {
  constructor(
    readonly bin: string,
    private readonly git: string,
  ) {}

  exec(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
    return run(this.bin, args, { timeoutMs });
  }

  /** 检测安装、登录、git 凭据三项，返回每一步的命令和输出。 */
  async status(): Promise<GhStatus> {
    const steps: GhStep[] = [];
    const base = { installHints: installHints(), steps, checkedAt: Date.now() };

    const ver = await this.exec(['--version'], 10_000);
    steps.push(step(ver));
    if (ver.code !== 0) {
      return { ...base, installed: false, version: null, loggedIn: false, account: null, tokenSource: null, scopes: null, gitConfigured: false, problem: '未安装：服务器上找不到 gh 命令' };
    }
    const version = /gh version ([\w.-]+)/.exec(ver.stdout)?.[1] ?? ver.stdout.split('\n')[0]!.trim();

    const auth = await this.exec(['auth', 'status', '--hostname', HOST], 20_000);
    steps.push(step(auth));
    const authText = `${auth.stdout}\n${auth.stderr}`;
    const account = /account (\S+)/.exec(authText)?.[1] ?? /Logged in to \S+ as (\S+)/.exec(authText)?.[1] ?? null;
    const tokenSource = /\(([^)]*(?:keyring|GH_TOKEN|GITHUB_TOKEN|hosts\.yml|oauth_token)[^)]*)\)/i.exec(authText)?.[1] ?? null;
    const scopes = /Token scopes:\s*(.+)/.exec(authText)?.[1]?.trim() ?? null;
    const loggedIn = auth.code === 0 && !!account;

    const helper = await run(this.git, ['config', '--global', '--get-all', `credential.https://${HOST}.helper`], { timeoutMs: 10_000 });
    steps.push(step(helper));
    const gitConfigured = /gh(\.exe)?['"]? auth git-credential/.test(helper.stdout);

    return {
      ...base,
      installed: true,
      version,
      loggedIn,
      account,
      tokenSource,
      scopes,
      gitConfigured,
      problem: !loggedIn ? diagnose(authText) : !gitConfigured ? '还没有配置 git 凭据：git fetch 无法复用 gh 的登录' : null,
    };
  }

  async setupGit(): Promise<GhStep> {
    return step(await this.exec(['auth', 'setup-git', '--hostname', HOST], 20_000));
  }

  /** 当前账号及其所属组织，用于选择仓库所有者。 */
  async owners(): Promise<string[]> {
    const me = await this.exec(['api', 'user', '--jq', '.login']);
    if (me.code !== 0) throw new Error(diagnose(me.stderr || me.stdout));
    const orgs = await this.exec(['api', 'user/orgs', '--paginate', '--jq', '.[].login']);
    return [me.stdout.trim(), ...orgs.stdout.split('\n').map((s) => s.trim())].filter(Boolean);
  }

  async listRepos(owner: string): Promise<Omit<AvailableRepo, 'bound'>[]> {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) throw new Error('所有者名称不合法');
    const r = await this.exec(['repo', 'list', owner, '--json', 'nameWithOwner,defaultBranchRef,isPrivate,description,pushedAt,diskUsage', '--limit', '200'], 60_000);
    if (r.code !== 0) throw new Error(diagnose(r.stderr || r.stdout));
    const rows = JSON.parse(r.stdout) as {
      nameWithOwner: string;
      defaultBranchRef: { name: string } | null;
      isPrivate: boolean;
      description: string | null;
      pushedAt: string | null;
      diskUsage: number | null;
    }[];
    return rows.map((x) => ({
      fullName: x.nameWithOwner,
      defaultBranch: x.defaultBranchRef?.name ?? 'main',
      isPrivate: x.isPrivate,
      description: x.description ?? '',
      pushedAt: x.pushedAt ? Date.parse(x.pushedAt) : null,
      diskUsage: x.diskUsage ?? null,
    }));
  }

  async view(fullName: string): Promise<{ fullName: string; defaultBranch: string; isPrivate: boolean; diskUsage: number | null }> {
    const r = await this.exec(['repo', 'view', fullName, '--json', 'nameWithOwner,defaultBranchRef,isPrivate,diskUsage']);
    if (r.code !== 0) throw new Error(diagnose(r.stderr || r.stdout));
    const x = JSON.parse(r.stdout) as { nameWithOwner: string; defaultBranchRef: { name: string } | null; isPrivate: boolean; diskUsage: number | null };
    return { fullName: x.nameWithOwner, defaultBranch: x.defaultBranchRef?.name ?? 'main', isPrivate: x.isPrivate, diskUsage: x.diskUsage };
  }

  async clone(fullName: string, dest: string): Promise<void> {
    // 部分克隆：只取提交和树，文件内容按需拉取，大仓库也快（设计文档 7.2）
    const r = await this.exec(['repo', 'clone', fullName, dest, '--', '--filter=blob:none', '--no-checkout', '--quiet'], 30 * 60_000);
    if (r.code !== 0) throw new Error(diagnose(r.stderr || r.stdout));
  }
}

export { diagnose };
