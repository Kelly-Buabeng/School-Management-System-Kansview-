import { defineConfig, devices } from '@playwright/test';

/** Smoke tests against `vite preview` in mock mode (no API needed). Run: pnpm test:e2e */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_API_MODE: 'mock' },
  },
});
