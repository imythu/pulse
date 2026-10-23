import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Sql } from './db/index.js';
import { HttpError } from './lib/http-error.js';
import { LiveBus } from './lib/live.js';
import { AlertEngine, type EngineOptions } from './modules/alerting/engine.js';
import { registerAlertingRoutes } from './modules/alerting/routes.js';
import { registerAuth } from './modules/auth/index.js';
import { registerEnroll } from './modules/enroll/index.js';
import { Gateway } from './modules/gateway/index.js';
import { registerHostRoutes } from './modules/hosts/routes.js';
import { registerLive } from './modules/live/index.js';
import { registerLogRoutes } from './modules/logs/routes.js';
import { Notifier, registerNotifyRoutes, type NotifierOptions } from './modules/notify/index.js';

export interface App {
  app: FastifyInstance;
  gateway: Gateway;
  live: LiveBus;
  engine: AlertEngine;
  notifier: Notifier;
}

export interface BuildOptions {
  logger?: boolean;
  engine?: EngineOptions;
  notifier?: Partial<NotifierOptions>;
}

function findUp(rel: string): string {
  let dir = resolve(fileURLToPath(import.meta.url), '..');
  for (let i = 0; i < 6; i++) {
    const p = resolve(dir, rel);
    if (existsSync(p)) return p;
    dir = resolve(dir, '..');
  }
  throw new Error(`找不到 ${rel}`);
}

export async function buildApp(config: Config, sql: Sql, opts: BuildOptions = {}): Promise<App> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, '请求处理失败');
    return reply.status(500).send({ error: 'internal', message: '服务器内部错误' });
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  const publicUrl = config.PULSE_PUBLIC_URL.replace(/\/$/, '');
  const live = new LiveBus();
  const notifier = new Notifier(sql, app.log, { publicUrl, ...opts.notifier });
  const engine = new AlertEngine(sql, live, notifier, app.log, opts.engine);
  const gateway = new Gateway(sql, live, app.log, engine, { offlineAfterSeconds: config.PULSE_OFFLINE_AFTER_SECONDS });

  app.get('/healthz', async () => ({ ok: true }));
  registerAuth(app, sql, { secureCookies: config.PULSE_PUBLIC_URL.startsWith('https://') });
  registerEnroll(app, sql, live, {
    publicUrl,
    agentDist: config.PULSE_AGENT_DIST ? resolve(config.PULSE_AGENT_DIST) : undefined,
    installScriptPath: findUp('deploy/install.sh'),
  });
  gateway.register(app);
  registerHostRoutes(app, sql, gateway, engine);
  registerAlertingRoutes(app, sql, engine);
  registerLogRoutes(app, sql, engine);
  registerNotifyRoutes(app, sql, notifier);
  registerLive(app, sql, live);

  // 生产环境由后端同源托管前端，前端路由一律回退到 index.html
  const webDist = config.PULSE_WEB_DIST ? resolve(config.PULSE_WEB_DIST) : undefined;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      const isPage = !/^\/(api|agent|assets|downloads)\//.test(req.url);
      if (req.method === 'GET' && isPage) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: '不存在' });
    });
  }

  return { app, gateway, live, engine, notifier };
}
