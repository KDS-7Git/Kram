import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, weekStartDate } from '@kram/time';
import type { Bootstrap, RecurrenceSeries } from '@kram/shared';

const testApi = process.env.E2E_API_URL || 'http://127.0.0.1:8422';
test.setTimeout(60000);
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${testApi}/api/v1/__test/reset`, { headers: { 'X-Kram-Test': 'reset-isolated-db' } })).ok()).toBeTruthy();
});
async function seed(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', { headers: { 'X-CSRF-Token': auth.csrfToken }, data: { email: 'schedule-fixture@kram.test', password: 'paper-calendar-synthetic-owner', profileName: 'Learning', timezone: 'Asia/Kolkata' } });
  expect(setup.ok(), await setup.text()).toBeTruthy();
  const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrfToken;
  let data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const skill = await page.request.post('/api/v1/skills', { headers: { 'X-CSRF-Token': csrf }, data: { name: 'Systems', profileId: data.profiles[0]!.id } });
  expect(skill.ok()).toBeTruthy(); data = await (await page.request.get('/api/v1/bootstrap')).json();
  await page.goto('/plan'); await expect(page.getByRole('link', { name: 'Schedules and templates' })).toBeVisible();
  return { data, csrf };
}
async function accessible(page: Page) { await expect(page.locator('html')).not.toHaveClass(/theme-crossfade/); expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]); }
async function repeating(page: Page, anchor: string, title: string) {
  await page.getByRole('link', { name: 'Schedules and templates' }).click();
  await page.getByRole('button', { name: 'Add repeating commitment', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schedule title', { exact: true }).fill(title);
  await dialog.getByLabel('Repeat frequency', { exact: true }).selectOption('DAILY');
  await dialog.getByLabel('Repeat every', { exact: true }).fill('2');
  await dialog.getByLabel('Anchor date', { exact: true }).fill(anchor);
  await dialog.getByLabel('Starts at', { exact: true }).fill('09:00');
  await dialog.getByLabel('Duration (min)', { exact: true }).fill('30');
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  return (await (await page.request.get('/api/v1/recurrence/series')).json() as RecurrenceSeries[]).find(row => row.title === title)!;
}

test('alternate-day commitments edit, move, skip and split without changing prior occurrences', async ({ page }) => {
  const { data } = await seed(page), anchor = addDays(data.studyDate, 2), row = await repeating(page, anchor, 'A regular study appointment');
  let occurrence = page.locator('.occurrence-row').filter({ hasText: 'A regular study appointment' }).first();
  await occurrence.getByRole('button', { name: 'Edit one', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schedule title', { exact: true }).fill('This one appointment');
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click(); await expect(dialog).not.toBeVisible();
  occurrence = page.locator('.occurrence-row').filter({ hasText: 'This one appointment' });
  await occurrence.getByRole('button', { name: 'Move one', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('Move to date', { exact: true }).fill(addDays(anchor, 1));
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(occurrence).toContainText('Moved from');
  await page.locator('.occurrence-row').filter({ hasText: 'A regular study appointment' }).first().getByRole('button', { name: 'Skip one', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/recurrence/occurrences?from=${addDays(anchor, 2)}&to=${addDays(anchor, 2)}`)).json()).filter((item: { seriesId: string; status: string }) => item.seriesId === row.id && item.status === 'scheduled').length).toBe(0);
  await page.getByRole('button', { name: 'Edit future', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('Changes start on', { exact: true }).fill(addDays(anchor, 4));
  await dialog.getByLabel('Schedule title', { exact: true }).fill('The future rhythm');
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'The future rhythm', exact: true })).toBeVisible();
  await accessible(page);
});

test('weekly templates apply independently, copy a week, and calendar filters only affect the view', async ({ page }) => {
  const { data, csrf } = await seed(page), week = weekStartDate(addDays(data.studyDate, 7), data.user.settings.weekStart);
  await page.getByRole('link', { name: 'Schedules and templates' }).click();
  await page.getByRole('button', { name: 'Templates and copy', exact: true }).click();
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template name', { exact: true }).fill('A calm learning week');
  await dialog.getByLabel('Block title', { exact: true }).fill('Systems study window');
  await dialog.getByLabel('Reserved for skill', { exact: true }).selectOption(data.skills[0]!.id);
  await dialog.getByRole('button', { name: 'Save template', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await page.getByLabel('Apply to date or week', { exact: true }).fill(week);
  await page.getByRole('button', { name: 'Apply template', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/timetable/global?from=${week}&to=${addDays(week, 6)}`)).json()).length).toBe(1);
  await page.getByLabel('Copy from', { exact: true }).fill(week); await page.getByLabel('Copy to', { exact: true }).fill(addDays(week, 7));
  await page.getByLabel('Copy how much', { exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Copy time blocks', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/timetable/global?from=${addDays(week, 7)}&to=${addDays(week, 13)}`)).json()).length).toBe(1);
  const otherProfile = await (await page.request.post('/api/v1/profiles', { headers: { 'X-CSRF-Token': csrf }, data: { name: 'Fitness' } })).json();
  const otherSkill = await (await page.request.post('/api/v1/skills', { headers: { 'X-CSRF-Token': csrf }, data: { profileId: otherProfile.id, name: 'Running' } })).json();
  const otherBlock = await page.request.post('/api/v1/timetable/slots', { headers: { 'X-CSRF-Token': csrf }, data: { date: week, startMin: 600, endMin: 630, title: 'Another profile block', layer: 'fixed', skillId: otherSkill.id } }); expect(otherBlock.ok()).toBeTruthy();
  await page.goto(`/plan?date=${week}&view=week`);
  await expect(page.getByRole('button', { name: /Edit block Another profile block on/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit block Systems study window on/ })).toBeVisible();
  await page.getByLabel('Profile filter', { exact: true }).selectOption(data.profiles[0]!.id);
  await expect(page.getByRole('button', { name: /Edit block Another profile block on/ })).not.toBeVisible();
  await page.getByLabel('Skill filter', { exact: true }).selectOption(data.skills[0]!.id);
  await expect(page.getByRole('button', { name: /Edit block Systems study window on/ })).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: 'Month', exact: true }).click(); await expect(page.getByLabel('month timetable', { exact: true })).toBeVisible(); await accessible(page);
  await page.getByRole('button', { name: 'Agenda', exact: true }).click(); await expect(page.getByRole('button', { name: /Edit block Systems study window on/ })).toHaveCount(2);
  await page.getByRole('button', { name: /Edit block Systems study window on/ }).first().click();
  await expect(page.getByRole('dialog').getByLabel('Starts at', { exact: true })).toHaveValue('18:00');
  await page.keyboard.press('Escape');
});

test('far-future projected blocks open the occurrence editor, and phone text and both themes remain accessible', async ({ page }, testInfo) => {
  const { data } = await seed(page), row = await repeating(page, data.studyDate, 'पढ़ाई · A longer mixed-script appointment'), future = addDays(data.studyDate, 70);
  await page.goto(`/plan?date=${future}&view=week`);
  await expect(page.getByRole('button', { name: /Edit block पढ़ाई/ }).first()).toBeVisible();
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light and dark theme', exact: true }).click();
    await accessible(page);
    await page.screenshot({ path: testInfo.outputPath(`calendar-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: /Edit block पढ़ाई/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/schedules\\?seriesId=${row.id}`));
  await expect(page.getByLabel('Series filter', { exact: true })).toHaveValue(row.id);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.locator('.occurrence-row').first().getByRole('button', { name: 'Edit one', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Starts at', { exact: true })).toHaveValue('09:00');
  await accessible(page); await page.keyboard.press('Escape');
  await page.goto(`/plan?date=${future}&view=month`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await accessible(page);
});

test('monthly weekday controls, holidays and offline drafts remain usable', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { data } = await seed(page);
  await page.getByRole('link', { name: 'Schedules and templates' }).click();
  const add = page.getByRole('button', { name: 'Add repeating commitment', exact: true }); await add.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schedule title', { exact: true }).fill('Last working weekday');
  await dialog.getByLabel('Repeat frequency', { exact: true }).selectOption('MONTHLY');
  await dialog.getByLabel('Monthly pattern', { exact: true }).selectOption('last-weekday');
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const rows = await (await page.request.get('/api/v1/recurrence/series')).json(); expect(rows[0].rrule).toContain('BYSETPOS=-1');
  await page.getByRole('button', { name: 'Holidays', exact: true }).click();
  await page.getByLabel('Holiday name', { exact: true }).fill('A planned rest day');
  await page.getByLabel('Holiday date', { exact: true }).fill(addDays(data.studyDate, 4));
  await context.setOffline(true); await expect(page.getByRole('button', { name: 'Add holiday', exact: true })).toBeDisabled();
  await context.setOffline(false); await expect(page.getByLabel('Holiday name', { exact: true })).toHaveValue('A planned rest day');
  await page.getByRole('button', { name: 'Add holiday', exact: true }).click(); await expect(page.getByText('A planned rest day', { exact: true })).toBeVisible();
  await accessible(page);
});
