import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { DateTime } from "luxon";
import type { Bootstrap } from "@kram/shared";
import { settleAppearance } from "./helpers/appearance";

test.setTimeout(120000);
test.beforeEach(async ({ request }) => {
  expect((await request.post("http://127.0.0.1:8422/api/v1/__test/reset", {
    headers: { "X-Kram-Test": "reset-isolated-db" },
  })).ok()).toBeTruthy();
});

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("kram-appearance")) localStorage.setItem("kram-appearance", JSON.stringify({ theme: "light", motion: "reduced" }));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  expect((await page.request.post("/api/v1/auth/setup", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: { email: "modern-layout@example.test", password: "synthetic-modern-layout-42", profileName: "Learning", timezone: "Asia/Kolkata" },
  })).ok()).toBeTruthy();
  const csrf = (await (await page.request.get("/api/v1/auth/me")).json()).csrfToken;
  const headers = { "X-CSRF-Token": csrf };
  expect((await page.request.patch("/api/v1/settings", { headers, data: { featurePreset: "full" } })).ok()).toBeTruthy();
  const data: Bootstrap = await (await page.request.get("/api/v1/bootstrap")).json();
  const post = async (path: string, input: unknown) => {
    const response = await page.request.post(`/api/v1${path}`, { headers, data: input });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const skill = await post("/skills", { name: "Focused practice", profileId: data.profiles[0]!.id, weeklyTargetMin: 300 });
  const goal = await post("/goals", { title: "Finish the course", skillId: skill.id, type: "milestone", unit: "pages", targetQty: 100, startDate: data.studyDate });
  for (let i = 0; i < 13; i++) await post("/tasks", { title: `Practice chapter ${i + 1}`, goalId: goal.id, estMinutes: 25, qty: 5, earliestDate: data.studyDate });
  await post("/timetable/slots", { title: "Morning preparation", date: data.studyDate, startMin: 420, endMin: 450, layer: "fixed" });
  const resource = await post("/resources", { title: "Practice handbook", type: "book", skillId: skill.id });
  await page.clock.install({ time: DateTime.fromISO(data.studyDate, { zone: "Asia/Kolkata" }).set({ hour: 9, minute: 30 }).toMillis() });
  return { data, resource };
}

test("a sparse schedule and prior-day notice leave current tasks in the first viewport", async ({ page }, info) => {
  const { data } = await seed(page);
  await page.route("**/api/v1/today", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.unverifiedReviews = [DateTime.fromISO(data.studyDate).minus({ days: 1 }).toISODate()];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.locator(".today-live-compact")).toContainText("Morning preparation");
  await expect(page.locator(".today-live-compact")).toContainText("07:00");
  await expect(page.locator(".today-live-compact")).toContainText("07:30");
  await expect(page.locator(".today-timeline-svg")).toHaveCount(0);
  await expect(page.locator(".today-now .today-next")).toHaveCount(1);
  await settleAppearance(page);
  const first = (await page.locator(".today-task-row .task-row-title").first().boundingBox())!;
  expect(first.y + Math.min(first.height, 44)).toBeLessThan(page.viewportSize()!.height - (info.project.name === "phone" ? 80 : 20));
  await page.screenshot({ path: info.outputPath("today-sparse.png"), animations: "disabled" });
  await page.locator(".today-now").getByRole("link", { name: "Choose a task", exact: true }).click();
  await expect(page.locator(".today-tasks")).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.getByRole("button", { name: "Open task Practice chapter 1", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Task in focus", exact: true });
  await expect(sheet).toBeVisible();
  const close = sheet.locator(".dialog-close");
  expect(await close.evaluate(element => getComputedStyle(element).position)).toBe("absolute");
  await close.click();
  await expect(sheet).toBeHidden();
});

test("working screens keep a coherent palette, usable controls and narrow reflow", async ({ page }, info) => {
  const { data } = await seed(page);
  const screens = [
    ["today", "/"], ["plan", `/plan?date=${data.studyDate}&view=week`],
    ["goals", "/goals"], ["progress", "/progress"], ["review", "/review"],
    ["settings", "/settings"], ["notifications", "/notifications"], ["resources", "/resources"],
  ];
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => {
      localStorage.setItem("kram-appearance", JSON.stringify({ theme: value, motion: "reduced" }));
    }, theme);
    for (const [name, path] of screens) {
      await page.goto(path!);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await settleAppearance(page);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`), animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  await page.goto("/settings");
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  await expect(page.locator(".settings-sections")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.locator(".settings-sections").getByRole("link", { name: "Quiet hours", exact: true }).click();
  await expect(page.locator("#quiet-hours")).toBeInViewport();
});
