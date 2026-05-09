import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const e2eDataDir = path.join(process.cwd(), '.playwright-data');
const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL ||
  (process.platform === 'darwin' && !process.env.CI ? 'chrome' : undefined);
process.env.PRIVACYTRACKER_DATA_DIR = e2eDataDir;
process.env.NEXT_TELEMETRY_DISABLED = '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'rm -rf .playwright-data && mkdir -p .playwright-data && npm run build && HOSTNAME=127.0.0.1 npm start',
    url: 'http://127.0.0.1:3000/api/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PRIVACYTRACKER_DATA_DIR: e2eDataDir,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
});
