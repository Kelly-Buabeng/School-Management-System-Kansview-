// Owner: Agent H. Full-stack end-to-end tests: real API + fresh seeded PostgreSQL + production web build.
// Run with: bash scripts/e2e.sh   (builds what is missing, links node_modules, runs with --trace off)
import { defineConfig, devices } from '@playwright/test';

const API_PORT = process.env.E2E_API_PORT ?? '3100';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '4300';

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one shared seeded database; specs create their own records
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : [['list']],
  outputDir: '../../test-results',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    timezoneId: 'Africa/Accra',
    locale: 'en-GB',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node support/start-api.mjs',
      url: `http://127.0.0.1:${API_PORT}/api/v1/health/ready`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: process.env.E2E_DEBUG ? 'pipe' : 'ignore',
    },
    {
      command: 'node support/serve-web.mjs',
      url: `http://127.0.0.1:${WEB_PORT}/`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
