import assert from "node:assert/strict";
import test from "node:test";
import { CSP_NOT_FOUND_KEY, cspRouteKey } from "../../lib/csp-route-key";

/**
 * `cspRouteKey` decides which route's inline-script hashes proxy.ts puts in
 * `script-src`. Get it wrong and the browser is handed one page's hashes
 * while being served another page's HTML — the page goes blank under an
 * enforced CSP. `tests/e2e/zz-csp-integrity.spec.ts` imports the same
 * function and holds every served page to the list it selects, so these
 * cases pin the mapping itself.
 *
 * Stand-in for the `routes` object of csp-hashes.json: only its keys matter.
 */
const ROUTES: Record<string, string[]> = {
  "/": [],
  "/_global-error": [],
  "/_not-found": [],
  "/apps/view": [],
  "/dashboard": [],
  "/dashboard/settings": [],
  "/dashboard/settings/you": [],
  "/legal": [],
  "/manual-apps/view": [],
};

test("prerendered routes map to themselves", () => {
  for (const route of [
    "/",
    "/dashboard",
    "/dashboard/settings/you",
    "/legal",
  ]) {
    assert.equal(cspRouteKey(route, ROUTES), route);
  }
});

test("per-id detail URLs resolve to the static view shells", () => {
  // Mirrors the next.config.js rewrites: the browser URL is unchanged, but
  // the HTML served is the shell's, so the shell's hashes are the right ones.
  assert.equal(cspRouteKey("/apps/94961186", ROUTES), "/apps/view");
  assert.equal(cspRouteKey("/manual-apps/17", ROUTES), "/manual-apps/view");
  // Only ONE segment deep — a sub-path is not the detail shell.
  assert.equal(
    cspRouteKey("/apps/94961186/history", ROUTES),
    CSP_NOT_FOUND_KEY
  );
});

test("unknown paths fall back to the 404 shell", () => {
  assert.equal(cspRouteKey("/definitely-not-a-route", ROUTES), "/_not-found");
  assert.equal(cspRouteKey("/dashboard/nope", ROUTES), "/_not-found");
});

test("a trailing slash resolves to the same key, but '/' is preserved", () => {
  assert.equal(cspRouteKey("/dashboard/", ROUTES), "/dashboard");
  assert.equal(cspRouteKey("/apps/94961186/", ROUTES), "/apps/view");
  assert.equal(cspRouteKey("/", ROUTES), "/");
});

test("/_global-error is reachable, not a dead entry in the hash map", () => {
  // scripts/generate-csp-hashes.mjs deliberately emits hashes for
  // `/_global-error`. They are NOT unreachable: the app-path manifest maps
  // `/_global-error/page` to the literal route `/_global-error`, so it lands
  // in csp-hashes.json's `routes`, and Next serves the `__next_error__`
  // shell (HTTP 500) at that path. If this ever stops holding, those hashes
  // become dead weight and the entry should be dropped from the generator.
  assert.equal(cspRouteKey("/_global-error", ROUTES), "/_global-error");
});

test("every key it returns exists in the map, so proxy never widens to `all`", () => {
  // proxy.ts does `hashes.routes[cspRouteKey(...)] ?? hashes.all`. That
  // fallback is a silent widening of the policy, so the key must always hit.
  const paths = [
    "/",
    "/dashboard",
    "/dashboard/",
    "/apps/1",
    "/manual-apps/1",
    "/_global-error",
    "/nope",
    "/a/b/c/d",
  ];
  for (const p of paths) {
    assert.ok(
      cspRouteKey(p, ROUTES) in ROUTES,
      `${p} resolved to a key absent from the map`
    );
  }
});
