import { expect, test } from '@playwright/test';

/**
 * E2E coverage for the AppGrid profile-mismatch filter on
 * `/dashboard/apps`. The filter is gated by:
 *
 *   - `flag.appgrid.filter.profile_mismatch` (turned on by the
 *     `declutter` goal — see GOAL_RULES.declutter)
 *   - the user has saved a privacy profile
 *   - at least one app's badge tier exceeds the saved profile
 *
 * The spec seeds canonical-identifier sample apps + a Strict profile,
 * navigates to the apps grid, captures the unfiltered card count,
 * clicks the mismatch toggle, and verifies the visible card count
 * drops to only the apps that actually mismatch the profile. The
 * canned Instagram fixture exceeds Strict at multiple tracked
 * categories, so it must remain visible after filtering — Notes /
 * Calendar / Weather (which collect almost nothing) should drop out.
 */

const sameOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const STRICT_PROFILE = {
  CONTACT_INFO: 'not_linked',
  HEALTH_AND_FITNESS: 'not_collected',
  FINANCIAL_INFO: 'not_linked',
  LOCATION: 'not_collected',
  SENSITIVE_INFO: 'not_collected',
  CONTACTS: 'not_collected',
  USER_CONTENT: 'not_linked',
  BROWSING_HISTORY: 'not_collected',
  SEARCH_HISTORY: 'not_linked',
  IDENTIFIERS: 'not_linked',
  PURCHASES: 'not_linked',
  USAGE_DATA: 'not_linked',
  DIAGNOSTICS: 'not_linked',
  OTHER: 'not_collected',
} as const;

test.beforeEach(async ({ request }) => {
  const reset = await request.post('/api/reset', { headers: sameOriginHeaders });
  await expect(reset).toBeOK();

  // declutter goal turns on flag.appgrid.filter.profile_mismatch via
  // GOAL_RULES.declutter; understand stays on as the primary goal.
  // accessibility=true keeps the privacy-profile onboarding flag on
  // for any indirect surface that needs it (the apps grid itself
  // doesn't gate on it, but it's harmless and matches the rest of
  // the suite).
  const focus = await request.post('/api/focus', {
    headers: sameOriginHeaders,
    data: {
      audience: 'self',
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  const profile = await request.put('/api/privacy-profile', {
    headers: sameOriginHeaders,
    data: { profile: STRICT_PROFILE },
  });
  await expect(profile).toBeOK();

  // Seed a few canned apps so we have a mix: Instagram (mismatches
  // heavily under Strict) + Notes/Calendar/Weather (collect almost
  // nothing → match Strict cleanly). limit=6 covers Instagram at
  // index 0 plus the low-collection Apple apps later in SAMPLE_APPS.
  const seed = await request.post(
    '/api/dev/seed-sample-data?source=canned&limit=10',
    { headers: sameOriginHeaders },
  );
  await expect(seed).toBeOK();
});

browserFlow('AppGrid profile-mismatch filter narrows the visible apps to those that exceed the profile', async ({ page }) => {
  await page.goto('/dashboard/apps');

  const cards = page.locator('.app-card').filter({ hasNot: page.locator('.app-card-custom') });

  // Capture the unfiltered count first. We don't pin a magic number
  // — the canned set is allowed to grow without breaking the spec —
  // we just need the BEFORE count to compare against AFTER.
  const beforeCount = await cards.count();
  expect(beforeCount).toBeGreaterThan(0);

  const mismatchToggle = page.locator('.mismatch-toggle');
  await expect(mismatchToggle).toBeVisible();
  // The badge count next to the label tells us how many cards should
  // remain after toggling. Read it before clicking to confirm the
  // grid wiring is sane.
  const expectedAfter = parseInt(
    (await mismatchToggle.locator('.mismatch-toggle-count').textContent()) ?? '0',
    10,
  );
  expect(expectedAfter).toBeGreaterThan(0);
  expect(expectedAfter).toBeLessThan(beforeCount);

  await mismatchToggle.click();
  await expect(mismatchToggle).toHaveAttribute('aria-pressed', 'true');

  // After filtering, only mismatched apps are visible. Card count
  // matches the toggle's pre-click count.
  await expect(cards).toHaveCount(expectedAfter);

  // Spot-check: Instagram (high-tracking under Strict) survives.
  await expect(
    cards.filter({ has: page.getByText('Instagram') }),
  ).toHaveCount(1);

  // And a low-collection Apple app drops out — Notes' fixture
  // collects only Diagnostics not_linked, which Strict allows.
  await expect(
    cards.filter({ has: page.getByText(/^Notes$/) }),
  ).toHaveCount(0);
});
