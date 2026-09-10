import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { cspRouteKey } from "../../lib/csp-route-key";

/**
 * Runs LAST (files run alphabetically, one worker): after every other spec
 * has mutated state — verdicts, resets, imports, layout saves — the HTML
 * the server hands out for each page must still be the HTML the build
 * hashed. If any code path regenerates a prerendered page at runtime
 * (a stray revalidatePath, an ISR setting), its flight scripts change,
 * the hash-based CSP blocks them, and the page goes blank. This caught
 * exactly that once; it stays so it can't come back.
 *
 * The check is PER ROUTE, not against the union of every route's hashes.
 * proxy.ts picks one route's hash list via `cspRouteKey` and emits only
 * those in `script-src`, so a page whose inline script hashes to something
 * another route allows is still blocked by the browser. In this build the
 * union is 158 hashes while a typical page is allowed 12 — exactly one
 * hash is shared by every route — so a union check waves through almost
 * anything the build has ever emitted anywhere.
 *
 * Two independent nets, both required to pass:
 *
 *   1. Against the live response header. Each page's inline scripts must be
 *      covered by the `script-src` of the very response that carried the
 *      HTML. This is the real browser contract end-to-end and cannot drift
 *      from proxy.ts, because it IS proxy.ts's output.
 *   2. Against the build map, keyed by the same `cspRouteKey` proxy.ts uses
 *      (imported, not re-implemented). This is the runtime-regeneration
 *      guard: it pins served HTML to what `next build` actually wrote.
 *      Asserting the header's hash set EQUALS `map.routes[key]` also pins
 *      the key resolution itself, and catches proxy.ts silently widening to
 *      `hashes.all` via its `?? hashes.all` fallback.
 *
 * (2) strictly implies the old union check: `map.all` is the union of every
 * `map.routes[*]`, so a hash allowed for this route is always in `map.all`.
 *
 * Skips itself when there is no hash map next to the server, or when the
 * server is serving a dev-mode `'unsafe-inline'` policy (dev mode).
 */

const distDir = path.resolve(process.env.NEXT_DIST_DIR ?? ".next");
const mapPath = path.join(distDir, "csp-hashes.json");

const ROUTES = [
  "/",
  "/dashboard",
  "/dashboard/apps",
  "/dashboard/stats",
  "/dashboard/settings/you",
  "/dashboard/settings/admin",
  "/dashboard/review-recommendations",
  "/dashboard/shortlist",
  // Exercises the `/apps/:id` -> `/apps/view` rewrite branch of cspRouteKey.
  "/apps/94961186",
  // ...and the `/manual-apps/:id` -> `/manual-apps/view` branch, which had
  // no coverage at all.
  "/manual-apps/1",
  // The settings landing that forwards on the client — a prerendered route
  // in its own right, distinct from the four group routes.
  "/dashboard/settings",
  // Unknown path -> the `/_not-found` shell.
  "/definitely-not-a-route",
  // generate-csp-hashes.mjs emits hashes for `/_global-error` too. Those are
  // NOT unreachable: the manifest maps `/_global-error/page` -> the literal
  // route `/_global-error`, so it lands in `map.routes`, `cspRouteKey`
  // returns it for that path, and Next really does serve the
  // `__next_error__` shell there (HTTP 500). Listed so the hashes the build
  // spends on it are held to the same contract as every other route.
  "/_global-error",
];

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function inlineHashes(html: string): { hash: string; snippet: string }[] {
  const out: { hash: string; snippet: string }[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[1];
    if (body.trim().length === 0) {
      continue;
    }
    out.push({
      hash: `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`,
      snippet: body.slice(0, 70).replace(/\s+/g, " "),
    });
  }
  return out;
}

/** The `script-src` directive of a CSP header, or null if it has none. */
function scriptSrcOf(csp: string): string | null {
  return /(?:^|;)\s*script-src\b([^;]*)/.exec(csp)?.[1] ?? null;
}

function hashesIn(scriptSrc: string): Set<string> {
  return new Set(
    [...scriptSrc.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1])
  );
}

test("served HTML still matches the per-route CSP the browser is given", async ({
  request,
}) => {
  test.skip(!existsSync(mapPath), "no csp-hashes.json (dev server)");
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
    all: string[];
    routes: Record<string, string[]>;
  };

  const drift: string[] = [];
  let devPolicy: string | null = null;

  for (const route of ROUTES) {
    const res = await request.get(route);
    const html = await res.text();
    const headers = res.headers();
    const csp =
      headers["content-security-policy"] ??
      headers["content-security-policy-report-only"] ??
      null;

    // request.get follows redirects, so a route that bounces (an auth gate
    // sending us to /login) would hand back another page's HTML and another
    // page's CSP — self-consistent, and checked against the WRONG key. Name
    // it instead of quietly passing: the page in ROUTES went unchecked.
    const finalPath = new URL(res.url()).pathname;
    if (finalPath !== route) {
      drift.push(
        `${route}: redirected to ${finalPath}, so this page was never checked (is the request authenticated?)`
      );
      continue;
    }

    const key = cspRouteKey(route, map.routes);
    const allowed = map.routes[key];
    if (!allowed) {
      drift.push(
        `${route}: resolves to key ${key}, which the build map has no entry for (proxy.ts would fall back to the full union)`
      );
      continue;
    }
    const allowedSet = new Set(allowed);

    // --- Net 1: the policy the browser actually received ---------------
    if (csp === null) {
      if (process.env.PRIVACYTRACKER_CSP?.toLowerCase() !== "off") {
        drift.push(`${route}: response carried no Content-Security-Policy`);
      }
    } else {
      const directive = scriptSrcOf(csp);
      if (directive === null) {
        drift.push(`${route}: CSP has no script-src directive`);
      } else if (directive.includes("'unsafe-inline'")) {
        // Dev server (proxy.ts short-circuits when NODE_ENV !== production).
        devPolicy = directive.trim();
        break;
      } else {
        const served = hashesIn(directive);
        for (const { hash, snippet } of inlineHashes(html)) {
          if (!served.has(hash)) {
            drift.push(
              `${route}: inline script NOT allowed by the script-src this response carried — ${hash} ${snippet}`
            );
          }
        }
        // The served list must be exactly this route's list: catches a
        // cspRouteKey mismatch and proxy.ts widening to hashes.all.
        const extra = [...served].filter((h) => !allowedSet.has(h));
        const missing = allowed.filter((h) => !served.has(h));
        if (extra.length > 0 || missing.length > 0) {
          drift.push(
            `${route}: script-src does not match map.routes[${key}] — ${extra.length} hash(es) served that this route never had${extra.length > 0 ? ` (e.g. ${extra[0]})` : ""}, ${missing.length} of its own missing`
          );
        }
      }
    }

    // --- Net 2: the build map, per route (runtime-regeneration guard) ---
    for (const { hash, snippet } of inlineHashes(html)) {
      if (!allowedSet.has(hash)) {
        drift.push(
          `${route}: inline script the build never hashed for ${key} (page regenerated at runtime?) — ${hash} ${snippet}${map.all.includes(hash) ? " [hash exists, but belongs to a DIFFERENT route]" : ""}`
        );
      }
    }
  }

  test.skip(
    devPolicy !== null,
    `dev-mode CSP (script-src${devPolicy ?? ""}) — no build hashes to check against`
  );
  expect(
    drift,
    `CSP integrity drift (a browser would block these):\n  ${drift.join("\n  ")}`
  ).toEqual([]);
});
