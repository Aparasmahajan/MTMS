import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * These run against a real build, so they exercise what unit tests deliberately do not:
 * the session cookie, the route handlers, the optimistic update and its reconciliation,
 * and the sticky-grid rendering that no assertion on the projection can reach.
 *
 * `npm run dev` rather than `start` on purpose — the session cookie is `Secure` in
 * production, so a browser on plain HTTP would silently drop it and every test would fail
 * as "not signed in". That is the correct production behaviour and the wrong test setup.
 *
 * NOT YET RUN: `@playwright/test` is not installed and no browsers are downloaded on this
 * machine. `npm i -D @playwright/test && npx playwright install chromium` first.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // The store is one document behind a serialised write queue; parallel workers editing
  // the same seeded project would fight over it and fail for the wrong reason.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3100/login',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // A throwaway store per run, so a test that closes a module does not leave the
          // developer's own data closed.
          TRACKER_STORE_PATH: './data/e2e-tracker.json',
          JWT_SECRET: 'e2e-secret-not-for-real-use',
        },
      },
});
