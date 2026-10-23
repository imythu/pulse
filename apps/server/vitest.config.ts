import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 集成测试共用 TEST_DATABASE_URL 指定的库，并且会清空它，不能并行
    fileParallelism: false,
  },
});
