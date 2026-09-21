import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Two targets, one build.
 *
 * Dev: this server proxies /v1 to the relay on 8787, so the client is same-origin and there is
 * no CORS anywhere in the stack. Prod: the relay (and later the Worker) serves ./dist as static
 * assets from the same origin as /v1, which is the arrangement Workers static assets gives for
 * free. Keeping both same-origin means the client never needs a CORS path that only exists in dev.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // The card contract is the source of truth for both clients. Importing it rather than
      // restating it means the age ladder and the skip-unknown rule cannot drift from the server.
      '#contract': path.resolve(import.meta.dirname, '../../packages/contract/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/healthz': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
