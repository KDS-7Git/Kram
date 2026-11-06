import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseOption } from "./helpers/select";

for (const theme of ["light", "dark"] as const) {
  test(`custom choices submit controlled and registered values and reset in ${theme}`, async ({ page }) => {
    const writes: string[] = [];
    page.on("request", request => {
      if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.url());
    });
    await page.addInitScript(value => localStorage.setItem("kram-appearance", JSON.stringify({ theme: value, motion: "reduced" })), theme);
    await page.goto("/workshop");
    const view = page.getByRole("combobox", { name: "Example view", exact: true });
    const area = page.getByRole("combobox", { name: "Example area", exact: true });
    const preview = page.getByRole("status", { name: "Select choices preview", exact: true });
    const submit = page.getByRole("button", { name: "Preview select choices", exact: true });
    await expect(view).toHaveAttribute("data-value", "today");
    await expect(area).toHaveAttribute("data-value", "");
    await expect(page.getByLabel("Example area", { exact: true })).toHaveCount(1);
    await expect(area).toHaveAttribute("aria-required", "true");
    await chooseOption(view, "week");
    await chooseOption(area, "work");
    await submit.click();
    await expect(preview).toHaveText("Preview: Week · Work");
    await expect(preview).toHaveAttribute("data-preview-count", "1");
    await page.getByRole("button", { name: "Reset select choices", exact: true }).click();
    await expect(view).toHaveAttribute("data-value", "today");
    await expect(area).toHaveAttribute("data-value", "");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await submit.click();
    await expect(area).toBeFocused();
    await expect(area).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await expect(page.getByRole("alert").filter({ hasText: "Choose an option before continuing." })).toBeVisible();
    await chooseOption(area, "learning");
    await expect(area).not.toHaveAttribute("aria-invalid", "true");
    await chooseOption(view, "week");
    await submit.click();
    await expect(preview).toHaveText("Preview: Week · Learning");
    await page.getByRole("button", { name: "Reset native choices", exact: true }).click();
    await expect(view).toHaveAttribute("data-value", "today");
    await expect(area).toHaveAttribute("data-value", "");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await submit.click();
    await expect(area).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toHaveAttribute("data-preview-count", "0");
    await chooseOption(area, "work");
    await submit.click();
    await expect(preview).toHaveText("Preview: Today · Work");
    await expect(preview).toHaveAttribute("data-preview-count", "1");
    expect(writes).toEqual([]);
  });
}

test("choice keyboard navigation skips disabled values and restores focus after selection or Escape", async ({ page }) => {
  await page.goto("/workshop");
  const area = page.getByRole("combobox", { name: "Example area", exact: true });
  await area.press("ArrowDown");
  const picker = page.getByRole("dialog", { name: "Example area", exact: true });
  const learning = picker.getByRole("option", { name: "Learning", exact: true });
  const work = picker.getByRole("option", { name: "Work", exact: true });
  await expect(picker.getByRole("listbox", { name: "Example area", exact: true })).toBeVisible();
  await expect(picker.getByRole("option", { name: "Choose an area", exact: true })).toBeDisabled();
  await expect(picker.getByRole("option", { name: "Archived · unavailable", exact: true })).toBeDisabled();
  await expect(learning).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(work).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(learning).toBeFocused();
  await page.keyboard.press("End");
  await expect(work).toBeFocused();
  await page.keyboard.press("Home");
  await expect(learning).toBeFocused();
  await page.keyboard.press("w");
  await expect(work).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(area).toHaveAttribute("data-value", "work");
  await expect(area).toBeFocused();
  await expect(picker).toBeHidden();
  await area.press("Home");
  await expect(area).toHaveAttribute("data-value", "learning");
  await area.press("End");
  await expect(area).toHaveAttribute("data-value", "work");
  await area.press("l");
  await expect(area).toHaveAttribute("data-value", "learning");
  await area.press("Space");
  await expect(learning).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(area).toBeFocused();
  await expect(area).toHaveAttribute("data-value", "learning");
});

test("desktop outside dismissal preserves focus on the clicked field", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phone chooser uses a modal sheet.");
  await page.goto("/workshop");
  const area = page.getByRole("combobox", { name: "Example area", exact: true });
  const date = page.getByLabel("Example date", { exact: true });
  await area.click();
  await expect(page.getByRole("dialog", { name: "Example area", exact: true })).toHaveClass(/select-popover/);
  await date.click();
  await expect(area).toHaveAttribute("aria-expanded", "false");
  await expect(date).toBeFocused();
});

test("phone choice sheet reflows at 320 pixels with large targets and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/workshop");
  const area = page.getByRole("combobox", { name: "Example area", exact: true });
  await area.click();
  const picker = page.getByRole("dialog", { name: "Example area", exact: true });
  await expect(picker).toHaveClass(/select-sheet/);
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  for (const target of await picker.getByRole("option").all()) {
    const box = await target.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await picker.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await picker.getByRole("option", { name: "Work", exact: true }).click();
  await expect(area).toHaveAttribute("data-value", "work");
  await expect(area).toBeFocused();
});

test("forced colours retain a single custom chooser, selected state, and focus outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/workshop");
  const area = page.getByRole("combobox", { name: "Example area", exact: true });
  await chooseOption(area, "work");
  await area.press("ArrowDown");
  const picker = page.getByRole("dialog", { name: "Example area", exact: true });
  const selected = picker.getByRole("option", { name: "Work", exact: true });
  await expect(selected).toBeFocused();
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected.locator("svg")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Example area", exact: true, includeHidden: true })).toHaveCount(1);
  const colours = await selected.evaluate(element => {
    const style = getComputedStyle(element);
    return { text: style.color, background: style.backgroundColor, outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(colours.text).not.toBe(colours.background);
  expect(colours.outline).not.toBe("none");
  expect(colours.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");
  await expect(area).toBeFocused();
});
