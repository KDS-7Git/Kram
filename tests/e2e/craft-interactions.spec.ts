import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Bootstrap, Goal, Task, TimeSlot } from '@kram/shared';
import { settleAppearance } from './helpers/appearance';

const testApi = process.env.E2E_API_URL || 'http://127.0.0.1:8422';
test.setTimeout(120000);
test.beforeEach(async ({ request }) => {
  const response = await request.post(`${testApi}/api/v1/__test/reset`, {
    headers: { 'X-Kram-Test': 'reset-isolated-db' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
});

async function appearance(page: Page, motion: 'full' | 'reduced' = 'reduced') {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
  await page.addInitScript(value => localStorage.setItem('kram-appearance', JSON.stringify({ theme: 'light', motion: value })), motion);
}

async function bootstrap(page: Page): Promise<Bootstrap> {
  const response = await page.request.get('/api/v1/bootstrap');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function seed(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', {
    headers: { 'X-CSRF-Token': auth.csrfToken },
    data: { email: 'craft-review@example.test', password: 'synthetic-craft-review-42', profileName: 'Learning', timezone: 'Asia/Kolkata', featurePreset: 'full' },
  });
  expect(setup.ok(), await setup.text()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await (await page.request.get('/api/v1/auth/me')).json()).csrfToken };
  const post = async <T,>(path: string, input: unknown): Promise<T> => {
    const response = await page.request.post(`/api/v1${path}`, { headers, data: input });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const data = await bootstrap(page);
  const skill = await post<{ id: string }>('/skills', { name: 'Focused practice', profileId: data.profiles[0]!.id, weeklyTargetMin: 300 });
  const goal = await post<Goal>('/goals', { title: 'Practice with intention', skillId: skill.id, type: 'milestone', unit: 'pages', targetQty: 40, estMinutes: 30, startDate: data.studyDate });
  const tasks: Task[] = [];
  for (const [index, title] of ['Read chapter one', 'Sketch a small idea', 'Review the notes'].entries()) {
    tasks.push(await post<Task>('/tasks', { title, goalId: goal.id, estMinutes: 25, qty: 10, earliestDate: data.studyDate, sortOrder: index + 1 }));
  }
  await post(`/tasks/${tasks[0]!.id}/events`, { kind: 'progress', clientEventId: randomUUID(), occurredAt: new Date().toISOString(), minutes: 7, qty: 2 });
  return { data, goal, tasks, post };
}

const progressFacts = (tasks: Task[]) => tasks.map(task => ({
  id: task.id, status: task.status, completedQty: task.completedQty, actualMinutes: task.actualMinutes,
  qty: task.qty, estMinutes: task.estMinutes, remainingMinutes: task.remainingMinutes,
  earliestDate: task.earliestDate, dueDate: task.dueDate,
})).sort((a, b) => a.id.localeCompare(b.id));

const visibleOrder = (page: Page) => page.locator('.task-order-row').evaluateAll(rows =>
  rows.map(row => row.querySelector('[data-task-id]')!.getAttribute('data-task-id')),
);

test('keyboard and pointer task ordering persist without altering progress or scheduled times', async ({ page }, info) => {
  await appearance(page, 'full');
  const { data, tasks, post } = await seed(page);
  const slot = await post<TimeSlot>('/timetable/slots', { title: tasks[0]!.title, taskId: tasks[0]!.id, date: data.studyDate, startMin: 540, endMin: 565, layer: 'pinned' });
  const before = await bootstrap(page);
  const originalOrder = [...before.tasks].sort((a, b) => a.sortOrder - b.sortOrder).map(task => task.id);
  const patches: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && /\/api\/v1\/tasks\//.test(request.url())) patches.push(request.postDataJSON());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your tasks', exact: true })).toBeVisible();
  const navigation = info.project.name === 'desktop' ? '.sidebar' : '.mobile-nav';
  const axis = info.project.name === 'desktop' ? 'y' : 'x';
  await expect(page.locator(`${navigation} .nav-active-pill`)).toBeVisible();
  const selected = (await page.locator(`${navigation} .nav-active-pill`).boundingBox())!;
  const destination = (await page.locator(`${navigation} .nav-link[href="/plan"]`).boundingBox())!;
  const start = axis === 'y' ? selected.y + selected.height / 2 : selected.x + selected.width / 2;
  const end = axis === 'y' ? destination.y + destination.height / 2 : destination.x + destination.width / 2;
  const sampling = page.evaluate(({ navigation, axis }) => new Promise<number[]>(resolve => {
    const positions: number[] = [];
    let frames = 0;
    const sample = () => {
      const pill = document.querySelector(`${navigation} .nav-link[aria-current="page"] .nav-active-pill`);
      if (pill) {
        const rect = pill.getBoundingClientRect();
        positions.push(axis === 'y' ? rect.y + rect.height / 2 : rect.x + rect.width / 2);
      }
      if (++frames < 30) requestAnimationFrame(sample); else resolve(positions);
    };
    requestAnimationFrame(sample);
  }), { navigation, axis });
  await page.locator(`${navigation} .nav-link[href="/plan"]`).click();
  const positions = await sampling;
  expect(positions.some(position => position > Math.min(start, end) + 3 && position < Math.max(start, end) - 3), 'The active navigation surface passes through intermediate positions.').toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Arrange tasks', exact: true }).click();
  await expect.poll(() => visibleOrder(page)).toEqual(originalOrder);
  const moved = tasks[2]!;
  await page.getByRole('button', { name: `Reorder ${moved.title}`, exact: true }).focus();
  await page.keyboard.press('ArrowUp');
  const keyboardOrder = [...originalOrder];
  const index = keyboardOrder.indexOf(moved.id);
  [keyboardOrder[index - 1], keyboardOrder[index]] = [keyboardOrder[index]!, keyboardOrder[index - 1]!];
  await expect.poll(async () => [...(await bootstrap(page)).tasks].sort((a, b) => a.sortOrder - b.sortOrder).map(task => task.id)).toEqual(keyboardOrder);
  await expect(page.getByRole('button', { name: `Reorder ${moved.title}`, exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Arrange tasks', exact: true })).toBeEnabled();

  const handle = page.getByRole('button', { name: `Reorder ${tasks[0]!.title}`, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const target = (await page.locator('.task-order-row').last().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height - 8, { steps: 18 });
  await page.mouse.up();
  const pointerOrder = [...keyboardOrder.filter(id => id !== tasks[0]!.id), tasks[0]!.id];
  await expect.poll(() => visibleOrder(page)).toEqual(pointerOrder);
  await expect.poll(async () => [...(await bootstrap(page)).tasks].sort((a, b) => a.sortOrder - b.sortOrder).map(task => task.id)).toEqual(pointerOrder);
  expect(progressFacts((await bootstrap(page)).tasks)).toEqual(progressFacts(before.tasks));
  expect(await (await page.request.get(`/api/v1/timetable/slots/${slot.id}`)).json()).toMatchObject({ date: slot.date, startMin: 540, endMin: 565, taskId: tasks[0]!.id });
  expect(patches.length).toBeGreaterThan(0);
  patches.forEach(patch => expect(Object.keys(patch as object)).toEqual(['sortOrder']));
  await page.reload();
  await page.getByRole('button', { name: 'Arrange tasks', exact: true }).click();
  await expect.poll(() => visibleOrder(page)).toEqual(pointerOrder);
  await page.screenshot({ path: info.outputPath('task-order.png'), animations: 'disabled' });
});

test('stacked messages expire independently and Undo only applies to its own message', async ({ page }) => {
  await appearance(page);
  await page.clock.install();
  await page.goto('/workshop');
  await page.getByRole('button', { name: 'Preview Undo toast', exact: true }).click();
  const first = page.locator('.toast').filter({ hasText: 'Marked done · example.' });
  await expect(first).toBeVisible();
  await page.clock.runFor(2500);
  await page.getByRole('button', { name: 'Preview feedback', exact: true }).click();
  const second = page.locator('.toast').filter({ hasText: 'Example feedback.' });
  await expect(second).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(2);
  await page.clock.runFor(2600);
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await page.getByRole('button', { name: 'Preview Undo toast', exact: true }).click();
  await first.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await expect(page.locator('.toast').filter({ hasText: 'Example undone.' })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: 'Preview feedback', exact: true }).focus();
  await page.clock.runFor(2500);
  await expect(second).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Example undone.' })).toBeVisible();
});

test('Undo windows pause during hover and keyboard focus, including a dialog opening and closing', async ({ page }) => {
  await appearance(page);
  await page.clock.install();
  await page.goto('/workshop');
  await page.getByRole('button', { name: 'Preview Undo toast', exact: true }).click();
  const message = page.locator('.toast').filter({ hasText: 'Marked done · example.' });
  await message.hover();
  await expect(message.locator('.toast-window')).toHaveClass(/toast-window-paused/);
  await page.clock.runFor(6000);
  await expect(message).toBeVisible();
  await page.mouse.move(0, 0);
  await message.getByRole('button', { name: 'Undo', exact: true }).focus();
  await expect(message.locator('.toast-window')).toHaveClass(/toast-window-paused/);
  await page.clock.runFor(6000);
  await expect(message).toBeVisible();

  await page.getByRole('button', { name: 'Open details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A little more detail', exact: true });
  await expect(dialog.locator('.toast')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).focus();
  await page.clock.runFor(6000);
  await expect(dialog.locator('.toast')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: 'Open details', exact: true }).focus();
  await page.clock.runFor(5100);
  await expect(message).toHaveCount(0);
});

test('the command palette supports arrows, Home and End, typing from a result, and focus return', async ({ page }) => {
  await appearance(page);
  await seed(page);
  await page.goto('/settings');
  const origin = page.getByLabel('Timezone', { exact: true });
  await origin.focus();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'A small next step', exact: true });
  const search = palette.getByRole('searchbox', { name: 'Search or choose an action', exact: true });
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  await expect(palette.locator('.command-result').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(palette.locator('.command-result').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(palette.locator('.command-result').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(palette.locator('.command-result').first()).toBeFocused();
  await page.keyboard.type('Settings');
  await expect(search).toHaveValue('Settings');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(origin).toBeFocused();
  await page.keyboard.press('Control+k');
  await search.fill('Review the notes');
  await search.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Review the notes', exact: true })).toBeVisible();
});

test('the settings save shortcut keeps invalid time drafts and commits valid exact minutes', async ({ page }) => {
  await appearance(page);
  await seed(page);
  await page.goto('/settings');
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/v1/settings')) writes.push(request.postDataJSON());
  });
  const waking = page.getByLabel('Waking time', { exact: true });
  await waking.fill('07:');
  await waking.press('Control+s');
  await expect(waking).toHaveAttribute('aria-invalid', 'true');
  await expect(waking).toHaveValue('07:');
  expect(writes).toHaveLength(0);
  expect((await bootstrap(page)).user.settings.wakingMin).toBe(420);
  await waking.fill('07:15');
  await waking.press('Control+s');
  await expect(page.locator('.toast').filter({ hasText: 'Settings saved.' })).toBeVisible();
  expect((await bootstrap(page)).user.settings.wakingMin).toBe(435);
  expect(writes).toHaveLength(1);
});

test('secondary screens, overflow tooltips and empty-state actions work in both themes', async ({ page }, info) => {
  await appearance(page);
  const { data, goal, post } = await seed(page);
  const title = 'A detailed reference for thoughtful practice and the small ideas that make a productive day '.repeat(2).slice(0, 195).trim();
  const resource = await post<{ id: string }>('/resources', { title, type: 'book', skillId: goal.skillId });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => localStorage.setItem('kram-appearance', JSON.stringify({ theme: value, motion: 'reduced' })), theme);
    for (const route of ['/schedules', '/schedules?tab=templates', '/schedules?tab=holidays', '/data', '/channels', '/progress/streaks', `/goals/${goal.id}`, `/resources/${resource.id}`, `/review?kind=weekly&date=${data.studyDate}`]) {
      await page.goto(route);
      await expect(page.locator('h1')).toBeVisible();
      await settleAppearance(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}: ${route}`).toBeTruthy();
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations, `${theme}: ${route}`).toEqual([]);
    }
  }
  await page.goto('/schedules?tab=templates');
  await page.getByRole('button', { name: 'Create your first template', exact: true }).click();
  const template = page.getByRole('dialog', { name: 'A reusable template', exact: true });
  await expect(template).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/resources');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const overflow = page.locator('.resource-card .truncate-text').filter({ hasText: title });
  await expect(overflow).toHaveAttribute('title', title);
  await overflow.hover();
  await expect(page.getByRole('tooltip')).toHaveText(title);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 320, height: 760 });
  for (const route of ['/schedules?tab=templates', '/data']) {
    await page.goto(route);
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await settleAppearance(page);
  }
  await page.screenshot({ path: info.outputPath('recovery-narrow.png'), animations: 'disabled' });
});
