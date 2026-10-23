import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';
import { migrationsDir } from './paths.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
try {
  const ran = await migrate(sql, migrationsDir(), (m) => console.log(m));
  console.log(ran.length ? `完成，共 ${ran.length} 个迁移` : '已是最新');
} finally {
  await sql.end();
}
