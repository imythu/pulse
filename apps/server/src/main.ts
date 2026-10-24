import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { migrationsDir } from './db/paths.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const { app, gateway, engine, commands, repos } = await buildApp(config, sql);

await migrate(sql, migrationsDir(), (m) => app.log.info(m));
// 服务器重启前在线的主机给一个心跳周期的宽限期重连，超时未连上的由离线检测正常判定并告警
await sql`UPDATE hosts SET last_seen_at = now() WHERE status = 'online'`;
await engine.start();
gateway.start();
commands.start();
repos.start();
await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`收到 ${signal}，正在关闭`);
    engine.stop();
    commands.stop();
    repos.stop();
    await gateway.stop();
    await app.close();
    await engine.idle();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
