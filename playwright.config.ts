import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30000,
  reporter: [['list'], ['html', { open:'never' }]],
  use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5173', trace:'retain-on-failure', screenshot:'only-on-failure' },
  projects: [{ name:'desktop', use:{ ...devices['Desktop Chrome'] } }, { name:'phone', use:{ ...devices['Pixel 7'], defaultBrowserType:'chromium' } }],
  webServer: process.env.E2E_BASE_URL ? undefined : { command:'npm run dev:web', url:'http://127.0.0.1:5173', reuseExistingServer:!process.env.CI, timeout:30000 }
});
