import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 产物纯 ASCII：中文全部转成 \uXXXX 转义。GBK/ASCII 字节兼容，
  // 即使浏览器忽略 charset 响应头按本地编码解码 JS 也不会乱码。
  esbuild: {
    charset: 'ascii',
  },
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
