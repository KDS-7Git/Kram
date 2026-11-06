import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const theme of ["light", "dark"] as const) {
  test(`custom temporal controls commit registered and controlled values, reset, and preserve invalid drafts in ${theme}`, async ({ page }) => {
    const writes: string[] = [];
    page.on("request", request => {
      if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.url());
    });
    await page.addInitScript(value => localStorage.setItem("kram-appearance", JSON.stringify({ theme: value, motion: "reduced" })), theme);
    await page.goto("/workshop");
    const date = page.getByLabel("Example date", { exact: true });
    const start = page.getByLabel("Example starts at", { exact: true });
    const end = page.getByLabel("Example ends at", { exact: true });
    const preview = page.getByRole("status", { name: "Date and time preview", exact: true });
    const reset = page.getByRole("button", { name: "Reset date and time", exact: true });
    const submit = page.getByRole("button", { name: "Preview date and time", exact: true });
    await expect(date).toHaveAttribute("type", "text");
    await expect(date).toHaveValue("2026-11-06");
    await page.getByRole("button", { name: "Choose Example date", exact: true }).click();
    const calendar = page.getByRole("dialog", { name: "Choose Example date", exact: true });
    await expect(calendar.locator('[data-picker-value="2026-11-06"]')).toBeFocused();
    await calendar.locator('[data-picker-value="2026-11-09"]').click();
    await expect(date).toHaveValue("2026-11-09");
    await expect(date).toBeFocused();
    await page.getByRole("button", { name: "Choose Example starts at", exact: true }).click();
    await page.getByRole("option", { name: "09:15", exact: true }).click();
    await expect(start).toHaveValue("09:15");
    await start.press("ArrowUp");
    await expect(start).toHaveValue("09:20");
    await page.getByRole("button", { name: "Choose Example ends at", exact: true }).click();
    await page.getByRole("option", { name: "24:00", exact: true }).click();
    await expect(end).toHaveValue("24:00");
    await submit.click();
    await expect(preview).toHaveText("Preview: 2026-11-09 · 09:20–24:00");
    await expect(preview).toHaveAttribute("data-preview-count", "1");
    await reset.click();
    await expect(date).toHaveValue("2026-11-06");
    await expect(start).toHaveValue("09:00");
    await expect(end).toHaveValue("10:00");
    await expect(preview).toHaveAttribute("data-preview-count", "0");

    // The numeric parent retains its last valid value, while the actual empty input
    // blocks submission; it must not silently become midnight through timeMinute("").
    await start.fill("");
    await submit.click();
    await expect(start).toHaveValue("");
    await expect(start).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await reset.click();
    await expect(start).toHaveValue("09:00");
    await expect(page.locator(".temporal-error")).toHaveCount(0);

    await date.fill("2026-02-31");
    await submit.click();
    await expect(date).toHaveValue("2026-02-31");
    await expect(date).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await reset.click();
    await expect(date).toHaveValue("2026-11-06");
    await expect(page.locator(".temporal-error")).toHaveCount(0);

    await start.fill("09:");
    await submit.click();
    await expect(start).toHaveValue("09:");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await reset.click();
    await start.fill("24:00");
    await submit.click();
    await expect(start).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await reset.click();
    await end.fill("23:55");
    await end.press("ArrowUp");
    await expect(end).toHaveValue("24:00");
    await submit.click();
    await expect(preview).toHaveText("Preview: 2026-11-06 · 09:00–24:00");
    expect(writes).toEqual([]);
  });
}

test("date picker honours bounds and keyboard selection; Escape restores the typed input", async ({ page }) => {
  await page.goto("/workshop");
  const date = page.getByLabel("Example date", { exact: true });
  await date.press("Alt+ArrowDown");
  const calendar = page.getByRole("dialog", { name: "Choose Example date", exact: true });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole("button", { name: "Previous month", exact: true })).toBeDisabled();
  await expect(calendar.locator('[data-picker-value="2026-10-31"]')).toBeDisabled();
  await expect(calendar.locator('[data-picker-value="2026-11-06"]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(calendar.locator('[data-picker-value="2026-11-07"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(date).toHaveValue("2026-11-07");
  await expect(date).toBeFocused();
  await date.press("Alt+ArrowDown");
  await page.keyboard.press("PageDown");
  await expect(calendar.locator('[data-picker-value="2026-12-07"]')).toBeFocused();
  await expect(calendar.getByRole("button", { name: "Next month", exact: true })).toBeDisabled();
  await expect(calendar.locator('[data-picker-value="2027-01-01"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(calendar).toBeHidden();
  await expect(date).toBeFocused();
  await page.getByRole("button", { name: "Choose Example starts at", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose Example starts at", exact: true });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await expect(picker.getByRole("option", { name: "09:00", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Example starts at", { exact: true })).toHaveValue("09:05");
});

test("phone date sheet fits 320 pixels and keeps its day targets usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/workshop");
  await page.getByRole("button", { name: "Choose Example date", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose Example date", exact: true });
  await expect(picker).toHaveClass(/temporal-sheet/);
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const target = await picker.locator('[data-picker-value="2026-11-09"]').boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.height).toBeGreaterThanOrEqual(44);
  expect(await picker.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await picker.locator('[data-picker-value="2026-11-09"]').click();
  await expect(page.getByLabel("Example date", { exact: true })).toHaveValue("2026-11-09");
});

test("desktop date picker dismissal keeps focus on the clicked field", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phone picker uses a modal sheet.");
  await page.goto("/workshop");
  const date = page.getByLabel("Example date", { exact: true });
  const next = page.getByLabel("Example starts at", { exact: true });
  await page.getByRole("button", { name: "Choose Example date", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose Example date", exact: true });
  await expect(picker).toHaveClass(/temporal-popover/);
  await next.click();
  await expect(picker).toBeHidden();
  await expect(next).toBeFocused();
  await expect(date).toHaveValue("2026-11-06");
});
