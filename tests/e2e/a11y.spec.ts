import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectNoBlockingViolations } from "./helpers/axe";

/**
 * Blocking accessibility gate.
 *
 * Axe-core scans of the highest-traffic surfaces: /welcome, the
 * onboarding import-matching step, /dashboard, the app detail page,
 * the mobile navigation drawer, the Stats and Privacy Map pages, the
 * apps grid (including Select mode with a card picked), Compare with
 * two apps, Settings → Admin and the dev menu, and the prose pages
 * (privacy policy, Legal, AI disclosure, 404).
 * Serious/critical WCAG 2.2 A/AA violations, target size included,
 * fail CI (this file runs inside the `quality` job's Playwright step
 * like every other spec here).
 *
 * The onboarding, detail and mobile-nav scans run in light mode only.
 * Everything else is also scanned in dark and high-contrast mode,
 * because the failures there were theme-specific: text on chart fills,
 * severity tints and nested panels that passed in one palette and not
 * another. The grid, dashboard and Compare scans run with a partial
 * privacy profile, which is what renders the profile badges, the
 * "N mismatches" chips and the Compare profile column.
 *
 * The known-issue allowlist (see `helpers/axe.ts`) is EMPTY: every
 * defect it tracked has been fixed. If a new violation must ship
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

/**
 * Save a partial privacy profile for the length of `run`, then clear it.
 * Partial on purpose: the pages render both "preference set" and "no
 * preference" markup, and Instagram and TikTok exceed it, so mismatch
 * chips, profile badges and the Compare profile column appear. The
 * suite shares one DB, so the profile never outlives the test.
 */
async function withPartialProfile(
  request: APIRequestContext,
  run: () => Promise<void>
) {
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
    await run();
  } finally {
    await request.put("/api/privacy-profile", {
      headers: sameOriginHeaders,
      data: { profile: null },
    });
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

/**
 * Make sure the install has at least one device, so the nav's device
 * picker renders (it renders nothing with zero devices, and the canned
 * seed creates none). Returns the id of a device created here, for the
 * caller to delete, or null when one already existed.
 */
async function ensureDevice(
  request: APIRequestContext
): Promise<string | null> {
  const list = await request.get("/api/devices", {
    headers: sameOriginHeaders,
  });
  await expect(list).toBeOK();
  const { devices } = (await list.json()) as { devices?: unknown[] };
  if ((devices ?? []).length > 0) {
    return null;
  }
  const created = await request.post("/api/devices", {
    headers: sameOriginHeaders,
    data: { name: "A11y iPhone", deviceClass: "iPhone", model: "iPhone15,2" },
  });
  await expect(created).toBeOK();
  return (await created.json()).device.id as string;
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
// 5. Mobile navigation — compact tier, closed drawer, open drawer
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: mobile nav drawer has no blocking violations",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);
    // With a device, the drawer also holds the device picker. Without
    // one the closed-drawer scan below would pass whatever the drawer
    // did with its picker, since there would be no picker.
    const createdDeviceId = await ensureDevice(request);

    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto("/dashboard");
      // Client shell (Rust-core Phase 0): wait for HomeView's root so axe
      // scans real cards, not an empty wrapper.
      await expect(page.locator(".home-page").first()).toBeVisible();

      // Closed drawer first. It stays laid out while closed (it fades and
      // slides rather than unmounting), so everything focusable inside it
      // has to be out of the tab order, not just hidden from screen
      // readers: axe's aria-hidden-focus catches the difference.
      await expect(
        page.locator("#nav-drawer .device-scope-trigger")
      ).toHaveCount(1);
      await expectNoBlockingViolations(page, "mobile-nav-closed", {
        include: "#nav-drawer",
      });

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
    } finally {
      if (createdDeviceId) {
        await request.delete(`/api/devices/${createdDeviceId}`, {
          headers: sameOriginHeaders,
        });
      }
    }
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

        await expectNoBlockingViolations(page, `stats-${theme}`);

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

      await expectNoBlockingViolations(page, `privacy-map-${theme}`);
    }
  }
);

// ---------------------------------------------------------------------------
// 8. Settings → Admin and the dev menu — every switch has a name
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: Settings → Admin has no blocking violations and its switches are named",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    // The dev-menu switch's caption is a sibling of the switch, so the
    // switch used to have no accessible name at all (axe button-name,
    // critical). getByRole matches on the computed name.
    for (const theme of THEMES) {
      await gotoInTheme(page, "/dashboard/settings/admin", theme);
      await expect(
        page.getByRole("switch", { name: "Dev menu trigger" })
      ).toBeVisible();
      await page.waitForTimeout(600);
      await expectNoBlockingViolations(page, `settings-admin-${theme}`);
    }

    // The dev menu's profile switches had the same shape: the row label
    // sits in the <summary>, the switch below it had no name. Turn the
    // menu on from the panel, open it, and expand both rows.
    await gotoInTheme(page, "/dashboard/settings/admin", "light");
    const devMenuSwitch = page.getByRole("switch", {
      name: "Dev menu trigger",
    });
    const wasOn = (await devMenuSwitch.getAttribute("aria-checked")) === "true";
    try {
      if (!wasOn) {
        await devMenuSwitch.click();
        await expect(devMenuSwitch).toHaveAttribute("aria-checked", "true");
      }
      await page.getByRole("button", { name: "Open dev menu" }).click();
      const menu = page.locator(".dev-menu-popover");
      await expect(menu).toBeVisible();
      for (const label of ["Privacy profile", "Accessibility profile"]) {
        await menu
          .locator("summary.dev-menu-config-summary", { hasText: label })
          .click();
        await expect(menu.getByRole("switch", { name: label })).toBeVisible();
      }
      // Scoped to the switches: this test pins their names. The rest of
      // the dev menu (a developer surface) is not part of this gate yet.
      await expectNoBlockingViolations(page, "dev-menu-switches", {
        include: '.dev-menu-config-actions [role="switch"]',
      });
    } finally {
      // The toggle persists server-side too; leave the suite's shared DB
      // as it was.
      if (!wasOn) {
        await page.keyboard.press("Escape");
        await gotoInTheme(page, "/dashboard/settings/admin", "light");
        const toggle = page.getByRole("switch", { name: "Dev menu trigger" });
        if ((await toggle.getAttribute("aria-checked")) === "true") {
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-checked", "false");
        }
      }
    }
  }
);

// ---------------------------------------------------------------------------
// 9. /dashboard/apps — every theme, then Select mode with a card picked
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: the apps grid has no blocking violations in any theme, in Select mode too",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    await withPartialProfile(request, async () => {
      for (const theme of THEMES) {
        await gotoInTheme(page, "/dashboard/apps", theme);
        // Custom (user-authored) cards have no Select behaviour; skip any
        // another spec may have left in the shared DB.
        const cards = page
          .locator(".app-card")
          .filter({ hasNot: page.locator(".app-card-custom") });
        await expect(cards.first()).toBeVisible();
        // The profile badges and the Low risk pill are the tints whose
        // labels failed contrast; make sure the scan sees them.
        await expect(
          page.locator(".app-card-profile-badge.match-bad").first()
        ).toBeVisible();
        await expect(page.locator(".risk-pill-low").first()).toBeVisible();
        await page.waitForTimeout(600);
        await expectNoBlockingViolations(page, `apps-grid-${theme}`);

        // Select mode, one card picked: the bulk bar in its active
        // state (links, count) and a selected card's highlight.
        const select = page.getByRole("button", {
          name: "Select",
          exact: true,
        });
        await expect(select).toBeEnabled();
        await select.click();
        const bar = page.getByRole("region", { name: "Bulk actions" });
        await expect(bar).toBeVisible();
        await cards.first().locator(".app-card-link").click();
        await expect(bar.getByRole("status")).toContainText("1 app selected");
        await page.waitForTimeout(600);
        await expectNoBlockingViolations(page, `apps-select-${theme}`);
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 10. /dashboard with a privacy profile — every theme
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /dashboard with a privacy profile has no blocking violations in any theme",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    await withPartialProfile(request, async () => {
      for (const theme of THEMES) {
        await gotoInTheme(page, "/dashboard", theme);
        await expect(page.locator(".home-page").first()).toBeVisible();
        // The "Consider replacing" rows carry the "N mismatches" chip,
        // which was 3.8:1 in dark mode.
        await expect(
          page.locator(".profile-replace-row-count").first()
        ).toBeVisible();
        await page.waitForTimeout(600);
        await expectNoBlockingViolations(page, `dashboard-${theme}`);
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 11. /dashboard/compare with two apps — every theme
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: /dashboard/compare with two apps has no blocking violations in any theme",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);
    const appsRes = await request.get("/api/apps");
    await expect(appsRes).toBeOK();
    const apps = (await appsRes.json()) as Array<{ id: string; name: string }>;
    const a = apps.find((app) => app.name === "Instagram");
    const b = apps.find((app) => app.name === "TikTok");
    expect(a && b, "expected the canned Instagram and TikTok").toBeTruthy();

    await withPartialProfile(request, async () => {
      for (const theme of THEMES) {
        await gotoInTheme(
          page,
          `/dashboard/compare?a=id:${a?.id}&b=id:${b?.id}`,
          theme
        );
        // Picked slot cards (with their Change / Clear actions), the
        // matrix table and its profile column are all on screen.
        await expect(page.getByRole("table").first()).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Clear App A" })
        ).toBeVisible();
        await page.waitForTimeout(600);
        await expectNoBlockingViolations(page, `compare-${theme}`);
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 12. Prose pages — privacy policy, Legal, AI disclosure, 404
// ---------------------------------------------------------------------------

browserFlow(
  "a11y: the prose pages have no blocking violations in any theme",
  async ({ page, request }) => {
    await setDefaultFocus(request);
    await seedCannedApps(request);

    // Each page's running text holds links; they must be underlined, not
    // told apart by colour alone (axe link-in-text-block).
    const pages: Array<{ path: string; ready: string }> = [
      { path: "/privacy-policy", ready: ".priv-inline-link" },
      { path: "/legal", ready: ".legal-license-blurb a" },
      {
        path: "/dashboard/about/ai-disclosure",
        ready: ".ai-disclosure-inline-link",
      },
      { path: "/this-page-does-not-exist", ready: ".notfound-hint a" },
    ];
    for (const { path, ready } of pages) {
      for (const theme of THEMES) {
        await gotoInTheme(page, path, theme);
        await expect(page.locator(ready).first()).toBeVisible();
        await page.waitForTimeout(300);
        await expectNoBlockingViolations(page, `${path}-${theme}`);
      }
    }
  }
);
