// 通知渠道（设计文档 5.2 alerting）：飞书、企业微信、钉钉、Slack 与通用 Webhook。
// 只在 Incident 打开、升级、重开、恢复时通知；抖动中的告警不通知。
import { createHmac } from 'node:crypto';
import {
  ChannelInput,
  type AlertInfo,
  type ChannelKind,
  type IncidentSummary,
  type NotificationChannel,
  type Severity,
} from '@pulse/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Sql } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-error.js';
import { addIncidentEvent, SEVERITY_RANK } from '../alerting/repo.js';
import { audit, requireRole } from '../auth/index.js';
import { isUuid } from '../hosts/repo.js';

export type NotifyKind = 'opened' | 'escalated' | 'reopened' | 'resolved' | 'test';

export interface NotifyPayload {
  kind: NotifyKind;
  incident: IncidentSummary;
  alerts: AlertInfo[];
}

export interface ChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  url: string;
  secret: string | null;
  min_severity: Severity;
  enabled: boolean;
  created_at: Date;
}

export interface OutgoingRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const KIND_TEXT: Record<NotifyKind, string> = {
  opened: '新 Incident',
  escalated: '升级',
  reopened: '重新打开',
  resolved: '已恢复',
  test: '测试消息',
};
const SEVERITY_TEXT: Record<Severity, string> = { warning: '警告', critical: '严重' };

export function toChannelInfo(r: ChannelRow): NotificationChannel {
  let urlHint = '';
  try {
    const u = new URL(r.url);
    urlHint = `${u.protocol}//${u.host}`;
  } catch {
    urlHint = '（地址无效）';
  }
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    urlHint,
    hasSecret: !!r.secret,
    minSeverity: r.min_severity,
    enabled: r.enabled,
    createdAt: r.created_at.getTime(),
  };
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' });
}

/** 生成通知正文（Markdown 子集，各家 IM 都能正常显示）。 */
export function renderMessage(p: NotifyPayload, publicUrl: string): { title: string; text: string; link: string } {
  const i = p.incident;
  const link = `${publicUrl}/incidents/${i.id}`;
  const title = `[Pulse ${KIND_TEXT[p.kind]}] #${i.no} ${i.title}`;
  const lines = [
    `**${title}**`,
    `级别：${SEVERITY_TEXT[i.severity]}　状态：${i.status === 'resolved' ? '已恢复' : '处理中'}`,
    `主机：${i.hosts.map((h) => h.hostname).join('、') || '—'}${i.service ? `　服务：${i.service}` : ''}`,
    `开始：${fmtTime(i.openedAt)}${i.resolvedAt ? `　恢复：${fmtTime(i.resolvedAt)}` : ''}`,
  ];
  const shown = p.alerts.slice(0, 5);
  if (shown.length) {
    lines.push('', '告警：');
    for (const a of shown) {
      const state = a.state === 'resolved' ? '（已恢复）' : a.severity === 'critical' ? '（严重）' : '';
      lines.push(`- ${a.title}${state}`);
    }
    if (p.alerts.length > shown.length) lines.push(`- 另有 ${p.alerts.length - shown.length} 条`);
  }
  lines.push('', `[在 Pulse 中查看](${link})`);
  return { title, text: lines.join('\n'), link };
}

function hmacBase64(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64');
}

/** 按渠道类型构造请求，含飞书、钉钉的签名和通用 Webhook 的 HMAC 头。 */
export function buildRequest(ch: Pick<ChannelRow, 'kind' | 'url' | 'secret'>, p: NotifyPayload, publicUrl: string, now = Date.now()): OutgoingRequest {
  const msg = renderMessage(p, publicUrl);
  const json = { 'content-type': 'application/json' };
  switch (ch.kind) {
    case 'feishu': {
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: msg.text.replace(/\*\*/g, '') } };
      if (ch.secret) {
        const ts = Math.floor(now / 1000).toString();
        body.timestamp = ts;
        body.sign = hmacBase64(`${ts}\n${ch.secret}`, '');
      }
      return { url: ch.url, headers: json, body: JSON.stringify(body) };
    }
    case 'dingtalk': {
      let url = ch.url;
      if (ch.secret) {
        const ts = now.toString();
        const sign = encodeURIComponent(hmacBase64(ch.secret, `${ts}\n${ch.secret}`));
        url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
      }
      return { url, headers: json, body: JSON.stringify({ msgtype: 'markdown', markdown: { title: msg.title, text: msg.text } }) };
    }
    case 'wecom':
      return { url: ch.url, headers: json, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: msg.text } }) };
    case 'slack':
      return {
        url: ch.url,
        headers: json,
        body: JSON.stringify({ text: msg.text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>') }),
      };
    case 'webhook': {
      const body = JSON.stringify({ event: p.kind, title: msg.title, text: msg.text, url: msg.link, incident: p.incident, alerts: p.alerts });
      const headers: Record<string, string> = { ...json };
      if (ch.secret) headers['x-pulse-signature'] = `sha256=${createHmac('sha256', ch.secret).update(body).digest('hex')}`;
      return { url: ch.url, headers, body };
    }
  }
}

/** 各家 IM 在 HTTP 200 里用 code / errcode 表示失败。 */
async function checkResponse(res: Response): Promise<void> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    const j = JSON.parse(text) as { code?: number; errcode?: number; msg?: string; errmsg?: string; StatusCode?: number };
    const code = j.code ?? j.errcode ?? j.StatusCode ?? 0;
    if (code !== 0) throw new Error(`返回错误 ${code}：${j.msg ?? j.errmsg ?? text.slice(0, 200)}`);
  } catch (err) {
    if (err instanceof SyntaxError) return; // 非 JSON（如 Slack 返回 "ok"）
    throw err;
  }
}

export interface NotifierOptions {
  publicUrl: string;
  fetch?: typeof fetch;
  /** 失败后的重试间隔，默认 2 秒、10 秒 */
  retryDelaysMs?: number[];
}

export class Notifier {
  private readonly inflight = new Set<Promise<void>>();
  private readonly fetch: typeof fetch;
  private readonly retryDelays: number[];

  constructor(
    private readonly sql: Sql,
    private readonly log: FastifyBaseLogger,
    private readonly opts: NotifierOptions,
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.retryDelays = opts.retryDelaysMs ?? [2000, 10_000];
  }

  /** 异步发送，不阻塞告警处理；结果写入 Incident 时间线。 */
  dispatch(p: NotifyPayload): void {
    const job = this.deliverAll(p)
      .catch((err) => this.log.error({ err }, '发送通知失败'))
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async deliverAll(p: NotifyPayload) {
    const channels = await this.sql<ChannelRow[]>`SELECT * FROM notification_channels WHERE enabled ORDER BY created_at`;
    const targets = channels.filter((c) => SEVERITY_RANK[p.incident.severity] >= SEVERITY_RANK[c.min_severity]);
    await Promise.all(
      targets.map(async (ch) => {
        try {
          await this.send(ch, p);
          await addIncidentEvent(this.sql, p.incident.id, 'notified', `已通知「${ch.name}」（${KIND_TEXT[p.kind]}）`);
        } catch (err) {
          this.log.warn({ err, channel: ch.name }, '通知发送失败');
          await addIncidentEvent(this.sql, p.incident.id, 'notify_failed', `通知「${ch.name}」失败：${(err as Error).message}`);
        }
      }),
    );
  }

  /** 发送一条通知，失败按 retryDelays 重试。 */
  async send(ch: Pick<ChannelRow, 'kind' | 'url' | 'secret'>, p: NotifyPayload, retryDelays = this.retryDelays): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
      try {
        const req = buildRequest(ch, p, this.opts.publicUrl);
        const res = await this.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(5000) });
        await checkResponse(res);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function sampleIncident(): NotifyPayload {
  const now = Date.now();
  return {
    kind: 'test',
    incident: {
      id: '00000000-0000-0000-0000-000000000000',
      no: 0,
      title: '这是一条测试消息',
      severity: 'warning',
      status: 'open',
      service: null,
      hosts: [{ id: '00000000-0000-0000-0000-000000000000', hostname: 'example-host' }],
      alertCount: 0,
      firingCount: 0,
      openedAt: now,
      updatedAt: now,
      resolvedAt: null,
    },
    alerts: [],
  };
}

export function registerNotifyRoutes(app: FastifyInstance, sql: Sql, notifier: Notifier) {
  const admin = { preHandler: requireRole(sql, 'admin') };

  const load = async (id: string) => {
    if (!isUuid(id)) throw notFound('渠道不存在');
    const [row] = await sql<ChannelRow[]>`SELECT * FROM notification_channels WHERE id = ${id}`;
    if (!row) throw notFound('渠道不存在');
    return row;
  };

  app.get('/api/v1/notification-channels', admin, async () => {
    const rows = await sql<ChannelRow[]>`SELECT * FROM notification_channels ORDER BY created_at`;
    return { items: rows.map(toChannelInfo) };
  });

  app.post('/api/v1/notification-channels', admin, async (req) => {
    const body = ChannelInput.safeParse(req.body);
    if (!body.success || !body.data.url) throw badRequest('请填写名称、类型和 Webhook 地址');
    const c = body.data;
    const [row] = await sql<ChannelRow[]>`
      INSERT INTO notification_channels (name, kind, url, secret, min_severity, enabled)
      VALUES (${c.name}, ${c.kind}, ${c.url!}, ${c.secret || null}, ${c.minSeverity}, ${c.enabled}) RETURNING *`;
    await audit(sql, `user:${req.user!.id}`, 'channel.created', row!.id, { name: c.name, kind: c.kind });
    return toChannelInfo(row!);
  });

  app.patch<{ Params: { id: string } }>('/api/v1/notification-channels/:id', admin, async (req) => {
    const cur = await load(req.params.id);
    const body = ChannelInput.safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    const c = body.data;
    // 地址和密钥留空表示保持不变；密钥传空串以外的值才覆盖
    const [row] = await sql<ChannelRow[]>`
      UPDATE notification_channels SET name = ${c.name}, kind = ${c.kind}, url = ${c.url ?? cur.url},
        secret = ${c.secret === undefined ? cur.secret : c.secret || null}, min_severity = ${c.minSeverity}, enabled = ${c.enabled}
      WHERE id = ${cur.id} RETURNING *`;
    await audit(sql, `user:${req.user!.id}`, 'channel.updated', cur.id, { name: c.name });
    return toChannelInfo(row!);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/notification-channels/:id', admin, async (req) => {
    const cur = await load(req.params.id);
    await sql`DELETE FROM notification_channels WHERE id = ${cur.id}`;
    await audit(sql, `user:${req.user!.id}`, 'channel.deleted', cur.id, { name: cur.name });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/notification-channels/:id/test', admin, async (req) => {
    const cur = await load(req.params.id);
    try {
      await notifier.send(cur, sampleIncident(), []); // 测试时不重试，立即返回结果
      return { ok: true };
    } catch (err) {
      throw badRequest(`发送失败：${(err as Error).message}`);
    }
  });
}
