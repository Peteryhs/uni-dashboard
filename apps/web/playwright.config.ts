import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 45_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:8799', headless: true, screenshot: 'only-on-failure', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
  webServer: { command: 'node ../../test/helpers/feature-preview.mjs', url: 'http://127.0.0.1:8799/healthz', reuseExistingServer: false, timeout: 20_000 },
});
