import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Bootstrap, Goal, Task } from "@kram/shared";
import { settleAppearance } from "./helpers/appearance";

const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
test.setTimeout(60000);
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${testApi}/api/v1/__test/reset`, {
    headers: { "X-Kram-Test": "reset-isolated-db" },
  })).ok()).toBeTruthy();
});

async function seed(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  expect((await page.request.post("/api/v1/auth/setup", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: { email: "followup-review@example.test", password: "synthetic-followup-review-42", profileName: "new", timezone: "Asia/Kolkata", featurePreset: "full" },
  })).ok()).toBeTruthy();
  const csrf = (await (await page.request.get("/api/v1/auth/me")).json()).csrfToken;
  const headers = { "X-CSRF-Token": csrf };
  const post = async <T,>(path: string, data: unknown): Promise<T> => {
    const response = await page.request.post(`/api/v1${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const data: Bootstrap = await (await page.request.get("/api/v1/bootstrap")).json();
  const skill = await post<{ id: string }>("/skills", { name: "new", profileId: data.profiles[0]!.id, weeklyTargetMin: 300 });
  const goal = await post<Goal>("/goals", { title: "new", skillId: skill.id, type: "milestone", unit: "pages", targetQty: 10, estMinutes: 30, startDate: data.studyDate });
  const task = await post<Task>("/tasks", { title: "new", goalId: goal.id, qty: 10, estMinutes: 30, earliestDate: data.studyDate });
  return { data, task, headers, post };
}

async function accessible(page: Page) {
  await settleAppearance(page);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
}

test("existing minute-precision blocks remain editable and exact typed minutes persist", async ({ page }) => {
  const { data, post } = await seed(page);
  const slot = await post<{ id: string }>("/timetable/slots", {
    title: "One precise block", date: data.studyDate, startMin: 541, endMin: 556, layer: "flexible",
  });
  await page.goto(`/plan?date=${data.studyDate}`);
  await page.getByRole("button", { name: "Edit block One precise block", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByLabel("Starts at", { exact: true })).toHaveValue("09:01");
  await expect(editor.getByLabel("Ends at", { exact: true })).toHaveValue("09:16");
  await editor.getByLabel("Block title", { exact: true }).fill("A renamed precise block");
  await editor.getByRole("button", { name: "Save time block", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await (await page.request.get(`/api/v1/timetable/slots/${slot.id}`)).json()).toMatchObject({ startMin: 541, endMin: 556, title: "A renamed precise block" });
  await page.getByRole("button", { name: "Edit block A renamed precise block", exact: true }).click();
  await editor.getByLabel("Starts at", { exact: true }).fill("09:02");
  await editor.getByLabel("Ends at", { exact: true }).fill("09:17");
  await editor.getByRole("button", { name: "Save time block", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await (await page.request.get(`/api/v1/timetable/slots/${slot.id}`)).json()).toMatchObject({ startMin: 542, endMin: 557 });
});

test("default Plan puts the timetable first and Month keeps empty dates quiet at narrow large text", async ({ page }, info) => {
  const { data, post } = await seed(page);
  await page.goto(`/plan?date=${data.studyDate}`);
  const filters = page.locator(".calendar-filter-disclosure");
  await expect(filters).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("Profile filter", { exact: true })).toBeHidden();
  await expect(page.locator(".day-timeline")).toBeVisible();
  const timeline = await page.locator(".day-timeline").boundingBox();
  expect(timeline!.y).toBeLessThan(page.viewportSize()!.height - 150);
  await filters.locator("summary").click();
  await expect(page.getByLabel("Profile filter", { exact: true })).toBeVisible();
  await filters.locator("summary").click();
  await post("/timetable/slots", { title: "One real block", date: data.studyDate, startMin: 540, endMin: 570, layer: "fixed" });
  await page.getByRole("button", { name: "Month", exact: true }).click();
  const month = page.getByLabel("month timetable", { exact: true });
  await expect(month).toBeVisible();
  await expect(month).not.toContainText("0 blocks");
  await expect(month.getByRole("img", { name: "1 block, 30 min allocated", exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: "Toggle light and dark theme", exact: true }).click();
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`plan-month-${theme}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await expect(page.locator(".month-scroll-hint")).toBeVisible();
  expect(await page.locator(".month-scroll").evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy();
  await accessible(page);
  await page.locator(".month-scroll-hint").getByRole("link", { name: "open Agenda", exact: true }).click();
  await expect(page.getByLabel("agenda timetable", { exact: true })).toBeVisible();
});

test("task metadata, zero credit, singular counts and Simple mode actions remain truthful", async ({ page }, info) => {
  const { data, task, headers } = await seed(page);
  await page.goto("/");
  const row = page.locator(`[data-task-id="${task.id}"] .task-row-title`);
  await expect(row).toContainText("0 of 10 pages");
  expect((await row.innerText()).match(/new/g)).toHaveLength(1);
  await expect(row.locator(".caption")).toHaveText("0 of 10 pages");
  const track = page.getByRole("progressbar", { name: "Logged minutes toward skill weekly time targets", exact: true });
  await expect(track).toHaveAttribute("value", "0");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: "Toggle light and dark theme", exact: true }).click();
    expect(await track.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await row.locator(".caption").evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    await accessible(page);
  }
  await page.goto("/goals");
  await expect(page.getByText("1 profile · 1 skill", { exact: true })).toBeVisible();
  await page.goto("/streaks");
  await expect(page).toHaveURL(/\/progress\/streaks$/);
  await expect(page.getByRole("link", { name: "Progress", exact: true }).filter({ visible: true })).toHaveAttribute("aria-current", "page");
  if (info.project.name === "desktop") {
    const positions = await page.locator(".sidebar .nav-link > svg, .sidebar-footer .button-label > svg").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
  }
  expect((await page.request.patch("/api/v1/settings", { headers, data: { featurePreset: "simple" } })).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator('.route-content a[href^="/planning"], .route-content a[href^="/review"]')).toHaveCount(0);
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Schedule time", exact: true })).toHaveCount(0);
  await page.keyboard.press("p");
  expect(new URL(page.url()).pathname).toBe(`/tasks/${task.id}`);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("button", { name: /Add time block|Plan Navigate/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await accessible(page);
  for (const featurePreset of ["simple", "planner", "full"]) {
    expect((await page.request.patch("/api/v1/settings", { headers, data: { featurePreset } })).ok()).toBeTruthy();
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Messages, without the noise", exact: true })).toBeVisible();
    const routing = page.getByRole("link", { name: "Channels and reminder routing", exact: true });
    if (featurePreset === "full") await expect(routing).toHaveAttribute("href", "/channels");
    else await expect(routing).toHaveCount(0);
  }
  expect(data.profiles).toHaveLength(1);
});
