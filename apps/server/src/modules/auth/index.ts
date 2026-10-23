import { hash, verify } from '@node-rs/argon2';
import { LoginRequest, SetupRequest, type Me } from '@pulse/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql, Tx } from '../../db/index.js';
import { hashToken, newToken } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/http-error.js';

export const SESSION_COOKIE = 'pulse_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 } as const;
type Role = keyof typeof ROLE_RANK;
const DUMMY_HASH = hash('pulse-timing-equalizer');

declare module 'fastify' {
  interface FastifyRequest {
    user?: Me;
  }
}

export async function userFromSession(sql: Sql, token: string | undefined): Promise<Me | undefined> {
  if (!token) return undefined;
  const [row] = await sql<{ id: string; username: string; role: Role }[]>`
    SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  return row;
}

/** 路由前置钩子：要求登录且角色不低于 role。 */
export function requireRole(sql: Sql, role: Role) {
  return async (req: FastifyRequest) => {
    const user = await userFromSession(sql, req.cookies[SESSION_COOKIE]);
    if (!user) throw unauthorized();
    if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw forbidden();
    req.user = user;
  };
}

async function startSession(sql: Sql, reply: FastifyReply, userId: string, secure: boolean) {
  const token = newToken('ps');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${hashToken(token)}, ${userId}, ${expires})`;
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires });
}

async function countUsers(sql: Sql | Tx): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM users`;
  return row?.count ?? 0;
}

export async function audit(sql: Sql, actor: string, action: string, target: string | null, detail: object = {}) {
  await sql`INSERT INTO audit_logs (actor, action, target, detail) VALUES (${actor}, ${action}, ${target}, ${sql.json(detail as never)})`;
}

export function registerAuth(app: FastifyInstance, sql: Sql, opts: { secureCookies: boolean }) {
  app.get('/api/v1/setup/status', async () => {
    return { needsSetup: (await countUsers(sql)) === 0 };
  });

  // 首次启动时创建第一个 admin；已有用户后此接口永久关闭
  app.post('/api/v1/setup', async (req, reply) => {
    const body = SetupRequest.safeParse(req.body);
    if (!body.success) throw badRequest('用户名 3–64 位字母数字，密码至少 10 位');
    const passwordHash = await hash(body.data.password);
    const created = await sql.begin(async (tx) => {
      await tx`LOCK TABLE users IN EXCLUSIVE MODE`;
      if ((await countUsers(tx)) > 0) return undefined;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO users (username, password_hash, role) VALUES (${body.data.username}, ${passwordHash}, 'admin') RETURNING id`;
      return row;
    });
    if (!created) throw conflict('系统已初始化');
    await audit(sql, `user:${created.id}`, 'setup.admin_created', body.data.username);
    await startSession(sql, reply, created.id, opts.secureCookies);
    return { ok: true };
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) throw badRequest('请输入用户名和密码');
    const [user] = await sql<{ id: string; password_hash: string }[]>`
      SELECT id, password_hash FROM users WHERE username = ${body.data.username}`;
    // 用户不存在时也做一次哈希校验，避免通过响应时间探测用户名
    const ok = await verify(user?.password_hash ?? (await DUMMY_HASH), body.data.password);
    if (!user || !ok) {
      await audit(sql, 'anonymous', 'auth.login_failed', body.data.username);
      throw unauthorized('用户名或密码错误');
    }
    await startSession(sql, reply, user.id, opts.secureCookies);
    await audit(sql, `user:${user.id}`, 'auth.login', null);
    return { ok: true };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/me', { preHandler: requireRole(sql, 'viewer') }, async (req) => req.user);
}
