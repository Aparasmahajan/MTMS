import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the static build.
 *
 * These run against the *built* site served as plain files, not against a dev server, and
 * that is the point: persistence and cross-tab sync are browser behaviours, and the only
 * honest way to check them is to open two real tabs of the real artefact.
 *
 * `npm run build` must have been run first — the server serves `demo/`, and Playwright
 * will not build it for you. Left that way deliberately: a config that silently rebuilds
 * makes a five-second test take two minutes.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Tabs in these tests share one origin's localStorage on purpose. Parallel workers would
  // be editing the same store and failing for reasons that have nothing to do with the code.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'node scripts/serve-static.mjs',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
