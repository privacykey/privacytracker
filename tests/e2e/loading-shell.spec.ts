import { expect, type Page, test } from "@playwright/test";

/**
 * A slow server must not mean a blank page.
 *
 * AppChrome holds the flag-gated chrome until the flag bundle settles, and
 * each page loader holds its view until its reads land. With every /api
 * call taking a few seconds that used to leave the page empty, with no nav
 * and no text, for the whole wait. Now a neutral shell paints straight
 * away: the skip link, a nav skeleton (brand only, no flag-gated links) on
 * routes that have a nav, and an `aria-busy` page skeleton. The device
 * scope read also starts alongside the flag read instead of after it.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const API_DELAY_MS = 2500;

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

/** Delay every /api call, recording when each path was requested and answered. */
async function slowApi(page: Page) {
  const timings = new Map<string, { requested: number; answered?: number }>();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const entry = { requested: Date.now() } as {
      requested: number;
      answered?: number;
    };
    if (!timings.has(path)) {
      timings.set(path, entry);
    }
    await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
    await route.continue().catch(() => {
      /* page navigated away */
    });
    entry.answered = Date.now();
  });
  return timings;
}

browserFlow(
  "dashboard paints the nav and page skeletons before any data arrives",
  async ({ page }) => {
    const timings = await slowApi(page);
    await page.goto("/dashboard", { waitUntil: "commit" });

    // Well inside the first API round trip, the shell is up.
    const navSkeleton = page.getByTestId("nav-skeleton");
    const pageSkeleton = page.getByTestId("page-skeleton");
    await expect(navSkeleton).toBeVisible({ timeout: API_DELAY_MS - 500 });
    await expect(pageSkeleton).toBeVisible();
    await expect(pageSkeleton).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".skip-link")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);

    // The skeleton names nothing a flag decides: brand link only.
    await expect(navSkeleton.getByRole("link")).toHaveCount(1);
    await expect(navSkeleton.locator(".nav-link")).toHaveCount(0);

    // The device scope read runs alongside the flag read, not after it.
    await expect
      .poll(() => timings.get("/api/device-scope")?.requested ?? null)
      .not.toBeNull();
    const flags = timings.get("/api/feature-flags");
    const scope = timings.get("/api/device-scope");
    expect(flags).toBeDefined();
    expect(scope?.requested ?? Number.POSITIVE_INFINITY).toBeLessThan(
      flags?.answered ?? Number.POSITIVE_INFINITY
    );

    // Then the real dashboard replaces the shell.
    await expect(page.locator(".home-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("nav.nav .nav-link").first()).toBeVisible();
    await expect(navSkeleton).toHaveCount(0);
    await expect(pageSkeleton).toHaveCount(0);
  }
);

browserFlow(
  "apps grid shows the skeleton while its reads are in flight",
  async ({ page }) => {
    await slowApi(page);
    await page.goto("/dashboard/apps", { waitUntil: "commit" });
    await expect(page.getByTestId("page-skeleton")).toBeVisible({
      timeout: API_DELAY_MS - 500,
    });
    await expect(page.locator(".app-card").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("page-skeleton")).toHaveCount(0);
  }
);

browserFlow(
  "a route without a nav gets the page skeleton and no nav skeleton",
  async ({ page }) => {
    await slowApi(page);
    await page.goto("/welcome", { waitUntil: "commit" });
    await expect(page.getByTestId("page-skeleton")).toBeVisible({
      timeout: API_DELAY_MS - 500,
    });
    await expect(page.getByTestId("nav-skeleton")).toHaveCount(0);
  }
);
