import { generateKeyPairSync, sign } from 'node:crypto';
import { agentAuthMessage } from '@pulse/shared';
import { describe, expect, it } from 'vitest';
import { verifyEd25519 } from '../src/lib/crypto.js';
import { snapshotFromPoints } from '../src/modules/hosts/repo.js';
import { chooseStep } from '../src/modules/hosts/routes.js';

const HOUR = 3600_000;

describe('chooseStep', () => {
  it('短时间范围用 1 分钟原始数据', () => {
    expect(chooseStep(0, HOUR)).toEqual({ stepSeconds: 60, source: 'metrics' });
    expect(chooseStep(0, 6 * HOUR)).toEqual({ stepSeconds: 60, source: 'metrics' });
  });
  it('点数不超过 360', () => {
    expect(chooseStep(0, 24 * HOUR).stepSeconds).toBe(300);
    expect(chooseStep(0, 7 * 24 * HOUR)).toEqual({ stepSeconds: 1800, source: 'metrics' });
  });
  it('超过 7 天改查小时聚合表', () => {
    expect(chooseStep(0, 30 * 24 * HOUR)).toEqual({ stepSeconds: 3 * 3600, source: 'metrics_1h' });
  });
});

describe('snapshotFromPoints', () => {
  it('磁盘取所有挂载点的最大值，缺失的指标为 null', () => {
    const p = (name: string, tag: string, avg: number) => ({ name, tag, min: avg, max: avg, avg, p95: avg });
    const s = snapshotFromPoints([p('cpu.usage_pct', '', 12), p('disk.used_pct', '/', 40), p('disk.used_pct', '/data', 88)], 1000);
    expect(s).toEqual({ cpuPct: 12, memPct: null, diskPct: 88, load1: null, at: 1000 });
  });
});

describe('verifyEd25519', () => {
  it('校验 Agent 握手签名', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const msg = agentAuthMessage('id', 1);
    const sig = sign(null, Buffer.from(msg), privateKey);
    expect(verifyEd25519(raw, msg, sig)).toBe(true);
    expect(verifyEd25519(raw, agentAuthMessage('id', 2), sig)).toBe(false);
  });
});
