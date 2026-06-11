import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the Stats page at `/dashboard/stats`. The page is
 * server-rendered and redirects to `/onboard` when `totalApps === 0`,
 * so seeding canned apps is mandatory before navigating.
 *
 * `flag.page.stats` defaults to 'on' for the `self` audience, so we
 * don't need to elevate focus beyond the standard seed.
 *
 * We assert two things:
 *   1. The summary cards (`.stat-cards`) render with the right
 *      numeric value reflecting the seeded app count.
 *   2. At least one chart panel (`.glass-card.stats-panel`) is
 *      visible — proving the heavier viz components didn't error out
 *      under the canned data shape.
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
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // The canned seeder ignores the `limit` query param — it always
  // inserts all of SAMPLE_APPS (currently 10). Other specs pass a
  // limit anyway because the contract suggests it should work, but
  // we don't rely on it here; we read the actual count back from
  // `/api/apps` and assert the stats card reports that exact number.
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
});

browserFlow(
  "stats page: seeded canned apps render summary cards and chart panels",
  async ({ page, request }) => {
    // Read the actual app count the DB landed on. /api/apps returns the
    // rows flat (not wrapped). Asserting against this rather than a
    // hard-coded number means a future change to SAMPLE_APPS or the
    // canned seeder doesn't break the spec — we just want to prove
    // the stats page reports what's actually in the DB.
    const appsRes = await request.get("/api/apps");
    await expect(appsRes).toBeOK();
    const apps = (await appsRes.json()) as Array<{ id: string }>;
    expect(apps.length).toBeGreaterThan(0);

    await page.goto("/dashboard/stats");

    // The summary card row at the top of the page is the most stable
    // anchor — it renders one .stat-card-value per metric (total apps,
    // total categories, apps with changes, stale apps).
    const cards = page.locator(".stat-cards");
    await expect(cards).toBeVisible();

    // First card reads `stats.totalApps`; verify it matches the count
    // we just read from the API.
    const firstValue = page.locator(".stat-card-value").first();
    await expect(firstValue).toHaveText(String(apps.length));

    // At least one chart panel renders. We use `.first()` rather than
    // counting because every panel is independently flag-gated and a
    // future flag flip shouldn't break this spec — we just want to
    // prove at least one visualisation lit up.
    await expect(page.locator(".glass-card.stats-panel").first()).toBeVisible();
  }
);
