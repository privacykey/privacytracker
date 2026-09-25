import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * Marking several apps at once from the apps grid: Select, pick two cards,
 * Mark safe, and both are marked safe on the server and on their cards;
 * Undo takes the marks back. Nothing else drives the bulk bar
 * through the UI; the suite runs on both servers (e2e on Node, e2e-rust on
 * the core).
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
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=3",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

/** The user's own verdict on an app, or null. */
async function verdictOf(
  request: APIRequestContext,
  appId: string
): Promise<string | null> {
  const res = await request.get(
    `/api/verdicts?appId=${encodeURIComponent(appId)}`,
    { headers: sameOriginHeaders }
  );
  await expect(res).toBeOK();
  const { verdicts } = (await res.json()) as {
    verdicts: Array<{ source: string; verdict: string }>;
  };
  return verdicts.find((v) => v.source === "user")?.verdict ?? null;
}

browserFlow(
  "bulk verdicts: select two apps in the grid, mark them safe, then undo",
  async ({ page, request }) => {
    await page.goto("/dashboard/apps");
    const cards = page
      .locator(".app-card")
      .filter({ hasNot: page.locator(".app-card-custom") });
    await expect(cards.nth(1)).toBeVisible();
    const ids: string[] = [];
    for (const i of [0, 1]) {
      const href =
        (await cards.nth(i).locator(".app-card-link").getAttribute("href")) ??
        "";
      const id = href.match(/\/apps\/([^/?#]+)/)?.[1];
      expect(id, `card ${i} links to an app`).toBeTruthy();
      ids.push(id as string);
    }
    for (const id of ids) {
      expect(await verdictOf(request, id)).toBeNull();
    }

    await page.getByRole("button", { name: "Select", exact: true }).click();
    const bar = page.getByRole("region", { name: "Bulk actions" });
    await expect(bar).toBeVisible();
    // In select mode a card link toggles the card instead of opening it.
    await cards.nth(0).locator(".app-card-link").click();
    await cards.nth(1).locator(".app-card-link").click();
    await expect(bar).toContainText("2 apps selected");

    // Up to ten apps apply at once; more ask to confirm first.
    await bar.getByRole("button", { name: /Mark safe/ }).click();

    // Marked on the server, and on the cards without a reload.
    for (const id of ids) {
      await expect.poll(() => verdictOf(request, id)).toBe("safe");
    }
    for (const i of [0, 1]) {
      await expect(cards.nth(i).locator(".verdict-pill")).toBeVisible();
    }

    // Undo takes both marks back, on the server and on the cards.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    for (const id of ids) {
      await expect.poll(() => verdictOf(request, id)).toBeNull();
    }
    for (const i of [0, 1]) {
      await expect(cards.nth(i).locator(".verdict-pill")).toHaveCount(0);
    }
  }
);
