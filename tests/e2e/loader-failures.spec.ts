import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * A failed read is not an empty install.
 *
 * The page loaders that send an empty install to onboarding used to map
 * any non-OK response to "no apps": a 500 on the first grid read sent a
 * user with ten apps to "Add the apps from your iPhone". Each loader now
 * keeps a failed read distinct from `{ total: 0 }`, shows "This page
 * couldn't load its data" with Try again, and only bounces when a read
 * SUCCEEDS with nothing in it.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
});

/**
 * Fail the first `times` requests matching `match` with a 500, then let
 * the rest through. Returns a counter of the failures served.
 */
async function failFirst(
  page: Page,
  match: (url: URL) => boolean,
  times = 1
): Promise<{ failed: number }> {
  const counter = { failed: 0 };
  await page.route(
    (url) => match(url),
    async (route: Route) => {
      if (route.request().method() === "GET" && counter.failed < times) {
        counter.failed++;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Simulated internal error" }),
        });
        return;
      }
      await route.continue();
    }
  );
  return counter;
}

async function expectRetryableError(page: Page, path: RegExp) {
  const error = page.getByTestId("loader-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("This page couldn't load its data.");
  await expect(page).toHaveURL(path);
  await expect(
    page.getByRole("heading", { name: /Add the apps from your/ })
  ).toHaveCount(0);
}

browserFlow(
  "apps grid: a failed first read shows Try again instead of onboarding",
  async ({ page }) => {
    const counter = await failFirst(
      page,
      (url) =>
        url.pathname === "/api/apps" && url.searchParams.get("meta") === "grid"
    );
    await page.goto("/dashboard/apps");
    await expectRetryableError(page, /\/dashboard\/apps$/);
    expect(counter.failed).toBe(1);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".app-card").first()).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/apps$/);
  }
);

browserFlow(
  "apps gate (Settings): a failed app count shows Try again instead of onboarding",
  async ({ page }) => {
    await failFirst(
      page,
      (url) =>
        url.pathname === "/api/apps" && url.searchParams.get("limit") === "1"
    );
    await page.goto("/dashboard/settings/you");
    await expectRetryableError(page, /\/dashboard\/settings\/you$/);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("loader-error")).toHaveCount(0);
    await expect(page.locator(".settings-section").first()).toBeVisible();
  }
);

browserFlow(
  "review queue: a failed read shows Try again instead of onboarding",
  async ({ page }) => {
    await failFirst(page, (url) => url.pathname === "/api/review-queue");
    await page.goto("/dashboard/review-recommendations");
    await expectRetryableError(page, /\/dashboard\/review-recommendations$/);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("loader-error")).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard\/review-recommendations$/);
  }
);

browserFlow(
  "root: a failed app count goes to the dashboard, not the welcome page",
  async ({ page }) => {
    await failFirst(
      page,
      (url) =>
        url.pathname === "/api/apps" && url.searchParams.get("limit") === "1"
    );
    await page.goto("/");
    await page.waitForURL(/\/dashboard$/);
    await expect(page.locator(".home-page")).toBeVisible();
  }
);

browserFlow(
  "a read that succeeds with nothing in it still goes to onboarding",
  async ({ page, request }) => {
    const reset = await request.post("/api/reset", {
      headers: sameOriginHeaders,
    });
    await expect(reset).toBeOK();
    const focus = await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: {
        audience: "self",
        monitor: true,
        cleanup: false,
        minimal: false,
        accessibility: false,
      },
    });
    await expect(focus).toBeOK();

    await page.goto("/dashboard/apps");
    await page.waitForURL(/\/onboard$/);
  }
);
