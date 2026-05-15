import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the PRMS browser test suite.
 *
 * Targets the dev HTTP server on port 4202 by default (no SSL, no cert
 * prompts). Override with PRMS_BASE_URL if running against a different
 * host. The API base URL is derived by replacing the port; override
 * with PRMS_API_URL for a non-standard setup.
 *
 * Output artifacts (screenshots, traces, videos) land in
 * tests/browser/playwright-report/ and tests/browser/test-results/ —
 * both gitignored.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './global-setup.ts',

  // Run files in parallel within a worker, but only one worker so the
  // shared dev DB sees deterministic ordering. Bump workers up if you
  // partition fixtures per spec.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.PRMS_BASE_URL ?? 'http://localhost:4202',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
