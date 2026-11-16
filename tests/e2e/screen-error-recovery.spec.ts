import { test, expect } from '@playwright/test';
import { defaultSettings, type Bootstrap } from '@kram/shared';

test.skip(process.env.E2E_SERVE_BUILD === '0', 'Lazy route download recovery is verified against production chunks.');
test.use({ serviceWorkers: 'block' });

test('a failed lazy route download offers reload and recovers the requested screen', async ({ page }) => {
  const user = { id: '00000000-0000-4000-8000-000000000001', email: 'private-screen-fixture@kram.test', settings: { ...defaultSettings, featurePreset: 'full' as const } };
  const bootstrap: Bootstrap = { user, profiles: [], skills: [], goals: [], tasks: [], resources: [], resourceItems: [], slots: [], plans: [], streaks: [], notifications: [], reviews: [], studyDate: '2026-11-06' };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const response = path.endsWith('/auth/me') ? { user, csrfToken: 'mock-screen-csrf', setupRequired: false, defaults: defaultSettings }
      : path.endsWith('/bootstrap') ? bootstrap
      : path.endsWith('/channels') ? [{ id: 'ntfy', configured: false, linked: false, enabled: false, privacy: true, lastSentAt: null }, { id: 'telegram', configured: false, linked: false, enabled: false, privacy: true, lastSentAt: null }]
      : path.endsWith('/notification-routes') ? { defaults: {}, routes: [] } : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  let failedDownloads = 0;
  let failDownloads = true;
  const routeChunk = /\/assets\/Channels-[A-Za-z0-9_-]+\.js(?:\?.*)?$/;
  await page.route(routeChunk, async route => {
    // Reject both module-preload and import requests until the explicit retry.
    if (failDownloads) { failedDownloads++; await route.abort('failed'); }
    else await route.continue();
  });

  await page.goto('/channels');
  await expect(page.getByRole('heading', { name: 'This screen could not load', exact: true })).toBeVisible();
  const reload = page.getByRole('button', { name: 'Reload screen', exact: true });
  await expect(reload).toBeEnabled();
  await expect(reload).toBeFocused();
  expect(failedDownloads).toBeGreaterThan(0);
  await expect(page.locator('[data-screen-error]')).not.toContainText(user.email);
  await expect(page.locator('[data-screen-error]')).not.toContainText('Channels-');

  const recoveredDownload = page.waitForResponse(response => routeChunk.test(response.url()) && response.ok());
  const failuresBeforeRetry = failedDownloads;
  failDownloads = false;
  await reload.click();
  await recoveredDownload;
  await expect(page.getByRole('heading', { name: 'Delivery channels', exact: true })).toBeVisible();
  await expect(page.locator('[data-screen-error]')).toHaveCount(0);
  expect(failedDownloads).toBe(failuresBeforeRetry);
});
