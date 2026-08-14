import { defineConfig, devices } from '@playwright/test';
import { validateE2EOrigin } from './validate-e2e-origin.mjs';

// ADAPT: keep these values aligned. Prefer a dedicated local/test server.
const PORT = 4173;
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const HEALTH_PATH = '/'; // ADAPT: use a lightweight health route when the app provides one.
const START_COMMAND = 'bun run start:test'; // ADAPT: command must bind PORT and use isolated test data.

const target = validateE2EOrigin(BASE_URL);
const healthURL = new URL(HEALTH_PATH, target).href;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [['html', { open: 'never' }], ['line']] : 'list',
  use: {
    baseURL: target.origin,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off', // Enable retain-on-failure only when video materially improves diagnosis.
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: START_COMMAND,
    url: healthURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
