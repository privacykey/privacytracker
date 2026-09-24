import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * Saving an alternative from Compare and managing it on the shortlist
 * page, end to end: with a tracked app in slot A, search the App Store
 * from slot B, shortlist a result against the tracked app, find it on
 * /dashboard/shortlist and remove it there. App Store search is mocked in
 * the browser, so the spec never reaches Apple; the shortlist writes are
 * real, and the suite runs on both servers (e2e on Node, e2e-rust on the
 * core).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const CANDIDATE = {
  appleId: "874139669",
  name: "Signal - Private Messenger",
  developer: "Signal Messenger, LLC",
  iconUrl:
    "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/signal.png/100x100bb.jpg",
  url: "https://apps.apple.com/us/app/signal-private-messenger/id874139669",
  bundleId: "org.whispersystems.signal",
};

/** Compare's App Store search sends `{ names: [query] }`. */
async function mockSearch(page: Page) {
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as { names?: string[] };
    const query = body.names?.[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          { query, candidates: [{ ...CANDIDATE, searchQuery: query }] },
        ],
      }),
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
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=3",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

async function pairs(
  request: APIRequestContext
): Promise<Array<{ candidateAppleId: string; sourceAppId: string }>> {
  const res = await request.get("/api/shortlist", {
    headers: sameOriginHeaders,
  });
  await expect(res).toBeOK();
  return ((await res.json()) as { pairs: never[] }).pairs;
}

browserFlow(
  "shortlist: save an App Store alternative from Compare, then remove it from the shortlist page",
  async ({ page, request }) => {
    const appsRes = await request.get("/api/apps", {
      headers: sameOriginHeaders,
    });
    await expect(appsRes).toBeOK();
    const [source] = (await appsRes.json()) as Array<{ id: string }>;
    expect(source).toBeTruthy();
    expect(await pairs(request)).toEqual([]);

    await mockSearch(page);
    await page.goto(`/dashboard/compare?a=id:${source.id}`);
    await page.getByRole("button", { name: "Pick an app for App B" }).click();
    await page.getByRole("button", { name: "App Store", exact: true }).click();
    await page.getByPlaceholder(/Search the App Store/).fill("Signal");
    const save = page.getByRole("button", { name: "+ Shortlist" }).first();
    await save.click();
    await expect(
      page.getByRole("button", { name: "★ Saved" }).first()
    ).toBeVisible();
    await expect
      .poll(() => pairs(request))
      .toEqual([
        { candidateAppleId: CANDIDATE.appleId, sourceAppId: source.id },
      ]);

    // The shortlist page lists it, and removing it there empties both.
    await page.goto("/dashboard/shortlist");
    await expect(page.getByText(CANDIDATE.name).first()).toBeVisible();
    await page
      .getByRole("button", { name: `Remove ${CANDIDATE.name} from shortlist` })
      .click();
    await expect.poll(() => pairs(request)).toEqual([]);
    await expect(page.getByText("Nothing shortlisted yet.")).toBeVisible();
  }
);
