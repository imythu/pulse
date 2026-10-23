import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { migrationsDir } from './db/paths.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const { app, gateway } = await buildApp(config, sql);

await migrate(sql, migrationsDir(), (m) => app.log.info(m));
// 服务器重启前在线的主机，状态以重连后的心跳为准
await sql`UPDATE hosts SET status = 'offline' WHERE status = 'online'`;
gateway.start();
await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`收到 ${signal}，正在关闭`);
    await gateway.stop();
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
