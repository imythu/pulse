import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprint, type LogLevel } from '@pulse/shared/fingerprint';
import { describe, expect, it } from 'vitest';
import { evaluate, IDLE, recordFlap, type ThresholdParams, type Track } from '../src/modules/alerting/machine.js';
import { buildRequest, type NotifyPayload } from '../src/modules/notify/index.js';

const CPU: ThresholdParams = { threshold: 90, forSeconds: 180, recover: 80, recoverForSeconds: 300, critical: 98 };
const MIN = 60_000;

/** 按分钟喂一串值，返回每一步的状态变化。 */
function run(values: number[], p = CPU, start = 0) {
  let track: Track = IDLE;
  return values.map((v, i) => {
    const r = evaluate(track, v, start + i * MIN, p, 'warning');
    track = r.track;
    return r.transition;
  });
}

describe('告警状态机', () => {
  it('超阈值持续满 for 才触发，期间回落直接丢弃', () => {
    expect(run([95, 95, 70])).toEqual(['pending', 'pending', 'dropped']);
    expect(run([95, 95, 95, 95])).toEqual(['pending', 'pending', 'pending', 'fire']);
  });

  it('firing 期间重复上报只更新，不重复触发', () => {
    expect(run([95, 95, 95, 95, 96, 97, 93])).toEqual(['pending', 'pending', 'pending', 'fire', 'update', 'update', 'update']);
  });

  it('滞回：在 80–90 之间不恢复，低于 80 持续满 5 分钟才恢复', () => {
    const t = run([95, 95, 95, 95, 85, 85, 85, 85, 85, 85, 75, 75, 75, 75, 75, 75]);
    expect(t.slice(4, 10).every((x) => x === 'update')).toBe(true);
    expect(t.slice(10)).toEqual(['update', 'update', 'update', 'update', 'update', 'resolve']);
  });

  it('恢复计时被打断后重新计算', () => {
    const t = run([95, 95, 95, 95, 75, 75, 75, 85, 75, 75, 75, 75, 75, 75]);
    expect(t.indexOf('resolve')).toBe(13);
  });

  it('达到严重阈值时升级一次', () => {
    const t = run([95, 95, 95, 95, 99, 99, 95]);
    expect(t.slice(3)).toEqual(['fire', 'escalate', 'update', 'update']);
    expect(run([99, 99, 99, 99]).at(-1)).toBe('fire'); // 直接以 critical 触发，不再单独升级
  });

  it('for = 0 时立即触发；direction=below 时值越小越糟', () => {
    const disk: ThresholdParams = { threshold: 24, recover: 48, forSeconds: 0, recoverForSeconds: 0, direction: 'below' };
    expect(run([100, 20, 30, 50], disk)).toEqual(['none', 'fire', 'update', 'resolve']);
  });

  it('1 小时内第 3 次重新触发判定为抖动', () => {
    let flaps: number[] = [];
    const results = [0, 10, 20, 90].map((m) => {
      const r = recordFlap(flaps, m * MIN);
      flaps = r.flaps;
      return r.flapping;
    });
    expect(results).toEqual([false, false, true, false]);
  });
});

describe('日志指纹（与 Go Agent 共用用例）', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../packages/shared/fingerprint/cases.json', import.meta.url), 'utf8')) as {
    name: string;
    service: string;
    level: LogLevel;
    record: string;
    fingerprint: string;
    template: string;
  }[];
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(fingerprint(c.service, c.level, c.record)).toEqual({ fingerprint: c.fingerprint, template: c.template });
  });
});

describe('通知渠道', () => {
  const payload: NotifyPayload = {
    kind: 'opened',
    incident: {
      id: 'i-1',
      no: 7,
      title: 'web-01 CPU 使用率过高',
      severity: 'critical',
      status: 'open',
      service: null,
      hosts: [{ id: 'h', hostname: 'web-01' }],
      alertCount: 1,
      firingCount: 1,
      openedAt: 0,
      updatedAt: 0,
      resolvedAt: null,
    },
    alerts: [],
  };
  const url = 'https://pulse.example.com';

  it('飞书：按 timestamp + 密钥签名', () => {
    const req = buildRequest({ kind: 'feishu', url: 'https://open.feishu.cn/hook/x', secret: 's' }, payload, url, 1_700_000_000_000);
    const body = JSON.parse(req.body);
    expect(body.timestamp).toBe('1700000000');
    expect(body.sign).toBe(createHmac('sha256', '1700000000\ns').update('').digest('base64'));
    expect(body.content.text).toContain('#7 web-01 CPU 使用率过高');
    expect(body.content.text).toContain(`${url}/incidents/i-1`);
  });

  it('钉钉：签名放在 URL 上', () => {
    const req = buildRequest({ kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 's' }, payload, url, 1000);
    const sign = encodeURIComponent(createHmac('sha256', 's').update('1000\ns').digest('base64'));
    expect(req.url).toBe(`https://oapi.dingtalk.com/robot/send?access_token=t&timestamp=1000&sign=${sign}`);
    expect(JSON.parse(req.body).msgtype).toBe('markdown');
  });

  it('Webhook：带 HMAC 签名头和完整数据', () => {
    const req = buildRequest({ kind: 'webhook', url: 'https://hooks.example.com/x', secret: 'k' }, payload, url);
    expect(req.headers['x-pulse-signature']).toBe(`sha256=${createHmac('sha256', 'k').update(req.body).digest('hex')}`);
    expect(JSON.parse(req.body)).toMatchObject({ event: 'opened', incident: { no: 7 } });
  });

  it('Slack：链接转换为 Slack 格式', () => {
    const req = buildRequest({ kind: 'slack', url: 'https://hooks.slack.com/x', secret: null }, payload, url);
    expect(JSON.parse(req.body).text).toContain(`<${url}/incidents/i-1|在 Pulse 中查看>`);
  });
});
