import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function paletteMatchesChrome(page: Page, theme: string) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByRole("button", { name: "Toggle light and dark theme", exact: true })
    .locator(theme === "dark" ? ".lucide-sun" : ".lucide-moon")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme);
  await expect.poll(async () => (await page.locator('meta[name="theme-color"]').getAttribute("content"))?.toLowerCase())
    .toBe(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()));
}

test("system themes follow the visible palette, native chrome and reduced-motion preference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kram-appearance", JSON.stringify({ theme: "system", motion: "full" })));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await page.goto("/workshop");
  await paletteMatchesChrome(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await paletteMatchesChrome(page, "light");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Toggle light and dark theme", exact: true }).click();
  await paletteMatchesChrome(page, "dark");
  await expect(page.locator("html")).not.toHaveClass(/theme-crossfade/);
  expect(await page.locator(".route-content").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.getByRole("button", { name: "Open details", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open details", exact: true })).toBeFocused();
});

test("scheduled themes catch up on foreground and device motion choice survives reload", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-06T00:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("kram-appearance", JSON.stringify({ theme: "scheduled", motion: "reduced", wakeMin: 420, sleepMin: 1380 })));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/workshop");
  await paletteMatchesChrome(page, "dark");
  expect(await page.locator(".route-content").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00Z"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await paletteMatchesChrome(page, "light");
  await page.reload();
  await paletteMatchesChrome(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
});

test("Today columns size to their content and calendar query changes preserve the current screen", async ({ page, request }, info) => {
  const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
  expect((await request.post(`${testApi}/api/v1/__test/reset`, { headers: { "X-Kram-Test": "reset-isolated-db" } })).ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem("kram-appearance", JSON.stringify({ theme: "light", motion: "full" })));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  expect((await page.request.post("/api/v1/auth/setup", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: { email: "interaction-review@example.test", password: "synthetic-interaction-review-42", profileName: "Learning", timezone: "Asia/Kolkata" },
  })).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator(".today-now")).toBeVisible();
  if (info.project.name === "desktop") {
    const now = await page.locator(".today-now").boundingBox();
    const next = await page.locator(".today-next").boundingBox();
    const tasks = await page.locator(".today-tasks").boundingBox();
    expect(next!.y).toBeGreaterThan(now!.y);
    expect(next!.y + next!.height).toBeLessThanOrEqual(now!.y + now!.height + 1);
    expect(next!.height).toBeLessThan(220);
    expect(tasks!.y).toBeLessThan(page.viewportSize()!.height - 100);
  }
  await page.goto("/plan");
  await expect(page.getByLabel("Calendar date", { exact: true })).toBeVisible();
  const marker = await page.locator(".route-content").evaluateHandle(element => element);
  const previous = await page.getByLabel("Calendar date", { exact: true }).inputValue();
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(page.getByLabel("Calendar date", { exact: true })).not.toHaveValue(previous);
  expect(await page.locator(".route-content").evaluate((element, original) => element === original, marker)).toBe(true);
  await marker.dispose();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("link", { name: "Proposals and plan history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate plan", exact: true })).toBeVisible();
  expect(await page.locator(".route-content").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await expect(page.locator("h1")).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const csrf = (await (await page.request.get("/api/v1/auth/me")).json()).csrfToken;
  const headers = { "X-CSRF-Token": csrf };
  expect((await page.request.patch("/api/v1/settings", { headers, data: { featurePreset: "simple" } })).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator(".today-now").getByRole("link", { name: "Create a goal", exact: true })).toHaveAttribute("href", "/goals");
  await expect(page.locator(".day-ribbon, .today-live")).toHaveCount(0);
  if (info.project.name === "phone") {
    const add = await page.locator(".mobile-add").boundingBox();
    expect(Math.abs(add!.x + add!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
  }
  const data = await (await page.request.get("/api/v1/bootstrap")).json();
  const skill = await (await page.request.post("/api/v1/skills", { headers, data: { name: "Learning", profileId: data.profiles[0].id } })).json();
  expect((await page.request.post("/api/v1/goals", { headers, data: { title: "One defined step", skillId: skill.id, type: "milestone", unit: "minutes", targetQty: 30, startDate: data.studyDate } })).ok()).toBeTruthy();
  await page.reload();
  await page.locator(".today-now").getByRole("link", { name: "Choose a task", exact: true }).click();
  await expect(page.locator(".today-tasks")).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/");
});
