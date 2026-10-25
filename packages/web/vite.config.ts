import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4765', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4765', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // elkjs bundled 布局引擎体积较大，提高告警阈值避免噪音
    chunkSizeWarningLimit: 1600,
  },
});
