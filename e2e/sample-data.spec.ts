import { expect, test } from '@playwright/test';

/**
 * E2E coverage for the "Try with sample data" entry point on
 * /welcome. The button calls `seedSampleApps()` to populate
 * `sessionStorage['sample_apps']` with 10 canned demo apps and routes
 * to `/dashboard?sample=1`, where `SampleModeView` reads the
 * sessionStorage payload and renders one `<article class="sample-app-card">`
 * per app.
 *
 * The spec validates the welcome → dashboard transition and proves
 * the demo apps reach the screen — it doesn't assert on the
 * mismatch UX because `SampleAppCard` doesn't currently render
 * privacyTypes (it shows the AI summary text instead). If that ever
 * lands, this spec becomes the natural place to add per-card
 * mismatch assertions.
 */

const sameOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  // Reset so the welcome page actually renders for first-time users
  // rather than redirecting to a populated dashboard.
  const reset = await request.post('/api/reset', { headers: sameOriginHeaders });
  await expect(reset).toBeOK();
});

browserFlow('Try with sample data: welcome → /dashboard?sample=1 with canned apps rendered', async ({ page }) => {
  await page.goto('/welcome');

  // The "Try with sample data" button is gated by
  // flag.onboarding.sample_data_button, which defaults 'on'. Click it
  // and wait for the navigation it triggers.
  await page.locator('.welcome-sample-data').click();
  await page.waitForURL(/\/dashboard\?sample=1$/);

  // SampleModeView mounts and reads the seeded sessionStorage payload.
  // The grid container + at least one card should render — Instagram
  // is at index 0 of SAMPLE_APPS so it always shows first.
  await expect(page.locator('.sample-app-grid')).toBeVisible();

  const cards = page.locator('.sample-app-card');
  // The fixture is 10 apps — assert ≥1 rather than exact-match so a
  // future fixture trim doesn't break this spec.
  await expect(cards.first()).toBeVisible();

  // Spot-check that Instagram (a known fixture) is among the rendered
  // cards. This proves the sessionStorage write + read path is wired
  // correctly, not just that the grid container exists.
  await expect(
    cards.filter({ has: page.getByRole('heading', { name: 'Instagram' }) }),
  ).toHaveCount(1);
});
