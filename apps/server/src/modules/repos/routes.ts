import { AddRepoRequest, ServiceBindingRequest, type AvailableRepo, type GhStatus } from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, HttpError, notFound } from '../../lib/http-error.js';
import { audit, requireRole } from '../auth/index.js';
import type { Gh } from './gh.js';
import type { RepoManager } from './repos.js';
import type { ServiceRegistry } from './services.js';

const SERVICE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** gh 的报错（网络、权限）不是服务器内部错误，按 502 把原因原样告诉控制台。 */
async function viaGh<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'gh_failed', (err as Error).message);
  }
}

export function registerRepoRoutes(app: FastifyInstance, sql: Sql, gh: Gh, repos: RepoManager, services: ServiceRegistry) {
  const viewer = { preHandler: requireRole(sql, 'viewer') };
  const admin = { preHandler: requireRole(sql, 'admin') };

  // 设置页长期显示 gh 的登录账号和上次检测时间；refresh=1 时重新检测
  app.get<{ Querystring: { refresh?: string } }>('/api/v1/repos/gh-status', viewer, async (req): Promise<GhStatus> => {
    if (!req.query.refresh) {
      const [cached] = await sql<{ value: GhStatus }[]>`SELECT value FROM settings WHERE key = 'gh.status'`;
      if (cached) return cached.value;
    }
    const status = await gh.status();
    await sql`
      INSERT INTO settings (key, value) VALUES ('gh.status', ${sql.json(status as never)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
    return status;
  });

  app.post('/api/v1/repos/gh-setup-git', admin, async (req) => {
    const step = await gh.setupGit();
    await audit(sql, `user:${req.user!.id}`, 'gh.setup_git', null, { ok: step.ok });
    return step;
  });

  app.get('/api/v1/repos/owners', admin, async () => ({ items: await viaGh(() => gh.owners()) }));

  app.get<{ Querystring: { owner?: string } }>('/api/v1/repos/available', admin, async (req): Promise<{ items: AvailableRepo[] }> => {
    if (!req.query.owner) throw badRequest('需要 owner');
    const list = await viaGh(() => gh.listRepos(req.query.owner!));
    const bound = new Set((await sql<{ full_name: string }[]>`SELECT lower(full_name) AS full_name FROM repos`).map((r) => r.full_name));
    return { items: list.map((r) => ({ ...r, bound: bound.has(r.fullName.toLowerCase()) })) };
  });

  app.get('/api/v1/repos', viewer, async () => ({ items: await repos.list() }));

  app.post('/api/v1/repos', admin, async (req) => {
    const body = AddRepoRequest.safeParse(req.body);
    if (!body.success) throw badRequest('仓库名格式应为 owner/name');
    const repo = await viaGh(() => repos.add(body.data.fullName));
    await audit(sql, `user:${req.user!.id}`, 'repo.added', repo.id, { fullName: repo.fullName });
    return repo;
  });

  app.post<{ Params: { id: string } }>('/api/v1/repos/:id/sync', admin, async (req) => repos.sync(req.params.id));

  app.delete<{ Params: { id: string } }>('/api/v1/repos/:id', admin, async (req) => {
    const row = await repos.row(req.params.id);
    await repos.remove(row.id);
    await audit(sql, `user:${req.user!.id}`, 'repo.removed', row.id, { fullName: row.full_name });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/repos/:id/commits', viewer, async (req) => ({ items: await repos.commits(req.params.id) }));

  app.get('/api/v1/services', viewer, async () => ({ items: await services.list() }));

  app.put<{ Params: { name: string } }>('/api/v1/services/:name/binding', admin, async (req) => {
    if (!SERVICE_RE.test(req.params.name)) throw badRequest('服务名不合法');
    const body = ServiceBindingRequest.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0]?.message ?? '参数错误');
    await repos.row(body.data.repoId);
    await services.bind(req.params.name, body.data.repoId, body.data.subdir, `user:${req.user!.id}`);
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/v1/services/:name/binding', admin, async (req) => {
    await services.unbind(req.params.name, `user:${req.user!.id}`);
    return { ok: true };
  });

  app.get<{ Params: { name: string }; Querystring: { days?: string } }>('/api/v1/services/:name/deploys', viewer, async (req) => {
    if (!SERVICE_RE.test(req.params.name)) throw notFound('服务不存在');
    const days = Math.min(90, Number(req.query.days) || 30);
    return { items: await services.deploys(req.params.name, Date.now() - days * 86400_000) };
  });
}
