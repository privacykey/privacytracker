import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * Start over, end to end: the two confirmations in Settings wipe every
 * tracked app, the privacy profile, the focus and the notifications, the
 * browser lands on the welcome screen, and the activity row the route writes
 * after the wipe is what the log holds. Nothing else drives this through the
 * UI; the suite runs on both servers (e2e on Node, e2e-rust on the core), so
 * this covers both implementations of the wipe.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

/** A complete profile, so the save is accepted as it stands. */
const PROFILE = {
  CONTACT_INFO: "not_linked",
  HEALTH_AND_FITNESS: "not_collected",
  FINANCIAL_INFO: "not_linked",
  LOCATION: "not_collected",
  SENSITIVE_INFO: "not_collected",
  CONTACTS: "not_collected",
  USER_CONTENT: "not_linked",
  BROWSING_HISTORY: "not_collected",
  SEARCH_HISTORY: "not_linked",
  IDENTIFIERS: "not_linked",
  PURCHASES: "not_linked",
  USAGE_DATA: "not_linked",
  DIAGNOSTICS: "not_linked",
  OTHER: "not_collected",
} as const;

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
  const profile = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: { profile: PROFILE },
  });
  await expect(profile).toBeOK();
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=3",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

async function read<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: sameOriginHeaders });
  await expect(res).toBeOK();
  return (await res.json()) as T;
}

interface ActivityRow {
  detail: { mode?: string } | null;
  type: string;
}

browserFlow(
  "start over: two confirmations in Settings wipe the data and land on the welcome screen",
  async ({ page, request }) => {
    // What there is to wipe.
    expect(
      (await read<unknown[]>(request, "/api/apps")).length
    ).toBeGreaterThan(0);
    expect(
      (await read<{ profile: unknown }>(request, "/api/privacy-profile"))
        .profile
    ).not.toBeNull();
    expect(
      (await read<{ audienceSet: boolean }>(request, "/api/focus")).audienceSet
    ).toBe(true);
    const seeded = await read<{ rows: ActivityRow[] }>(
      request,
      "/api/activity?limit=50"
    );
    expect(seeded.rows.length).toBeGreaterThan(0);

    await page.goto("/dashboard/settings/admin#reset");
    const section = page.locator("#reset");
    await section
      .getByRole("button", { name: "Start over", exact: true })
      .click();
    await section.getByRole("button", { name: "Yes, start over" }).click();
    await section.getByRole("button", { name: /wipe everything/ }).click();
    await page.waitForURL("**/welcome");

    // What the route promises to wipe.
    expect(await read<unknown[]>(request, "/api/apps")).toEqual([]);
    expect(
      (await read<{ profile: unknown }>(request, "/api/privacy-profile"))
        .profile
    ).toBeNull();
    expect(
      (await read<{ audienceSet: boolean }>(request, "/api/focus")).audienceSet
    ).toBe(false);
    expect(
      (await read<{ notifications: unknown[] }>(request, "/api/notifications"))
        .notifications
    ).toEqual([]);
    const { rows } = await read<{ rows: ActivityRow[] }>(
      request,
      "/api/activity?limit=50"
    );
    // The seed's rows went with the wipe; the route's own row came after.
    expect(rows.map((r) => [r.type, r.detail?.mode])).toEqual([
      ["reset", "start-over"],
    ]);
  }
);
