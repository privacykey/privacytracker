import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectNoBlockingViolations, type KnownIssue } from "./helpers/axe";

/**
 * Blocking accessibility gate.
 *
 * Axe-core scans of the five highest-traffic surfaces: /welcome, the
 * onboarding import-matching step, /dashboard, the app detail page,
 * and the mobile navigation drawer. Serious/critical WCAG A/AA
 * violations fail CI (this file runs inside the `quality` job's
 * Playwright step like every other spec here).
 *
 * Known, already-tracked defects are suppressed
 * via per-surface allowlists in `helpers/axe.ts` style — each entry
 * names the fix that must delete it. Everything else is a regression
 * and fails immediately.
 *
 * Keyboard-only coverage lives in `onboarding-keyboard.spec.ts`; this
 * file is DOM/ARIA analysis only (axe cannot see that a plain
 * clickable <div> is interactive, which is exactly why both files
 * exist).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

// ---------------------------------------------------------------------------
// Known tracked issues — delete each entry in the same PR as its fix
// ---------------------------------------------------------------------------

/** Reason strings, shared so the entries stay greppable per fixing PR. */
const R_NAMES = "pending fix: accessible names / labels / structure";
const R_CONTRAST = "pending fix: colour-contrast sweep of secondary text/links";

const contrast = (match: string): KnownIssue => ({
  rule: "color-contrast",
  match,
  reason: R_CONTRAST,
});

/**
 * The unlabeled app-names textarea (a known, tracked defect) is NOT
 * listed here: axe's accessible-name computation accepts a placeholder,
 * so the `label` rule never fires on it. That defect is covered by
 * human review + the keyboard spec, not this gate.
 */
const KNOWN_ONBOARD: KnownIssue[] = [
  contrast("kbd-hint-link"),
  contrast("site-info-hint-link"),
];

/** Step 2 only — the violation exists while the import table is empty
 * (its hint <div> is the sole child of a role="list" container), so it
 * disappears by the match step once rows are committed. */
const KNOWN_ONBOARD_STEP2: KnownIssue[] = [
  ...KNOWN_ONBOARD,
  {
    rule: "aria-required-children",
    match: "imported-apps-table-rows",
    reason: R_NAMES,
  },
];

const KNOWN_WELCOME: KnownIssue[] = [
  // SiteInfoHint's floating pill links (Privacy policy / Legal / GitHub).
  contrast("site-info-hint-link"),
];

const KNOWN_DASHBOARD: KnownIssue[] = [
  contrast("site-info-hint-link"),
  contrast("task-list-card-attribution"),
  contrast("task-list-add-tray"),
  contrast("task-journey-detail-actions"),
  contrast("home-section-count"),
  contrast("home-layout-footer"),
  contrast("coachmark-"),
];

const KNOWN_APP_DETAIL: KnownIssue[] = [
  // Accordion header nests the InfoTooltip <button> inside a
  // role="button" element.
  { rule: "nested-interactive", match: "accordion-header", reason: R_NAMES },
  // Gate-found: the collapsed annotations sidebar is aria-hidden but
  // keeps focusable children in the tab order.
  { rule: "aria-hidden-focus", match: "annotations-sidebar", reason: R_NAMES },
  contrast("detail-a11y-chip"),
  contrast("detail-tab"),
  contrast("app-detail-footer-link"),
  contrast("kbd-hint-link"),
];

const KNOWN_MOBILE_NAV: KnownIssue[] = [
  // "Add Apps" link loses its accessible name in compact tiers (label
  // display:none, visible "+" aria-hidden).
  { rule: "link-name", match: "nav-add-apps", reason: R_NAMES },
  // Gate-found: the brand/home link is icon-only with no accessible
  // name at mobile width.
  { rule: "link-name", match: "nav-brand", reason: R_NAMES },
  contrast("nav-drawer-link"),
];

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Single ambiguous fixture so the matching step renders the candidate
 * list UI (the surface the candidate-row fix rebuilds). */
const NOTES_CANDIDATES = [
  {
    appleId: "111100000",
    name: "Notes",
    developer: "Random Notes Co",
    iconUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-other.png/100x100bb.jpg",
    url: "https://apps.apple.com/us/app/notes/id111100000",
    bundleId: "com.example.notes",
  },
  {
    appleId: "1110145109",
    name: "Notes",
    developer: "Apple",
    iconUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-apple.png/100x100bb.jpg",
    url: "https://apps.apple.com/us/app/notes/id1110145109",
    bundleId: "com.apple.mobilenotes",
  },
];

async function mockNotesSearch(page: Page) {
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: Array<{ name?: string }>;
    };
    const results = (body.rows ?? []).map((row) => {
      const query = (row.name ?? "").trim();
      const candidates =
        query === "Notes"
          ? NOTES_CANDIDATES.map((c) => ({ ...c, searchQuery: query }))
          : [];
      return { query, candidates };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results }),
    });
  });
}

/** Same wizard walk as onboard-import.spec.ts — see the `toPass` note
 * there for why the method click is polled. */
async function openWizardToTextEntry(page: Page) {
  await page.goto("/onboard?preview=fresh");
  await page.getByText("Other import options").click();
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manualCard.click();
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
}

/** Seed the canned demo apps (idempotent — re-seeding reports
 * "skipped" rows) and return Instagram's app id for the detail scan. */
async function seedCannedApps(request: APIRequestContext): Promise<string> {
  const seedRes = await request.post(
    "/api/dev/seed-sample-data?source=canned",
    {
      headers: sameOriginHeaders,
    }
  );
  await expect(seedRes).toBeOK();
  const seedBody = (await seedRes.json()) as {
    apps?: Array<{ id: string; name: string }>;
    results?: Array<{ id: string; name: string }>;
  };
  const seeded = seedBody.apps ?? seedBody.results ?? [];
  const instagram = seeded.find((s) => s.name === "Instagram");
  expect(
    instagram?.id,
    "expected the canned Instagram app to seed"
  ).toBeTruthy();
  return String(instagram?.id);
}

async function setDefaultFocus(request: APIRequestContext) {
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
}

// ---------------------------------------------------------------------------
// 1. /welcome — first-run splash + focus form
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /welcome has no blocking violations",
  async ({ page, request }) => {
    // Reset so welcome renders the first-run experience instead of
    // redirecting to a populated dashboard.
    const reset = await request.post("/api/reset", {
      headers: sameOriginHeaders,
    });
    await expect(reset).toBeOK();

    await page.goto("/welcome");
    await expect(page.locator(".focus-purpose-card").first()).toBeVisible();

    await expectNoBlockingViolations(page, "welcome", {
      knownIssues: KNOWN_WELCOME,
    });
  }
);

// ---------------------------------------------------------------------------
// 2. Onboarding import matching — text entry + candidate list
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: onboarding text-entry and match steps have no blocking violations",
  async ({ page, request }) => {
    // The welcome spec above resets the DB; without a stored focus the
    // wizard route bounces back to /welcome, so seed one first — same
    // invariant every wizard spec in this directory maintains.
    await setDefaultFocus(request);
    await mockNotesSearch(page);
    await openWizardToTextEntry(page);

    // Step 2 — the app-names textarea view.
    await expect(page.getByTestId("onboard-app-names")).toBeVisible();
    await expectNoBlockingViolations(page, "onboard-step2", {
      knownIssues: KNOWN_ONBOARD_STEP2,
    });

    // Step 3 — matched block with the candidate list expanded, so the
    // candidate rows (the surface awaiting native controls) are in
    // the scanned DOM.
    await page.getByTestId("onboard-app-names").fill("Notes");
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    const block = page
      .locator(".search-result-item")
      .filter({ hasText: "Notes" });
    await expect(block).toHaveCount(1);
    await block.locator(".show-more-btn").click();
    await expect(block.locator(".candidate-row").first()).toBeVisible();

    await expectNoBlockingViolations(page, "onboard-match", {
      knownIssues: KNOWN_ONBOARD,
    });
  }
);

// ---------------------------------------------------------------------------
// 3. /dashboard — home view with seeded apps
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /dashboard has no blocking violations",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    await page.goto("/dashboard");
    await expect(page.locator("main").first()).toBeVisible();

    await expectNoBlockingViolations(page, "dashboard", {
      knownIssues: KNOWN_DASHBOARD,
    });
  }
);

// ---------------------------------------------------------------------------
// 4. App detail — seeded Instagram
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: app detail has no blocking violations",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    const instagramId = await seedCannedApps(request);

    await page.goto(`/apps/${instagramId}`);
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");

    await expectNoBlockingViolations(page, "app-detail", {
      knownIssues: KNOWN_APP_DETAIL,
    });
  }
);

// ---------------------------------------------------------------------------
// 5. Mobile navigation — compact tier + open drawer
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: mobile nav drawer has no blocking violations",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/dashboard");
    await expect(page.locator("main").first()).toBeVisible();

    // Open the drawer so its links are in the scanned DOM alongside the
    // compact top bar (where the icon-only Add Apps link lives).
    const menuTrigger = page.locator(".nav-menu-trigger");
    await expect(menuTrigger).toBeVisible();
    await menuTrigger.click();

    // Scope the scan to the nav element (compact bar + drawer both live
    // inside `nav.nav`). Unscoped, this scan re-covers the dashboard
    // behind the drawer, whose TaskList renders state-dependently
    // (attribution/add-tray nodes appear or not per run) — the desktop
    // dashboard scan above already owns that surface deterministically.
    await expectNoBlockingViolations(page, "mobile-nav", {
      include: "nav.nav",
      knownIssues: KNOWN_MOBILE_NAV,
    });
  }
);
