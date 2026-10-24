import { CommandListQuery, CreateCommandRequest, RejectCommandRequest, type CommandInfo, type HostCommandTemplates, type Page } from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-error.js';
import { requireRole } from '../auth/index.js';
import type { CommandService } from './service.js';

export function registerCommandRoutes(app: FastifyInstance, sql: Sql, commands: CommandService) {
  const viewer = { preHandler: requireRole(sql, 'viewer') };
  const operator = { preHandler: requireRole(sql, 'operator') };
  const admin = { preHandler: requireRole(sql, 'admin') };

  app.get<{ Params: { id: string } }>('/api/v1/hosts/:id/command-templates', viewer, async (req): Promise<HostCommandTemplates> => {
    return commands.templatesFor(req.params.id);
  });

  app.get('/api/v1/commands', viewer, async (req): Promise<Page<CommandInfo>> => {
    const q = CommandListQuery.safeParse(req.query);
    if (!q.success) throw badRequest('查询参数错误');
    const { hostId, status, cursor, limit } = q.data;
    const items = await commands.list(
      sql`true
        ${hostId ? sql`AND c.host_id = ${hostId}` : sql``}
        ${status === 'pending_approval' ? sql`AND c.status = 'pending_approval'` : status === 'active' ? sql`AND c.status IN ('queued', 'sent', 'running')` : sql``}
        ${cursor ? sql`AND c.no < ${cursor}` : sql``}`,
      limit,
    );
    return { items, nextCursor: items.length === limit ? items[items.length - 1]!.no : null };
  });

  app.get<{ Params: { id: string } }>('/api/v1/commands/:id', viewer, async (req) => {
    const cmd = await commands.get(req.params.id);
    if (!cmd) throw notFound('指令不存在');
    return cmd;
  });

  app.post('/api/v1/commands', operator, async (req) => {
    const body = CreateCommandRequest.safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    return commands.create({ kind: 'user', user: req.user! }, body.data);
  });

  app.post<{ Params: { id: string } }>('/api/v1/commands/:id/approve', admin, async (req) => commands.approve(req.params.id, req.user!));

  app.post<{ Params: { id: string } }>('/api/v1/commands/:id/reject', admin, async (req) => {
    const body = RejectCommandRequest.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('参数错误');
    return commands.reject(req.params.id, req.user!, body.data.reason);
  });

  app.post<{ Params: { id: string } }>('/api/v1/commands/:id/cancel', operator, async (req) => commands.cancel(req.params.id, req.user!));
}
