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
  await ensureDeviceFixture(request);
  await resetDeviceScope(request);
  await forceFlagsOn(request);
});

/**
 * Devices are cross-suite state — the device-sync and audit-bundle specs
 * create named ones, and the nav picker lists every device it finds, so
 * a stray row changes the popover in any shot that has it open.
 *
 * This used to delete everything down to the seeded placeholder,
 * because the apps grid's device `<select>` sized itself to its widest
 * option and stray names shifted the whole toolbar. That `<select>` is
 * gone (the nav picker replaced it), and "no devices" turned out to be
 * the wrong normalisation anyway: with zero devices the picker renders
 * NOTHING, so the nav was identical in every shot and three stylesheets
 * of new chrome sat outside the net entirely.
 *
 * So: a fixed, owned, two-device fleet instead. Owners differ on
 * purpose — one 'self', one 'loved_one' — because that is what makes
 * the group headings and the focus-switch prompt reachable.
 *
 * IDEMPOTENT BY DESIGN. `beforeEach` runs once per shot, and
 * `devices.delete` is rate limited to 15/min server-side, so recreating
 * the fleet 13 times would be throttled into silently inconsistent
 * state. Steady state after the first shot is zero writes.
 */
const FIXTURE_DEVICES = [
  {
    appCount: 3,
    deviceClass: "iPhone",
    model: "iPhone15,2",
    name: "Visual iPhone",
    ownerAudience: "self",
    ownerLabel: "Me",
  },
  {
    appCount: 2,
    deviceClass: "iPad",
    model: "iPad13,4",
    name: "Visual iPad",
    ownerAudience: "loved_one",
    ownerLabel: "Robin",
  },
] as const;

const FIXTURE_NAMES: readonly string[] = FIXTURE_DEVICES.map((d) => d.name);

/** Narrow the global scope to a single fixture device by name. The
 *  shared beforeEach puts it back afterwards. */
async function scopeTo(
  request: APIRequestContext,
  deviceName: string
): Promise<void> {
  const { devices } = (await (
    await request.get("/api/device-scope", { headers: sameOriginHeaders })
  ).json()) as { devices: Array<{ id: string; name: string }> };
  const target = devices.find((d) => d.name === deviceName);
  if (!target) {
    throw new Error(`visual fixture device not found: ${deviceName}`);
  }
  const res = await request.put("/api/device-scope", {
    headers: sameOriginHeaders,
    data: {
      scope: {
        v: 1,
        mode: "subset",
        deviceIds: [target.id],
        includeUnattached: false,
      },
    },
  });
  await expect(res).toBeOK();
}

async function ensureDeviceFixture(request: APIRequestContext): Promise<void> {
  const { devices } = (await (
    await request.get("/api/devices", { headers: sameOriginHeaders })
  ).json()) as {
    devices: Array<{ id: string; name: string; appCount: number }>;
  };

  for (const device of devices) {
    if (!FIXTURE_NAMES.includes(device.name)) {
      await request.delete(`/api/devices/${device.id}`, {
        headers: sameOriginHeaders,
      });
    }
  }

  // App ids are stable across runs (the canned set is keyed by Apple
  // track id), so slicing the sorted list gives the same apps on every
  // device every time — which is what keeps the per-device counts in
  // the popover from drifting.
  const apps = (await (
    await request.get("/api/apps", { headers: sameOriginHeaders })
  ).json()) as Array<{ id: string }>;
  const ids = apps.map((a) => a.id);

  let offset = 0;
  for (const fixture of FIXTURE_DEVICES) {
    const slice = ids.slice(offset, offset + fixture.appCount);
    offset += fixture.appCount;
    const existing = devices.find((d) => d.name === fixture.name);
    const id =
      existing?.id ??
      (
        (await (
          await request.post("/api/devices", {
            headers: sameOriginHeaders,
            data: {
              name: fixture.name,
              deviceClass: fixture.deviceClass,
              model: fixture.model,
            },
          })
        ).json()) as { device: { id: string } }
      ).device.id;

    if (!existing) {
      await request.patch(`/api/devices/${id}`, {
        headers: sameOriginHeaders,
        data: {
          ownerAudience: fixture.ownerAudience,
          ownerLabel: fixture.ownerLabel,
        },
      });
    }
    // Links are re-asserted only when the count is wrong. Other specs
    // run /api/reset, which cascades app_devices away while leaving the
    // device rows behind, so "the device exists" does not imply "its
    // apps are still linked".
    if (!existing || existing.appCount !== fixture.appCount) {
      await request.post("/api/device-sync/commit", {
        headers: sameOriginHeaders,
        data: { deviceId: id, addAppIds: slice, removeAppIds: [] },
      });
    }
  }
}

/** Every shot starts unscoped; the scoped shots opt in and this puts it
 *  back. Read-then-delete so the common case costs no write — the
 *  scope endpoint is rate limited too. */
async function resetDeviceScope(request: APIRequestContext): Promise<void> {
  const { scope } = (await (
    await request.get("/api/device-scope", { headers: sameOriginHeaders })
  ).json()) as { scope?: { mode?: string } };
  if (scope?.mode !== "all") {
    await request.delete("/api/device-scope", { headers: sameOriginHeaders });
  }
}

/**
 * Force every flag-gated section on so the shots cover the full surface
 * — a selector for a hidden section would otherwise never be exercised.
 *
 * Only writes flags that are not already on. The unconditional version
 * posted eight overrides per shot, which blew through the 30/min
 * override limiter partway down the file: later shots were then taken
 * with some sections MISSING, quietly weakening the very coverage this
 * loop exists to provide (the rate-limit DENY lines are visible in any
 * full-file run).
 */
async function forceFlagsOn(request: APIRequestContext): Promise<void> {
  const wanted = [
    "flag.settings.admin.backup",
    "flag.settings.admin.reset",
    "flag.settings.admin.start_over",
    "flag.settings.policies.wayback",
    "flag.settings.sync.schedule",
    "flag.devopts.visible",
    "flag.settings.ai.enabled",
    "flag.settings.import.history",
  ];
  const { flags } = (await (
    await request.get("/api/feature-flags", { headers: sameOriginHeaders })
  ).json()) as { flags: Array<{ key: string; currentValue: string }> };
  const current = new Map(flags.map((f) => [f.key, f.currentValue]));
  for (const key of wanted) {
    if (current.get(key) !== "on") {
      await request.post("/api/feature-flags/overrides", {
        headers: sameOriginHeaders,
        data: { key, value: "on" },
      });
    }
  }
}

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
      // The change-history chart is ECharts on a CANVAS: its week-bucket
      // axis labels ("Jun 1", "Jun 8", …) are painted pixels, not text
      // nodes, so settle()'s freezer can never reach them — and the
      // buckets are relative to now, so the labels move every week. The
      // earlier no-year date pattern only "fixed" this because both runs
      // fell on the same day. Mask the chart; its bars and legend are
      // covered by the app-detail e2e spec, not by pixels.
      page.locator(".app-change-timeline-chart"),
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
  // The dashboard is a client shell now — `main` is the layout wrapper
  // and exists before any card; gate on HomeView's own root.
  await expect(page.locator(".home-page")).toBeVisible();
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
/**
 * Device-scope chrome. Four shots for four distinct CSS states — the
 * picker's own stylesheet has no other cover, and the net's whole
 * premise is that a rule which silently stops applying passes every
 * behavioural test.
 */
visual("device picker: open", async ({ page }) => {
  await page.goto("/dashboard/apps");
  const trigger = page.locator(".nav-right .device-scope-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator(".nav-right .device-scope-popover")).toBeVisible();
  await settle(page);
  // Covers: trigger, popover chrome, help copy, All-devices row, owner
  // group headings, per-device rows with their phone/tablet glyphs and
  // sub-lines, the unattached row, the divider and the tick column.
  await expect(page).toHaveScreenshot(
    "device-picker-open.png",
    shotOptions(page)
  );
});

visual("apps grid: scoped to one device", async ({ page, request }) => {
  await scopeTo(request, "Visual iPad");
  await page.goto("/dashboard/apps");
  await expect(page.locator(".app-card").first()).toBeVisible();
  await settle(page);
  // Covers the trigger's `is-scoped` treatment and the in-grid
  // "Showing {device}" chip — the two things that tell a user the list
  // in front of them is a subset.
  await expect(page).toHaveScreenshot(
    "apps-grid-scoped.png",
    shotOptions(page)
  );
});

visual("device picker: focus-switch prompt", async ({ page, request }) => {
  // Scoped to the loved-one device while the fixture's focus is 'self',
  // which is exactly the mismatch the prompt exists to surface.
  await scopeTo(request, "Visual iPad");
  await page.goto("/dashboard/apps");
  const trigger = page.locator(".nav-right .device-scope-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator(".device-scope-prompt")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot(
    "device-picker-prompt.png",
    shotOptions(page)
  );
});

visual("stats: scoped, with the export note", async ({ page, request }) => {
  // Stats had no shot at all before this. It earns one now because it
  // is where the page's own figures and a whole-install download sit
  // side by side — the reconciliation note is the only thing making
  // that honest, so a dropped rule there is a correctness problem.
  //
  // Scoped to `.page-header`, NOT the full page. The Stats page is
  // 5000px of accumulated state: its policy radar auto-selects which
  // apps to plot from whichever have been analysed, so a full-page shot
  // failed on the legend two runs later with nothing to do with CSS.
  // `.page-subtitle` is masked for the same reason one step smaller —
  // it counts total syncs, which grows every time another spec seeds.
  // What's left is exactly what this shot is for: the export controls
  // and the note beside them.
  await scopeTo(request, "Visual iPad");
  await page.goto("/dashboard/stats");
  await expect(page.locator(".scope-export-note")).toBeVisible();
  await settle(page);
  await expect(page.locator(".page-header")).toHaveScreenshot(
    "stats-scoped-header.png",
    {
      animations: "disabled" as const,
      mask: [page.locator(".page-subtitle")],
    }
  );
});

/**
 * Mobile. The nav collapses to a drawer below ~860px and renders its
 * OWN copy of the picker there — full-width, above the links — while
 * the popover switches to viewport-anchored `position: fixed` under a
 * `max-width: 640px` media query. None of that shares a code path with
 * the desktop shots above, and the file had no mobile shot at all, so
 * every one of those rules was uncovered.
 *
 * Both are ELEMENT shots rather than page shots — see the reasoning on
 * each. A page shot here would also drag in an unrelated pre-existing
 * bug: the apps grid overflows sideways at this width, because
 * `.header-actions` carries `flex-shrink: 0` which defeats the
 * `flex-wrap: wrap` set for it under `max-width: 640px`, pushing
 * scrollWidth past 700px. Measured at 375px with no scope set, so it
 * has nothing to do with the picker.
 */
const MOBILE = { width: 375, height: 812 } as const;

/**
 * Pixel budget for the two shots whose entire frame is a
 * `backdrop-filter` surface.
 *
 * The drawer and the popover are glass: their own pixels are computed
 * from whatever is behind them, so the blurred fringe at their rounded
 * corners moves when the page behind changes — which it does whenever
 * another suite has run in between (the header of this file already
 * warns to compare baselines and verify runs from the same DB context).
 * Observed drift is 27px in a 9x5 patch at one corner, on frames that
 * are otherwise identical.
 *
 * 150 is deliberately far below anything a real CSS regression
 * produces: the actual regressions this net has caught moved 897, 1042,
 * 3618 and 20611 pixels. Same explicit trade the task-center mask makes
 * above — a smaller gap than a net that fails for reasons no CSS change
 * caused, which is the failure mode that gets a net ignored, then
 * deleted.
 */
const GLASS_EDGE_TOLERANCE = 150;

visual("mobile: nav drawer with the device picker", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/dashboard/apps");
  const menu = page.locator(".nav-menu-trigger");
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.locator(".nav-drawer-device-scope")).toBeVisible();
  await settle(page);
  // Covers the drawer wrapper's rule below the links, and the trigger
  // stretched to full width — both of which only exist at this tier.
  // The DRAWER ELEMENT, not the page. The drawer is translucent and
  // narrower than the viewport, so a page shot — full or viewport —
  // captures the apps grid showing through beside and below it, and
  // that grid's toolbar renders a variable number of rows depending on
  // what earlier specs left in the DB. A run where the accessibility
  // filter row appeared shifted everything under it and failed a
  // baseline in which the picker was pixel-identical. Masking cannot
  // help here: Playwright paints masks ON TOP, so masking the page
  // would paint over the drawer itself.
  //
  // The drawer is glass, so page content still shows faintly THROUGH
  // it — but only the ~430px the drawer itself occupies, which is the
  // stable part of the grid (title, toolbar, risk chips). The row that
  // caused the flake sat below that and is now out of frame by
  // construction.
  await expect(page.locator(".nav-drawer")).toHaveScreenshot(
    "mobile-nav-drawer-picker.png",
    { animations: "disabled" as const, maxDiffPixels: GLASS_EDGE_TOLERANCE }
  );
});

visual("mobile: device picker open", async ({ page, request }) => {
  await scopeTo(request, "Visual iPad");
  await page.setViewportSize(MOBILE);
  await page.goto("/dashboard/apps");
  await page.locator(".nav-menu-trigger").click();
  const trigger = page.locator(
    ".nav-drawer-device-scope .device-scope-trigger"
  );
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator(".device-scope-popover")).toBeVisible();
  await settle(page);
  // The popover's mobile layout: pinned to the viewport rather than the
  // trigger, because anchoring it to a full-width control inside the
  // drawer would push its edge off-screen. Scoped so the prompt and the
  // checked/unchecked rows are in frame too.
  // The POPOVER ELEMENT, for the same reason as the shot above. It is
  // also the sharper assertion: at this width the popover is pinned to
  // the viewport (`left: 12; right: 12`) rather than sized to its
  // trigger, so the element's own width IS the evidence the media query
  // applied — a regression to the desktop `width: min(300px, …)` rule
  // changes it and fails here.
  await expect(page.locator(".device-scope-popover")).toHaveScreenshot(
    "mobile-device-picker-open.png",
    { animations: "disabled" as const, maxDiffPixels: GLASS_EDGE_TOLERANCE }
  );
});

visual("settings: devices, owner editor open", async ({ page }) => {
  await page.goto("/dashboard/settings/devices");
  const row = page.locator(".devices-list-row").first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /owner/i }).click();
  await expect(page.locator(".devices-owner-form")).toBeVisible();
  await settle(page);
  // Covers the owner meta line on every row plus the inline editor's
  // fields, help copy and action row.
  await expect(page).toHaveScreenshot(
    "settings-devices-owner.png",
    shotOptions(page)
  );
});

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
