import { expect, test, type Page } from "@playwright/test";
import type { Bootstrap } from "@kram/shared";
import { chooseOption } from "./helpers/select";

const testApi = process.env.E2E_API_URL || "http://127.0.0.1:8422";
const canonicalUrl = new URL(
  process.env.E2E_BASE_URL || "http://127.0.0.1:5174",
);
canonicalUrl.hostname = "127.0.0.1";
const canonicalOrigin = canonicalUrl.origin;
const localUrl = new URL(canonicalOrigin);
localUrl.hostname = "localhost";
const localOrigin = localUrl.origin;
const email = "local-access-owner@example.test";
const password = "local-access-synthetic-owner-42";

async function signIn(page: Page, origin: string) {
  await page.goto(origin);
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(submit).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) =>
        result.url() === `${origin}/api/v1/auth/login` &&
        result.request().method() === "POST",
    ),
    submit.click(),
  ]);
  expect((await response.request().allHeaders()).origin).toBe(origin);
  expect(response.status(), await response.text()).toBe(200);
  const headers = await response.allHeaders();
  expect(headers["set-cookie"]).toBeDefined();
  expect(headers["set-cookie"]).not.toMatch(/\bDomain=/i);
  await expect(
    page.getByRole("heading", { name: "Your tasks", exact: true }),
  ).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Owner account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make room your way", exact: true }),
  ).toBeVisible();
}

async function expectClockFormat(page: Page) {
  const control = page.getByLabel("Clock format", { exact: true });
  if (await control.evaluate((element) => element.tagName === "SELECT")) {
    await expect(control).toHaveValue("12");
  } else {
    await expect(control).toHaveAttribute("data-value", "12");
  }
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

test("localhost and the configured numeric address share data with separate browser sessions", async ({
  page,
  context,
  request,
}) => {
  // The request fixture has its own cookie jar: canonical setup must not sign
  // the browser into 127.0.0.1 before either browser login is exercised.
  const authResponse = await request.get(`${canonicalOrigin}/api/v1/auth/me`);
  expect(authResponse.ok()).toBeTruthy();
  const auth = await authResponse.json();
  const setup = await request.post(`${canonicalOrigin}/api/v1/auth/setup`, {
    headers: {
      Origin: canonicalOrigin,
      "X-CSRF-Token": auth.csrfToken,
    },
    data: {
      email,
      password,
      profileName: "Local access",
      timezone: "Asia/Kolkata",
      featurePreset: "planner",
    },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const ownerId = (await setup.json()).user.id;

  await signIn(page, localOrigin);
  const localSession = (await context.cookies(localOrigin)).find(
    (cookie) => cookie.name === "kram.sid",
  );
  expect(localSession).toBeDefined();
  expect(localSession!.domain).toBe("localhost");
  expect(localSession!.httpOnly).toBe(true);
  expect(localSession!.sameSite).toBe("Lax");
  expect(
    (await context.cookies(canonicalOrigin)).filter(
      (cookie) => cookie.name === "kram.sid",
    ),
  ).toHaveLength(0);

  await openSettings(page);
  await chooseOption(page.getByLabel("Clock format", { exact: true }), "12");
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${localOrigin}/api/v1/settings` &&
        response.request().method() === "PATCH",
    ),
    page.getByRole("button", { name: "Save settings", exact: true }).click(),
  ]);
  expect((await saved.request().allHeaders()).origin).toBe(localOrigin);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.locator(".toast").filter({ hasText: "Settings saved." })).toBeVisible();

  // A host-only localhost cookie must not authenticate this fresh numeric-host
  // page. Its successful login must still reveal the same persisted account.
  await signIn(page, canonicalOrigin);
  const numericSession = (await context.cookies(canonicalOrigin)).find(
    (cookie) => cookie.name === "kram.sid",
  );
  expect(numericSession).toBeDefined();
  expect(numericSession!.domain).toBe("127.0.0.1");
  expect(numericSession!.value).not.toBe(localSession!.value);
  const bootstrapResponse = await page.request.get(
    `${canonicalOrigin}/api/v1/bootstrap`,
  );
  expect(bootstrapResponse.ok()).toBeTruthy();
  const data = (await bootstrapResponse.json()) as Bootstrap;
  expect(data.user.id).toBe(ownerId);
  expect(data.user.settings.clockFormat).toBe("12");
  await openSettings(page);
  await expectClockFormat(page);

  // Revoking the numeric-host session must leave the localhost session usable.
  await page.getByRole("button", { name: "Owner account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies(localOrigin)).find(
      (cookie) => cookie.name === "kram.sid",
    )?.value,
  ).toBe(localSession!.value);
  await page.goto(localOrigin);
  await expect(
    page.getByRole("heading", { name: "Your tasks", exact: true }),
  ).toBeVisible();
  await openSettings(page);
  await expectClockFormat(page);
});
