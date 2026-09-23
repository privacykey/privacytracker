import { expect, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test("stale section syncs the full stale subset, not only preview rows", async ({
  page,
  request,
}) => {
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
      accessibility: false,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();

  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  let triageReads = 0;
  await page.route("**/api/triage**", async (route) => {
    triageReads += 1;
    const response = await route.fetch();
    const data = await response.json();
    if (triageReads === 1) {
      data.stale = [{ ...data.higherRisk[0], lastSynced: old }];
      data.staleCount = 501;
      data.quiet = false;
    } else {
      data.stale = [];
      data.staleCount = 0;
      data.quiet = true;
    }
    await route.fulfill({ response, json: data });
  });

  const apps = Array.from({ length: 501 }, (_, index) => ({
    id: String(index + 1),
    url: `https://apps.apple.com/app/id${index + 1}`,
    lastSynced: old,
  }));
  apps.push({
    id: "502",
    url: "https://apps.apple.com/app/id502",
    lastSynced: Date.now(),
  });
  await page.route(/\/api\/apps\?/, async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        apps: apps.slice(offset, offset + limit),
        total: apps.length,
        offset,
        limit,
      }),
    });
  });
  const scrapedUrls: string[] = [];
  await page.route("**/api/scrape", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    scrapedUrls.push(...body.urls);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: body.urls.map(() => ({
          status: "success",
          changesDetected: false,
          changeCount: 0,
          versionChanged: false,
          currentVersion: null,
        })),
      }),
    });
  });

  await page.goto("/dashboard");
  const sync = page.getByRole("button", { name: "Sync 501 stale apps" });
  await expect(sync).toBeVisible();
  await sync.click();
  await expect(page.getByText("✓ Sync complete")).toBeVisible();
  expect(scrapedUrls).toEqual(apps.slice(0, 501).map((app) => app.url));
  await expect(page.locator(".home-section-stale")).toHaveCount(0);
});
