import { defineConfig } from 'vite';

export default defineConfig({
  base: '/DaFeiYuGomo/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
