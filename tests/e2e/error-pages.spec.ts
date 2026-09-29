import { expect, test } from "@playwright/test";
import { expectNoBlockingViolations } from "./helpers/axe";

/**
 * A page that throws while it renders lands on app/error.tsx, not on
 * Next's bare "Application error: a client-side exception has occurred".
 *
 * The throw is forced from the test alone, with no test route or page in
 * the app: the browser's /api/stats request is answered with an empty
 * object, and StatsView reads `stats.recentChanges.filter(...)` during
 * render. Un-routing the request and pressing Try again must bring the
 * real page back, which proves the button re-renders the page rather
 * than leaving the reader stuck.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

// Only the stats summary itself, not /api/stats/timeline and friends.
const STATS_SUMMARY = /\/api\/stats(\?|$)/;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();

  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // RequireAppsGate sends an empty install to onboarding, so the page
  // needs apps before it renders StatsView at all.
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
});

browserFlow(
  "a render error shows the error page, and Try again recovers",
  async ({ page }) => {
    await page.route(STATS_SUMMARY, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      })
    );

    await page.goto("/dashboard/stats");

    const card = page.locator(".app-error-card");
    await expect(card).toBeVisible();
    await expect(
      card.getByRole("heading", { level: 1, name: "This page stopped working" })
    ).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);

    // It renders inside the app's chrome: the main landmark and the footer
    // links are still there.
    await expect(page.locator("#main-content .app-error-card")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Privacy policy" }).first()
    ).toBeVisible();

    await expect(card.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/"
    );

    // The report link fills in the path only: no host, no query string.
    const report = card.getByRole("link", {
      name: "Report this problem on GitHub",
    });
    await expect(report).toHaveAttribute(
      "href",
      /current-url=%2Fdashboard%2Fstats(&|$)/
    );
    const href = (await report.getAttribute("href")) ?? "";
    expect(new URL(href).hostname).toBe("github.com");
    expect(href).not.toContain("127.0.0.1");

    await expectNoBlockingViolations(page, "error-page");

    await page.unroute(STATS_SUMMARY);
    await card.getByTestId("app-error-retry").click();

    await expect(page.locator(".stat-cards")).toBeVisible();
    await expect(card).toHaveCount(0);
  }
);
