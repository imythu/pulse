// 压测：故障风暴（设计文档 12.3 M2 验收）。
//
//   pnpm --filter @pulse/server loadtest:storm -- --log /tmp/storm/order-api.log --hostname <真实 Agent 的主机名> --minutes 30
//
// 配合一个真实的 pulse-agent 使用：往它跟踪的日志文件里匀速写入 --lines 条同类报错（带堆栈、变量各不相同），
// 同时用 nice 19 的忙循环把所有 CPU 打满。结束后通过控制台接口检查：这台主机只产生 1 个 Incident，
// 日志指纹的计数与写入条数一致。
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:8080' },
    user: { type: 'string', default: 'admin' },
    password: { type: 'string', default: 'loadtest-password' },
    log: { type: 'string' },
    hostname: { type: 'string' },
    service: { type: 'string', default: 'order-api' },
    lines: { type: 'string', default: '100000' },
    minutes: { type: 'string', default: '30' },
    /** 写完日志后再等多久让 Agent 把最后的窗口送到 */
    settle: { type: 'string', default: '40' },
    'no-cpu': { type: 'boolean', default: false },
    out: { type: 'string', default: '' },
  },
});

if (!args.log || !args.hostname) {
  console.error('需要 --log 和 --hostname');
  process.exit(2);
}

const SERVER = args.server!.replace(/\/$/, '');
const TOTAL = Number(args.lines);
const DURATION_MS = Number(args.minutes) * 60_000;
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

function record(n: number): string {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  // 订单号、耗时、线程号、请求 ID 各不相同，指纹规则应把它们归为同一个模板
  return (
    `${ts} ERROR [http-nio-8080-exec-${n % 200}] c.e.order.OrderService - Order ${100000 + n} failed after ${n % 3000}ms (req=${crypto.randomUUID()})\n` +
    `java.net.SocketTimeoutException: Read timed out\n` +
    `\tat java.base/java.net.SocketInputStream.read(SocketInputStream.java:${150 + (n % 20)})\n` +
    `\tat com.example.order.PaymentClient.charge(PaymentClient.java:88)\n` +
    `\tat com.example.order.OrderService.submit(OrderService.java:${200 + (n % 7)})\n`
  );
}

async function main() {
  await http('POST', '/api/v1/auth/login', { username: args.user, password: args.password });
  writeFileSync(args.log!, '');

  const burners: ChildProcess[] = [];
  if (!args['no-cpu']) {
    for (let i = 0; i < availableParallelism(); i++) {
      burners.push(spawn('nice', ['-n', '19', process.execPath, '-e', 'for(;;){}'], { stdio: 'ignore' }));
    }
    console.log(`启动 ${burners.length} 个 nice 19 的忙循环`);
  }

  const t0 = Date.now();
  let written = 0;
  // 每 100 毫秒按进度补齐应写的条数，写入速率均匀
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const due = Math.min(TOTAL, Math.round((TOTAL * (Date.now() - t0)) / DURATION_MS));
      if (due > written) {
        let chunk = '';
        for (; written < due; written++) chunk += record(written);
        appendFileSync(args.log!, chunk);
      }
      if (written >= TOTAL) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
    const progress = setInterval(() => {
      console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), written }));
      if (written >= TOTAL) clearInterval(progress);
    }, 60_000);
  });
  console.log(`已写入 ${written} 条，等待 ${args.settle} 秒`);
  await new Promise((r) => setTimeout(r, Number(args.settle) * 1000));
  burners.forEach((b) => b.kill());

  const { items: hosts } = await http<{ items: { id: string; hostname: string }[] }>('GET', '/api/v1/hosts');
  const host = hosts.find((h) => h.hostname === args.hostname);
  if (!host) throw new Error(`找不到主机 ${args.hostname}`);
  const incidents = await http<{ items: { id: string; no: number; title: string; severity: string; alertCount: number }[] }>(
    'GET',
    `/api/v1/incidents?status=all&hostId=${host.id}`,
  );
  const groups = await http<{ items: { template: string; totalCount: number; status: string }[] }>(
    'GET',
    `/api/v1/log-groups?status=all&service=${args.service}`,
  );
  const detail = incidents.items[0]
    ? await http<{ alerts: { title: string; state: string; severity: string; count: number }[]; events: { type: string }[] }>(
        'GET',
        `/api/v1/incidents/${incidents.items[0].id}`,
      )
    : null;

  const result = {
    written,
    minutes: Number(args.minutes),
    incidents: incidents.items.map((i) => ({ no: i.no, title: i.title, severity: i.severity, alerts: i.alertCount })),
    logGroups: groups.items.map((g) => ({ template: g.template.split('\n')[0], totalCount: g.totalCount })),
    alerts: detail?.alerts.map((a) => ({ title: a.title, state: a.state, severity: a.severity, count: a.count })) ?? [],
    notifications: detail?.events.filter((e) => e.type === 'notified' || e.type === 'notify_failed').length ?? 0,
    pass: incidents.items.length === 1 && groups.items.length === 1 && groups.items[0]!.totalCount === written,
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

await main();
