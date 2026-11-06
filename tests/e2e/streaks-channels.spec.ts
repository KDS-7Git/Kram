import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { defaultSettings, profileSchema, type Bootstrap } from '@kram/shared';
import type { StreakDto } from '../../apps/web/src/features/streaks/Streaks';
const owner = '00000000-0000-4000-8000-000000000001', profile = '00000000-0000-4000-8000-000000000002', id = '00000000-0000-4000-8000-000000000003';
const date = '2026-11-06', initialRule = { scope: 'global' as const, scopeId: null, version: 1, measure: 'minutes' as const, threshold: 30, period: 'day' as const, eligibleDays: [1, 2, 3, 4, 5, 6, 7], restPolicy: 'skip' as const, countPartial: true, gracePerMonth: 0, restWeekdays: [], pausedRanges: [] };
async function mock(page: Page) {
  await page.clock.setFixedTime(new Date(`${date}T12:00:00Z`));
  const data: Bootstrap = { user: { id: owner, email: 'mock-only@kram.test', settings: { ...defaultSettings, timezone: 'UTC', featurePreset: 'full', theme: 'light', dayRollover: 0 } }, profiles: [{ ...profileSchema.parse({ name: 'Learning' }), id: profile, createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, archivedAt: null, isDemo: false }], skills: [], goals: [], tasks: [], resources: [], resourceItems: [], slots: [], plans: [], streaks: [], notifications: [], reviews: [], studyDate: date };
  const streak: StreakDto = { id, title: 'Steady practice', scope: 'global', scopeId: null, startDate: '2026-11-04', status: 'active', rule: initialRule, rules: [{ version: 1, effectiveFrom: '2026-11-04', rules: initialRule }], summary: { current: 1, best: 1, met: 1, missed: 0, grace: 0, provisional: 0 }, records: [{ id: `${id}-r`, periodStart: '2026-11-04', periodEnd: '2026-11-04', result: 'met', reason: 'Met: 34 of 30 min; rule v1.', beforeReason: null, provisional: false, value: 34, ruleVersion: 1 }, { id: `${id}-s`, periodStart: '2026-11-05', periodEnd: '2026-11-05', result: 'rest', reason: 'Rest period; the run stays unchanged; rule v1.', beforeReason: 'Below target: 0 of 30 min; rule v1.', provisional: false, value: 0, ruleVersion: 1 }] };
  const channels = [{ id: 'ntfy', configured: true, linked: true, enabled: false, privacy: true, lastSentAt: `${date}T11:30:00Z` }, { id: 'telegram', configured: false, linked: false, enabled: false, privacy: true, lastSentAt: null }];
  const defaults = Object.fromEntries(['plan_ready', 'upcoming', 'task_reminder', 'deadline', 'overdue', 'daily_review', 'weekly_review', 'streak_at_risk', 'schedule_changed', 'feasibility_warning', 'backup_failed', 'worker_unhealthy', 'healthcheck_report'].map(type => [type, ['ntfy']]));
  const routes: { profileId: string | null; type: string; channels: string[]; topic: string | null }[] = [];
  await page.route('**/api/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/api/v1', ''), body = req.postDataJSON();
    let response: unknown = [];
    if (path === '/auth/me') response = { user: data.user, csrfToken: 'mock-csrf-only', setupRequired: false, defaults: defaultSettings };
    else if (path === '/bootstrap') response = data;
    else if (path === '/settings') { data.user.settings = { ...data.user.settings, ...body }; response = data.user.settings; }
    else if (path === '/streaks') response = [streak];
    else if (path === `/streaks/${id}` && req.method() === 'PATCH') { streak.rules.push({ version: 2, effectiveFrom: body.effectiveFrom, rules: { ...initialRule, ...body.rule, version: 2 } }); response = streak; }
    else if (path === '/channels') response = channels;
    else if (path === '/channels/telegram/link-code') { channels[1]!.configured = true; response = { command: '/start mock-one-time-code', expiresAt: `${date}T12:10:00Z` }; }
    else if (path === '/notification-routes' && req.method() === 'PUT') { routes.push(body); response = body; }
    else if (path === '/notification-routes') response = { defaults, routes };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  return { data, streak, routes };
}
async function accessible(page: Page) { await expect(page.locator('html')).not.toHaveClass(/theme-crossfade/); expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]); }
test('stored streak reasons and corrections are available through the date inspector', async ({ page }) => {
  await mock(page); await page.goto('/streaks'); await expect(page.getByRole('heading', { name: 'Practice, over time' })).toBeVisible();
  await expect(page.getByText('Rest period; the run stays unchanged; rule v1.', { exact: true })).toBeVisible();
  await page.getByText('Correction history', { exact: true }).click(); await expect(page.getByText('Before: Below target: 0 of 30 min; rule v1.', { exact: true })).toBeVisible();
  await page.getByLabel('Inspect a day', { exact: true }).fill('2026-11-04'); await expect(page.getByText('Met: 34 of 30 min; rule v1.', { exact: true })).toBeVisible();
  const box = await page.getByLabel('Inspect a day', { exact: true }).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); await accessible(page);
});
test('quiet mode hides counts and a future rule change preserves the stored reason', async ({ page }) => {
  const fixture = await mock(page); await page.goto('/streaks'); await page.getByRole('switch', { name: /Quiet mode/ }).check(); await expect(page.locator('.streak-counts')).toHaveCount(0);
  await page.getByRole('switch', { name: /Quiet mode/ }).uncheck(); await expect(page.locator('.streak-counts')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Edit streak rule' })).toBeVisible();
  await page.getByLabel('Target (min)', { exact: true }).fill('45'); await accessible(page); await page.getByRole('button', { name: 'Save future rule', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(fixture.streak.rules.at(-1)?.rules.threshold).toBe(45); expect(fixture.streak.records[1]?.reason).toBe('Rest period; the run stays unchanged; rule v1.');
});
test('channel linking and per-profile routing retain private defaults', async ({ page }) => {
  const fixture = await mock(page); await page.goto('/channels'); await expect(page.getByRole('heading', { name: 'Delivery channels' })).toBeVisible();
  await expect(page.getByText(/^Last accepted/)).toBeVisible(); await expect(page.getByText('No accepted messages yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Kram reminder', { exact: true })).toHaveCount(2); await page.getByText('Link Telegram', { exact: true }).click();
  await page.getByLabel('Bot token', { exact: true }).fill('123456789:mock-token-123456789'); await page.getByRole('button', { name: 'Create link code', exact: true }).click();
  await expect(page.getByLabel('Send this command to your bot')).toHaveValue('/start mock-one-time-code'); await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');
  await page.getByLabel('Apply these routes to').selectOption(profile); const task = page.locator('.routing-matrix fieldset').filter({ has: page.getByText('Task reminder', { exact: true }) }); await task.getByLabel('Telegram', { exact: true }).check();
  await page.getByRole('button', { name: 'Generate a private topic name' }).click(); await page.getByRole('button', { name: 'Save routing', exact: true }).click(); await expect.poll(() => fixture.routes.length).toBe(13);
  expect(fixture.routes.find(route => route.type === 'task_reminder')).toMatchObject({ profileId: profile, channels: ['ntfy', 'telegram'] }); await accessible(page);
});
test('streak and channel controls reflow at 320px and 200% text in both themes', async ({ page }) => {
  const fixture = await mock(page);
  for (const theme of ['light', 'dark'] as const) {
    fixture.data.user.settings.theme = theme;
    for (const route of ['/streaks', '/channels']) {
      await page.goto(route); await expect(page.locator('h1')).toBeVisible(); await accessible(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.setViewportSize({ width: 320, height: 720 }); await page.evaluate(() => document.documentElement.style.fontSize = '32px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.getByRole('button').first().focus(); await expect(page.getByRole('button').first()).toBeFocused();
      await page.evaluate(() => document.documentElement.style.fontSize = '');
    }
  }
});
