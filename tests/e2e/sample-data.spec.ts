import { expect, type Page, test } from "@playwright/test";

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
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  // Reset so the welcome page actually renders for first-time users
  // rather than redirecting to a populated dashboard.
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
});

browserFlow(
  "Try with sample data: welcome → /dashboard?sample=1 with canned apps rendered",
  async ({ page, request }) => {
    await page.goto("/welcome");

    // Preview carries the user's current form choices and only opens after
    // the focus write succeeds. A failed first write leaves the form intact.
    await page
      .getByRole("button", { name: /Monitor my apps for changes/ })
      .click();
    await page.getByRole("button", { name: /Clean up my phone/ }).click();
    await page.getByRole("radio", { name: /For a child or dependant/ }).click();
    let writes = 0;
    await page.route("**/api/focus", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      writes += 1;
      if (writes === 1) {
        await route.fulfill({
          status: 503,
          body: JSON.stringify({ error: "Please retry" }),
        });
      } else {
        await route.continue();
      }
    });
    await page.locator(".welcome-sample-data").click();
    await expect(page.locator(".welcome-error")).toContainText("Please retry");
    await expect(page).toHaveURL(/\/welcome$/);
    expect(
      await page.evaluate(() => sessionStorage.getItem("sample_apps"))
    ).toBeNull();
    await page.locator(".welcome-sample-data").click();
    await page.waitForURL(/\/dashboard\?sample=1$/);
    const savedFocus = await request.get("/api/focus");
    await expect(savedFocus).toBeOK();
    const focus = await savedFocus.json();
    expect(focus).toMatchObject({
      audience: "guardian",
      monitor: false,
      cleanup: true,
    });

    // SampleModeView mounts and reads the seeded sessionStorage payload.
    // The grid container + at least one card should render — Instagram
    // is at index 0 of SAMPLE_APPS so it always shows first.
    await expect(page.locator(".sample-app-grid")).toBeVisible();

    const cards = page.locator(".sample-app-card");
    // The fixture is 10 apps — assert ≥1 rather than exact-match so a
    // future fixture trim doesn't break this spec.
    await expect(cards.first()).toBeVisible();

    // Spot-check that Instagram (a known fixture) is among the rendered
    // cards. This proves the sessionStorage write + read path is wired
    // correctly, not just that the grid container exists.
    await expect(
      cards.filter({ has: page.getByRole("heading", { name: "Instagram" }) })
    ).toHaveCount(1);
  }
);

// ---------------------------------------------------------------------------
// Sample mode has a way out, and nothing in it leaves silently
// ---------------------------------------------------------------------------
//
// The demo used to have no exit, and every nav link sent a fresh user to
// /onboard (the real pages bounce an empty install there) without saying
// why. The sample page now carries a bar with "Start with your own apps"
// (clears the demo, opens onboarding) and "Back to welcome", and its nav
// only links back into the demo or out through those two exits.

async function openSampleMode(page: Page) {
  await page.goto("/welcome");
  await page.locator(".welcome-sample-data").click();
  await page.waitForURL(/\/dashboard\?sample=1$/);
  await expect(page.locator(".sample-app-card").first()).toBeVisible();
}

browserFlow(
  "sample mode: every link stays in the demo or is a named exit",
  async ({ page }) => {
    await openSampleMode(page);

    const bar = page.getByRole("region", { name: "Sample data" });
    await expect(bar).toBeVisible();
    await expect(
      bar.getByRole("link", { name: "Start with your own apps" })
    ).toBeVisible();
    await expect(
      bar.getByRole("link", { name: "Back to welcome" })
    ).toBeVisible();

    // The nav no longer offers Apps / Settings / etc., which would bounce
    // to onboarding without a word. What is left goes back into the demo
    // or out through an exit that says where it goes.
    const hrefs = await page
      .locator("nav a[href]")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(["/dashboard?sample=1", "/onboard", "/welcome"]).toContain(href);
    }

    // The exit stays on screen while scrolling through the demo.
    await page.mouse.wheel(0, 4000);
    await expect(
      page
        .getByRole("navigation")
        .getByRole("link", { name: "Start with your own apps" })
    ).toBeInViewport();
  }
);

browserFlow(
  "sample mode: Start with your own apps clears the demo and opens onboarding",
  async ({ page }) => {
    await openSampleMode(page);
    await page
      .getByRole("region", { name: "Sample data" })
      .getByRole("link", { name: "Start with your own apps" })
      .click();
    await page.waitForURL(/\/onboard$/);
    expect(
      await page.evaluate(() => sessionStorage.getItem("sample_apps"))
    ).toBeNull();
  }
);

browserFlow(
  "sample mode: Back to welcome returns to the welcome page",
  async ({ page }) => {
    await openSampleMode(page);
    await page
      .getByRole("region", { name: "Sample data" })
      .getByRole("link", { name: "Back to welcome" })
      .click();
    await page.waitForURL(/\/welcome$/);
    await expect(page.locator(".welcome-sample-data")).toBeVisible();
  }
);
