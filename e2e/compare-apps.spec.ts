import { expect, test } from '@playwright/test';

/**
 * E2E coverage for the side-by-side Compare apps view at
 * `/dashboard/compare?a=id:<id>&b=id:<id>`.
 *
 * The page reads both slots from query params; spec uses URL-direct
 * navigation (`a=id:X&b=id:Y`) rather than walking the AppGrid →
 * Compare-mode dock flow, because the URL path is the more stable
 * integration surface — refactors to the grid's compare-mode toggle
 * won't affect the comparison page's contract.
 *
 * `flag.page.compare` defaults to 'on' for the `self` audience, so
 * no focus elevation is needed beyond the standard seed.
 */

const sameOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  const reset = await request.post('/api/reset', { headers: sameOriginHeaders });
  await expect(reset).toBeOK();

  const focus = await request.post('/api/focus', {
    headers: sameOriginHeaders,
    data: {
      audience: 'self',
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Seed two canned apps so we have something to put in the two
  // comparison slots. limit=2 covers Instagram + TikTok by
  // SAMPLE_APPS order — two distinctly-shaped privacy footprints
  // gives the spec real data to assert on.
  const seed = await request.post(
    '/api/dev/seed-sample-data?source=canned&limit=2',
    { headers: sameOriginHeaders },
  );
  await expect(seed).toBeOK();
});

browserFlow('compare apps: side-by-side render with two seeded apps', async ({ page, request }) => {
  // Read seeded app rows so we have real IDs for the URL slots.
  // `/api/apps` returns a flat array of app rows (not wrapped).
  const appsRes = await request.get('/api/apps');
  await expect(appsRes).toBeOK();
  const apps = (await appsRes.json()) as Array<{ id: string; name: string }>;
  expect(apps.length).toBeGreaterThanOrEqual(2);

  const [appA, appB] = apps;
  await page.goto(`/dashboard/compare?a=id:${appA.id}&b=id:${appB.id}`);

  // Both app names render in the comparison header row. We don't
  // pin a specific selector for the header chrome (it has no test
  // id) — text presence is the user-visible promise.
  await expect(page.getByText(appA.name, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(appB.name, { exact: true }).first()).toBeVisible();

  // At least one category row should render. The canned Instagram
  // fixture collects Location in DATA_USED_TO_TRACK_YOU, so the
  // category label "Location" will appear in the grid. We don't
  // assert which row tier it lands in — just that the comparison
  // is populated, not blank.
  await expect(page.getByText('Location').first()).toBeVisible();
});
