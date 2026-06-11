import { expect, test } from "@playwright/test";

/**
 * Settings → Deployment & diagnostics while the non-local admin gate is
 * closed.
 *
 * proxy.ts rejects GET /api/deployment/diagnostics (and
 * /api/backup/snapshots) with 401 for non-local hosts without the admin
 * token. The deployment card is the login destination every blocked
 * surface links to (the read-only banner, the onboarding search error,
 * the task-mutation alert) — so when the diagnostics read itself is
 * rejected, the section must render the locked explanation WITH the
 * unlock form, not the generic "unable to load" dead end it used to.
 *
 * The gate states are simulated via route interception (the e2e server
 * is loopback, so the real gate never fires here):
 *   - /api/deployment/diagnostics + /api/backup/snapshots → 401
 *   - /api/auth/admin-token/status → { configured: true, unlocked: false }
 */

const sameOriginHeaders = {
  origin: "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  // /dashboard/settings server-redirects to /onboard when the DB has no
  // apps — seed one so the page renders. Mirrors profile-presets.spec.ts.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=1",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

browserFlow(
  "locked deployment card renders the admin-token unlock form",
  async ({ page }) => {
    await page.route("**/api/deployment/diagnostics", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Admin token required for non-local API access",
        }),
      })
    );
    await page.route("**/api/backup/snapshots", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Admin token required for non-local API access",
        }),
      })
    );
    await page.route("**/api/auth/admin-token/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: true, unlocked: false }),
      })
    );

    await page.goto("/dashboard/settings#deployment-diagnostics");

    const section = page.locator("#deployment-diagnostics");
    await expect(section).toBeVisible();

    // Locked explanation instead of the generic load failure...
    await expect(
      section.getByText("Locked — admin token required")
    ).toBeVisible();
    // ...with a usable login form (the old behaviour nested the form
    // inside the diagnostics success branch, so it never rendered here).
    await expect(
      section.getByPlaceholder("Paste token for this session")
    ).toBeVisible();
    const unlock = section.getByRole("button", { name: "Unlock session" });
    await expect(unlock).toBeVisible();
    // Disabled until a token is typed.
    await expect(unlock).toBeDisabled();
    await section
      .getByPlaceholder("Paste token for this session")
      .fill("some-token");
    await expect(unlock).toBeEnabled();
  }
);
