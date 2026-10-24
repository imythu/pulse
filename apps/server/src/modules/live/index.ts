import type { LiveClientMessage, LiveEvent } from '@pulse/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '../../db/index.js';
import { unauthorized } from '../../lib/http-error.js';
import type { LiveBus } from '../../lib/live.js';
import { SESSION_COOKIE, userFromSession } from '../auth/index.js';

const CHANNEL_RE = /^(overview|(host|command):[0-9a-f-]{36})$/;
const MAX_CHANNELS = 20;

/** 控制台实时推送：客户端按频道订阅，服务器只推变更（设计文档 9.4）。 */
export function registerLive(app: FastifyInstance, sql: Sql, live: LiveBus) {
  app.get(
    '/api/v1/live',
    {
      websocket: true,
      preValidation: async (req: FastifyRequest) => {
        const user = await userFromSession(sql, req.cookies[SESSION_COOKIE]);
        if (!user) throw unauthorized();
        req.user = user;
      },
    },
    (socket) => {
      const subs = new Map<string, () => void>();
      const forward = (event: LiveEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };
      socket.on('message', (raw: Buffer) => {
        let msg: LiveClientMessage;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (!Array.isArray(msg?.channels)) return;
        for (const ch of msg.channels) {
          if (typeof ch !== 'string' || !CHANNEL_RE.test(ch)) continue;
          if (msg.op === 'subscribe' && !subs.has(ch) && subs.size < MAX_CHANNELS) subs.set(ch, live.subscribe(ch, forward));
          if (msg.op === 'unsubscribe') {
            subs.get(ch)?.();
            subs.delete(ch);
          }
        }
      });
      socket.on('close', () => subs.forEach((off) => off()));
    },
  );
}
