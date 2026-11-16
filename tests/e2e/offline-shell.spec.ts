import { test, expect } from '@playwright/test';
import { DateTime } from 'luxon';
import { studyDate } from '@kram/time';

const testApi = process.env.E2E_API_URL || 'http://127.0.0.1:8422';
test.skip(process.env.E2E_SERVE_BUILD === '0', 'The installable shell is verified against the production build.');
test.setTimeout(60_000);
test.beforeEach(async ({ request }) => {
  const response = await request.post(`${testApi}/api/v1/__test/reset`, { headers: { 'X-Kram-Test': 'reset-isolated-db' } });
  expect(response.ok()).toBeTruthy();
});

test('installed shell survives an offline hard reload and replays a saved timer exactly once', async ({ page, context }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  let auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', { headers: { 'X-CSRF-Token': auth.csrfToken }, data: { email: 'offline-shell-owner@kram.test', password: 'synthetic-offline-shell-password-42', profileName: 'Learning', featurePreset: 'full', timezone: 'Asia/Kolkata' } }); expect(setup.ok()).toBeTruthy();
  auth = await (await page.request.get('/api/v1/auth/me')).json();
  const data = await (await page.request.get('/api/v1/bootstrap')).json();
  const headers = { 'X-CSRF-Token': auth.csrfToken };
  const skill = await (await page.request.post('/api/v1/skills', { headers, data: { profileId: data.profiles[0].id, name: 'Offline practice' } })).json();
  const goal = await (await page.request.post('/api/v1/goals', { headers, data: { skillId: skill.id, type: 'milestone', title: 'Offline shell fixture', targetQty: 30, unit: 'minutes', startDate: data.studyDate } })).json();
  const task = await (await page.request.post('/api/v1/tasks', { headers, data: { goalId: goal.id, title: 'Offline task', estMinutes: 30, earliestDate: data.studyDate } })).json();
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  // A controlled online reload warms lazy route chunks before disconnecting.
  await page.reload(); await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('button', { name: 'Start timer', exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const key = (await caches.keys()).find(key => key.startsWith('kram-shell-')); if (!key) return 0;
    const cache = await caches.open(key); return (await cache.keys()).filter(request => request.url.includes('/assets/')).length;
  })).toBeGreaterThan(2);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause timer', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume timer', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Offline task', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume timer', exact: true })).toBeEnabled();
  const cachePaths = await page.evaluate(async () => { const key = (await caches.keys()).find(key => key.startsWith('kram-shell-'))!; return (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname); });
  expect(cachePaths.some(path => path.startsWith('/api/'))).toBe(false);
  await context.setOffline(false);
  await expect.poll(async () => {
    const history = await (await page.request.get(`/api/v1/tasks/${task.id}/events`)).json(); return history.map((event: { kind: string }) => event.kind);
  }).toEqual(['started', 'paused']);
  await page.reload();
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}/events`)).json()).length).toBe(2);
});

test('Today starts and pauses offline before a task route or sheet warms validation code', async ({ page, context }) => {
  // Seed entirely through HTTP before the first page load; no Auth or Task chunk has run.
  let auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', { headers: { 'X-CSRF-Token': auth.csrfToken }, data: { email: 'offline-today-owner@kram.test', password: 'synthetic-offline-today-password-42', profileName: 'Learning', featurePreset: 'full', timezone: 'Asia/Kolkata' } }); expect(setup.ok()).toBeTruthy();
  auth = await (await page.request.get('/api/v1/auth/me')).json();
  const data = await (await page.request.get('/api/v1/bootstrap')).json(); const headers = { 'X-CSRF-Token': auth.csrfToken };
  const skillResponse = await page.request.post('/api/v1/skills', { headers, data: { profileId: data.profiles[0].id, name: 'Offline Today practice' } }); expect(skillResponse.ok()).toBeTruthy(); const skill = await skillResponse.json();
  const goalResponse = await page.request.post('/api/v1/goals', { headers, data: { skillId: skill.id, type: 'milestone', title: 'Offline Today task', targetQty: 30, unit: 'minutes', startDate: data.studyDate, availableDays: [1, 2, 3, 4, 5, 6, 7] } }); expect(goalResponse.ok()).toBeTruthy(); const goal = await goalResponse.json();
  const seededResponse = await page.request.get('/api/v1/bootstrap');
  const seeded = await seededResponse.json(); const task = seeded.tasks.find((task: { goalId: string }) => task.goalId === goal.id); expect(task).toBeTruthy();
  // Freeze the browser at the response's server instant. An arbitrary noon clock
  // can be ahead of the server and correctly rejected when offline events replay.
  // The current block uses its civil date; pre-rollover work still belongs to the
  // prior study date, and the final minute of a day ends at the permitted 24:00.
  const instant = DateTime.fromHTTP(seededResponse.headers().date!, { setZone: true });
  expect(instant.isValid).toBeTruthy();
  const local = instant.setZone(seeded.user.settings.timezone);
  const minute = local.hour * 60 + local.minute;
  expect(studyDate(instant.toISO()!, seeded.user.settings.timezone, seeded.user.settings.dayRollover)).toBe(seeded.studyDate);
  const slot = await page.request.post('/api/v1/timetable/slots', { headers, data: { taskId: task.id, title: task.title, layer: 'flexible', date: local.toISODate(), startMin: minute, endMin: Math.min(1440, minute + 40) } }); expect(slot.ok(), await slot.text()).toBeTruthy();
  await page.clock.setFixedTime(instant.toJSDate());
  await page.goto('/'); await expect(page.locator('.today-now').getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })); });
  const manifest = await (await page.request.get('/pwa-assets.json')).json();
  const paths = await page.evaluate(async () => { const key = (await caches.keys()).find(key => key.startsWith('kram-shell-'))!; return (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname); });
  expect(paths).toEqual(expect.arrayContaining(manifest.assets)); expect(paths.some(path => path.startsWith('/api/'))).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).pathname).toBe('/');
  await context.setOffline(true);
  await page.locator('.today-now').getByRole('button', { name: 'Start', exact: true }).click(); await expect(page.locator('.today-now').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.locator('.today-now').getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.locator('.today-now').getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await page.reload(); await expect(page.locator('.today-now').getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await context.setOffline(false);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}/events`)).json()).map((event: { kind: string }) => event.kind)).toEqual(['started', 'paused']);
});
