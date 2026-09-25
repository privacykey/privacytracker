import { expect, test } from "@playwright/test";

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
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

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

  // Seed two canned apps so we have something to put in the two
  // comparison slots. limit=2 covers Instagram + TikTok by
  // SAMPLE_APPS order — two distinctly-shaped privacy footprints
  // gives the spec real data to assert on.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=2",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

browserFlow(
  "compare apps: side-by-side render with two seeded apps",
  async ({ page, request }) => {
    // Read seeded app rows so we have real IDs for the URL slots.
    // `/api/apps` returns a flat array of app rows (not wrapped).
    const appsRes = await request.get("/api/apps");
    await expect(appsRes).toBeOK();
    const apps = (await appsRes.json()) as Array<{ id: string; name: string }>;
    expect(apps.length).toBeGreaterThanOrEqual(2);

    const [appA, appB] = apps;
    await page.goto(`/dashboard/compare?a=id:${appA.id}&b=id:${appB.id}`);

    // Both app names render in the comparison header row. We don't
    // pin a specific selector for the header chrome (it has no test
    // id) — text presence is the user-visible promise.
    await expect(
      page.getByText(appA.name, { exact: true }).first()
    ).toBeVisible();
    await expect(
      page.getByText(appB.name, { exact: true }).first()
    ).toBeVisible();

    // At least one category row should render. The canned Instagram
    // fixture collects Location in DATA_USED_TO_TRACK_YOU, so the
    // category label "Location" will appear in the grid. We don't
    // assert which row tier it lands in — just that the comparison
    // is populated, not blank.
    await expect(page.getByText("Location").first()).toBeVisible();
  }
);

browserFlow(
  "compare apps: the category matrix is a table with row and column headers",
  async ({ page, request }) => {
    const appsRes = await request.get("/api/apps");
    await expect(appsRes).toBeOK();
    const [appA, appB] = (await appsRes.json()) as Array<{
      id: string;
      name: string;
    }>;
    await page.goto(`/dashboard/compare?a=id:${appA.id}&b=id:${appB.id}`);

    // A screen reader reads the matrix as a table named for the two apps,
    // not one flat run of text, so it can announce "Location, row header"
    // and each app's column header as it moves across a row.
    const table = page.getByRole("table", {
      name: `Data categories collected by ${appA.name} and ${appB.name}`,
    });
    await expect(table).toBeVisible();
    const headers = table.getByRole("columnheader");
    await expect(headers.first()).toHaveText("Category");
    await expect(
      table.getByRole("columnheader", { name: appA.name, exact: true })
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: appB.name, exact: true })
    ).toBeVisible();

    const locationRow = table
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "Location" }) });
    await expect(locationRow).toHaveCount(1);
    // One rowheader plus one cell per app (no profile column: no profile
    // is set in this spec).
    await expect(locationRow.getByRole("cell")).toHaveCount(2);
    const headerCount = await headers.count();
    for (const row of await table.getByRole("row").all()) {
      const width =
        (await row.getByRole("rowheader").count()) +
        (await row.getByRole("cell").count()) +
        (await row.getByRole("columnheader").count());
      expect(width, "every row spans every column").toBe(headerCount);
    }
  }
);
