import { defineConfig, devices } from '@playwright/test';

// Isolated synthetic WebKit engine compatibility test. This is NOT iOS Safari.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['**/webkit-compat-smoke.pw.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Safari'],
    baseURL: 'http://127.0.0.1:4198',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'webkit-linux', use: { browserName: 'webkit' } }],
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4198 --strictPort',
    url: 'http://127.0.0.1:4198',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
