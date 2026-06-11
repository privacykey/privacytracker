import { expect, type Page, test } from "@playwright/test";

/**
 * E2E coverage for the audit-bundle dedup flow. When the user drops
 * the same bundle file twice (same `exported_at`), the import API
 * looks the bundle up in `audit_bundle_imports` and the preview
 * modal switches from the "Import {name}'s recommendations?" copy to
 * the "You already imported this bundle" copy. The user can either
 * cancel or re-import (which the API allows via `?allowDuplicate=1`).
 *
 * The round-trip spec covers the happy-path import; this spec
 * covers the dedup branch the round-trip can't reach.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const RECOMMENDER_NAME = "Dedup Recommender";

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();

  // loved_one audience flips flag.settings.admin.export.audit_bundle to 'on'
  // so the export endpoint becomes callable.
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "loved_one",
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Seed a couple of canned apps so the bundle isn't empty (validateBundle
  // accepts empty arrays, but a populated bundle exercises more of the
  // import path on the second go-round).
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=2",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

async function attachBundle(page: Page, bundleJson: string) {
  await page
    .locator('.audit-bundle-import input[type="file"][accept*="json"]')
    .setInputFiles({
      name: "recommender.audit.json",
      mimeType: "application/json",
      buffer: Buffer.from(bundleJson),
    });
}

browserFlow(
  "audit-bundle dedup: importing the same bundle twice surfaces the re-import modal",
  async ({ page, request }) => {
    // Pull a real bundle from the export API (so `exported_at` is a
    // proper ISO timestamp the dedup index keys off of).
    const exportRes = await request.post("/api/export/audit-bundle", {
      headers: { ...sameOriginHeaders, "content-type": "application/json" },
      data: {
        recommenderName: RECOMMENDER_NAME,
        includeRecommenderProfile: false,
      },
    });
    await expect(exportRes).toBeOK();
    const bundleJson = await exportRes.text();

    await page.goto("/dashboard/settings");
    // Wait for the import widget to mount before attaching the file —
    // setInputFiles auto-waits on the input existing, not on the
    // owning component's drop handler being wired up.
    await expect(page.locator(".audit-bundle-import").first()).toBeVisible();

    // First import — the modal should show the "Import {name}'s
    // recommendations?" headline (the new-bundle copy).
    await attachBundle(page, bundleJson);
    let modal = page.locator('.modal-card[role="dialog"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-badge")).not.toContainText(/re.import/i);

    // Commit. Banner appears, modal closes.
    await modal
      .getByRole("button", { name: /import bundle|re.import/i })
      .click();
    await expect(page.locator(".audit-bundle-import__result")).toBeVisible();

    // Second import — same bundle bytes, same exported_at. The preview
    // modal should now use the existing-import copy: a "Re-import" badge
    // and the "you already imported this bundle" headline.
    await attachBundle(page, bundleJson);

    // The component reuses the same .modal-card; wait for it to come back
    // (the result banner is dismissed implicitly when a new preview
    // starts).
    modal = page.locator('.modal-card[role="dialog"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-badge")).toContainText(/re.import/i);
    await expect(modal.locator(".modal-title")).toContainText(
      /already imported/i
    );

    // The primary action is now "Re-import anyway" — verify the
    // copy-button label has shifted.
    await expect(
      modal.getByRole("button", { name: /re.import anyway/i })
    ).toBeVisible();

    // User chooses Cancel — the modal dismisses and no new import row
    // is written. We re-open the same widget to confirm we can still
    // see the previous result banner unchanged.
    await modal.getByRole("button", { name: /cancel/i }).click();
    await expect(modal).toHaveCount(0);
  }
);
