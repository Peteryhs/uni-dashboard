import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Two targets, one build.
 *
 * Dev: this server proxies /v1 to the relay on 8787, so the client is same-origin and there is
 * no CORS anywhere in the stack. Prod: the relay (and later the Worker) serves ./dist as static
 * assets from the same origin as /v1, which is the arrangement Workers static assets gives for
 * free. Keeping both same-origin means the client never needs a CORS path that only exists in dev.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA({
    strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts', injectRegister: false, registerType: 'prompt',
    injectManifest: { globPatterns: ['**/*.{js,css,html,svg,woff2,png}'], maximumFileSizeToCacheInBytes: 4_000_000 },
    manifest: { name: 'Uni Dashboard', short_name: 'Uni', description: 'Your Waterloo day, with saved information offline.', theme_color: '#1d1f23', background_color: '#1d1f23', display: 'standalone', start_url: '/', scope: '/', icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ] }, devOptions: { enabled: false },
  })],
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
      // Preserve the browser's Host so the relay can compare it to the Origin header.
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
