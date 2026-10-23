import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 源码运行时在 src/db 下，打包后在 dist 下；两种情况都向上找 migrations 目录。 */
export function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = resolve(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error('找不到 migrations 目录');
}
