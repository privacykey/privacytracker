import { expect, type Page, test } from "@playwright/test";

/**
 * Regression net for client-side feature-flag resolution.
 *
 * The bug this pins: client components used to gate UI on `useFlag`
 * (lib/feature-flags-hooks.ts), which resolved against a resolver context
 * that **nothing primes in the browser**. After the Rust-core Phase 0
 * static-shell migration there is no server component left to prime it,
 * so every such call fell through to `HARD_DEFAULTS[key]` — silently
 * ignoring both focus rules and user overrides. Typechecks clean, renders
 * the wrong thing, forever. That hook is gone; client code now reads
 * resolved values from `GET /api/feature-flags` via `lib/use-flag-bundle.ts`.
 *
 * Two probes, chosen because they exercise the two different loading
 * policies in lib/use-flag-bundle.ts (see that file's header):
 * `flag.global.label_hints` on the hold-render path, and
 * `flag.devopts.visible` on the other side of the same decision.
 *
 * (Named for the contract rather than for the label hints alone — a
 * `label-hints.spec.ts` also exists on a parallel branch covering the
 * same flag from the app-detail page, and two files by that name would
 * collide on merge.)
 *
 * `flag.global.label_hints` is the sharpest probe available:
 *
 *   - its HARD_DEFAULT is `on`, so a broken read is indistinguishable
 *     from a correct one on the default focus — the failure only shows
 *     up when something is supposed to turn it OFF;
 *   - `GOAL_RULES.minimal` turns it off, covering the RULE path;
 *   - it is user-overridable, covering the OVERRIDE path;
 *   - it renders a countable DOM element (`.data-label-hint-trigger`),
 *     one per category row of the privacy-profile editor.
 *
 * Both paths are asserted because they fail independently: a component
 * could read the bundle but be mounted where the focus never varies, and
 * an override could be written but never re-read.
 *
 * The editor lives in Settings rather than `/onboard/profile` on purpose.
 * `flag.settings.profiles.privacy` resolves `on` for every audience and
 * goal, so the host section stays put while the flag under test moves —
 * whereas `flag.onboarding.privacy_profile_setup` is itself goal-gated,
 * which would make an empty page ambiguous between "hints off" and
 * "section gone".
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const LABEL_HINTS = "flag.global.label_hints";
const SETTINGS_URL = "/dashboard/settings/you";

/** Focus payload shape accepted by POST /api/focus. */
interface FocusPayload {
  accessibility: boolean;
  audience: "self" | "loved_one" | "guardian";
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

const MONITOR_FOCUS: FocusPayload = {
  audience: "self",
  monitor: true,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

/** The subtractive strip. `GOAL_RULES.minimal` sets label_hints to 'off'. */
const MINIMAL_FOCUS: FocusPayload = {
  audience: "self",
  monitor: false,
  cleanup: false,
  minimal: true,
  accessibility: false,
};

/**
 * Wait for the privacy-profile editor itself before counting triggers.
 *
 * Without this the "hints are hidden" assertion passes for the wrong
 * reason on a slow load — zero triggers because the section hasn't
 * painted yet, rather than because the flag resolved off. Anchoring on a
 * sibling that is NOT flag-gated makes the count meaningful.
 */
async function openProfileEditor(page: Page) {
  await page.goto(SETTINGS_URL);
  const section = page.locator("#privacy-profile");
  await expect(section).toBeVisible();
  await expect(
    section.locator(".privacy-profile-strip-row").first()
  ).toBeVisible();
  return section;
}

/**
 * The Balanced tier map (mirrors `DEFAULT_PROFILE` in lib/privacy-profile.ts).
 *
 * Settings renders the profile editor only when a profile is saved — the
 * master switch above it reads `profileEnabled` from the loaded value —
 * so the spec has to seed one to have any hint triggers to count. The
 * exact tiers are irrelevant here; every category row carries a trigger
 * whatever its tier, since the hint's severity just follows the pill.
 */
const BALANCED_PROFILE = {
  CONTACT_INFO: "linked",
  HEALTH_AND_FITNESS: "not_linked",
  FINANCIAL_INFO: "linked",
  LOCATION: "not_linked",
  SENSITIVE_INFO: "not_collected",
  CONTACTS: "not_linked",
  USER_CONTENT: "linked",
  BROWSING_HISTORY: "not_linked",
  SEARCH_HISTORY: "not_linked",
  IDENTIFIERS: "not_linked",
  PURCHASES: "linked",
  USAGE_DATA: "linked",
  DIAGNOSTICS: "linked",
  OTHER: "linked",
};

test.beforeEach(async ({ request }) => {
  // Settings redirects to /onboard when the DB holds no apps.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=1",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();

  const profile = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: { profile: BALANCED_PROFILE },
  });
  await expect(profile).toBeOK();

  // Start from a clean flag state — a leftover override from another
  // spec would mask exactly the behaviour under test.
  const cleared = await request.delete(
    `/api/feature-flags/overrides/${encodeURIComponent(LABEL_HINTS)}`,
    { headers: sameOriginHeaders }
  );
  await expect(cleared).toBeOK();
});

browserFlow(
  "hint triggers follow the focus rule, not the hard default",
  async ({ page, request }) => {
    // Baseline: the default-ish focus leaves label_hints at its hard
    // default of 'on'. One trigger per category row.
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MONITOR_FOCUS,
      })
    ).toBeOK();

    let section = await openProfileEditor(page);
    const onCount = await section.locator(".data-label-hint-trigger").count();
    expect(onCount).toBeGreaterThan(0);

    // The regression: switch to the minimal goal, whose rule sets
    // label_hints 'off'. Reading HARD_DEFAULTS instead of the resolver
    // leaves every trigger on the page.
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MINIMAL_FOCUS,
      })
    ).toBeOK();

    section = await openProfileEditor(page);
    await expect(section.locator(".data-label-hint-trigger")).toHaveCount(0);

    // …and back, so a component that simply never renders the trigger
    // can't pass this spec.
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MONITOR_FOCUS,
      })
    ).toBeOK();

    section = await openProfileEditor(page);
    await expect(section.locator(".data-label-hint-trigger")).toHaveCount(
      onCount
    );
  }
);

browserFlow(
  "hint triggers follow a user override, not the hard default",
  async ({ page, request }) => {
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MONITOR_FOCUS,
      })
    ).toBeOK();

    let section = await openProfileEditor(page);
    const onCount = await section.locator(".data-label-hint-trigger").count();
    expect(onCount).toBeGreaterThan(0);

    // Overrides are the resolver's final word. This is the exact case
    // that was confirmed broken by hand: the API reported
    // currentValue 'off' while the browser kept rendering every hint.
    await expect(
      await request.post("/api/feature-flags/overrides", {
        headers: sameOriginHeaders,
        data: { key: LABEL_HINTS, value: "off" },
      })
    ).toBeOK();

    // Cross-check the server actually resolved it off, so a failure
    // below points at the client read rather than at the write.
    const registry = await (await request.get("/api/feature-flags")).json();
    const row = (
      registry.flags as { currentValue: string; key: string }[]
    ).find((f) => f.key === LABEL_HINTS);
    expect(row?.currentValue).toBe("off");

    section = await openProfileEditor(page);
    await expect(section.locator(".data-label-hint-trigger")).toHaveCount(0);

    await expect(
      await request.delete(
        `/api/feature-flags/overrides/${encodeURIComponent(LABEL_HINTS)}`,
        { headers: sameOriginHeaders }
      )
    ).toBeOK();

    section = await openProfileEditor(page);
    await expect(section.locator(".data-label-hint-trigger")).toHaveCount(
      onCount
    );
  }
);

browserFlow(
  "developer options stay hidden for a minimal focus",
  async ({ page, request }) => {
    // The other half of the loading-policy decision. `flag.devopts.visible`
    // defaults 'on' and only `GOAL_RULES.minimal` turns it off, so seeding
    // the hard default (what the Settings CARD flags do) would paint the
    // whole Developer Options section — and its sidebar link — at a user
    // who asked to keep things minimal, then snatch them back. SettingsView
    // and SettingsSidebar therefore read this one through the fail-closed
    // hook: unknown counts as hidden.
    //
    // Under the old resolver hook the section was permanently visible here,
    // because 'on' is the hard default and the minimal rule never reached
    // the browser at all.
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MINIMAL_FOCUS,
      })
    ).toBeOK();

    await page.goto("/dashboard/settings/admin");
    // Anchor on a sibling section in the same group that is NOT flag-gated,
    // so "developer is absent" can't pass just because the page is slow.
    await expect(page.locator("#export-data")).toBeVisible();
    await expect(page.locator("#developer")).toHaveCount(0);
    await expect(
      page.locator('.settings-sidebar a[href$="#developer"]')
    ).toHaveCount(0);

    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MONITOR_FOCUS,
      })
    ).toBeOK();

    await page.goto("/dashboard/settings/admin");
    await expect(page.locator("#developer")).toBeVisible();
  }
);

browserFlow(
  "an unreadable flag bundle keeps Settings intact but still hides dev tooling",
  async ({ page, request }) => {
    // The test above pins the settled state, which Playwright reaches by
    // retrying — so it passes under either loading policy. This one pins
    // the choice itself.
    //
    // Note it does NOT do so by racing the fetch: `AppChrome` holds the
    // whole tree until the bundle settles (it seeds TaskCenterProvider
    // from these values at mount), so nothing inside the app paints
    // early under either policy. The two policies only diverge when the
    // bundle cannot be read at all — which AppChrome survives, because
    // its own chrome flags fail OPEN and it renders the tree anyway.
    //
    // Both assertions describe that state, and they must disagree:
    //
    //   - #export-data is gated by a Settings CARD flag read through
    //     useFlagValuesWithDefaults, which keeps HARD_DEFAULTS on a
    //     failed read. Settings must still be usable. Swap it to the
    //     fail-closed hook and every card here vanishes at once.
    //   - #developer is gated by flag.devopts.visible read through the
    //     fail-closed hook. It must stay hidden even though its hard
    //     default is 'on' and this focus resolves it 'on': if we cannot
    //     tell whether the user asked to keep things minimal, developer
    //     tooling is the wrong thing to guess into existence.
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: MONITOR_FOCUS,
      })
    ).toBeOK();

    await page.route("**/api/feature-flags", (route) => route.abort());
    await page.goto("/dashboard/settings/admin");

    // Hard-default seed survives the failure: the page is not empty.
    await expect(page.locator("#export-data")).toBeVisible();
    await expect(page.locator("#backup")).toBeVisible();
    // Fail-closed gate: withheld rather than guessed at.
    await expect(page.locator("#developer")).toHaveCount(0);
  }
);
