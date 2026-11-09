import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, weekday } from '@kram/time';
import type { Bootstrap, RecurrenceSeries } from '@kram/shared';
import { chooseOption } from './helpers/select';
import { settleAppearance } from './helpers/appearance';

const testApi = process.env.E2E_API_URL || 'http://127.0.0.1:8422';
test.setTimeout(60000);
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${testApi}/api/v1/__test/reset`, { headers: { 'X-Kram-Test': 'reset-isolated-db' } })).ok()).toBeTruthy();
});
async function seed(page: Page) {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const setup = await page.request.post('/api/v1/auth/setup', { headers: { 'X-CSRF-Token': auth.csrfToken }, data: { email: 'college-ui@kram.test', password: 'synthetic-college-ui-password-42', profileName: 'Learning', timezone: 'Asia/Kolkata', featurePreset: 'planner' } });
  expect(setup.ok(), await setup.text()).toBeTruthy();
  const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrfToken;
  let data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect((await page.request.post('/api/v1/skills', { headers: { 'X-CSRF-Token': csrf }, data: { profileId: data.profiles[0]!.id, name: 'College' } })).ok()).toBeTruthy();
  data = await (await page.request.get('/api/v1/bootstrap')).json();
  return { data, csrf };
}
async function accessible(page: Page) {
  await settleAppearance(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
}
async function paste(page: Page, text: string) {
  await page.locator('.class-paste summary').click();
  await page.getByLabel('Timetable cells', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Preview pasted timetable', exact: true }).click();
  await expect(page.getByLabel('Editable paste preview', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add preview to weekly sheet', exact: true }).click();
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save weekly timetable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save weekly timetable', exact: true })).toBeDisabled();
  await expect(page.locator('.class-form-fields [role="status"]')).not.toContainText('unsaved changes');
  return await (await page.request.get('/api/v1/recurrence/series')).json() as RecurrenceSeries[];
}

test('Excel class/lab rows save once, retain differing times, and group course filters', async ({ page }, testInfo) => {
  const { data } = await seed(page);
  await page.goto('/plan'); await page.getByRole('link', { name: 'Classes and labs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your classes, one weekly sheet', exact: true })).toBeVisible();
  await expect(page.locator('a.nav-link[href="/plan"]:visible').first()).toHaveAttribute('aria-current', 'page');
  await page.getByLabel('Semester ends', { exact: true }).fill(addDays(data.studyDate, 45));
  await paste(page, 'Course\tType\tSlot\tDay\tStart\tEnd\nNetworks\tLecture\tA1\tMon/Wed\t08:00\t08:50\nNetworks\tLecture\tA1\tThu\t11:00\t11:50\nNetworks\tLab\tL2\tFri\t14:00\t16:30');
  await expect(page.getByLabel('Course, meeting 1', { exact: true })).toHaveValue('Networks');
  await expect(page.locator('.class-duration').last()).toHaveText('2 h 30 min');
  const rows = await save(page); expect(rows).toHaveLength(3);
  await page.reload(); await expect(page.getByLabel('End time, meeting 3', { exact: true })).toHaveValue('16:30');
  await accessible(page);
  await page.screenshot({ path: testInfo.outputPath('classes-weekly-sheet.png'), fullPage: true, animations: 'disabled' });
  await page.goto('/schedules'); await expect(page.getByRole('heading', { name: 'Networks', exact: true })).toHaveCount(1);
  await expect(page.locator('a.nav-link[href="/plan"]:visible').first()).toHaveAttribute('aria-current', 'page');
  await chooseOption(page.getByLabel('Series filter', { exact: true }), `course:${encodeURIComponent('Networks')}`);
  await expect(page.locator('.occurrence-row').first()).toContainText('Networks');
  await accessible(page);
});

test('compiled Excel grids, editable lab previews, future edits and makeup days need no weekly re-entry', async ({ page }) => {
  const { data, csrf } = await seed(page);
  await page.goto('/classes');
  await paste(page, 'Time\tMon\tTue\tWed\tThu\tFri\tSat\n08:00-08:50\tNetworks\tMaths\tNetworks\t\t\tSaturday lecture\n14:00-16:30\tNetworks Lab\t\t\t\t\t');
  const rows = await save(page); expect(rows).toHaveLength(4);
  const future = addDays(data.studyDate, 7);
  await page.getByLabel('Changes apply from', { exact: true }).fill(future);
  await page.getByLabel('Start time, meeting 1', { exact: true }).fill('09:00');
  await page.getByLabel('End time, meeting 1', { exact: true }).fill('09:50');
  const edited = await save(page); expect(edited.some(row => row.title === 'Networks' && row.startMin === 540)).toBe(true);
  await page.reload();
  await expect(page.locator('.class-form-fields .class-grid tbody tr')).toHaveCount(4);
  await expect(page.getByLabel('Start time, meeting 1', { exact: true })).toHaveValue('08:00');
  await page.getByLabel('Changes apply from', { exact: true }).fill(future);
  await page.getByRole('button', { name: 'Load saved meetings for this change date', exact: true }).click();
  await expect(page.locator('.class-form-fields .class-grid tbody tr')).toHaveCount(4);
  await expect.poll(() => page.locator('.class-form-fields .class-grid tbody tr').evaluateAll(rows => rows.map(row => ({ course: row.querySelector<HTMLInputElement>('[aria-label^="Course,"]')!.value, start: row.querySelector<HTMLInputElement>('[aria-label^="Start time,"]')!.value })))).toContainEqual({ course: 'Networks', start: '09:00' });
  const target = addDays(future, (6 - weekday(future) + 7) % 7);
  const appointment = await page.request.post('/api/v1/timetable/slots', { headers: { 'X-CSRF-Token': csrf }, data: { date: target, title: 'Personal appointment', startMin: 720, endMin: 750, layer: 'fixed' } });
  expect(appointment.ok()).toBeTruthy();
  await page.getByLabel('College day to replace', { exact: true }).fill(target);
  await chooseOption(page.getByLabel('Follow this weekday', { exact: true }), '1');
  await expect(page.locator('.class-day-preview')).toContainText('Monday meetings to add');
  await page.getByRole('button', { name: 'Apply college day', exact: true }).click();
  await expect(page.getByText(/follows Monday · 2 meetings applied/)).toBeVisible();
  const slots = await (await page.request.get(`/api/v1/timetable/global?from=${target}&to=${target}`)).json();
  expect(slots.map((slot: { title: string }) => slot.title)).toEqual(['Networks', 'Personal appointment', 'Networks Lab']);
  await expect(page.locator('.class-day-preview')).toContainText('Currently follows Monday');
  await chooseOption(page.getByLabel('Follow this weekday', { exact: true }), '2');
  await expect(page.locator('.class-day-preview')).toContainText('Networks Lab');
  await page.getByRole('button', { name: 'Apply college day', exact: true }).click();
  await expect(page.getByText(/follows Tuesday · 1 meeting applied/)).toBeVisible();
  const replacement = await (await page.request.get(`/api/v1/timetable/global?from=${target}&to=${target}`)).json();
  expect(replacement.map((slot: { title: string }) => slot.title)).toEqual(['Maths', 'Personal appointment']);
  await accessible(page);
});

test('weekday cells have even targets; drafts and both themes reflow at 320px with enlarged text', async ({ page, context }, testInfo) => {
  await seed(page); await page.goto('/classes');
  await page.getByRole('button', { name: 'Add lecture · 50 min', exact: true }).click();
  await page.getByLabel('Course, meeting 1', { exact: true }).fill('Signal processing');
  await page.getByRole('button', { name: 'Add lab · 2 hours', exact: true }).click();
  await page.getByLabel('Course, meeting 2', { exact: true }).fill('Signal processing');
  const sizes = await page.locator('.class-weekdays').first().locator('label').evaluateAll(labels => labels.map(label => ({ width: label.getBoundingClientRect().width, height: label.getBoundingClientRect().height })));
  expect(sizes.every(size => size.height >= 44 && size.width >= 44)).toBe(true);
  expect(Math.max(...sizes.map(size => size.width)) - Math.min(...sizes.map(size => size.width))).toBeLessThan(1);
  await context.setOffline(true); await expect(page.getByRole('button', { name: 'Save weekly timetable', exact: true })).toBeDisabled();
  await context.setOffline(false); await expect(page.getByLabel('Course, meeting 1', { exact: true })).toHaveValue('Signal processing');
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light and dark theme', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await accessible(page); await page.screenshot({ path: testInfo.outputPath(`classes-${theme}-320-enlarged.png`), fullPage: true, animations: 'disabled' });
  }
});

test('goal/history deletion is explicit, cancelable, and also deletes archived goals', async ({ page }, testInfo) => {
  const { data, csrf } = await seed(page);
  const goal = await (await page.request.post('/api/v1/goals', { headers: { 'X-CSRF-Token': csrf }, data: { skillId: data.skills[0]!.id, title: 'Disposable practice goal', type: 'daily', targetQty: 30, startDate: data.studyDate } })).json();
  const withTasks: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(), task = withTasks.tasks.find(row => row.goalId === goal.id)!;
  expect(task).toBeTruthy();
  expect((await page.request.post(`/api/v1/tasks/${task.id}/events`, { headers: { 'X-CSRF-Token': csrf }, data: { clientEventId: crypto.randomUUID(), kind: 'progress', minutes: 10, occurredAt: new Date().toISOString() } })).ok()).toBeTruthy();
  await page.goto(`/goals/${goal.id}`); await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Delete progress history', exact: true }).click();
  let dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Progress and timer history entries');
  await accessible(page);
  await page.screenshot({ path: testInfo.outputPath('delete-history-confirmation.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await (await page.request.get(`/api/v1/goals/${goal.id}/events`)).json()).length).toBe(1);
  await page.getByRole('button', { name: 'Delete progress history', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/goals/${goal.id}/events`)).json()).length).toBe(0);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Archive goal', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive goal', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive goal', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete goal', exact: true }).click(); dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Goal rule versions');
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await expect(page).toHaveURL('/goals'); expect((await page.request.get(`/api/v1/goals/${goal.id}`)).status()).toBe(404);
  await page.reload(); await expect(page.getByText('Disposable practice goal', { exact: true })).toHaveCount(0);
  await accessible(page);
});

test('archived templates remain deletable and their applied blocks survive reload', async ({ page }) => {
  const { data, csrf } = await seed(page);
  const templateResponse = await page.request.post('/api/v1/timetable/templates', { headers: { 'X-CSRF-Token': csrf }, data: { name: 'Disposable college template', kind: 'day', entries: [{ weekday: weekday(data.studyDate), title: 'Independent applied lecture', startMin: 480, endMin: 530, layer: 'fixed' }] } });
  expect(templateResponse.ok(), await templateResponse.text()).toBeTruthy();
  const template = await templateResponse.json();
  expect((await page.request.post(`/api/v1/timetable/templates/${template.id}/apply`, { headers: { 'X-CSRF-Token': csrf, 'If-Match': `"${template.version}"` }, data: { anchor: data.studyDate } })).ok()).toBeTruthy();
  await page.goto('/schedules?tab=templates');
  await expect(page.getByText(template.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archive template', exact: true }).click();
  await expect(page.getByText(template.name, { exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Include archived templates', exact: true }).check();
  await expect(page.getByText(template.name, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply template', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete template', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Blocks already placed in the timetable stay independent');
  await accessible(page);
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(template.name, { exact: true })).toHaveCount(0);
  await page.reload();
  expect((await (await page.request.get('/api/v1/timetable/templates?archived=true')).json())).toEqual([]);
  const slots = await (await page.request.get(`/api/v1/timetable/global?from=${data.studyDate}&to=${data.studyDate}`)).json();
  expect(slots).toHaveLength(1);
  expect(slots[0]).toMatchObject({ title: 'Independent applied lecture', startMin: 480, endMin: 530, templateId: null });
  await accessible(page);
});
