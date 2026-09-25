import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * Names the App Store does not know, saved as manual apps from onboarding's
 * match step: each row picks a source or Skip, the button saves the rows
 * that are not skipped, and exactly those land as manual apps. In the dev
 * preview (`?preview=fresh`), whose banner promises nothing gets saved,
 * the same click writes nothing. App Store search is mocked in the
 * browser; the manual-app writes are real, on both servers.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const CLOCK = {
  appleId: "1584215688",
  name: "Clock",
  developer: "Apple",
  iconUrl:
    "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/clock.png/100x100bb.jpg",
  url: "https://apps.apple.com/us/app/clock/id1584215688",
  bundleId: "com.apple.mobiletimer",
};

/** Clock matches; every other name comes back with no candidates. */
async function mockSearch(page: Page) {
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: Array<{ name?: string }>;
    };
    const results = (body.rows ?? []).map((row) => {
      const query = (row.name ?? "").trim();
      return {
        query,
        candidates: query === "Clock" ? [{ ...CLOCK, searchQuery: query }] : [],
      };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results }),
    });
  });
}

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
});

/** Walk the wizard to the match step with these names typed in. */
async function matchStep(page: Page, url: string, names: string[]) {
  await mockSearch(page);
  await page.goto(url);
  await page.getByText("Other import options").click();
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manualCard.click();
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
  await page.getByTestId("onboard-app-names").fill(names.join("\n"));
  await page.getByTestId("imported-apps-add").click();
  await page.getByTestId("onboard-search").click();
}

async function manualApps(
  request: APIRequestContext
): Promise<Array<{ name: string; source: string }>> {
  const res = await request.get("/api/manual-apps", {
    headers: sameOriginHeaders,
  });
  await expect(res).toBeOK();
  return (
    (await res.json()) as { apps: Array<{ name: string; source: string }> }
  ).apps;
}

browserFlow(
  "manual apps: unmatched names save as manual apps, skipped rows are left out",
  async ({ page, request }) => {
    await matchStep(page, "/onboard", [
      "Clock",
      "Company Portal Beta",
      "Home Screen Bookmark",
    ]);
    await page.getByLabel("Save as").nth(0).selectOption("testflight");
    await page.getByLabel("Save as").nth(1).selectOption("skip");

    // The button counts what it will save, not every row in the section.
    const save = page.getByRole("button", { name: /as manual apps/ });
    await expect(save).toHaveText("Save 1 as manual apps");
    await save.click();
    await expect(page.getByText(/^Saved 1 as manual apps/)).toBeVisible();
    // A saved row was handled, not skipped: no Skipped section lists it.
    await expect(page.getByRole("heading", { name: "Skipped" })).toHaveCount(0);

    const saved = await manualApps(request);
    expect(saved.map((app) => [app.name, app.source])).toEqual([
      ["Company Portal Beta", "testflight"],
    ]);
  }
);

browserFlow(
  "manual apps: the dev preview saves nothing, as its banner promises",
  async ({ page, request }) => {
    await matchStep(page, "/onboard?preview=fresh", [
      "Clock",
      "Company Portal Beta",
    ]);
    await expect(page.getByText(/nothing gets saved/)).toBeVisible();
    await page.getByRole("button", { name: /as manual apps/ }).click();
    // With every unmatched row saved, the section stays to say so.
    await expect(page.getByText(/^Saved 1 as manual apps/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Skipped" })).toHaveCount(0);
    expect(await manualApps(request)).toEqual([]);
  }
);
