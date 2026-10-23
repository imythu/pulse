import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './index.js';

// TimescaleDB 的连续聚合等语句不能放在事务里，所以迁移按语句逐条执行。
// 迁移文件里不要写包含分号的函数体。
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

export async function migrate(sql: Sql, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    log(`应用迁移 ${file}`);
    for (const stmt of splitStatements(await readFile(join(dir, file), 'utf8'))) {
      await sql.unsafe(stmt);
    }
    await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
    ran.push(file);
  }
  return ran;
}
