/**
 * Maps a request path to the key under which `csp-hashes.json` stores the
 * inline-script hashes for the HTML that path will actually serve.
 *
 * Shared deliberately: `proxy.ts` uses it to pick the per-route `script-src`
 * hash list, and `tests/e2e/zz-csp-integrity.spec.ts` uses it to check each
 * served page against that same list. Keeping one implementation is what
 * stops the test from validating a different route's hashes than the browser
 * is handed. Must stay dependency-free — `proxy.ts` runs in the proxy sandbox
 * and must not pull in the native better-sqlite3 binding.
 */

/** Served for any path with no prerendered page of its own. */
export const CSP_NOT_FOUND_KEY = "/_not-found";

/**
 * `routes` is the `routes` object of csp-hashes.json (only its keys are read).
 * Mirrors the rewrites in next.config.js: the per-id detail URLs serve the
 * static `view` shells, and everything unrecognised serves the 404 page.
 */
export function cspRouteKey(
  pathname: string,
  routes: Readonly<Record<string, unknown>>
): string {
  const clean =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (/^\/apps\/[^/]+$/.test(clean)) {
    return "/apps/view";
  }
  if (/^\/manual-apps\/[^/]+$/.test(clean)) {
    return "/manual-apps/view";
  }
  return clean in routes ? clean : CSP_NOT_FOUND_KEY;
}
