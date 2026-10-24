// 压测：模拟 N 台 Agent 按真实协议接入服务器（设计文档 5.5、12.3 M2 验收）。
//
//   pnpm --filter @pulse/server loadtest:sim -- --agents 500 --minutes 30 --out /tmp/sim.json
//
// 每台模拟 Agent 自己注册、签名握手，然后按默认配置上报：60 秒一个 40 个指标的窗口、
// 15 秒心跳、30 秒进程快照，偶尔上报异常日志汇总。统计 ack 延迟、断线、控制台接口延迟，
// 并按 --pids 采样服务器与数据库进程的 CPU 和内存。
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { agentAuthMessage, Metric, type HostInfo, type LogEvent, type MetricPoint, type ProcessInfo } from '@pulse/shared';
import WebSocket from 'ws';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:8080' },
    agents: { type: 'string', default: '500' },
    minutes: { type: 'string', default: '10' },
    user: { type: 'string', default: 'admin' },
    password: { type: 'string', default: 'loadtest-password' },
    /** 逗号分隔的进程号，采样 CPU 与内存；pg 表示所有 postgres 进程 */
    pids: { type: 'string', default: '' },
    /** 所有 Agent 在多少秒内陆续连上 */
    ramp: { type: 'string', default: '60' },
    /** 每台 Agent 每个 10 秒窗口上报异常日志的概率 */
    'log-rate': { type: 'string', default: '0.05' },
    out: { type: 'string', default: '' },
  },
});

const SERVER = args.server!.replace(/\/$/, '');
const WS_URL = SERVER.replace(/^http/, 'ws') + '/agent/ws';
const N = Number(args.agents);
const DURATION_MS = Number(args.minutes) * 60_000;
const RAMP_MS = Number(args.ramp) * 1000;
const LOG_RATE = Number(args['log-rate']);
const SERVICES = Array.from({ length: 20 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);

// ---------- 统计 ----------

class Hist {
  private v: number[] = [];
  add(x: number) {
    this.v.push(x);
  }
  get count() {
    return this.v.length;
  }
  summary() {
    if (!this.v.length) return { count: 0 };
    const s = this.v.slice().sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return { count: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1]! };
  }
  reset() {
    const out = this.summary();
    this.v = [];
    return out;
  }
}

const stats = {
  ack: new Hist(),
  ackAll: new Hist(),
  api: new Hist(),
  apiAll: new Hist(),
  sent: 0,
  bytes: 0,
  acked: 0,
  connects: 0,
  disconnects: 0,
  connectFailures: 0,
  apiErrors: 0,
};

// ---------- 控制台 ----------

let cookie = '';

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(SERVER + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function login() {
  const { needsSetup } = await http<{ needsSetup: boolean }>('GET', '/api/v1/setup/status');
  if (needsSetup) await http('POST', '/api/v1/setup', { username: args.user, password: args.password });
  else await http('POST', '/api/v1/auth/login', { username: args.user, password: args.password });
}

// ---------- 模拟 Agent ----------

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const LOG_TEMPLATES = [
  (n: number) => `ERROR c.e.order.OrderService - Order ${n} failed: payment gateway timeout after ${n % 5000}ms`,
  (n: number) => `ERROR db pool exhausted, waited ${n % 3000}ms for connection to 10.0.${n % 255}.7:5432`,
  (n: number) => `ERROR java.lang.NullPointerException: Cannot invoke "User.getId()" because "user" is null\n\tat com.example.api.UserController.show(UserController.java:${n % 300})\n\tat com.example.api.Router.dispatch(Router.java:88)`,
  (n: number) => `Traceback (most recent call last):\n  File "/srv/app/worker.py", line ${n % 400}, in run\n    job = queue.pop()\nKeyError: 'job-${n}'`,
  (n: number) => `FATAL redis connection refused at 10.1.0.${n % 255}:6379`,
  (n: number) => `ERROR upstream request ${crypto.randomUUID()} returned 502 in ${n % 900}ms`,
];

class SimAgent {
  private seq = 0;
  private ws?: WebSocket;
  private readonly pending = new Map<number, { at: number; frame: Buffer }>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private cpu = rand(5, 40);
  private mem = rand(20, 60);
  private readonly disks = ['/', '/data', '/var'].map((m) => ({ m, used: rand(10, 60) }));
  private agentId = '';
  private key!: KeyObject;
  private readonly host: HostInfo;
  private backoff = 1000;

  constructor(private readonly i: number) {
    this.host = {
      hostname: `sim-${String(i).padStart(4, '0')}`,
      os: 'linux',
      platform: 'ubuntu',
      platformVersion: '24.04',
      kernel: '6.8.0-sim',
      arch: 'amd64',
      cpuCores: 8,
      cpuModel: 'Simulated CPU',
      memTotal: 16e9,
      ips: [`10.9.${Math.floor(i / 250)}.${i % 250}`],
      labels: { env: 'load', service: SERVICES[i % SERVICES.length]! },
      bootTime: Math.floor(Date.now() / 1000) - 86400,
    };
  }

  async enroll(token: string) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.key = privateKey;
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const { agentId } = await http<{ agentId: string }>('POST', '/agent/enroll', {
      token,
      publicKey: raw.toString('base64'),
      host: this.host,
      agentVersion: 'sim',
    });
    this.agentId = agentId;
  }

  connect() {
    if (this.stopped) return;
    const ts = Date.now();
    const sig = sign(null, Buffer.from(agentAuthMessage(this.agentId, ts)), this.key).toString('base64url');
    const ws = new WebSocket(WS_URL, { headers: { authorization: `Pulse ${this.agentId}.${ts}.${sig}` } });
    this.ws = ws;
    ws.on('open', () => {
      stats.connects++;
      this.backoff = 1000;
      this.raw({ type: 'hello', seq: 0, ts: Date.now(), payload: { protocol: 1, agentVersion: 'sim', host: this.host } });
    });
    ws.on('message', (data: Buffer) => this.onMessage(JSON.parse(zstdDecompressSync(data).toString('utf8'))));
    ws.on('error', () => {});
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (code === 1006 && !this.stopped) stats.connectFailures++;
      stats.disconnects++;
      if (this.stopped) return;
      // 与真实 Agent 相同的退避：1 秒起、上限 60 秒、带抖动
      const wait = this.backoff / 2 + Math.random() * (this.backoff / 2);
      this.backoff = Math.min(this.backoff * 2, 60_000);
      setTimeout(() => this.connect(), wait);
    });
  }

  private onMessage(msg: { type: string; payload: { maxSeq?: number } }) {
    if (msg.type !== 'ack') return;
    const max = msg.payload.maxSeq ?? 0;
    const now = Date.now();
    for (const [seq, p] of this.pending) {
      if (seq > max) continue;
      stats.ack.add(now - p.at);
      stats.ackAll.add(now - p.at);
      stats.acked++;
      this.pending.delete(seq);
    }
    // hello 的 ack：补传服务器还没确认的消息
    if (msg.payload.maxSeq !== undefined && this.ws) {
      for (const [seq, p] of this.pending) if (seq > max) this.ws.send(p.frame);
    }
  }

  private raw(m: object) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame = zstdCompressSync(Buffer.from(JSON.stringify(m)));
    stats.sent++;
    stats.bytes += frame.length;
    this.ws.send(frame);
  }

  private reliable(type: string, payload: object) {
    const seq = ++this.seq;
    const frame = zstdCompressSync(Buffer.from(JSON.stringify({ type, seq, ts: Date.now(), payload })));
    this.pending.set(seq, { at: Date.now(), frame });
    if (this.ws?.readyState === WebSocket.OPEN) {
      stats.sent++;
      stats.bytes += frame.length;
      this.ws.send(frame);
    }
  }

  start() {
    const every = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        fn();
        this.timers.push(setInterval(fn, ms));
      }, Math.random() * ms);
      this.timers.push(t);
    };
    every(15_000, () => this.raw({ type: 'heartbeat', seq: 0, ts: Date.now(), payload: { queueDepth: this.pending.size, uptimeSeconds: 3600, cpuPct: 0.3, memPct: 0.2 } }));
    every(60_000, () => this.reliable('metrics', this.metrics()));
    every(30_000, () => this.reliable('procs', this.procs()));
    every(10_000, () => {
      if (Math.random() < LOG_RATE) this.reliable('logs', this.logs());
    });
  }

  stop() {
    this.stopped = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.ws?.close(1000);
  }

  private metrics() {
    this.cpu = clamp(this.cpu + rand(-5, 5), 1, 75);
    this.mem = clamp(this.mem + rand(-2, 2), 10, 80);
    const pt = (name: string, v: number, tag = ''): MetricPoint => ({ name, tag, min: v * 0.8, max: v * 1.2, avg: v, p95: v * 1.1 });
    const points: MetricPoint[] = [
      pt(Metric.cpuUsage, this.cpu),
      pt(Metric.cpuIowait, rand(0, 3)),
      pt(Metric.load1, this.cpu / 12),
      pt(Metric.load5, this.cpu / 13),
      pt(Metric.load15, this.cpu / 14),
      pt(Metric.memUsed, this.mem),
      pt(Metric.memUsedBytes, this.mem * 16e7),
      pt(Metric.swapUsed, rand(0, 5)),
      pt(Metric.tcpEstablished, Math.round(rand(50, 400))),
      pt(Metric.tcpTimeWait, Math.round(rand(0, 200))),
    ];
    for (const d of this.disks) {
      d.used = clamp(d.used + rand(-0.05, 0.08), 1, 80);
      points.push(pt(Metric.diskUsed, d.used, d.m), pt(Metric.diskInodeUsed, d.used / 3, d.m));
      points.push(pt(Metric.diskReadBps, rand(0, 5e6), d.m), pt(Metric.diskWriteBps, rand(0, 8e6), d.m));
    }
    for (const nic of ['eth0', 'eth1', 'docker0']) {
      points.push(pt(Metric.netRxBps, rand(1e4, 5e7), nic), pt(Metric.netTxBps, rand(1e4, 5e7), nic));
    }
    // 补到 40 个点：模拟脚本或额外对象
    for (let k = points.length; k < 40; k++) points.push(pt('net.rx_bps', rand(0, 1e5), `veth${k}`));
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    return { windowStart, windowSeconds: 60, early: false, points };
  }

  private procs() {
    const proc = (k: number): ProcessInfo => ({
      pid: 1000 + k,
      name: pick(['java', 'node', 'python3', 'postgres', 'nginx', 'redis-server']),
      cmdline: `/usr/bin/app --worker ${k} --config /etc/app/config.yaml`,
      user: 'app',
      cpuPct: rand(0, 30),
      memPct: rand(0, 10),
      rssBytes: Math.round(rand(1e7, 1e9)),
    });
    return { byCpu: Array.from({ length: 10 }, (_, k) => proc(k)), byMem: Array.from({ length: 10 }, (_, k) => proc(k + 10)) };
  }

  private logs() {
    const now = Date.now();
    const service = this.host.labels.service!;
    const events: LogEvent[] = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => {
      const msg = pick(LOG_TEMPLATES)(Math.floor(Math.random() * 1e6));
      return {
        fingerprint: 'sim',
        service,
        level: msg.startsWith('FATAL') ? 'fatal' : 'error',
        source: `/var/log/${service}/app.log`,
        message: msg,
        context: ['INFO request started', 'INFO calling upstream'],
        count: 1 + Math.floor(Math.random() * 50),
        firstTs: now - 10_000,
        lastTs: now,
      };
    });
    return { rulesVersion: 1, events, dropped: 0 };
  }
}

// ---------- 进程采样 ----------

const CLK_TCK = 100;
const PAGE = 4096;

function listPids(): number[] {
  const spec = args.pids!.split(',').filter(Boolean);
  const out: number[] = [];
  for (const s of spec) {
    if (s !== 'pg') out.push(Number(s));
    else {
      for (const d of readdirSafe('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          if (readFileSync(`/proc/${d}/comm`, 'utf8').trim().startsWith('postgres')) out.push(Number(d));
        } catch {}
      }
    }
  }
  return out;
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// 内存用 PSS：PostgreSQL 各进程共享 shared_buffers，直接累加 RSS 会重复计算
function procTotals(pids: number[]): { cpuTicks: number; rssBytes: number; serverRssBytes: number } {
  let cpuTicks = 0;
  let rssBytes = 0;
  let serverRssBytes = 0;
  const server = new Set(args.pids!.split(',').filter((s) => /^\d+$/.test(s)).map(Number));
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      cpuTicks += Number(f[11]) + Number(f[12]);
      let mem = Number(f[21]) * PAGE;
      try {
        const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
        if (m) mem = Number(m[1]) * 1024;
      } catch {}
      rssBytes += mem;
      if (server.has(pid)) serverRssBytes += mem;
    } catch {}
  }
  return { cpuTicks, rssBytes, serverRssBytes };
}

// ---------- 主流程 ----------

async function main() {
  await login();
  console.log(`登录成功，开始注册 ${N} 台模拟 Agent`);
  const agents: SimAgent[] = [];
  for (let i = 0; i < N; i++) {
    const { token } = await http<{ token: string }>('POST', '/api/v1/agents/enroll-tokens', { ttlHours: 1, labels: {} });
    const a = new SimAgent(i);
    await a.enroll(token);
    agents.push(a);
  }
  console.log(`注册完成，${RAMP_MS / 1000} 秒内陆续连接`);

  const t0 = Date.now();
  agents.forEach((a, i) =>
    setTimeout(() => {
      a.connect();
      a.start();
    }, (i / N) * RAMP_MS),
  );

  // 控制台接口：模拟 5 个人开着页面，每 5 秒拉一次主机列表和总览
  const apiTimer = setInterval(async () => {
    for (const path of ['/api/v1/hosts', '/api/v1/overview', '/api/v1/incidents?status=open&limit=50']) {
      const s = Date.now();
      try {
        await http('GET', path);
        stats.api.add(Date.now() - s);
        stats.apiAll.add(Date.now() - s);
      } catch {
        stats.apiErrors++;
      }
    }
  }, 1000);

  const samples: object[] = [];
  let pids = listPids();
  let prev = procTotals(pids);
  let prevAt = Date.now();
  const report = setInterval(() => {
    pids = listPids();
    const cur = procTotals(pids);
    const now = Date.now();
    const cpuPct = ((cur.cpuTicks - prev.cpuTicks) / CLK_TCK / ((now - prevAt) / 1000)) * 100;
    prev = cur;
    prevAt = now;
    const connected = agents.filter((a) => (a as unknown as { ws?: WebSocket }).ws?.readyState === WebSocket.OPEN).length;
    const s = {
      t: Math.round((now - t0) / 1000),
      connected,
      sent: stats.sent,
      acked: stats.acked,
      ack: stats.ack.reset(),
      api: stats.api.reset(),
      apiErrors: stats.apiErrors,
      disconnects: stats.disconnects,
      procCpuPct: pids.length ? Math.round(cpuPct * 10) / 10 : null,
      procRssMb: pids.length ? Math.round(cur.rssBytes / 1e6) : null,
      serverRssMb: pids.length ? Math.round(cur.serverRssBytes / 1e6) : null,
    };
    samples.push(s);
    console.log(JSON.stringify(s));
  }, 10_000);

  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(apiTimer);
  clearInterval(report);
  agents.forEach((a) => a.stop());

  const summary = {
    agents: N,
    minutes: Number(args.minutes),
    messagesSent: stats.sent,
    reliableAcked: stats.acked,
    kbSent: Math.round(stats.bytes / 1024),
    ackLatencyMs: stats.ackAll.summary(),
    apiLatencyMs: stats.apiAll.summary(),
    apiErrors: stats.apiErrors,
    connects: stats.connects,
    disconnects: stats.disconnects,
    connectFailures: stats.connectFailures,
    samples,
  };
  console.log(JSON.stringify({ ...summary, samples: undefined }, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
  setTimeout(() => process.exit(0), 500);
}

await main();
