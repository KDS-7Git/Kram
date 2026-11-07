import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type MotionRecord = { role: string | null; name: string; opacity: number };
type MotionWindow = Window & { modernMotionEvents: MotionRecord[] };

async function fullMotion(page: Page) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    localStorage.setItem("kram-appearance", JSON.stringify({ theme: "light", motion: "full" }));
    (window as unknown as MotionWindow).modernMotionEvents = [];
    document.addEventListener("animationstart", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      (window as unknown as MotionWindow).modernMotionEvents.push({
        role: target.getAttribute("role"),
        name: (event as AnimationEvent).animationName,
        opacity: Number(getComputedStyle(target).opacity),
      });
    });
  });
}

async function transform(control: Locator) {
  return control.evaluate(element => {
    const value = getComputedStyle(element).transform;
    const matrix = value === "none" ? new DOMMatrix() : new DOMMatrix(value);
    return { scale: matrix.m11, x: matrix.m41, y: matrix.m42 };
  });
}

async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
  ).length)).toBe(0);
}

test("real controls acknowledge pointer and keyboard actions without shifting nearby content", async ({ page }, info) => {
  await fullMotion(page);
  const writes: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  await page.goto("/workshop");
  const open = page.getByRole("button", { name: "Open details", exact: true });
  const neighbor = page.getByRole("button", { name: "View week", exact: true });
  await expect(open).toBeVisible();
  await settled(page);
  const bounds = (await open.boundingBox())!;
  const neighborBefore = (await neighbor.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (info.project.name === "desktop") {
    await expect.poll(async () => (await transform(open)).y).toBeLessThan(-1);
  } else {
    // A touch device does not need hover to recognise or operate the control.
    expect((await transform(open)).y).toBe(0);
  }
  const neighborAfter = (await neighbor.boundingBox())!;
  expect(Math.abs(neighborAfter.x - neighborBefore.x)).toBeLessThan(1);
  expect(Math.abs(neighborAfter.y - neighborBefore.y)).toBeLessThan(1);
  expect(Math.abs(neighborAfter.width - neighborBefore.width)).toBeLessThan(1);
  await page.mouse.down();
  await expect.poll(async () => (await transform(open)).scale).toBeLessThan(.995);
  await page.mouse.up();
  const sheet = page.getByRole("dialog", { name: "A little more detail", exact: true });
  await expect(sheet).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as MotionWindow).modernMotionEvents
    .filter(event => event.role === "dialog").length)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(open).toBeFocused();

  const remove = page.getByRole("region", { name: "destructive button states", exact: true })
    .getByRole("button", { name: "Delete", exact: true }).first();
  const arrivals = await page.evaluate(() => (window as unknown as MotionWindow).modernMotionEvents.filter(event => event.role === "dialog").length);
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete this example?", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as MotionWindow).modernMotionEvents
    .filter(event => event.role === "dialog").length)).toBeGreaterThan(arrivals);
  await settled(page);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();
  expect(writes).toEqual([]);
});

test("switching palettes preserves typed work and keyboard chooser state", async ({ page }) => {
  await fullMotion(page);
  await page.goto("/workshop");
  const title = page.getByRole("textbox", { name: "Goal title", exact: true });
  const time = page.getByLabel("Example starts at", { exact: true });
  const view = page.getByRole("combobox", { name: "Example view", exact: true });
  await title.fill("Practise chord changes");
  await time.fill("11:35");
  await view.press("w");
  await expect(view).toHaveAttribute("data-value", "week");
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  await page.getByRole("button", { name: "Toggle light and dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settled(page);
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  expect(dark).not.toBe(light);
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
  expect((await page.locator('meta[name="theme-color"]').getAttribute("content"))?.toLowerCase()).toBe(dark.toLowerCase());
  await expect(title).toHaveValue("Practise chord changes");
  await expect(time).toHaveValue("11:35");
  await expect(view).toHaveAttribute("data-value", "week");

  await view.press("Space");
  const choices = page.getByRole("dialog", { name: "Example view", exact: true });
  await expect(choices).toBeVisible();
  const week = choices.getByRole("option", { name: "Week", exact: true });
  await expect(week).toBeFocused();
  expect((await week.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await expect(choices).toBeHidden();
  await expect(view).toBeFocused();
  await expect(view).toHaveAttribute("data-value", "week");
  await page.getByRole("button", { name: "Toggle light and dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(title).toHaveValue("Practise chord changes");
  await expect(time).toHaveValue("11:35");
  await settled(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toBe(light);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
});

test("OS and app Reduced motion keep the same usable controls with static feedback", async ({ page }) => {
  await fullMotion(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/workshop");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  for (const preference of ["OS", "app"]) {
    if (preference === "app") {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => {
        const appearance = JSON.parse(localStorage.getItem("kram-appearance") || "{}");
        localStorage.setItem("kram-appearance", JSON.stringify({ ...appearance, motion: "reduced" }));
        window.dispatchEvent(new Event("kram-appearance-changed"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    }
    const open = page.getByRole("button", { name: "Open details", exact: true });
    await open.scrollIntoViewIfNeeded();
    const bounds = (await open.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    expect(await transform(open)).toMatchObject({ scale: 1, x: 0, y: 0 });
    await page.mouse.down();
    expect(await transform(open)).toMatchObject({ scale: 1, x: 0, y: 0 });
    await page.mouse.up();
    const sheet = page.getByRole("dialog", { name: "A little more detail", exact: true });
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(element => element.getAnimations().length)).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
    const view = page.getByRole("combobox", { name: "Example view", exact: true });
    await view.press("Space");
    const choices = page.getByRole("dialog", { name: "Example view", exact: true });
    await expect(choices).toBeVisible();
    await expect(choices.getByRole("option", { name: "Today", exact: true })).toBeFocused();
    expect(await choices.evaluate(element => element.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(choices).toBeHidden();
    await expect(view).toBeFocused();
  }
});
