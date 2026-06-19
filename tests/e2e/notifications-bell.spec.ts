import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the notifications bell — DB row → badge count →
 * dropdown → auto-mark-as-read on open.
 *
 * Notifications are normally produced by the change-detection path
 * inside `lib/changelog.ts`, which only fires after the scraper sees
 * an actual diff against apps.apple.com. That round-trip can't be
 * mocked from a Playwright spec (server-side fetches are out of
 * reach), so we use the dev-mode seeding endpoint
 * `/api/dev/seed-notification` which calls `createNotification`
 * directly — same insert path the production code uses, just
 * triggered by an HTTP body instead of a real change diff.
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

  // Seed one canned app so the notification's app_id resolves to a
  // real row when the dropdown's notification item links into the
  // detail page (avoids a 404 from the link target). The notification
  // we'll seed below references this app.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=1",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

browserFlow(
  "notifications bell: seed → badge shows 1 → opening clears the badge",
  async ({ page, request }) => {
    // Read back the seeded app id so the notification points at a real
    // row. /api/apps returns the rows flat (not wrapped in {apps: [...]});
    // we don't care which canned app it is — the first one is Instagram
    // by SAMPLE_APPS order.
    const appsRes = await request.get("/api/apps");
    await expect(appsRes).toBeOK();
    const apps = (await appsRes.json()) as Array<{ id: string; name: string }>;
    const firstApp = apps[0];
    expect(firstApp, "expected at least one seeded app").toBeDefined();

    // Seed a single notification via the dev endpoint.
    const seedNotif = await request.post("/api/dev/seed-notification", {
      headers: { ...sameOriginHeaders, "content-type": "application/json" },
      data: {
        appId: firstApp!.id,
        appName: firstApp!.name,
        changes: [
          {
            type: "category_added",
            description: `${firstApp!.name} now collects Health & Fitness data`,
          },
        ],
      },
    });
    await expect(seedNotif).toBeOK();

    // Land on the dashboard. The bell polls `/api/notifications` on
    // mount; the badge should reflect the unread row.
    await page.goto("/dashboard");

    const bell = page.locator(".notif-bell-btn");
    await expect(bell).toBeVisible();

    const badge = page.locator(".notif-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");

    // Click the bell — auto-mark-as-read POST fires (`{action:'mark_read'}`),
    // server flips read=1 across all rows, client setUnread(0) makes the
    // badge unmount.
    await bell.click();

    const dropdown = page.locator("#notif-dropdown");
    await expect(dropdown).toBeVisible();

    // The seeded notification's row appears inside the dropdown list.
    // We don't assert a specific class on the row — the bell's row
    // selectors vary by notification type — just look for the
    // change-summary text we seeded.
    await expect(dropdown).toContainText(/now collects Health & Fitness/);

    // Badge unmounts after auto-mark-as-read. The locator should
    // resolve to zero elements (not just invisible).
    await expect(badge).toHaveCount(0);
  }
);
