import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost';

function appProject(name: string) {
  return {
    name,
    testDir: `./src/apps/${name}/tests`,
    dependencies: ['setup'],
    use: {
      storageState: path.join(__dirname, '.auth', 'admin.json'),
    },
  };
}

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 2,
  workers: process.env.CI ? 1 : 4,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ...(process.env.CI ? [['github' as const]] : []),
    ['./src/helpers/markdown-reporter.ts'],
  ],
  use: {
    baseURL: BASE_URL,
    // Local dev serves behind nginx with a self-signed cert and redirects
    // HTTP→HTTPS; without this, chromium rejects every navigation with
    // ERR_CERT_AUTHORITY_INVALID. Harmless in CI (real/no cert).
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
  },
  globalSetup: './src/global/global-setup.ts',
  globalTeardown: './src/global/global-teardown.ts',
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      testDir: './src/auth',
    },
    appProject('b3'),
    appProject('banter'),
    appProject('basis'),
    appProject('beacon'),
    appProject('bearing'),
    appProject('bench'),
    appProject('bill'),
    appProject('blank'),
    appProject('blast'),
    appProject('board'),
    appProject('bolt'),
    appProject('bond'),
    appProject('book'),
    appProject('brief'),
    appProject('helpdesk'),
  ],
});
