import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * Visual-regression net for the CSS migration (docs/CSS.md).
 *
 * Nothing else catches a dropped selector: the structural settings net
 * asserts sections *render with content*, the behavioural onboarding specs
 * assert flows *work* — a rule that silently stops applying passes both.
 * This net exists so CSS can move out of globals.css with a gate, the same
 * way settings-sections.spec.ts existed before the component split (and
 * caught two real regressions during it).
 *
 * DELIBERATELY LOCAL-ONLY, two reasons:
 *
 *   1. Screenshot baselines are platform-renderer-specific (font
 *      antialiasing differs between this machine and CI's Linux runners),
 *      so committed baselines would fail everywhere but the machine that
 *      made them.
 *   2. App screenshots stay out of the public repo as a matter of policy —
 *      the baseline PNGs are gitignored (see .gitignore), like
 *      docs/screenshots/.
 *
 * Usage, around any CSS-moving change:
 *
 *   VISUAL=1 npx playwright test tests/e2e/visual.spec.ts --update-snapshots  # before
 *   VISUAL=1 npx playwright test tests/e2e/visual.spec.ts                     # after
 *
 * Without VISUAL=1 every test here skips, so CI and ordinary local runs
 * are unaffected.
 */

const visual = process.env.VISUAL ? test : test.skip;

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test.beforeEach(async ({ request }) => {
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
  // Profiles make the shots strictly richer: privacy mismatch borders /
  // badges on the label cards, and the preference key + per-row chips on
  // the accessibility tab (voice_control is required-but-not-declared for
  // the canned Instagram, so that rendering is covered too). Same shapes
  // the app-detail behavioural spec uses.
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
  // Devices are cross-suite state: device-sync / audit-bundle specs
  // create named devices, and the apps grid's device <select> sizes
  // itself to its widest option — so stray devices shift everything to
  // the right of the dropdown by a few pixels between run contexts.
  // Normalise to the seeded "Unknown device" placeholder only.
  const devicesRes = await request.get("/api/devices", {
    headers: sameOriginHeaders,
  });
  const { devices } = (await devicesRes.json()) as {
    devices: Array<{ id: string; isUnknownPlaceholder?: boolean }>;
  };
  for (const device of devices) {
    if (!device.isUnknownPlaceholder) {
      await request.delete(`/api/devices/${device.id}`, {
        headers: sameOriginHeaders,
      });
    }
  }
  // Force every flag-gated section on so the shots cover the full surface —
  // a selector for a hidden section would otherwise never be exercised.
  for (const key of [
    "flag.settings.admin.backup",
    "flag.settings.admin.reset",
    "flag.settings.admin.start_over",
    "flag.settings.policies.wayback",
    "flag.settings.sync.schedule",
    "flag.devopts.visible",
    "flag.settings.ai.enabled",
    "flag.settings.import.history",
  ]) {
    await request.post("/api/feature-flags/overrides", {
      headers: sameOriginHeaders,
      data: { key, value: "on" },
    });
  }
});

/**
 * Neutralise legitimate nondeterminism before comparing pixels: relative
 * timestamps ("2m ago", "in ~40s"), clock-of-day datestamps ("02:41 AM" —
 * the canned fixture seeds snapshot times relative to seed time, so the
 * minutes drift between runs), and anything mid-animation. Same technique
 * as the DOM-diff harness used throughout the component split.
 *
 * The task-center trigger needs the same treatment for a different reason.
 * Its badge counts background jobs that are *in flight right now*, and its
 * `is-active` class restyles the button whenever that count is above zero —
 * so the nav, which appears in every shot, changes with how long the run
 * happened to take before this particular screenshot. Adding one test to
 * this file was enough to flip it from 3 to 2 and fail an unrelated
 * baseline. Both are normalised to the idle state.
 *
 * The trade is explicit: the net no longer covers the badge's own styling
 * (it is `position: absolute`, so removing it shifts nothing else). That is
 * a real gap, but a smaller one than a net that fails for reasons no CSS
 * change caused — the failure mode that gets a net ignored, then deleted.
 */
async function settle(page: Page) {
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    // Byte sizes are their own pattern (leaf text that IS a size, e.g.
    // the admin route's "Database size: 512.0 KB") — the SQLite file
    // grows as the suite itself runs, so the number differs between the
    // baseline run and the verify run.
    //
    // ABSOLUTE dates ("Aug 16, 2026" and "16 Aug 2026", both date-format
    // modes) are volatile for the same reason relative times are: every
    // date on screen derives from a fixture timestamp seeded relative to
    // NOW, so a baseline captured before midnight fails against a verify
    // run after it. Without this, the net reports five failures for a
    // day boundary and a real regression would hide among them.
    const volatile =
      /(\d+\s*((second|minute|hour|day)s?|[smh])\b\s*(ago|from now)?)|(\bjust now\b)|(\bmoments? ago\b)|(\d{1,2}:\d{2}(\s*[AP]M)?)|(^\s*\d+(\.\d+)?\s*(B|KB|MB|GB)\s*$)|(\b[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\b)|(\b\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\b)|(\b[A-Z][a-z]{2}\s+\d{1,2}\b)/gi;
    // Walk TEXT NODES, not elements. The previous element-based pass
    // only rewrote childless nodes, so a volatile value sharing a
    // paragraph with any inline element was skipped — e.g. the policy
    // banner's "…changed Aug 9, 2026, inside the 90-day window…" sits
    // beside a <a>, so its date drifted straight past the freezer and
    // failed the shot a day later. Replacing just the MATCHED substring
    // (rather than the whole node) also keeps the surrounding copy, and
    // collapses different-width values like "Aug 9" / "Aug 12" onto one
    // token so following text doesn't reflow.
    const roots = document.querySelectorAll("main, .wizard");
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? "";
        // No `volatile.test()` guard: the regex is global, and `test()`
        // advances lastIndex, so guarding would make the NEXT node start
        // matching mid-string and miss values. `replace` is a no-op when
        // nothing matches, so calling it unconditionally is both correct
        // and cheaper than resetting lastIndex by hand.
        const frozen = text.replace(volatile, "~F");
        if (frozen !== text) {
          node.nodeValue = frozen;
        }
        node = walker.nextNode();
      }
    }
    document.querySelector(".task-center-badge")?.remove();
    document
      .querySelector(".task-center-trigger")
      ?.classList.remove("is-active");
  });
}

/**
 * Screenshot options. Three elements are masked because they carry
 * run-order state rather than page content: the notification bell (its
 * unread badge appears when *other* specs' seeds fire notifications),
 * the Task Center trigger (its done-count ticks up as background work
 * completes), and the first-run checklist — both its dashboard card and
 * its nav icon (step-completion state flips as suite activity satisfies
 * the steps). Masking the stable
 * outer wrappers — not the badge itself — keeps the masked box constant
 * whether or not the inner state indicator exists in a given run.
 *
 * Even with the masks, compare baselines and verify runs FROM THE SAME
 * DB CONTEXT (fresh data dir, or at least no other suites interleaved
 * between the two runs): the dashboard legitimately renders stateful
 * content (callouts, activity, risk sections) that no mask can or
 * should hide.
 */
function shotOptions(page: Page) {
  return {
    fullPage: true,
    animations: "disabled" as const,
    mask: [
      page.locator(".notif-bell-wrap"),
      page.locator(".task-center"),
      page.locator(".task-list-card"),
      page.locator(".task-list-icon-wrap"),
    ],
  };
}

for (const group of ["you", "sync", "policies", "admin"] as const) {
  visual(`settings route: ${group}`, async ({ page }) => {
    await page.goto(`/dashboard/settings/${group}`);
    await expect(page.locator(".settings-sidebar")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(
      `settings-${group}.png`,
      shotOptions(page)
    );
  });
}

visual("onboarding: step 1, choose method", async ({ page }) => {
  await page.goto("/onboard");
  // On desktop the manual card sits inside the collapsed "Other import
  // options" disclosure; the primary card is always visible. Open the
  // disclosure so the shot covers the collapsed cards' styling too.
  await expect(page.locator(".method-card").first()).toBeVisible();
  await page.getByText("Other import options").click();
  await expect(page.getByTestId("onboard-method-manual")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("onboard-step1.png", shotOptions(page));
});

visual("onboarding: step 2, manual entry", async ({ page }) => {
  await page.goto("/onboard");
  await page.getByText("Other import options").click();
  // React may not have attached handlers on a cold start — poll the click
  // until the radio actually takes, same as the behavioural specs do.
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manualCard.click();
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
  await expect(page.getByTestId("onboard-app-names")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("onboard-step2.png", shotOptions(page));
});

visual("dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator("main")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("dashboard.png", shotOptions(page));
});

visual("apps grid", async ({ page }) => {
  await page.goto("/dashboard/apps");
  // The grid loads client-side now — `main` is the layout wrapper and
  // exists before any card, so gate on a real card like the filter spec
  // and the screenshot script already do.
  await expect(page.locator(".app-card").first()).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("apps-grid.png", shotOptions(page));
});

/**
 * Compare was in the net's original spec and got missed when the first
 * nine shots landed. It matters more than most: CompareAppsView is the
 * largest remaining unsplit component, so this is the net that has to be
 * in place before anyone takes it on.
 *
 * The assertions before the shot are the empty-fixture guard — the page
 * boots with blank slots for an unknown id rather than erroring, so a
 * screenshot of two empty columns would compare clean forever and prove
 * nothing.
 */
visual("compare", async ({ page, request }) => {
  const res = await request.get("/api/apps");
  const apps = (await res.json()) as { id: string; name: string }[];
  const [appA, appB] = apps;
  await page.goto(`/dashboard/compare?a=id:${appA.id}&b=id:${appB.id}`);
  await expect(
    page.getByText(appA.name, { exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByText(appB.name, { exact: true }).first()
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("compare.png", shotOptions(page));
});

/** Resolve the canned Instagram app (the richest fixture: five declared
 * accessibility features, a ready policy summary with a previous-summary
 * shift, unacknowledged changes, timeline history incl. a wayback row)
 * and open its detail page. */
async function gotoAppDetail(page: Page, request: APIRequestContext) {
  const res = await request.get("/api/apps");
  const apps = (await res.json()) as { id: string; name: string }[];
  const target = apps.find((a) => a.name === "Instagram") ?? apps[0];
  await page.goto(`/apps/${target.id}`);
  await expect(page.locator("h1").first()).toBeVisible();
}

visual("app detail", async ({ page, request }) => {
  await gotoAppDetail(page, request);
  await settle(page);
  await expect(page).toHaveScreenshot("app-detail.png", shotOptions(page));
});

// Per-tab shots — the AppDetailView split moves each of these panels
// into its own file, so each populated tab needs its own pixel gate.
// Tab clicks are polled (React may not have attached handlers yet on a
// cold server; re-clicking a selected tab is a no-op).

async function openTab(page: Page, tabId: string, revealed: string) {
  await expect(async () => {
    await page.locator(tabId).click();
    await expect(page.locator(revealed).first()).toBeVisible({
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
}

visual("app detail: accessibility tab", async ({ page, request }) => {
  await gotoAppDetail(page, request);
  await openTab(page, "#tab-accessibility", ".a11y-feature-row");
  await settle(page);
  await expect(page).toHaveScreenshot(
    "app-detail-accessibility.png",
    shotOptions(page)
  );
});

visual("app detail: AI policy tab", async ({ page, request }) => {
  await gotoAppDetail(page, request);
  await openTab(page, "#tab-policy", ".policy-lens-card");
  await settle(page);
  await expect(page).toHaveScreenshot(
    "app-detail-policy.png",
    shotOptions(page)
  );
});

visual("app detail: change history tab", async ({ page, request }) => {
  await gotoAppDetail(page, request);
  await openTab(page, "#tab-changelog", ".timeline-item");
  await settle(page);
  await expect(page).toHaveScreenshot(
    "app-detail-changelog.png",
    shotOptions(page)
  );
});
