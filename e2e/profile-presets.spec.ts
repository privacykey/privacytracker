import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the privacy-profile preset row introduced alongside
 * the existing per-category strip. The flow under test:
 *
 *   1. First-time user with a declutter-goal focus lands on
 *      /onboard/profile with no saved profile. The privacy section
 *      renders with a recommended Balanced preset and an
 *      Activate / Customise / Disable choice row
 *      (recommendedPrivacyPresetForFocus → 'balanced' for declutter).
 *   2. Clicking "Customise" opens the editor pre-loaded with the
 *      recommended (Balanced) profile.
 *   3. Clicking the Strict preset pill applies Strict to every row
 *      without a confirm bubble (onboarding passes
 *      confirmOnPresetApply={false}).
 *   4. Editing a single per-category pill drops the Strict pill's
 *      .is-active highlight, signalling "this is now custom".
 *
 * The spec deliberately avoids asserting the full 14-category mapping
 * — it picks one representative `not_collected` row (LOCATION) and one
 * `not_linked` row (CONTACT_INFO), matching the Strict preset constants
 * in lib/privacy-profile.ts. If the constants drift, the unit tests in
 * tests/profile-presets.test.ts catch the drift first; this spec then
 * fails at the assertion-pair below, signalling the dual update is
 * needed.
 */

const sameOriginHeaders = {
  origin: "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  // Pre-seed focus state so /onboard/profile renders the privacy
  // section. The page only renders that section when
  // flag.onboarding.privacy_profile_setup resolves 'on', which the
  // declutter goal rule provides (GOAL_RULES.declutter). Declutter also
  // makes recommendedPrivacyPresetForFocus return 'balanced', so the
  // section mounts in its recommended-preset shape with the
  // Activate / Customise / Disable choice row. The accessibility
  // modifier additionally flips accessibility_profile_setup on, keeping
  // the a11y section covered alongside.
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Clear any saved profile so the test runs against a first-time
  // user (the only path where preset clicks apply without a confirm).
  const cleared = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: { profile: null },
  });
  await expect(cleared).toBeOK();

  // Make sure at least one app exists in the DB. The Settings preset
  // test below navigates to `/dashboard/settings`, which server-side-
  // redirects to `/onboard` when `apps.length === 0` — and the
  // earlier specs in the suite occasionally leave the DB empty (when
  // a previous spec reset state without re-seeding). Seeding here
  // makes this file self-sufficient: it doesn't matter what state
  // the suite handed us.
  //
  // The first test (`/onboard/profile` preset flow) doesn't care
  // whether apps exist, so the extra seed is harmless to it.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=1",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

browserFlow(
  "Strict preset fills every row, edits drop the highlight",
  async ({ page }) => {
    await page.goto("/onboard/profile");

    // The declutter focus seeded in beforeEach gives the privacy section
    // a recommended Balanced preset, so it renders the
    // Activate / Customise / Disable choice row. "Customise" (exact —
    // the a11y section's button is "Customise accessibility needs")
    // opens the editor pre-loaded with the recommended profile.
    const customise = page.getByRole("button", {
      exact: true,
      name: "Customise",
    });
    await expect(customise).toBeVisible();
    await customise.click();

    const strictPreset = page.locator(
      '.privacy-profile-preset-pill[data-preset="strict"]'
    );
    const balancedPreset = page.locator(
      '.privacy-profile-preset-pill[data-preset="balanced"]'
    );
    await expect(strictPreset).toBeVisible();

    // Click Strict and verify it becomes the active preset. We deliberately
    // don't pre-assert which preset (if any) is highlighted on first mount —
    // the editor's local state seeds from the recommended profile, which
    // equals PROFILE_PRESETS.balanced for the declutter focus, so in theory
    // Balanced lights up immediately, but the user-visible contract is
    // "click a preset → it activates", and that's what matters.
    // Initial-mount highlighting is exercised by the unit tests in
    // tests/profile-presets.test.ts.
    await strictPreset.click();

    // Strict picks up `.is-active`. No inline confirm bubble appears because
    // onboarding passes `confirmOnPresetApply={false}` — first-time users
    // explore presets without nag confirms.
    await expect(strictPreset).toHaveClass(/is-active/);
    await expect(strictPreset).toHaveAttribute("aria-checked", "true");
    await expect(balancedPreset).not.toHaveClass(/is-active/);
    await expect(page.locator(".privacy-profile-preset-confirm")).toHaveCount(
      0
    );

    // Spot-check two rows from the Strict preset constants — LOCATION sits
    // at not_collected and CONTACT_INFO sits at not_linked. The row's
    // selected pill picks up `.is-selected`.
    const locationRow = page.locator(".privacy-profile-strip-row").filter({
      has: page.getByRole("radiogroup", { name: /Location/i }),
    });
    await expect(
      locationRow.locator(
        '.privacy-profile-pill[data-tier="not_collected"].is-selected'
      )
    ).toHaveCount(1);

    const contactRow = page.locator(".privacy-profile-strip-row").filter({
      has: page.getByRole("radiogroup", { name: /Contact Info/i }),
    });
    await expect(
      contactRow.locator(
        '.privacy-profile-pill[data-tier="not_linked"].is-selected'
      )
    ).toHaveCount(1);

    // Now edit a single row — bump LOCATION up to 'tracking'. The Strict
    // pill should drop its highlight; matchPreset returns null for the
    // resulting custom profile.
    await locationRow
      .locator('.privacy-profile-pill[data-tier="tracking"]')
      .click();
    await expect(strictPreset).not.toHaveClass(/is-active/);
    await expect(strictPreset).toHaveAttribute("aria-checked", "false");
  }
);

// ---------------------------------------------------------------------------
// Spec: Settings → Privacy Profile preset confirm-and-replace
// ---------------------------------------------------------------------------
//
// Onboarding skips the overwrite-confirm bubble for first-time users
// (PrivacyProfileSetup passes confirmOnPresetApply={false}).
// Settings is the OTHER side of that prop — when a returning user clicks
// a preset pill that doesn't match their saved profile, the editor must
// pop the inline confirm bubble before applying.

browserFlow(
  "Settings preset click on a saved custom profile shows the confirm bubble",
  async ({ page, request }) => {
    // Save a custom (non-preset) profile via API so the editor mounts in
    // a state where matchPreset returns null. Two-category sparse profile
    // is enough — applying any preset must replace it wholesale.
    const seedSparse = await request.put("/api/privacy-profile", {
      headers: sameOriginHeaders,
      data: {
        profile: {
          LOCATION: "tracking",
          CONTACT_INFO: "tracking",
        },
      },
    });
    await expect(seedSparse).toBeOK();

    // Navigate via the deep-link hash so Settings auto-scrolls to the
    // privacy-profile section. The page also has a one-shot pulse for
    // hash deep-links — we don't assert on it, just confirm the section
    // is reachable and the editor is mounted with the saved profile.
    await page.goto("/dashboard/settings#privacy-profile");

    const section = page.locator("#privacy-profile");
    await expect(section).toBeVisible();

    // The toggle should already be ON because there's a saved profile.
    const toggle = section.locator('[role="switch"]').first();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const strictPreset = section.locator(
      '.privacy-profile-preset-pill[data-preset="strict"]'
    );
    await expect(strictPreset).toBeVisible();

    // Pre-state: matchPreset(saved profile) returns null because the saved
    // profile is sparse (only 2 of 14 categories). No preset pill is active.
    await expect(
      section.locator(".privacy-profile-preset-pill.is-active")
    ).toHaveCount(0);

    // Click Strict — Settings keeps confirmOnPresetApply at its default
    // (true), so the inline bubble must appear before the profile is
    // replaced. The pill's aria-checked stays false until confirm.
    await strictPreset.click();

    const confirmBubble = section.locator(".privacy-profile-preset-confirm");
    await expect(confirmBubble).toBeVisible();
    await expect(strictPreset).not.toHaveClass(/is-active/);

    // Click Replace inside the bubble — the editor's Replace button
    // shares the bubble container, so locate it relative to the bubble
    // to avoid matching any other "Replace" buttons on the page.
    await confirmBubble.getByRole("button", { name: /replace/i }).click();

    // Bubble dismisses, Strict becomes active, and the per-row pills
    // update to Strict's tier map. Spot-check LOCATION (not_collected)
    // and CONTACT_INFO (not_linked) to prove the wholesale replace happened.
    await expect(confirmBubble).toHaveCount(0);
    await expect(strictPreset).toHaveClass(/is-active/);

    const locationRow = section.locator(".privacy-profile-strip-row").filter({
      has: page.getByRole("radiogroup", { name: /Location/i }),
    });
    await expect(
      locationRow.locator(
        '.privacy-profile-pill[data-tier="not_collected"].is-selected'
      )
    ).toHaveCount(1);

    const contactRow = section.locator(".privacy-profile-strip-row").filter({
      has: page.getByRole("radiogroup", { name: /Contact Info/i }),
    });
    await expect(
      contactRow.locator(
        '.privacy-profile-pill[data-tier="not_linked"].is-selected'
      )
    ).toHaveCount(1);

    // Final round-trip: the saved profile on the server should now be
    // a complete Strict profile (14 categories), not the sparse seed.
    // The editor debounces saves at 500 ms — wait that out plus a small
    // safety margin before reading the server state.
    await page.waitForTimeout(900);
    const verify = await request.get("/api/privacy-profile");
    await expect(verify).toBeOK();
    const body = (await verify.json()) as {
      profile: Record<string, string> | null;
    };
    expect(body.profile).not.toBeNull();
    expect(body.profile?.LOCATION).toBe("not_collected");
    expect(body.profile?.CONTACT_INFO).toBe("not_linked");
    expect(Object.keys(body.profile ?? {})).toHaveLength(14);

    // The save also writes a `profile_preset_applied` activity row so
    // users can trace why their mismatch counts shifted overnight. The
    // sparse seed in beforeEach didn't match a preset (so no row from
    // that PUT), and Strict definitely does — verify the top row of
    // the type-filtered feed captures the transition.
    const activityRes = await request.get(
      "/api/activity?type=profile_preset_applied&limit=5"
    );
    await expect(activityRes).toBeOK();
    const activity = (await activityRes.json()) as {
      rows: Array<{
        summary: string | null;
        detail: Record<string, unknown> | null;
      }>;
    };
    expect(activity.rows.length).toBeGreaterThan(0);
    expect(activity.rows[0].summary).toBe("Privacy profile changed to Strict");
    expect(activity.rows[0].detail).toMatchObject({ from: null, to: "strict" });
  }
);
