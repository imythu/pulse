import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EnrollRequest, EnrollTokenRequest, type EnrollResponse, type EnrollTokenResponse } from '@pulse/shared';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { hashToken, newToken } from '../../lib/crypto.js';
import { badRequest, notFound, unauthorized } from '../../lib/http-error.js';
import type { LiveBus } from '../../lib/live.js';
import { audit, requireRole } from '../auth/index.js';
import { toSummary, type HostRow } from '../hosts/repo.js';

const AGENT_ARCHES = new Set(['amd64']);

export interface EnrollOptions {
  publicUrl: string;
  signingPublicKey: string;
  agentDist?: string;
  installScriptPath: string;
}

export function registerEnroll(app: FastifyInstance, sql: Sql, live: LiveBus, opts: EnrollOptions) {
  // 控制台生成一次性注册令牌（设计文档 3.1）
  app.post('/api/v1/agents/enroll-tokens', { preHandler: requireRole(sql, 'admin') }, async (req): Promise<EnrollTokenResponse> => {
    const body = EnrollTokenRequest.safeParse(req.body ?? {});
    if (!body.success) throw badRequest('参数错误');
    const token = newToken('pe', 24);
    const expiresAt = new Date(Date.now() + body.data.ttlHours * 3600 * 1000);
    await sql`
      INSERT INTO enroll_tokens (token_hash, labels, created_by, expires_at)
      VALUES (${hashToken(token)}, ${sql.json(body.data.labels)}, ${req.user!.id}, ${expiresAt})`;
    await audit(sql, `user:${req.user!.id}`, 'agent.enroll_token_created', null, { ttlHours: body.data.ttlHours, labels: body.data.labels });
    return {
      token,
      expiresAt: expiresAt.getTime(),
      installCommand: `curl -fsSL ${opts.publicUrl}/install.sh | sudo sh -s -- --token ${token}`,
    };
  });

  // Agent 用注册令牌换取身份；令牌在同一事务里作废
  app.post('/agent/enroll', async (req): Promise<EnrollResponse> => {
    const body = EnrollRequest.safeParse(req.body);
    if (!body.success) throw badRequest('注册请求格式错误');
    const publicKey = Buffer.from(body.data.publicKey, 'base64');
    if (publicKey.length !== 32) throw badRequest('公钥格式错误');

    const host = await sql.begin(async (tx) => {
      const [token] = await tx<{ labels: Record<string, string> }[]>`
        UPDATE enroll_tokens SET used_at = now()
        WHERE token_hash = ${hashToken(body.data.token)} AND used_at IS NULL AND expires_at > now()
        RETURNING labels`;
      if (!token) return undefined;
      const labels = { ...body.data.host.labels, ...token.labels };
      const [row] = await tx<HostRow[]>`
        INSERT INTO hosts (hostname, info, labels, agent_version)
        VALUES (${body.data.host.hostname}, ${tx.json(body.data.host)}, ${tx.json(labels)}, ${body.data.agentVersion})
        RETURNING *`;
      await tx`INSERT INTO agent_credentials (host_id, public_key) VALUES (${row!.id}, ${publicKey})`;
      await tx`UPDATE enroll_tokens SET used_by = ${row!.id} WHERE token_hash = ${hashToken(body.data.token)}`;
      return row!;
    });
    if (!host) throw unauthorized('注册令牌无效、已使用或已过期');

    await audit(sql, `agent:${host.id}`, 'agent.enrolled', host.hostname, { ip: req.ip });
    live.publish({ channel: 'overview', type: 'host.enrolled', host: toSummary(host), at: Date.now() });
    return { agentId: host.id, signingPublicKey: opts.signingPublicKey };
  });

  // M3 之前注册的 Agent 没有保存指令签名公钥，启动时从这里取一次（经 HTTPS 时可信）
  app.get('/agent/signing-key', async () => ({ signingPublicKey: opts.signingPublicKey }));

  app.get('/install.sh', async (_req, reply) => {
    const script = await readFile(opts.installScriptPath, 'utf8');
    reply.type('text/x-shellscript; charset=utf-8');
    return script.replaceAll('__PULSE_SERVER__', opts.publicUrl);
  });

  app.get<{ Params: { arch: string } }>('/downloads/pulse-agent-linux-:arch', async (req, reply) => {
    if (!opts.agentDist || !AGENT_ARCHES.has(req.params.arch)) throw notFound();
    const file = resolve(opts.agentDist, `pulse-agent-linux-${req.params.arch}`);
    if (!existsSync(file)) throw notFound('该架构的 Agent 尚未构建');
    reply.header('content-disposition', `attachment; filename=pulse-agent`);
    reply.type('application/octet-stream');
    return reply.send(await readFile(file));
  });
}
