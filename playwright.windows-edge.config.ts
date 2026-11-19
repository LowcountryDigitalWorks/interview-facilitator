import { defineConfig, devices } from '@playwright/test';

// Branded Microsoft Edge on a fresh hosted Windows VM, NOT physical LDW01,
// a native installed PWA, iOS Safari, NVDA, or a customer release.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['**/windows-edge-smoke.pw.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Edge'],
    browserName: 'chromium',
    channel: 'msedge',
    baseURL: 'http://127.0.0.1:4199',
    serviceWorkers: 'allow',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'edge-windows-hosted', use: {} }],
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4199 --strictPort',
    url: 'http://127.0.0.1:4199',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
