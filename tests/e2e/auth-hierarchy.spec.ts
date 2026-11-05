import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Bootstrap, Skill } from "@kram/shared";

const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
const email = "browser-owner@example.test";
const password = "garden-lantern-steady-river";

async function createOwner(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your account", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your study day", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Study day ends at", { exact: true }).fill("04:00");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Waking time", { exact: true }).fill("07:00");
  await page.getByLabel("Sleeping time", { exact: true }).fill("23:00");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("First profile name", { exact: true }).fill("Research");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /Planner/ }).check();
  await page
    .getByRole("button", { name: "Create my planner", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A little room to focus", exact: true }),
  ).toBeVisible();
}

async function snapshotData(page: Page) {
  const response = await page.request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Bootstrap>;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${testApi}/api/v1/__test/reset`, {
    headers: { "X-Kram-Test": "reset-isolated-db" },
  });
  expect(
    response.ok(),
    "The reset endpoint must belong to the isolated test fixture.",
  ).toBeTruthy();
});

test("owner onboarding persists account, time choices and first profile", async ({
  page,
}) => {
  await createOwner(page);
  const data = await snapshotData(page);
  expect(data.user.email).toBe(email);
  expect(data.user.settings).toMatchObject({
    timezone: "Asia/Kolkata",
    dayRollover: 240,
    wakingMin: 420,
    sleepingMin: 1380,
    featurePreset: "planner",
  });
  expect(data.profiles.map((profile) => profile.name)).toEqual(["Research"]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A little room to focus", exact: true }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("profiles, arbitrary practice days, windows, ordering and archive persist", async ({
  page,
}) => {
  await createOwner(page);
  await page.getByRole("link", { name: "Goals", exact: true }).click();
  for (const name of ["Development", "Wellbeing"]) {
    await page
      .getByRole("button", { name: "New profile", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Profile name", { exact: true }).fill(name);
    await dialog
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Move Wellbeing earlier", exact: true })
    .click();
  await expect(page.locator(".profile-name-button h2")).toHaveText([
    "Research",
    "Wellbeing",
    "Development",
  ]);
  const development = page.locator(".card").filter({
    has: page.getByRole("heading", { name: "Development", exact: true }),
  });
  await development
    .getByRole("button", { name: "Add skill", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Skill name", { exact: true }).fill("Networks");
  await dialog.getByLabel("Daily target (min)", { exact: true }).fill("30");
  await dialog.getByLabel("Weekly target (min)", { exact: true }).fill("180");
  await dialog.getByLabel("Daily limit (min)", { exact: true }).fill("120");
  for (const day of ["Mon", "Wed", "Fri"])
    await dialog.getByRole("checkbox", { name: day, exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Add window", exact: true }).click();
  await dialog.getByLabel("Start", { exact: true }).fill("18:00");
  await dialog.getByLabel("End", { exact: true }).fill("19:30");
  await dialog.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Networks", exact: true }),
  ).toBeVisible();
  const data = await snapshotData(page);
  const skill = data.skills.find((item) => item.name === "Networks");
  expect(skill).toMatchObject({
    availableDays: [2, 4, 6],
    dailyTargetMin: 30,
    weeklyTargetMin: 180,
    maxDailyMin: 120,
    windows: [{ days: [2, 4, 6], startMin: 1080, endMin: 1170 }],
  });
  await page
    .getByRole("button", { name: "Edit Networks", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Skill name", { exact: true })
    .fill("Computer Networks");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save skill", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Archive Computer Networks", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Computer Networks", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("checkbox", { name: "Show archived", exact: true })
    .check();
  await expect(
    page.getByRole("heading", { name: "Computer Networks", exact: true }),
  ).toBeVisible();
  const archivedResponse = await page.request.get(
    "/api/v1/skills?archived=true",
  );
  expect(archivedResponse.ok()).toBeTruthy();
  const archivedSkills = (await archivedResponse.json()) as Skill[];
  expect(
    archivedSkills.find((item) => item.id === skill?.id)?.archivedAt,
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Archive Development", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Development", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Show archived", exact: true })
    .uncheck();
  await expect(
    page.getByRole("heading", { name: "Development", exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("checkbox", { name: "Show archived", exact: true })
    .check();
  await expect(
    page.getByRole("heading", { name: "Computer Networks", exact: true }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("settings, device theme, sign out and sign in work on desktop and phone", async ({
  page,
}) => {
  await createOwner(page);
  await page
    .getByRole("button", { name: "Owner account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make room your way", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Timezone", { exact: true }).fill("Europe/London");
  await page.getByLabel("Study day ends at", { exact: true }).fill("05:00");
  await page.getByLabel("Week starts on", { exact: true }).selectOption("7");
  await page
    .getByLabel("Desktop density", { exact: true })
    .selectOption("compact");
  await page.getByLabel("Clock format", { exact: true }).selectOption("12");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("Settings saved.");
  const data = await snapshotData(page);
  expect(data.user.settings).toMatchObject({
    timezone: "Europe/London",
    dayRollover: 300,
    weekStart: 7,
    theme: "dark",
    density: "compact",
    clockFormat: "12",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Make room your way", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page
    .getByRole("button", { name: "Owner account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A little room to focus", exact: true }),
  ).toBeVisible();
});
