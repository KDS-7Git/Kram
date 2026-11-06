import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { defaultSettings, type Bootstrap, type Notification } from "@kram/shared";
import { settleAppearance } from "./helpers/appearance";

test.use({ serviceWorkers: "block" });

async function mockNotifications(page: Page, theme: "light" | "dark") {
  const date = "2026-11-06";
  await page.clock.setFixedTime(new Date(`${date}T12:00:00Z`));
  const user = { id: "00000000-0000-4000-8000-000000000001", email: "notification-layout-fixture@kram.test", settings: { ...defaultSettings, timezone: "UTC", featurePreset: "full" as const, theme } };
  const bootstrap: Bootstrap = { user, profiles: [], skills: [], goals: [], tasks: [], resources: [], resourceItems: [], slots: [], plans: [], streaks: [], notifications: [], reviews: [], studyDate: date };
  const message = (id: string, title: string, scheduledFor: string, patch: Partial<Notification> = {}): Notification => ({ id, title, scheduledFor, type: "task_reminder", channel: "ntfy", body: "Open Kram to review your work.", status: "pending", attempts: [], ...patch });
  const notifications = [
    message("later", "Later reminder", "2026-11-08T18:00:00Z"),
    message("due", "Due message", "2026-11-06T11:30:00Z"),
    message("accepted", "Provider accepted", "2026-11-06T10:00:00Z", { status: "sent", attempts: [{ id: "accepted-attempt", attemptedAt: "2026-11-06T11:59:00Z", outcome: "accepted", httpStatus: 200 }] }),
    message("tomorrow", "Tomorrow reminder", "2026-11-07T18:00:00Z"),
    message("retry", "Retry message", "2026-11-06T09:00:00Z", { attempts: [{ id: "failed-attempt", attemptedAt: "2026-11-06T11:00:00Z", outcome: "failed", httpStatus: 503 }] }),
  ];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const response = path === "/auth/me" ? { user, csrfToken: "mock-notification-csrf", setupRequired: false, defaults: defaultSettings }
      : path === "/bootstrap" ? bootstrap
      : path === "/notifications" ? notifications
      : path === "/notifications/status" ? { configured: true, errorCode: null, topic: "private-topic", baseUrl: "https://ntfy.example.test/notify/", lastSentAt: "2026-11-06T11:59:00Z", workerHeartbeat: "2026-11-06T11:59:30Z" }
      : path === "/channels" ? [{ id: "ntfy", configured: true, linked: true, enabled: true, privacy: true, lastSentAt: "2026-11-06T11:59:00Z" }, { id: "telegram", configured: false, linked: false, enabled: false, privacy: true, lastSentAt: null }]
      : path === "/notification-routes" ? { defaults: {}, routes: [] }
      : [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
}

async function accessible(page: Page) {
  await settleAppearance(page);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  test(`notification history distinguishes scheduled, awaiting and accepted messages in ${theme}`, async ({ page }) => {
    await mockNotifications(page, theme);
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Delivery history", exact: true })).toBeVisible();
    await expect(page.locator(".channel-address")).toHaveText("https://ntfy.example.test/notify/private-topic");
    const history = page.locator(".notification-deliveries > .notification-history");
    await expect(history.locator(".notification-entry-header > strong")).toHaveText(["Provider accepted", "Due message", "Retry message"]);
    await expect(history.getByText("Awaiting delivery", { exact: true })).toBeVisible();
    await expect(history.getByText("Awaiting retry", { exact: true })).toBeVisible();
    await expect(history.getByText("Accepted by channel · ntfy", { exact: true })).toBeVisible();
    await expect(history.getByText("ntfy accepted this message. Arrival on your device is not confirmed here.", { exact: true })).toBeVisible();
    const upcoming = page.locator(".notification-upcoming");
    await expect(upcoming).not.toHaveAttribute("open", "");
    await expect(upcoming.locator("summary")).toHaveText("Upcoming reminders (2)");
    await expect(page.getByText("Tomorrow reminder", { exact: true })).not.toBeVisible();
    await upcoming.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(upcoming.locator(".notification-entry-header > strong")).toHaveText(["Tomorrow reminder", "Later reminder"]);
    await expect(upcoming.getByText("Scheduled", { exact: true })).toHaveCount(2);
    await history.getByText("1 delivery attempt", { exact: true }).first().click();
    await expect(history.getByText(/Accepted by ntfy · HTTP 200/)).toBeVisible();
    await accessible(page);
  });

  test(`notification channels keep a consistent card width and readable controls in ${theme}`, async ({ page }) => {
    await mockNotifications(page, theme);
    await page.goto("/channels");
    const cards = page.locator(".channel-grid > .channel-preference");
    await expect(cards).toHaveCount(2);
    const widths = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1);
    for (const card of await cards.all()) {
      const control = card.getByRole("button", { name: "Send test", exact: true });
      const size = await control.boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(44);
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await expect(page.getByText("Kram reminder", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No accepted messages yet.", { exact: true })).toBeVisible();
    await expect(page.getByText("Accepted means the provider received a message; check your receiving device to confirm arrival.", { exact: true })).toBeVisible();
    await accessible(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.evaluate(() => document.documentElement.style.fontSize = "32px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(cards.first().getByRole("link", { name: "Topic and delivery history", exact: true })).toBeVisible();
    await page.getByText("Link Telegram", { exact: true }).click();
    await expect(page.getByLabel("Bot token", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
