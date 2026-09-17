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
 * Axe-core scans of the highest-traffic surfaces: /welcome, the
 * onboarding import-matching step, /dashboard, the app detail page,
 * the mobile navigation drawer, and the Stats and Privacy Map pages.
 * Serious/critical WCAG 2.2 A/AA violations, target size included,
 * fail CI (this file runs inside
 * the `quality` job's Playwright step like every other spec here).
 *
 * Most scans run in light mode only. Stats and Privacy Map are also
 * scanned in dark and high-contrast mode, because their failures were
 * theme-specific: text on chart fills and severity tints that passed
 * in one palette and not another.
 *
 * The known-issue allowlist (see `helpers/axe.ts`) has one entry,
 * `DARK_MODE_KNOWN_ISSUES` below. If a new violation must ship
 * temporarily, add a per-surface entry whose reason names the pending
 * fix — and delete it in the same PR as that fix.
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

type Theme = "light" | "dark" | "high-contrast";

const THEMES: Theme[] = ["light", "dark", "high-contrast"];

/** Dark-mode-only failures shared by every page, via the nav. */
const DARK_MODE_KNOWN_ISSUES: KnownIssue[] = [
  {
    rule: "color-contrast",
    match: "nav-add-apps-label",
    reason:
      "white '+ Add Apps' label on the dark-mode --blue fill is 3.6:1; " +
      "fix/detail-page-axe-findings moves primary buttons onto --blue-fill",
  },
];

/**
 * Load `path` in `theme`. The OS scheme is emulated; high contrast is the
 * app's own theme, which the pre-hydration bootstrap in app/layout.tsx
 * reads from localStorage on load, so the key is written first (on the
 * app's origin, where localStorage lives) and the page loaded after.
 */
async function gotoInTheme(page: Page, path: string, theme: Theme) {
  if (!page.url().startsWith("http")) {
    await page.goto(path);
  }
  await page.emulateMedia({
    colorScheme: theme === "light" ? "light" : "dark",
  });
  await page.evaluate((t) => {
    if (t === "high-contrast") {
      localStorage.setItem("a11y-quick-theme", "high-contrast");
    } else {
      localStorage.removeItem("a11y-quick-theme");
    }
  }, theme);
  await page.goto(path);
  // Guard against scanning the wrong palette and passing for it.
  const html = page.locator("html");
  if (theme === "high-contrast") {
    await expect(html).toHaveAttribute("data-theme-override", "high-contrast");
  } else {
    await expect(html).not.toHaveAttribute("data-theme-override");
  }
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

    await expectNoBlockingViolations(page, "welcome");
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
    await expectNoBlockingViolations(page, "onboard-step2");

    // Step 3 — matched block with the candidate list expanded, so the
    // candidate rows (a roving radiogroup of role=radio buttons) are in
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

    await expectNoBlockingViolations(page, "onboard-match");
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
    // Client shell (Rust-core Phase 0): wait for HomeView's root so axe
    // scans real cards, not an empty wrapper.
    await expect(page.locator(".home-page").first()).toBeVisible();

    // The coachmark tour (when it auto-opens) pops in with a ~220ms
    // entrance animation, and axe measures mid-animation colours as
    // diluted — let the UI settle before scanning.
    await page.waitForTimeout(600);

    await expectNoBlockingViolations(page, "dashboard");
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

    // Saved accessibility profile → the Accessibility tab renders its
    // preference key + per-row chips (incl. voice_control as
    // required-but-not-declared), so that markup is in the scanned DOM.
    const a11yProfile = await request.put("/api/accessibility-profile", {
      headers: sameOriginHeaders,
      data: {
        profile: {
          voiceover: "required",
          voice_control: "required",
          captions: "nice",
        },
      },
    });
    await expect(a11yProfile).toBeOK();

    await page.goto(`/apps/${instagramId}`);
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");

    await expectNoBlockingViolations(page, "app-detail");

    // The other tabs each become their own component file in the
    // AppDetailView split — scan them activated and populated (the
    // canned seed provides declared accessibility features, a ready
    // policy summary, and timeline history). Tab clicks are polled —
    // same hydration caveat as the wizard's method click; re-clicking a
    // selected tab is a no-op so the poll is safe.
    await expect(async () => {
      await page.locator("#tab-accessibility").click();
      await expect(page.locator(".a11y-feature-row").first()).toBeVisible({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await expectNoBlockingViolations(page, "app-detail-accessibility");

    await expect(async () => {
      await page.locator("#tab-policy").click();
      await expect(page.locator(".policy-lens-card").first()).toBeVisible({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await expectNoBlockingViolations(page, "app-detail-policy");

    await expect(async () => {
      await page.locator("#tab-changelog").click();
      await expect(page.locator(".timeline-item").first()).toBeVisible({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await expectNoBlockingViolations(page, "app-detail-changelog");
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
    // Client shell (Rust-core Phase 0): wait for HomeView's root so axe
    // scans real cards, not an empty wrapper.
    await expect(page.locator(".home-page").first()).toBeVisible();

    // Open the drawer so its links are in the scanned DOM alongside the
    // compact top bar (where the icon-only Add Apps link lives).
    const menuTrigger = page.locator(".nav-menu-trigger");
    await expect(menuTrigger).toBeVisible();
    await menuTrigger.click();

    // Same settle as the dashboard scan: the drawer slides in over
    // 180ms (and the coachmark may be popping in behind it) — scanning
    // mid-transition measures diluted colours.
    await page.waitForTimeout(600);

    // Scope the scan to the nav element (compact bar + drawer both live
    // inside `nav.nav`). Unscoped, this scan re-covers the dashboard
    // behind the drawer, whose TaskList renders state-dependently
    // (attribution/add-tray nodes appear or not per run) — the desktop
    // dashboard scan above already owns that surface deterministically.
    await expectNoBlockingViolations(page, "mobile-nav", {
      include: "nav.nav",
    });
  }
);

// ---------------------------------------------------------------------------
// 6. /dashboard/stats — every theme, plus the matrix hover panel
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /dashboard/stats has no blocking violations in any theme",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    // A partial privacy profile, so the matrix renders both kinds of
    // preference bar (set and "no preference") and at least one cell
    // that exceeds its category's preference, which is what puts the
    // mismatch warning in the hover panel. Instagram collects location.
    const profile = await request.put("/api/privacy-profile", {
      headers: sameOriginHeaders,
      data: {
        profile: {
          CONTACT_INFO: "not_linked",
          LOCATION: "not_collected",
          IDENTIFIERS: "linked",
          USAGE_DATA: "tracking",
        },
      },
    });
    await expect(profile).toBeOK();

    try {
      for (const theme of THEMES) {
        await gotoInTheme(page, "/dashboard/stats", theme);
        // Client shell: wait for the fetched charts, not just the
        // wrapper. The bar counts sit on the card, the matrix and its
        // preference bars arrive on their own fetches.
        await expect(page.locator(".bar-count").first()).toBeVisible();
        await expect(page.locator(".sm-cell").first()).toBeVisible();
        await expect(page.locator(".sm-category-pref").first()).toBeVisible();
        await page.waitForTimeout(600);

        await expectNoBlockingViolations(page, `stats-${theme}`, {
          knownIssues: theme === "dark" ? DARK_MODE_KNOWN_ISSUES : [],
        });

        // The hover panel only renders its severity, preference and
        // mismatch lines while a cell is hovered, so the page scan
        // above never sees them.
        await page
          .locator(".sm-cell", { hasText: "exceeds your preference" })
          .first()
          .hover();
        await expect(page.locator(".sm-tooltip-mismatch")).toBeVisible();
        await expectNoBlockingViolations(page, `stats-${theme}-hover`, {
          include: ".sm-sidebar",
        });
        await page.mouse.move(0, 0);
      }
    } finally {
      // The suite shares one DB; don't leave a profile behind that
      // would change what later specs render.
      await request.put("/api/privacy-profile", {
        headers: sameOriginHeaders,
        data: { profile: null },
      });
    }
  }
);

// ---------------------------------------------------------------------------
// 7. /dashboard/privacy (Privacy Map) — every theme
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /dashboard/privacy has no blocking violations in any theme",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    for (const theme of THEMES) {
      await gotoInTheme(page, "/dashboard/privacy", theme);
      // The "not linked" badge is the one that failed in light mode.
      await expect(
        page.locator(".severity-badge.severity-unlinked").first()
      ).toBeVisible();
      await page.waitForTimeout(600);

      await expectNoBlockingViolations(page, `privacy-map-${theme}`, {
        knownIssues: theme === "dark" ? DARK_MODE_KNOWN_ISSUES : [],
      });
    }
  }
);
