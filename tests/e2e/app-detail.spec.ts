import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the app detail page (`/apps/[id]`). Verifies that a
 * freshly-seeded app renders its privacy labels, snapshot timeline,
 * and profile-mismatch indicators correctly.
 *
 * The spec uses `/api/dev/seed-sample-data?source=canned` to populate
 * the DB with the offline canned sample apps (Instagram, Spotify,
 * Gmail, Notes, Calendar, Weather). Canned mode is deterministic and
 * doesn't hit Apple's iTunes Search — perfect for E2E. The canned
 * fixture writes canonical privacy-type identifiers
 * (`DATA_USED_TO_TRACK_YOU` / `DATA_LINKED_TO_YOU` /
 * `DATA_NOT_LINKED_TO_YOU`) and canonical CATEGORY_META category keys
 * (`CONTACT_INFO`, `LOCATION`, …) so the profile-mismatch logic
 * (`TYPE_IDENTIFIER_TO_TIER` × `profile[categoryKey]`) joins correctly
 * and surfaces the same mismatch badges a real scraped app would.
 *
 * The Strict privacy profile is set first so that mismatch badges
 * surface on apps like Instagram (which collects identifiers, location,
 * and contact info as third-party tracking data).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

interface SeedResult {
  id: string;
  name: string;
  source: "canned" | "live";
  status: "inserted" | "skipped" | "error";
}

test.beforeEach(async ({ request }) => {
  // Reset apps + settings so each spec starts from a known state.
  // The reset endpoint rate-limits at 3 per 10 minutes — fine for the
  // single-spec count in this file.
  const resetRes = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(resetRes).toBeOK();

  // Reset wipes app_settings, so set focus + the privacy profile AFTER
  // the reset. Strict guarantees plenty of mismatches against the
  // canned Instagram fixture.
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Use the Strict preset's tier map so the profile is unambiguous and
  // matches what the unit / E2E preset specs already assume. Sets every
  // category to its strictest tolerable tier so collected categories
  // light up as mismatches.
  const profile = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: {
      profile: {
        CONTACT_INFO: "not_linked",
        HEALTH_AND_FITNESS: "not_collected",
        FINANCIAL_INFO: "not_linked",
        LOCATION: "not_collected",
        SENSITIVE_INFO: "not_collected",
        CONTACTS: "not_collected",
        USER_CONTENT: "not_linked",
        BROWSING_HISTORY: "not_collected",
        SEARCH_HISTORY: "not_linked",
        IDENTIFIERS: "not_linked",
        PURCHASES: "not_linked",
        USAGE_DATA: "not_linked",
        DIAGNOSTICS: "not_linked",
        OTHER: "not_collected",
      },
    },
  });
  await expect(profile).toBeOK();
});

browserFlow(
  "app detail: seeded sample app renders hero, categories, timeline, and mismatch flags",
  async ({ page, request }) => {
    // Seed offline canned sample apps. Returns a list of SeedAppResult
    // objects we can pick from to choose a stable app to navigate to.
    const seedRes = await request.post(
      "/api/dev/seed-sample-data?source=canned",
      { headers: sameOriginHeaders }
    );
    await expect(seedRes).toBeOK();
    const seedBody = (await seedRes.json()) as {
      apps?: SeedResult[];
      results?: SeedResult[];
    };
    // The endpoint historically used `results` but newer revisions wrap
    // it as `apps`; handle both shapes so the spec doesn't break on a
    // shape rename in the seeding path.
    const seeded = seedBody.apps ?? seedBody.results ?? [];
    const instagram = seeded.find((s) => s.name === "Instagram");
    expect(
      instagram,
      "expected Instagram to land in the seeded apps"
    ).toBeDefined();
    expect(
      instagram?.id,
      "seed result must include the synthetic app id"
    ).toBeTruthy();

    await page.goto(`/apps/${instagram!.id}`);

    // Hero: app name h1.
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");

    // Privacy labels: at least one category card per Instagram fixture
    // tier (tracking + linked + not-linked = three privacy_types). Each
    // privacy_type renders multiple category cards underneath; we only
    // assert at least one card exists rather than counting them, because
    // the canned fixture is allowed to evolve without breaking the spec.
    await expect(page.locator(".category-card").first()).toBeVisible();

    // At least one category should be flagged as a mismatch. Instagram
    // collects identifiers / location / contact info as third-party
    // tracking data; the Strict profile doesn't tolerate any of those at
    // 'tracking', so the mismatch badge MUST surface for at least one of
    // them. Asserting "at least one" rather than a specific category
    // means a fixture tweak (e.g. dropping a category from the canned
    // Instagram fixture) doesn't break the spec.
    await expect(page.locator(".category-card-mismatch").first()).toBeVisible();

    // Timeline lives behind the Changelog tab — click it to activate
    // the panel before asserting. The canned seed writes a baseline
    // snapshot plus 1–2 back-dated history rows, so at least one
    // .timeline-item should render once the tab is active.
    await page.locator("#tab-changelog").click();
    await expect(page.locator(".timeline-item").first()).toBeVisible();
  }
);
