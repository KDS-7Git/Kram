import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DateTime } from 'luxon';
import { addDays, weekStartDate } from '@kram/time';
import type { Bootstrap, Task, TimeSlot, Goal } from '@kram/shared';

const testApi = process.env.E2E_API_URL || 'http://127.0.0.1:8422';
test.setTimeout(60000);
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${testApi}/api/v1/__test/reset`, { headers: { 'X-Kram-Test': 'reset-isolated-db' } })).ok()).toBeTruthy();
});
async function seed(page: Page, unit = 'minutes') {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', { headers: { 'X-CSRF-Token': auth.csrfToken }, data: { email: 'wireframe-owner@example.test', password: 'synthetic-paper-and-ink-review', profileName: 'Academic', timezone: 'Asia/Kolkata' } });
  expect(setup.ok()).toBeTruthy();
  const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrfToken;
  let data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const post = async <T,>(path: string, body: unknown): Promise<T> => { const response = await page.request.post('/api/v1' + path, { headers: { 'X-CSRF-Token': csrf }, data: body }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); };
  const skill = await post<{ id: string }>('/skills', { profileId: data.profiles[0]!.id, name: 'Machine Learning', weeklyTargetMin: 600 });
  const goal = await post<Goal>('/goals', { skillId: skill.id, title: 'Course', unit, type: 'adaptive', targetQty: unit === 'minutes' ? 600 : 10, estMinutes: 60, startDate: data.studyDate, dueDate: addDays(data.studyDate, 9) });
  const task = await post<Task>('/tasks', { goalId: goal.id, title: 'पढ़ाई · Gradient descent', estMinutes: 60, qty: unit === 'minutes' ? 60 : 10, earliestDate: data.studyDate });
  data = await (await page.request.get('/api/v1/bootstrap')).json();
  return { data, task, skill, goal, post };
}
async function accessible(page: Page) {
  await expect(page.locator('html')).not.toHaveClass(/theme-crossfade/);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
}
async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

test('Today exposes timer actions; quick progress saves cumulative targets with Undo and exact durations', async ({ page }, info) => {
  const { data, task, post } = await seed(page);
  const local = DateTime.now().setZone(data.user.settings.timezone), minute = local.hour * 60 + local.minute;
  if (minute < 1400) await post('/timetable/slots', { title: task.title, taskId: task.id, layer: 'flexible', date: local.toISODate(), startMin: Math.max(0, minute - 1), endMin: Math.min(1440, minute + 35) });
  await post(`/tasks/${task.id}/events`, { kind: 'started', occurredAt: new Date(Date.now() - 2 * 60 * 60000).toISOString(), clientEventId: crypto.randomUUID() });
  await page.goto('/');
  if (info.project.name === 'desktop') {
    const positions = await page.locator('.sidebar .nav-link > svg, .sidebar-footer .button-label > svg').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
  }
  const now = page.locator('.today-now');
  await expect(now.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await now.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).timerStartedAt).toBeNull();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: `Open task ${task.title}`, exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: '25%', exact: true }).click();
  await expect(panel.getByText('45 min estimated remaining', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '50%', exact: true }).click();
  await expect(panel.getByText('30 min estimated remaining', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByText('45 min estimated remaining', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Other', exact: true }).click();
  await panel.getByLabel('Additional minutes', { exact: true }).fill('1h20');
  await panel.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).actualMinutes).toBe(95);
  await accessible(page);
  await page.screenshot({ path: info.outputPath('task-inspector-light.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light and dark theme', exact: true }).click();
    await accessible(page); await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }); await page.screenshot({ path: info.outputPath(`today-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 320, height: 760 }); await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await reflow(page);
  await page.getByRole('button', { name: `Open task ${task.title}`, exact: true }).click(); await reflow(page); await accessible(page);
});

test('count-based quick progress recalculates remaining work by quantity', async ({ page }) => {
  const { task } = await seed(page, 'videos');
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button', { name: '50%', exact: true }).click();
  await expect(page.getByText('5 of 10 videos', { exact: true })).toBeVisible();
  await expect(page.getByText('30 min estimated remaining', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '75%', exact: true }).click();
  await expect(page.getByText('7.5 of 10 videos', { exact: true })).toBeVisible();
  await expect(page.getByText('15 min estimated remaining', { exact: true })).toBeVisible();
});

test('week aligns time across days; phone date strip, filter scope, free targets and keyboard edits use the full schedule', async ({ page, context }, info) => {
  const { data, skill, task, post } = await seed(page);
  const week = weekStartDate(addDays(data.studyDate, 7), data.user.settings.weekStart);
  const fixed = await post<TimeSlot>('/timetable/slots', { title: 'Lecture · fixed', date: week, startMin: 540, endMin: 600, layer: 'fixed' });
  await post('/timetable/slots', { title: 'Another day at nine', date: addDays(week, 1), startMin: 540, endMin: 600, layer: 'fixed' });
  const flexible = await post<TimeSlot>('/timetable/slots', { title: task.title, taskId: task.id, date: week, startMin: 660, endMin: 720, layer: 'flexible' });
  await page.goto(`/plan?date=${week}&view=week`);
  if (info.project.name === 'desktop') {
    const a = await page.getByRole('button', { name: /Edit block Lecture/ }).boundingBox(), b = await page.getByRole('button', { name: /Edit block Another day/ }).boundingBox();
    expect(a && b).toBeTruthy(); expect(Math.abs(a!.y - b!.y)).toBeLessThan(1); expect(b!.x).toBeGreaterThan(a!.x);
    await expect(page.locator('.week-rest')).toContainText('Rest day');
  } else {
    await expect(page.getByRole('group', { name: 'Choose a day this week' })).toBeVisible();
    await expect(page.locator('.day-timeline')).toBeVisible();
  }
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light and dark theme', exact: true }).click();
    await accessible(page); await page.screenshot({ path: info.outputPath(`plan-week-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const movable = page.getByRole('button', { name: `Edit block ${task.title}`, exact: true });
  await movable.focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await (await page.request.get(`/api/v1/timetable/slots/${flexible.id}`)).json()).startMin).toBe(675);
  await expect(movable).toBeEnabled(); await movable.focus(); await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await (await page.request.get(`/api/v1/timetable/slots/${flexible.id}`)).json()).endMin).toBe(750);
  await page.getByRole('button', { name: 'Edit block Lecture · fixed', exact: true }).focus(); await page.keyboard.press('Alt+ArrowDown');
  expect((await (await page.request.get(`/api/v1/timetable/slots/${fixed.id}`)).json()).startMin).toBe(540);
  await page.getByLabel('Skill filter', { exact: true }).selectOption(skill.id);
  await expect(page.locator('.calendar-filter-banner')).toContainText('Showing Machine Learning only');
  await expect(page.locator('.calendar-filter-banner')).toContainText('schedule unchanged');
  await expect(page.getByRole('button', { name: 'Edit block Lecture · fixed', exact: true })).not.toBeVisible();
  const gaps = await page.locator('.timeline-free').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(gaps.some(label => label?.includes('at 09:00'))).toBeFalsy();
  await page.locator('.timeline-free').first().click();
  await expect(page.getByRole('dialog').getByLabel('Starts at', { exact: true })).not.toHaveValue('09:00');
  await context.setOffline(true); await expect(page.getByRole('dialog').getByRole('button', { name: 'Place time block', exact: true })).toBeDisabled();
  await context.setOffline(false); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.calendar-filter-banner')).not.toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 760 }); await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await reflow(page); await accessible(page);
  await page.getByRole('button', { name: 'Week', exact: true }).click(); await reflow(page);
  await expect(page.getByRole('group', { name: 'Choose a day this week' })).toBeVisible();
});

test('component kit exposes typed durations, toggles, destructive confirmation and an accessible Undo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/workshop');
  await page.getByRole('switch', { name: /Example setting/ }).check();
  await expect(page.getByRole('switch', { name: /Example setting/ })).toBeChecked();
  await page.getByLabel('Minutes', { exact: true }).fill('1h20');
  await page.getByRole('button', { name: 'Increase minutes', exact: true }).click();
  await expect(page.getByLabel('Minutes', { exact: true })).toHaveValue('85');
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Delete this example?', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Preview Undo toast', exact: true }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true }); await undo.focus();
  await page.waitForTimeout(5200); await expect(undo).toBeVisible(); await undo.click();
  await accessible(page);
  await page.setViewportSize({ width: 320, height: 760 }); await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; }); await reflow(page); await accessible(page);
});


test('reserved quick add keeps its skill, and contained work stays selectable at narrow large text', async ({ page }) => {
  const { data, skill, task, post } = await seed(page);
  const date = weekStartDate(addDays(data.studyDate, 7), data.user.settings.weekStart);
  await post('/timetable/slots', { title: 'ML reserved window', date, startMin: 600, endMin: 720, layer: 'reserved', skillId: skill.id });
  await post('/timetable/slots', { title: task.title, date, startMin: 630, endMin: 660, layer: 'flexible', taskId: task.id });
  await page.goto(`/plan?date=${date}`);
  await page.getByLabel('Goal filter', { exact: true }).selectOption(task.goalId);
  await page.getByRole('button', { name: /Add block at 10:00, available until 10:30, reserved skill time/ }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Block title', { exact: true }).fill('A step inside my reservation');
  await panel.getByRole('button', { name: 'Place time block', exact: true }).click();
  await expect(panel).not.toBeVisible();
  const slots: TimeSlot[] = await (await page.request.get(`/api/v1/timetable/global?from=${date}&to=${date}`)).json();
  expect(slots.find(slot => slot.title === 'A step inside my reservation')?.skillId).toBe(skill.id);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 760 }); await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await reflow(page);
  const edit = page.getByRole('button', { name: `Edit block ${task.title}`, exact: true });
  expect((await edit.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await edit.focus(); await page.keyboard.press('Enter'); await expect(panel.getByLabel('Block title', { exact: true })).toHaveValue(task.title); await accessible(page);
});
