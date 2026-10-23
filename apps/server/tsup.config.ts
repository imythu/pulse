import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/db/migrate-cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // 把 workspace 内的 @pulse/shared 打进产物，运行时不需要 TS 源码
  noExternal: ['@pulse/shared'],
});
