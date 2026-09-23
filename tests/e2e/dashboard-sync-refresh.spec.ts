import { expect, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test("dashboard reloads triage after a completed bulk sync", async ({
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

  let triageReads = 0;
  await page.route("**/api/triage**", async (route) => {
    triageReads += 1;
    const response = await route.fetch();
    const data = await response.json();
    if (triageReads > 1) {
      data.stale = [data.higherRisk[0]];
      data.staleCount = 1;
      data.quiet = false;
    }
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/scrape", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
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
  await expect(page.getByRole("button", { name: /Re-sync now/ })).toBeVisible();
  expect(triageReads).toBe(1);
  await page.getByRole("button", { name: /Re-sync now/ }).click();
  await expect(page.getByText("✓ Sync complete")).toBeVisible();
  await expect.poll(() => triageReads).toBeGreaterThan(1);
  await expect(page.locator(".home-section-stale")).toBeVisible();
});
