import { defineConfig, devices } from '@playwright/test';

// This source-only browser harness is served by Vite dev mode. It is NOT a
// production build entry point and does not activate the 1.4 UI.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['**/readback-renderer.pw.ts', '**/readback-accessibility.pw.ts', '**/known-fact-storage-14.pw.ts', '**/known-fact-lifecycle-trial-14.pw.ts', '**/known-fact-activation-preflight-14.pw.ts', '**/known-fact-recovery-ui-trial-14.pw.ts', '**/known-fact-migration-rollback-14.pw.ts', '**/known-fact-native-idb-abort-14.pw.ts', '**/known-fact-versionchange-14.pw.ts', '**/known-fact-lifecycle-controls-trial-14.pw.ts', '**/client-readback-controls-trial-14.pw.ts', '**/interview-prep-review-trial.pw.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4191',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4191 --strictPort',
    url: 'http://127.0.0.1:4191/tests/browser/fixtures/readback.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
