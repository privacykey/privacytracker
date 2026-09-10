import { expect, test } from "@playwright/test";

/**
 * Header coverage over the REAL HTTP pipeline.
 *
 * tests/app/security-regression.test.ts calls `proxy()` directly, which is
 * why it never caught this class of gap: Next can answer a request without
 * ever invoking the proxy. The trailing-slash 308 used to be emitted inside
 * the router (dist/server/lib/router-utils/resolve-routes.js), whose redirect
 * branch returns `resHeaders: null` — discarding both the proxy's headers and
 * the static set from next.config.js's `headers()`. `GET /dashboard/` came
 * back 308 with zero security headers while `GET /dashboard` carried six.
 *
 * `skipTrailingSlashRedirect: true` hands that redirect to proxy.ts. These
 * assertions pin it there.
 */

// The full set every HTML-bearing response must carry. Static assets excluded
// by the proxy matcher (`_next/static`, `fonts/`, …) legitimately carry only
// the five from next.config.js — they have no HTML to apply a CSP to.
const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
];

const PATHS = [
  "/",
  "/dashboard",
  "/legal",
  "/privacy-policy",
  "/dashboard/settings/you",
  "/apps/123",
  "/api/health",
];

function assertAllHeaders(headers: Record<string, string>, label: string) {
  const missing = REQUIRED_HEADERS.filter((h) => !(h in headers));
  expect(missing, `${label} is missing security headers`).toEqual([]);
}

test("canonical paths carry the full security header set", async ({
  request,
}) => {
  for (const path of PATHS) {
    const res = await request.get(path, { maxRedirects: 0 });
    assertAllHeaders(res.headers(), `GET ${path}`);
  }
});

test("trailing-slash redirects carry the full security header set", async ({
  request,
}) => {
  for (const path of PATHS.filter((p) => p !== "/")) {
    const res = await request.get(`${path}/`, { maxRedirects: 0 });
    expect(res.status(), `GET ${path}/ should redirect`).toBe(308);
    assertAllHeaders(res.headers(), `GET ${path}/`);
    // Exactly one slash removed — a Location that kept it would be an
    // infinite redirect, which is what NextURL.clone() produced.
    expect(res.headers().location).toBe(path);
  }
});

test("a 404 carries the full security header set", async ({ request }) => {
  const res = await request.get("/no-such-page-exists", { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  assertAllHeaders(res.headers(), "GET /no-such-page-exists");
});

test("HEAD responses carry the full security header set", async ({
  request,
}) => {
  const canonical = await request.head("/dashboard", { maxRedirects: 0 });
  assertAllHeaders(canonical.headers(), "HEAD /dashboard");

  const slashed = await request.head("/dashboard/", { maxRedirects: 0 });
  expect(slashed.status()).toBe(308);
  assertAllHeaders(slashed.headers(), "HEAD /dashboard/");
});

test("trailing-slash redirect preserves the query string and terminates", async ({
  request,
}) => {
  const res = await request.get("/dashboard/apps/?q=test&sort=name", {
    maxRedirects: 0,
  });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toBe("/dashboard/apps?q=test&sort=name");

  // Followed to completion it must land on the page in one hop, not loop.
  const followed = await request.get("/dashboard/apps/?q=test&sort=name");
  expect(followed.status()).toBe(200);
  expect(followed.url()).toContain("/dashboard/apps?q=test&sort=name");
});
