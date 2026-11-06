import { test, expect, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  Bootstrap,
  Goal,
  ProgressEvent,
  Task,
  TimeSlot,
} from "@kram/shared";

const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
test.setTimeout(60000);

async function seed(page: Page, unit = "minutes") {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your account", exact: true }),
  ).toBeVisible();
  let auth = await (await page.request.get("/api/v1/auth/me")).json();
  const setup = await page.request.post("/api/v1/auth/setup", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: {
      email: "tasks-owner@example.test",
      password: "paper-timer-calendar-room",
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
  const data = await bootstrap(page);
  const skill = await page.request.post(
    "/api/v1/profiles/" + data.profiles[0]!.id + "/skills",
    {
      headers: { "X-CSRF-Token": auth.csrfToken },
      data: {
        name: "Systems",
        profileId: data.profiles[0]!.id,
        weeklyTargetMin: 300,
      },
    },
  );
  expect(skill.ok()).toBeTruthy();
  const skillData = await skill.json();
  const response = await page.request.post("/api/v1/goals", {
    headers: { "X-CSRF-Token": auth.csrfToken },
    data: {
      title: "Read the reference",
      skillId: skillData.id,
      type: "daily",
      unit,
      targetQty: unit.toLowerCase() === "minutes" ? 60 : 10,
      estMinutes: 60,
      startDate: data.studyDate,
      availableDays: [1, 2, 3, 4, 5, 6, 7],
    },
  });
  expect(response.ok()).toBeTruthy();
  const goal: Goal = await response.json();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your tasks", exact: true }),
  ).toBeVisible();
  return { csrf: auth.csrfToken as string, data: await bootstrap(page), goal };
}
async function bootstrap(page: Page): Promise<Bootstrap> {
  const response = await page.request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function createTask(
  page: Page,
  title = "Watch the systems lesson",
  quantity?: number,
) {
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task title", { exact: true }).fill(title);
  await dialog.getByLabel("Estimated time (min)", { exact: true }).fill("60");
  if (quantity !== undefined)
    await dialog
      .getByLabel("Quantity (pages)", { exact: true })
      .fill(String(quantity));
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const task = (await bootstrap(page)).tasks.find(
    (item) => item.title === title,
  )!;
  expect(task).toBeTruthy();
  await page
    .getByRole("button", { name: "Open task " + title, exact: true })
    .click();
  return task;
}
async function assertAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}
async function captureThemes(page: Page, testInfo: TestInfo, screen: string) {
  const dismiss = page.getByRole("button", {
    name: "Dismiss message",
    exact: true,
  });
  if (await dismiss.count()) await dismiss.click();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  for (const theme of ["light", "dark"]) {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme)
      await page
        .getByRole("button", {
          name: "Toggle light and dark theme",
          exact: true,
        })
        .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).not.toHaveClass(/theme-crossfade/);
    await assertAccessible(page);
    await page.screenshot({
      path: testInfo.outputPath(screen + "-" + theme + ".png"),
      fullPage: true,
      animations: "disabled",
    });
    if (testInfo.project.name === "phone") {
      if (screen === "history")
        await page.locator(".task-history").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(screen + "-" + theme + "-viewport.png"),
        animations: "disabled",
      });
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  }
  await page
    .getByRole("button", { name: "Toggle light and dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}
async function savedTask(page: Page, id: string): Promise<Task> {
  const response = await page.request.get("/api/v1/tasks/" + id);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
test.beforeEach(async ({ request }) => {
  const response = await request.post(testApi + "/api/v1/__test/reset", {
    headers: { "X-Kram-Test": "reset-isolated-db" },
  });
  expect(
    response.ok(),
    "Only the isolated fixture may reset its database.",
  ).toBeTruthy();
});

test("partial minutes, total completion, undo and scoped goal history remain accurate", async ({
  page,
}, testInfo) => {
  const { goal } = await seed(page);
  const task = await createTask(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Log progress", exact: true })
    .click();
  await dialog.getByLabel("Additional minutes", { exact: true }).fill("40");
  await dialog
    .getByLabel("Progress note (optional)", { exact: true })
    .fill("Stopped at the recap.");
  await dialog
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(
    dialog.getByText("20 min estimated remaining", { exact: true }),
  ).toBeVisible();
  expect(await savedTask(page, task.id)).toMatchObject({
    actualMinutes: 40,
    remainingMinutes: 20,
    status: "partial",
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    dialog.getByLabel("Total actual minutes", { exact: true }),
  ).toHaveValue("60");
  await dialog.getByLabel("Total actual minutes", { exact: true }).fill("55.5");
  await dialog
    .getByRole("button", { name: "Complete task", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Undo completion", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("55.5 min logged", { exact: false }),
  ).toBeVisible();
  expect(await savedTask(page, task.id)).toMatchObject({
    actualMinutes: 55.5,
    remainingMinutes: 0,
    status: "completed",
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    dialog.getByText("20 min estimated remaining", { exact: true }),
  ).toBeVisible();
  expect(await savedTask(page, task.id)).toMatchObject({
    actualMinutes: 40,
    remainingMinutes: 20,
    status: "partial",
  });
  await dialog.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    dialog.getByText("completed · corrected", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Completion total: 55.5 min", { exact: true }),
  ).toBeVisible();
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await captureThemes(page, testInfo, "today");
  await page.goto("/tasks/" + task.id);
  await expect(
    page.getByRole("button", { name: "Log progress", exact: true }),
  ).toBeVisible();
  await captureThemes(page, testInfo, "task");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    page.getByText("completed · corrected", { exact: true }),
  ).toBeVisible();
  await captureThemes(page, testInfo, "history");
  await page.goto("/goals/" + goal.id);
  await expect(
    page.getByText("Lifetime logged progress in minutes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Watch the systems lesson/ }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    page.getByText("Stopped at the recap.", { exact: true }),
  ).toBeVisible();
});

test("a persisted timer survives pause, resume and reload without crediting unlogged time", async ({
  page,
}) => {
  await seed(page);
  const task = await createTask(page);
  const dialog = page.getByRole("dialog");
  await page.clock.install();
  await dialog
    .getByRole("button", { name: "Start timer", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Pause timer", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(2500);
  await expect(dialog.locator(".timer-number")).not.toHaveText("00:00");
  await dialog
    .getByRole("button", { name: "Pause timer", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Resume timer", exact: true }),
  ).toBeVisible();
  const paused = await savedTask(page, task.id);
  expect(paused.timerAccumulatedMinutes).toBeGreaterThan(0);
  expect(paused.actualMinutes).toBe(0);
  await dialog
    .getByRole("button", { name: "Resume timer", exact: true })
    .click();
  await page.goto("/tasks/" + task.id);
  await expect(
    page.getByRole("button", { name: "Pause timer", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Pause timer", exact: true }),
  ).toBeVisible();
  expect((await savedTask(page, task.id)).timerStartedAt).not.toBeNull();
  await assertAccessible(page);
});

test("an uncertain response retries the same event and adds progress once", async ({
  page,
}) => {
  await seed(page);
  const task = await createTask(page);
  const dialog = page.getByRole("dialog");
  const ids: string[] = [];
  await page.route("**/api/v1/tasks/" + task.id + "/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().clientEventId);
    expect(route.request().headers()["idempotency-key"]).toBe(
      ids[ids.length - 1],
    );
    if (ids.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Log progress", exact: true })
    .click();
  await dialog.getByLabel("Additional minutes", { exact: true }).fill("40");
  await dialog
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Retry same event", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Retry same event", exact: true })
    .click();
  await expect(
    dialog.getByText("20 min estimated remaining", { exact: true }),
  ).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  const events: ProgressEvent[] = await (
    await page.request.get("/api/v1/tasks/" + task.id + "/events")
  ).json();
  expect(events.filter((event) => event.kind === "progress")).toHaveLength(1);
  expect((await savedTask(page, task.id)).actualMinutes).toBe(40);
});

test("count quantities, defer, skip and cancel preserve distinct meanings", async ({
  page,
}) => {
  const { data } = await seed(page, "pages");
  const task = await createTask(page, "Read ten pages", 10);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Log progress", exact: true })
    .click();
  await dialog.getByLabel("Additional minutes", { exact: true }).fill("40");
  await dialog.getByLabel("Additional pages", { exact: true }).fill("4");
  await dialog
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(
    dialog.getByText("36 min estimated remaining", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Defer", exact: true }).click();
  const future = new Date(data.studyDate + "T12:00:00Z");
  future.setUTCDate(future.getUTCDate() + 2);
  const date = future.toISOString().slice(0, 10);
  await dialog.getByLabel("Defer until", { exact: true }).fill(date);
  await dialog.getByRole("button", { name: "Defer task", exact: true }).click();
  await expect
    .poll(() => savedTask(page, task.id))
    .toMatchObject({
      status: "deferred",
      deferredToDate: date,
      actualMinutes: 40,
      completedQty: 4,
    });
  await expect(
    dialog.getByRole("button", { name: "Skip", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const skippedTask = await createTask(page, "Skip an optional occurrence", 10);
  await dialog.getByRole("button", { name: "Skip", exact: true }).click();
  await dialog
    .getByLabel("Reason (optional)", { exact: true })
    .fill("This occurrence is no longer useful.");
  await dialog
    .getByRole("button", { name: "Skip occurrence", exact: true })
    .click();
  await expect
    .poll(async () => (await savedTask(page, skippedTask.id)).status)
    .toBe("skipped");
  await page.keyboard.press("Escape");
  const other = await createTask(page, "An optional exercise", 10);
  await dialog
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Cancel An optional exercise?",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  await expect
    .poll(async () => (await savedTask(page, other.id)).status)
    .toBe("cancelled");
  await assertAccessible(page);
});

async function addBlock(
  page: Page,
  title: string,
  start: string,
  end: string,
  layer = "flexible",
) {
  await page
    .getByRole("button", { name: "Add time block", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Block title", { exact: true }).fill(title);
  await dialog.getByLabel("Starts at", { exact: true }).fill(start);
  await dialog.getByLabel("Ends at", { exact: true }).fill(end);
  await dialog.getByLabel("Block kind", { exact: true }).selectOption(layer);
  return dialog;
}
test("timetable names conflicts, protects fixed changes and recovers a stale draft", async ({
  page,
}) => {
  const { csrf } = await seed(page);
  await page.goto("/plan");
  let dialog = await addBlock(page, "Breakfast", "07:00", "08:00", "fixed");
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  dialog = await addBlock(page, "Focused reading", "07:30", "08:30");
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(
    dialog.getByRole("list", { name: "Conflicting time blocks", exact: true }),
  ).toContainText("Breakfast");
  await expect(
    dialog.getByRole("list", { name: "Conflicting time blocks", exact: true }),
  ).toContainText("07:00–08:00");
  await expect(page.locator(".timeline-conflict")).toHaveCount(1);
  await dialog.getByLabel("Starts at", { exact: true }).fill("08:00");
  await dialog.getByLabel("Ends at", { exact: true }).fill("09:00");
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Edit block Breakfast", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Ends at", { exact: true })
    .fill("07:30");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save time block", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Change Breakfast?", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Change Breakfast?", exact: true })
    .getByRole("button", { name: "Apply fixed change", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const slots: TimeSlot[] = (await bootstrap(page)).slots;
  const reading = slots.find((slot) => slot.title === "Focused reading")!;
  await page
    .getByRole("button", { name: "Edit block Focused reading", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Block title", { exact: true })
    .fill("My retained draft");
  const updated = await page.request.patch(
    "/api/v1/timetable/slots/" + reading.id,
    {
      headers: {
        "X-CSRF-Token": csrf,
        "If-Match": '"' + reading.version + '"',
      },
      data: { title: "Changed elsewhere" },
    },
  );
  expect(updated.ok()).toBeTruthy();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save time block", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reload latest version", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Block title", { exact: true }),
  ).toHaveValue("My retained draft");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save time block", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Edit block My retained draft",
      exact: true,
    }),
  ).toBeVisible();
  await assertAccessible(page);
  await page
    .getByRole("button", {
      name: "Remove block My retained draft",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Remove My retained draft?", exact: true })
    .getByRole("button", { name: "Remove block", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Edit block My retained draft",
      exact: true,
    }),
  ).not.toBeVisible();
});

test("reserved overlaps count once, reminders edit and pause, and command search is accessible", async ({
  page,
}, testInfo) => {
  const { data } = await seed(page);
  await page.goto("/plan");
  let dialog = await addBlock(
    page,
    "Systems window",
    "10:00",
    "12:00",
    "reserved",
  );
  await dialog
    .getByText("Link a profile, skill or goal", { exact: true })
    .click();
  await dialog
    .getByLabel("Reserved skill", { exact: true })
    .selectOption(data.skills[0]!.id);
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  dialog = await addBlock(page, "Inside the window", "10:30", "11:00");
  await dialog
    .getByText("Link a profile, skill or goal", { exact: true })
    .click();
  await dialog
    .getByLabel("Skill (optional)", { exact: true })
    .selectOption(data.skills[0]!.id);
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("2 blocks · 2 h allocated", { exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByText("14 h free between waking and sleep", { exact: true }),
  ).toBeVisible();
  await page.goto("/notifications");
  await expect(
    page.getByRole("button", { name: "Send test", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Background delivery service has not reported yet/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Local reminder time", { exact: true }).fill("18:15");
  await dialog
    .getByRole("button", { name: "Save reminder", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("At 18:15, once", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Local reminder time", { exact: true })
    .fill("18:30");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save reminder", exact: true })
    .click();
  await expect(page.getByText("At 18:30, once", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused · ntfy", { exact: true })).toBeVisible();
  await captureThemes(page, testInfo, "notifications");
  await page.keyboard.press("Control+k");
  await page
    .getByRole("dialog")
    .getByLabel("Search or choose an action", { exact: true })
    .fill("rdref");
  await expect(
    page.getByRole("button", { name: "Read the reference Goal", exact: true }),
  ).toBeVisible();
  await assertAccessible(page);
  await page
    .getByRole("button", { name: "Read the reference Goal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Read the reference", exact: true }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Make room your way", exact: true }),
  ).toBeVisible();
  await captureThemes(page, testInfo, "settings");
});

test("task shortcuts or touch swipes, pointer time moves, and large text stay usable", async ({
  page,
}, testInfo) => {
  await seed(page);
  const task = await createTask(page, "A small focused step");
  await page.keyboard.press("Escape");
  const title = page.getByRole("button", {
    name: "Open task A small focused step",
    exact: true,
  });
  await title.scrollIntoViewIfNeeded();
  if (testInfo.project.name === "phone") {
    const box = await title.boundingBox();
    expect(box).not.toBeNull();
    const session = await page.context().newCDPSession(page);
    const x = box!.x + 12;
    const y = box!.y + Math.min(20, box!.height / 2);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 100, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
    await expect(
      page.getByRole("heading", { name: "Confirm completion", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    await title.focus();
    await page.keyboard.press("s");
    await expect
      .poll(async () => (await savedTask(page, task.id)).timerStartedAt)
      .not.toBeNull();
    await page.keyboard.press("s");
    await expect
      .poll(async () => (await savedTask(page, task.id)).timerStartedAt)
      .toBeNull();
    await page.keyboard.press("d");
    await expect(
      page.getByRole("heading", { name: "Confirm completion", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.goto("/plan");
  const dialog = await addBlock(page, "A movable block", "09:00", "10:00");
  await dialog
    .getByRole("button", { name: "Place time block", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const handle = page.getByRole("button", {
    name: "Move A movable block",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2,
    box!.y + box!.height / 2 + 44,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await bootstrap(page)).slots.find(
          (slot) => slot.title === "A movable block",
        )?.startMin,
    )
    .toBe(555);
  await page.screenshot({
    path: testInfo.outputPath("timetable.png"),
    fullPage: true,
  });
  await captureThemes(page, testInfo, "timetable");
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(
    page.getByRole("button", {
      name: "Edit block A movable block",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Edit block A movable block", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Starts at", { exact: true }),
  ).toHaveValue("09:15");
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await page.goto("/tasks/" + task.id);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(
    page.getByRole("heading", { name: "A small focused step", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await assertAccessible(page);
});

test("complete paginated history restores an undone completion by append order", async ({
  page,
}) => {
  const { csrf } = await seed(page, "Minutes");
  const task = await createTask(page, "A long recorded session");
  await page.keyboard.press("Escape");
  const append = async (kind: string, extra: Record<string, unknown> = {}) => {
    const clientEventId = crypto.randomUUID();
    const response = await page.request.post(
      "/api/v1/tasks/" + task.id + "/events",
      {
        headers: { "X-CSRF-Token": csrf, "Idempotency-Key": clientEventId },
        data: {
          clientEventId,
          kind,
          occurredAt: new Date().toISOString(),
          ...extra,
        },
      },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json() as Promise<{ task: Task; event: ProgressEvent }>;
  };
  for (let pair = 0; pair < 26; pair++) {
    await append(pair ? "resumed" : "started");
    await append("paused");
  }
  const completion = await append("completed", {
    minutes: 60,
    qty: 60,
    occurredAt: new Date(Date.now() - 20 * 60000).toISOString(),
  });
  const undo = await append("correction", {
    referenceEventId: completion.event.id,
  });
  await append("correction", { referenceEventId: undo.event.id });
  expect((await savedTask(page, task.id)).status).toBe("completed");
  let pages = 0;
  await page.route(
    "**/api/v1/tasks/" + task.id + "/events?**",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set("limit", "20");
      const response = await route.fetch({ url: url.toString() });
      pages++;
      await route.fulfill({ response });
    },
  );
  await page.goto("/tasks/" + task.id);
  await expect(
    page.getByRole("button", { name: "Undo completion", exact: true }),
  ).toBeVisible();
  expect(pages).toBeGreaterThan(1);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.locator(".task-history > li")).toHaveCount(55);
  await expect(page.getByText("completed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("correction · corrected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Completion total: 1 h", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Undo completion", exact: true })
    .click();
  await expect
    .poll(async () => (await savedTask(page, task.id)).status)
    .toBe("in_progress");
});
