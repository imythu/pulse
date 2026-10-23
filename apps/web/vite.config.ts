import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.PULSE_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api/v1/live': { target: api.replace(/^http/, 'ws'), ws: true },
      '/api': api,
      '/install.sh': api,
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 图表库单独分包，首屏不加载（设计文档 8.4 性能预算）
        manualChunks: { echarts: ['echarts'] },
      },
    },
  },
});
