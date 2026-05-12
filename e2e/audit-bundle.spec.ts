import { expect, test, type Page } from '@playwright/test';

/**
 * E2E coverage for the audit-bundle round-trip — the full recommender
 * pattern. Walks through:
 *
 *   1. Set up a "recommender" state: loved_one audience (which turns
 *      on the export flag), Strict privacy profile, a couple of apps
 *      seeded from the offline canned fixture.
 *   2. Export the bundle via the API. The bundle's
 *      `recommender_profile_preset` field is computed by matchPreset
 *      against the saved Strict profile and lands inline.
 *   3. Drag-drop the bundle into the AuditBundleImport widget on the
 *      Settings page (file-input.setInputFiles is the standard
 *      Playwright pattern for hidden inputs that drag-drop targets).
 *   4. Verify the preview modal renders the new "Started from the
 *      Strict preset" line under the privacy-profile envelope row.
 *   5. Confirm the import and verify the result banner renders the new
 *      "Recommender used the Strict preset." line under the
 *      profile-stashed line.
 *
 * Coverage matters because the field is plumbed through three
 * boundaries (export → bundle JSON → import preview/commit) and the
 * unit tests cover each in isolation but not the round-trip. A
 * regression in any of the layers (build, route handler, importer,
 * UI) would slip through unit tests but break the user-visible
 * promise this spec encodes.
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

const RECOMMENDER_NAME = 'Test Recommender';

test.beforeEach(async ({ request }) => {
  // Reset to a clean slate. /api/reset wipes apps, snapshots, AND
  // app_settings — so focus + profile must be re-seeded after.
  const reset = await request.post('/api/reset', { headers: sameOriginHeaders });
  await expect(reset).toBeOK();

  // `loved_one` audience + accessibility modifier turns on
  // `flag.settings.admin.export.audit_bundle`, which the export API
  // gates on. Without it the export endpoint returns 403.
  const focus = await request.post('/api/focus', {
    headers: sameOriginHeaders,
    data: {
      audience: 'loved_one',
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Save a profile that exactly matches PROFILE_PRESETS.strict so the
  // exporter's matchPreset() returns 'strict' and the bundle carries
  // recommender_profile_preset = 'strict'.
  const profile = await request.put('/api/privacy-profile', {
    headers: sameOriginHeaders,
    data: { profile: STRICT_PROFILE },
  });
  await expect(profile).toBeOK();

  // Seed offline canned sample apps so the bundle has real apps in it
  // (validateBundle accepts an empty `apps: []` array, but a populated
  // bundle exercises more of the importer's per-app code paths).
  const seed = await request.post(
    '/api/dev/seed-sample-data?source=canned&limit=2',
    { headers: sameOriginHeaders },
  );
  await expect(seed).toBeOK();
});

/**
 * Utility: drop the bundle JSON onto the import widget by attaching it
 * directly to the hidden <input type="file"> the drop zone wraps.
 * Setting files on hidden inputs is supported by Playwright and is
 * the standard pattern when an app's drag-drop UI delegates to a
 * hidden input via click handlers.
 */
async function attachBundle(page: Page, bundleJson: string) {
  const fileInput = page.locator(
    '.audit-bundle-import input[type="file"][accept*="json"]',
  );
  await fileInput.setInputFiles({
    name: 'recommender-test.audit.json',
    mimeType: 'application/json',
    buffer: Buffer.from(bundleJson),
  });
}

browserFlow('audit-bundle round-trip: export carries the Strict preset and the import UI surfaces it', async ({ page, request }) => {
  // Step 1 — Export the bundle. The body sets a recommenderName so
  // the post-import banner has a person to attribute the preset to.
  const exportRes = await request.post('/api/export/audit-bundle', {
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    data: {
      recommenderName: RECOMMENDER_NAME,
      includeRecommenderProfile: true,
    },
  });
  await expect(exportRes, 'export endpoint must succeed under loved_one focus').toBeOK();
  const bundleJson = await exportRes.text();

  // Sanity check before we hand the bundle to the UI: the field we
  // care about must be present and equal to 'strict'. If this fails,
  // the export side is broken and the UI assertions below would mask
  // the real issue.
  const parsed = JSON.parse(bundleJson) as {
    recommender_profile_preset?: string | null;
    recommender_profile?: Record<string, string> | null;
    recommender_name?: string | null;
  };
  expect(parsed.recommender_profile_preset).toBe('strict');
  expect(parsed.recommender_profile?.LOCATION).toBe('not_collected');
  expect(parsed.recommender_name).toBe(RECOMMENDER_NAME);

  // Step 2 — Drive the import UI. Navigate to Settings, drop the bundle.
  await page.goto('/dashboard/settings');

  // Wait for the widget container to mount before attaching the file.
  // setInputFiles auto-waits on the locator existing, but it doesn't
  // wait for the React component that owns the file input to finish
  // hydrating — without an explicit visibility wait, attachBundle can
  // run before the drop-handler is wired and the dropped bytes go
  // nowhere. We deliberately don't scrollIntoViewIfNeeded here:
  // Settings re-renders during hydration and a chained scroll races
  // the re-renders ("Element is not attached to the DOM").
  await expect(page.locator('.audit-bundle-import').first()).toBeVisible();

  await attachBundle(page, bundleJson);

  // Step 3 — Verify the preview modal renders our preset line. The
  // modal is a role="dialog" with the bundle envelope as a list.
  const modal = page.locator('.modal-card[role="dialog"]');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.audit-bundle-import__envelope-preset')).toContainText(/Strict/i);

  // Step 4 — Commit the import. The button label varies depending on
  // dedup state ("Import bundle" / "Re-import anyway"); match either.
  await modal.getByRole('button', { name: /import bundle|re.import/i }).click();

  // Step 5 — Verify the result banner shows the "{name} used the
  // Strict preset" line. The result region picks up role=status, so
  // we scope on its container class to avoid matching any other
  // status regions (toast, etc.) on Settings.
  const result = page.locator('.audit-bundle-import__result');
  await expect(result).toBeVisible();
  await expect(result).toContainText(new RegExp(`${RECOMMENDER_NAME}.*Strict.*preset`, 'i'));
});

// ---------------------------------------------------------------------------
// Spec: drive the export side via the AuditBundleExport UI in Settings
// ---------------------------------------------------------------------------
//
// The round-trip spec above exercises the export endpoint directly
// (`POST /api/export/audit-bundle`) so it can hand the bundle to the
// import widget in one test. This spec covers the OTHER side: the
// click-button → fill-form → trigger-download flow that a real
// loved_one-audience user would walk through. We use Playwright's
// download-event hook to capture the file the browser would save,
// parse it back into JSON, and assert the bundle shape — same final
// invariant the round-trip spec asserts on, just reached via the UI.

const EXPORT_RECOMMENDER_NAME = 'Settings UI Recommender';

browserFlow('audit-bundle export UI: form submission triggers a download with the right bundle', async ({ page }) => {
  await page.goto('/dashboard/settings');

  // Open the export panel.
  const openBtn = page.locator('.audit-bundle-export__open-btn');
  await expect(openBtn).toBeVisible();
  await openBtn.click();

  const panel = page.locator('.audit-bundle-export');
  await expect(panel).toBeVisible();

  await panel.locator('.audit-bundle-export__field-input').fill(EXPORT_RECOMMENDER_NAME);
  // includeProfile defaults true — leave it; the bundle should carry
  // the Strict preset key seeded in beforeEach.

  // Wire up the download capture BEFORE the click — Playwright
  // subscribes synchronously and resolves with the Download once
  // the browser fires the save-file dialog. Then click the
  // primary-action button inside the panel.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', { name: /^Export$/ }).click(),
  ]);

  // The server sets Content-Disposition with a generated filename;
  // it always ends in `.audit.json`.
  expect(download.suggestedFilename()).toMatch(/\.audit\.json$/);

  // Read the saved file and parse it back as JSON. Playwright stores
  // downloads in a temp location; `path()` resolves to it.
  const filePath = await download.path();
  expect(filePath, 'expected the download to land on disk').toBeTruthy();
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(filePath as string, 'utf8');
  const bundle = JSON.parse(text) as {
    version: number;
    recommender_name: string | null;
    recommender_profile_preset: string | null;
    apps: unknown[];
  };

  expect(bundle.version).toBe(2);
  expect(bundle.recommender_name).toBe(EXPORT_RECOMMENDER_NAME);
  expect(bundle.recommender_profile_preset).toBe('strict');
  expect(Array.isArray(bundle.apps)).toBe(true);

  // After a successful export the panel collapses back to the button
  // so the user knows the action completed.
  await expect(panel).toHaveCount(0);
  await expect(openBtn).toBeVisible();
});
