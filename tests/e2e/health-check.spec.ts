import { expect, test } from "@playwright/test";

/**
 * E2E for the periodic health-check endpoint (`lib/health-check.ts`,
 * `app/api/diagnostics/health/route.ts`). Runs against the real built Next
 * server, so it exercises the full stack the unit tests can't: the proxy.ts
 * CSRF guard, the admin-token gate, the route handler, the lib, and the
 * SQLite file. The 24h ticker is wired in `instrumentation.ts`; this spec
 * drives the on-demand POST instead of waiting for the scheduled run.
 *
 * Mutations are gated by proxy.ts (same-origin OR a valid admin token). The
 * shared `request` fixture already injects `x-auditor-admin-token` via the
 * config's extraHTTPHeaders, so the happy-path POST is authorised; we add
 * `origin` too, matching the other specs.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test.describe("server health check endpoint", () => {
  test("POST runs a check, GET returns the persisted result, and an activity row is written", async ({
    request,
  }) => {
    const post = await request.post("/api/diagnostics/health", {
      headers: sameOriginHeaders,
    });
    expect(post.ok()).toBeTruthy();

    const body = await post.json();
    expect(body.version).toBe(1);
    expect(["ok", "partial", "error"]).toContain(body.status);
    expect(typeof body.healthy).toBe("boolean");
    expect(Array.isArray(body.heals)).toBeTruthy();
    expect(Array.isArray(body.skippedHeals)).toBeTruthy();
    // Read-only checks were populated by a real run against the live DB.
    expect(body.checks.database.foreignKeysEnabled).toBe(1);
    expect(typeof body.checks.counts.activityLog).toBe("number");
    expect(typeof body.checks.runtime.rssMb).toBe("number");
    expect(typeof body.checks.orphans.manualAppEvents).toBe("number");

    // GET returns the persisted result (not the pre-run sentinel).
    const get = await request.get("/api/diagnostics/health");
    expect(get.ok()).toBeTruthy();
    const last = await get.json();
    expect(last.neverRun).toBeUndefined();
    expect(last.version).toBe(1);
    expect(["ok", "partial", "error"]).toContain(last.status);

    // The run wrote a `health_check` activity row.
    const activity = await request.get("/api/activity?limit=20");
    expect(activity.ok()).toBeTruthy();
    expect(await activity.text()).toContain("health_check");
  });

  test("POST is rejected without same-origin or a valid admin token", async ({
    request,
  }) => {
    // Override the fixture's admin token with a bad one and send no origin —
    // the proxy CSRF guard (403) or the route's admin gate (401) must reject.
    const res = await request.post("/api/diagnostics/health", {
      headers: { "x-auditor-admin-token": "definitely-not-the-token" },
    });
    expect([401, 403]).toContain(res.status());
  });
});
