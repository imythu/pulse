// 仓库克隆、定时同步与分析工作区（设计文档 7.2）。
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommitInfo, RepoInfo } from '@pulse/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../../db/index.js';
import { run } from '../../lib/exec.js';
import { conflict, notFound } from '../../lib/http-error.js';
import { diagnose, type Gh } from './gh.js';

const SYNC_INTERVAL_MS = 5 * 60_000;
const LARGE_REPO_BYTES = 2 * 1024 ** 3;

export interface RepoRow {
  id: string;
  full_name: string;
  default_branch: string;
  is_private: boolean;
  local_path: string;
  status: RepoInfo['status'];
  last_error: string | null;
  head_commit: string | null;
  size_bytes: string | null;
  last_synced_at: Date | null;
  created_at: Date;
  services?: string[];
}

export function toRepoInfo(r: RepoRow): RepoInfo {
  const size = r.size_bytes == null ? null : Number(r.size_bytes);
  return {
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    isPrivate: r.is_private,
    status: r.status,
    lastError: r.last_error,
    headCommit: r.head_commit,
    sizeBytes: size,
    large: (size ?? 0) > LARGE_REPO_BYTES,
    lastSyncedAt: r.last_synced_at?.getTime() ?? null,
    services: r.services ?? [],
    createdAt: r.created_at.getTime(),
  };
}

export interface Workspace {
  path: string;
  commit: string;
  /** false 表示部署版本未知或仓库里找不到，用的是默认分支最新提交 */
  confirmed: boolean;
  cleanup(): Promise<void>;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export class RepoManager {
  private timer?: NodeJS.Timeout;
  /** 同一仓库的 git 操作串行，避免并发 fetch 和 worktree 互相踩锁 */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sql: Sql,
    private readonly gh: Gh,
    private readonly git: string,
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    this.timer = setInterval(() => void this.syncAll(), SYNC_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  async list(): Promise<RepoInfo[]> {
    const rows = await this.sql<RepoRow[]>`
      SELECT r.*, coalesce(array_agg(b.service ORDER BY b.service) FILTER (WHERE b.service IS NOT NULL), '{}') AS services
      FROM repos r LEFT JOIN service_bindings b ON b.repo_id = r.id
      GROUP BY r.id ORDER BY r.full_name`;
    return rows.map(toRepoInfo);
  }

  async row(id: string): Promise<RepoRow> {
    const [row] = /^[0-9a-f-]{36}$/i.test(id) ? await this.sql<RepoRow[]>`SELECT * FROM repos WHERE id = ${id}` : [];
    if (!row) throw notFound('仓库不存在');
    return row;
  }

  /** 绑定仓库：先确认 gh 能访问，再在后台部分克隆。 */
  async add(fullName: string): Promise<RepoInfo> {
    const info = await this.gh.view(fullName);
    const [exists] = await this.sql`SELECT 1 FROM repos WHERE lower(full_name) = lower(${info.fullName})`;
    if (exists) throw conflict('仓库已经绑定');
    const localPath = resolve(this.dir, ...info.fullName.split('/'));
    const [row] = await this.sql<RepoRow[]>`
      INSERT INTO repos (full_name, default_branch, is_private, local_path, size_bytes)
      VALUES (${info.fullName}, ${info.defaultBranch}, ${info.isPrivate}, ${localPath}, ${info.diskUsage == null ? null : info.diskUsage * 1024})
      RETURNING *`;
    void this.locked(row!.id, () => this.cloneInto(row!));
    return toRepoInfo(row!);
  }

  private async cloneInto(row: RepoRow) {
    try {
      await rm(row.local_path, { recursive: true, force: true });
      await mkdir(resolve(row.local_path, '..'), { recursive: true });
      await this.gh.clone(row.full_name, row.local_path);
      await this.afterFetch(row);
      this.log.info({ repo: row.full_name }, '仓库克隆完成');
    } catch (err) {
      await this.sql`UPDATE repos SET status = 'error', last_error = ${(err as Error).message} WHERE id = ${row.id}`;
      this.log.warn({ err, repo: row.full_name }, '仓库克隆失败');
    }
  }

  private async afterFetch(row: RepoRow) {
    const head = await this.gitIn(row, ['rev-parse', `refs/remotes/origin/${row.default_branch}`]);
    await this.sql`
      UPDATE repos SET status = 'ready', last_error = NULL, last_synced_at = now(), head_commit = ${head.code === 0 ? head.stdout.trim() : null}
      WHERE id = ${row.id}`;
  }

  private gitIn(row: Pick<RepoRow, 'local_path'>, args: string[], timeoutMs = 120_000) {
    return run(this.git, ['-C', row.local_path, ...args], { timeoutMs });
  }

  sync(id: string): Promise<RepoInfo> {
    return this.locked(id, async () => {
      const row = await this.row(id);
      if (row.status === 'error' && !(await exists(join(row.local_path, '.git')))) {
        await this.cloneInto(row);
      } else {
        const r = await this.gitIn(row, ['fetch', '--prune', '--quiet', 'origin']);
        if (r.code !== 0) {
          await this.sql`UPDATE repos SET status = 'error', last_error = ${diagnose(r.stderr || r.stdout)} WHERE id = ${id}`;
        } else {
          await this.afterFetch(row);
        }
      }
      return toRepoInfo(await this.row(id));
    });
  }

  private async syncAll() {
    for (const r of await this.sql<{ id: string }[]>`SELECT id FROM repos WHERE status <> 'cloning'`) {
      await this.sync(r.id).catch((err) => this.log.warn({ err }, '仓库同步失败'));
    }
  }

  async remove(id: string): Promise<void> {
    await this.locked(id, async () => {
      const row = await this.row(id);
      await this.sql`DELETE FROM repos WHERE id = ${id}`;
      await rm(row.local_path, { recursive: true, force: true });
    });
  }

  async commits(id: string, limit = 30): Promise<CommitInfo[]> {
    const row = await this.row(id);
    if (row.status !== 'ready') return [];
    const r = await this.gitIn(row, ['log', `refs/remotes/origin/${row.default_branch}`, '-n', String(limit), '--format=%H%x09%an%x09%at%x09%s']);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, at, ...subject] = l.split('\t');
        return { sha: sha!, author: author!, time: Number(at) * 1000, subject: subject.join('\t') };
      });
  }

  /** 两个提交之间的变更：文件统计 + 截断的补丁。 */
  async diff(id: string, from: string, to: string, subdir = '', maxBytes = 200_000): Promise<{ stat: string; patch: string; truncated: boolean }> {
    if (!SHA_RE.test(from) || !SHA_RE.test(to)) throw new Error('提交号格式错误');
    const row = await this.row(id);
    const paths = subdir ? ['--', subdir] : [];
    const s = await this.gitIn(row, ['diff', '--stat=160', `${from}..${to}`, ...paths]);
    if (s.code !== 0) throw new Error(s.stderr.trim() || '无法比较这两个提交');
    const p = await this.gitIn(row, ['diff', '--no-color', `${from}..${to}`, ...paths]);
    return { stat: s.stdout, patch: p.stdout.slice(0, maxBytes), truncated: p.stdout.length > maxBytes };
  }

  /**
   * 为分析创建对应提交的只读工作区（git worktree，detached）。
   * 找不到该提交时先 fetch 一次，仍找不到就退回默认分支最新提交并标注“版本未确认”。
   */
  workspace(id: string, commit: string | null, subdir = ''): Promise<Workspace> {
    return this.locked(id, async () => {
      const row = await this.row(id);
      if (row.status !== 'ready') throw new Error(`仓库 ${row.full_name} 还不可用（${row.status}）`);
      await this.gitIn(row, ['fetch', '--prune', '--quiet', 'origin']);
      let target = commit && SHA_RE.test(commit) ? commit : null;
      let confirmed = !!target;
      if (target && (await this.gitIn(row, ['cat-file', '-e', `${target}^{commit}`])).code !== 0) {
        target = null;
        confirmed = false;
      }
      if (!target) {
        const head = await this.gitIn(row, ['rev-parse', `refs/remotes/origin/${row.default_branch}`]);
        if (head.code !== 0) throw new Error('无法确定默认分支的最新提交');
        target = head.stdout.trim();
      }
      const base = join(this.dir, '.worktrees');
      await mkdir(base, { recursive: true });
      const path = await mkdtemp(join(base, `${row.full_name.replace('/', '__')}-`));
      const add = await this.gitIn(row, ['worktree', 'add', '--detach', '--force', path, target], 10 * 60_000);
      if (add.code !== 0) {
        await rm(path, { recursive: true, force: true });
        throw new Error(add.stderr.trim() || '创建工作区失败');
      }
      const sha = (await this.gitIn({ local_path: path }, ['rev-parse', 'HEAD'])).stdout.trim();
      await setWritable(path, false);
      const root = subdir ? join(path, subdir) : path;
      return {
        path: (await exists(root)) ? root : path,
        commit: sha,
        confirmed,
        cleanup: () =>
          this.locked(id, async () => {
            await setWritable(path, true);
            await this.gitIn(row, ['worktree', 'remove', '--force', path]);
            await rm(path, { recursive: true, force: true });
            await this.gitIn(row, ['worktree', 'prune']);
          }),
      };
    });
  }
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 工作区设为只读：AI 分析即使绕过工具限制也写不进去。 */
async function setWritable(dir: string, writable: boolean) {
  // lstat：不跟随符号链接，避免改到工作区外的文件
  const walk = async (p: string) => {
    const st = await lstat(p);
    if (st.isDirectory()) {
      if (writable) await chmod(p, st.mode | 0o200);
      for (const e of await readdir(p)) if (e !== '.git') await walk(join(p, e));
      if (!writable) await chmod(p, st.mode & ~0o222);
    } else if (st.isFile()) {
      await chmod(p, writable ? st.mode | 0o200 : st.mode & ~0o222);
    }
  };
  await walk(dir);
}
