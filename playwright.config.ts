import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;
/** Set E2E_BASE_URL to run the journey against a deployed environment (e.g. Railway QA). */
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        // Built app (npm run build) against a fresh embedded database in DEMO MODE.
        command: 'node e2e/start-server.mjs',
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          NODE_ENV: 'production',
          PORT: String(PORT),
          APP_BASE_URL: `http://localhost:${PORT}`,
          DEMO_MODE: 'true',
          DEMO_LATENCY_MS: '2',
          SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdefghijkl',
          COOKIE_SECURE: 'false',
          PGLITE_DATA_DIR: './.data/e2e',
          LOG_LEVEL: 'warn',
          ENTRA_CLIENT_ID: '',
          ENTRA_CLIENT_SECRET: '',
          DATABASE_URL: '',
        },
      },
});
