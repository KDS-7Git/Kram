import { chooseOption } from "./helpers/select";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  Bootstrap,
  Goal,
  GoalRuleVersion,
  ResourceItem,
} from "@kram/shared";

const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
test.setTimeout(60000);

async function seed(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your account", exact: true }),
  ).toBeVisible();
  let auth = await (await page.request.get("/api/v1/auth/me")).json();
  const setup = await page.request.post("/api/v1/auth/setup", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: {
      email: "goals-owner@example.test",
      password: "paper-library-steady-garden",
      profileName: "Learning",
      timezone: "Asia/Kolkata",
      dayRollover: 240,
      wakingMin: 420,
      sleepingMin: 1380,
      featurePreset: "planner",
    },
  });
  expect(setup.ok()).toBeTruthy();
  auth = await (await page.request.get("/api/v1/auth/me")).json();
  const initial = await bootstrap(page);
  const skill = await page.request.post(
    `/api/v1/profiles/${initial.profiles[0]!.id}/skills`,
    {
      headers: { "X-CSRF-Token": auth.csrfToken },
      data: { name: "Systems", profileId: initial.profiles[0]!.id },
    },
  );
  expect(skill.ok()).toBeTruthy();
  await page.goto("/goals");
  await expect(
    page.getByRole("heading", { name: "Systems", exact: true }),
  ).toBeVisible();
  return { data: await bootstrap(page), csrf: auth.csrfToken };
}
async function bootstrap(page: Page): Promise<Bootstrap> {
  const response = await page.request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
async function seedGoals(page: Page) {
  const { data, csrf } = await seed(page);
  const goals: Goal[] = [];
  for (const title of ["Read the reference", "Review the material"]) {
    const response = await page.request.post("/api/v1/goals", {
      headers: { "X-CSRF-Token": csrf },
      data: {
        skillId: data.skills[0]!.id,
        title,
        type: "daily",
        unit: "pages",
        targetQty: 10,
        startDate: data.studyDate,
      },
    });
    expect(response.ok()).toBeTruthy();
    goals.push(await response.json());
  }
  await page.goto("/resources");
  return goals;
}
async function assertAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}
test.beforeEach(async ({ request }) => {
  const response = await request.post(`${testApi}/api/v1/__test/reset`, {
    headers: { "X-Kram-Test": "reset-isolated-db" },
  });
  expect(
    response.ok(),
    "Only the isolated fixture may reset its database.",
  ).toBeTruthy();
});

test("five goal types preserve units, dates, versioned rules and archive history", async ({
  page,
}) => {
  const { data } = await seed(page);
  const choices = [
    { label: "Daily practice", title: "Daily reading", unit: "pages" },
    { label: "Weekly quota", title: "Weekly practice", unit: "minutes" },
    { label: "Repeating goal", title: "Recurring review", unit: "sessions" },
    { label: "Adaptive goal", title: "Finish the course", unit: "videos" },
    { label: "Milestone", title: "Ship the project", unit: "projects" },
  ];
  for (const [index, choice] of choices.entries()) {
    await page
      .getByRole("button", { name: "New goal for Systems", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Goal title", { exact: true }).fill(choice.title);
    await chooseOption(dialog
      .getByLabel("Goal type", { exact: true }), { label: choice.label });
    await dialog
      .getByLabel("Measurement unit", { exact: true })
      .fill(choice.unit);
    await dialog.getByLabel("Target quantity", { exact: true }).fill("12");
    if (index === 2) {
      await chooseOption(dialog
        .getByLabel("Repeat frequency", { exact: true }), "MONTHLY");
      await dialog.getByLabel("Day of month", { exact: true }).fill("31");
      await expect(
        dialog.getByText(
          "Months without this date are skipped. Choose 1–28 for every month.",
          { exact: true },
        ),
      ).toBeVisible();
      await chooseOption(dialog
        .getByLabel("Repeat frequency", { exact: true }), "WEEKLY");
      await dialog.getByLabel("Repeat every", { exact: true }).fill("2");
    }
    if (index === 0) {
      await dialog
        .getByLabel("Deadline (optional)", { exact: true })
        .fill(addDays(data.studyDate, -1));
      await dialog
        .getByRole("button", { name: "Add goal", exact: true })
        .click();
      await expect(
        dialog.getByText("Deadline must be on or after the start date.", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await dialog
      .getByLabel("Deadline (optional)", { exact: true })
      .fill(addDays(data.studyDate, 14));
    await dialog.getByRole("button", { name: "Add goal", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("link", { name: new RegExp(choice.title) }),
    ).toBeVisible();
  }
  const saved = await bootstrap(page);
  expect(saved.goals.map((goal) => goal.type).sort()).toEqual([
    "adaptive",
    "daily",
    "milestone",
    "recurring",
    "weekly",
  ]);
  expect(saved.goals.map((goal) => goal.unit).sort()).toEqual([
    "minutes",
    "pages",
    "projects",
    "sessions",
    "videos",
  ]);
  await page.getByRole("link", { name: /Daily reading/ }).click();
  expect(
    saved.goals.find((goal) => goal.type === "recurring")?.rrule,
  ).toContain("INTERVAL=2");
  await expect(
    page.getByRole("heading", { name: "Daily reading", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Goal title", { exact: true })
    .fill("Daily reference reading");
  await dialog.getByLabel("Target quantity", { exact: true }).fill("45");
  await dialog
    .getByLabel("Rule takes effect on", { exact: true })
    .fill(addDays(data.studyDate, 1));
  await dialog
    .getByRole("button", { name: "Save goal rule", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("tab", { name: "Rule history", exact: true }).click();
  await expect(
    page.getByText(/Showing the latest configured rule/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByLabel("Rule takes effect on", { exact: true }),
  ).toHaveValue(addDays(data.studyDate, 1));
  await page.keyboard.press("Escape");
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  const id = saved.goals.find((goal) => goal.title === "Daily reading")!.id;
  const rules = (await (
    await page.request.get(`/api/v1/goals/${id}/rules`)
  ).json()) as GoalRuleVersion[];
  expect(rules.find((rule) => rule.version === 1)?.rules.targetQty).toBe(12);
  expect(rules.find((rule) => rule.version === 2)).toMatchObject({
    effectiveFrom: addDays(data.studyDate, 1),
    rules: { targetQty: 45, unit: "pages" },
  });
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Pause goal", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume goal", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume goal", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause goal", exact: true }),
  ).toBeVisible();
  await assertAccessible(page);
  await page.getByRole("button", { name: "Archive goal", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Archive goal", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("link", { name: "Profiles and goals", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: /Daily reference reading/ }),
  ).not.toBeVisible();
  await page
    .getByRole("checkbox", { name: "Show archived", exact: true })
    .check();
  await expect(
    page.getByRole("link", { name: /Daily reference reading/ }),
  ).toBeVisible();
});

test("resource outline, page ranges, prerequisites and keyboard tree edits persist", async ({
  page,
}, testInfo) => {
  const goals = await seedGoals(page);
  await page.getByRole("button", { name: "New resource", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Resource title", { exact: true })
    .fill("Systems reference");
  await chooseOption(dialog
    .getByLabel("Resource type", { exact: true }), "book");
  await dialog
    .getByRole("checkbox", { name: goals[0]!.title, exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Add resource", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("link", { name: "Systems reference", exact: true })
    .click();
  const resource = (await bootstrap(page)).resources.find(
    (item) => item.title === "Systems reference",
  )!;
  await page
    .getByRole("button", { name: "Paste outline", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Outline", { exact: true })
    .fill("Chapter One\n    Invalid indentation");
  await dialog
    .getByRole("button", { name: "Import outline", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByLabel("Outline", { exact: true })
    .fill("Chapter One\n  Foundations [20m]\n  Exercises [40m]\nChapter Two");
  await dialog
    .getByRole("button", { name: "Import outline", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".tree-item-title strong")).toHaveText([
    "Chapter One",
    "Foundations",
    "Exercises",
    "Chapter Two",
  ]);
  const list = async () => {
    const response = await page.request.get(
      `/api/v1/resources/${resource.id}/items`,
    );
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<ResourceItem[]>;
  };
  let items = await list();
  const chapter = items.find((item) => item.title === "Chapter One")!;
  const foundations = items.find((item) => item.title === "Foundations")!;
  expect(foundations).toMatchObject({
    parentItemId: chapter.id,
    estMinutes: 20,
    kind: "reading",
  });
  await page
    .getByRole("button", { name: "Edit Foundations", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Pages and media duration", { exact: true }).click();
  await dialog.getByLabel("First page", { exact: true }).fill("7");
  await dialog.getByLabel("Last page", { exact: true }).fill("18");
  await dialog.getByLabel("Estimated time (min)", { exact: true }).fill("25");
  await dialog
    .getByRole("checkbox", { name: "Exercises", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Edit Exercises", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: "Foundations", exact: true })
    .check();
  const failed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/resource-items/") &&
      response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "Save item", exact: true }).click();
  expect((await (await failed).json()).error.code).toBe("DEPENDENCY_CYCLE");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "Foundations", exact: true })
    .uncheck();
  await dialog.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Arrange items", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Arrange Chapter Two", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".toast")).toContainText(
    "nested under Chapter One",
  );
  items = await list();
  expect(items.find((item) => item.title === "Chapter Two")?.parentItemId).toBe(
    chapter.id,
  );
  await page
    .getByRole("button", { name: "Arrange Chapter Two", exact: true })
    .focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".toast")).toContainText("moved out one level");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Arrange items", exact: true }),
  ).toBeVisible();
  items = await list();
  expect(items.find((item) => item.id === foundations.id)).toMatchObject({
    pagesFrom: 7,
    pagesTo: 18,
    estMinutes: 25,
    dependsOn: [items.find((item) => item.title === "Exercises")!.id],
  });
  if (testInfo.project.name === "desktop") {
    await page
      .getByRole("button", { name: "Arrange items", exact: true })
      .click();
    const handle = page.getByRole("button", {
      name: "Arrange Chapter Two",
      exact: true,
    });
    const target = page.getByRole("button", {
      name: "Arrange Chapter One",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const end = (await target.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      start.x + start.width / 2 + 12,
      start.y + start.height / 2,
      { steps: 3 },
    );
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator(".toast")).toContainText(
      "Chapter Two moved before Chapter One",
    );
    await page
      .getByRole("button", { name: "Move Chapter Two later", exact: true })
      .click();
    await expect(page.locator(".tree-item-title strong")).toHaveText([
      "Chapter One",
      "Foundations",
      "Exercises",
      "Chapter Two",
    ]);
    await page
      .getByRole("button", { name: "Finish arranging", exact: true })
      .click();
  }
  await page.reload();
  await expect(page.locator(".tree-item-title strong")).toHaveText([
    "Chapter One",
    "Foundations",
    "Exercises",
    "Chapter Two",
  ]);
  await assertAccessible(page);
  await page
    .getByRole("button", { name: "Archive Chapter One", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByText("Foundations", { exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("checkbox", { name: "Show archived items", exact: true })
    .check();
  await expect(page.getByText("Foundations", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await page
    .getByRole("button", { name: "Dismiss message", exact: true })
    .click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await testInfo.attach("resource-tree", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("resource goal links, offline drafts and dark theme work", async ({
  page,
  context,
}) => {
  const goals = await seedGoals(page);
  await page.getByRole("button", { name: "New resource", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Resource title", { exact: true })
    .fill("Systems course");
  for (const goal of goals)
    await dialog
      .getByRole("checkbox", { name: goal.title, exact: true })
      .check();
  await dialog
    .getByRole("button", { name: "Add resource", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name: "Systems course", exact: true }).click();
  await expect(
    page.getByRole("link", { name: goals[0]!.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: goals[1]!.title, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit resource", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Resource title", { exact: true })
    .fill("Systems course and labs");
  await context.setOffline(true);
  await expect(
    dialog.getByRole("button", { name: "Save resource", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      "Reconnect to save this resource. Your changes stay in this form.",
      { exact: true },
    ),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    dialog.getByRole("button", { name: "Save resource", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Save resource", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Systems course and labs", exact: true }),
  ).toBeVisible();
  const resources = (await bootstrap(page)).resources;
  expect(resources[0]?.goalIds.sort()).toEqual(
    goals.map((goal) => goal.id).sort(),
  );
  await page
    .getByRole("button", { name: "Edit resource", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: goals[0]!.title, exact: true })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Save resource", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await bootstrap(page)).resources[0]?.goalIds).toEqual([goals[1]!.id]);
  await page
    .getByRole("button", { name: "Toggle light and dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertAccessible(page);
});
