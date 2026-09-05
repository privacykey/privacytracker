#!/usr/bin/env node
/**
 * Post-build: hash every inline <script> in every prerendered page so
 * proxy.ts can emit a hash-based Content-Security-Policy — and FAIL the
 * build if any page is no longer prerendered.
 *
 * Why hashes: a per-request nonce forces every route dynamic (Next has
 * to render per request to mint it), which is exactly what Phase 0
 * removes so the same static bundle can be served by the Rust core.
 * With every page static, the inline scripts in each HTML file are fixed
 * per build, so their SHA-256 hashes ARE the allowlist. Next's RSC flight
 * scripts (`self.__next_f.push(...)`) are per-route and per-build, hence
 * a map keyed by route rather than one global list.
 *
 * Why fail on a dynamic page: that's the static-routes guard. If someone
 * adds a headers()/cookies() read or a DB call to a page or the layout,
 * the page stops prerendering, this script finds no HTML for it, and the
 * build fails here with the route named — instead of shipping a route
 * the hash policy silently breaks.
 *
 * Output: <distDir>/csp-hashes.json → { generatedAt, routes: {route:
 * ["sha256-…"]}, all: ["sha256-…"] }. proxy.ts reads it at runtime;
 * stage-standalone.mjs copies it into the standalone tree.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(process.env.NEXT_DIST_DIR ?? ".next");
const manifestPath = path.join(dist, "app-path-routes-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(
    `generate-csp-hashes: ${manifestPath} missing — run next build first`
  );
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pageRoutes = Object.entries(manifest)
  .filter(
    ([key]) =>
      key.endsWith("/page") ||
      key === "/_not-found/page" ||
      key === "/_global-error/page"
  )
  .map(([, route]) => route)
  .filter((route) => !route.startsWith("/api/"));

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
function hashesFor(html) {
  const out = new Set();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const body = match[1];
    if (body.trim().length === 0) {
      continue;
    }
    out.add(
      `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`
    );
  }
  return [...out];
}

const routes = {};
const dynamic = [];
for (const route of pageRoutes) {
  const rel = route === "/" ? "/index" : route;
  const html = path.join(dist, "server", "app", `${rel}.html`);
  if (!existsSync(html)) {
    dynamic.push(route);
    continue;
  }
  routes[route] = hashesFor(readFileSync(html, "utf8"));
}

if (dynamic.length > 0 && !process.env.CSP_HASHES_ALLOW_DYNAMIC) {
  console.error(
    "generate-csp-hashes: these page routes did NOT prerender, so no CSP hash can cover them:\n" +
      dynamic.map((r) => `  ${r}`).join("\n") +
      "\nA page (or the root layout) reads headers()/cookies()/the DB per request, or declares force-dynamic." +
      "\nSet CSP_HASHES_ALLOW_DYNAMIC=1 only to debug a build locally."
  );
  process.exit(1);
}

const all = [...new Set(Object.values(routes).flat())].sort();
const out = { generatedAt: new Date().toISOString(), routes, all };
writeFileSync(path.join(dist, "csp-hashes.json"), JSON.stringify(out, null, 2));
console.log(
  `generate-csp-hashes: ${Object.keys(routes).length} static routes, ${all.length} distinct inline-script hashes` +
    (dynamic.length ? ` (ALLOWED dynamic: ${dynamic.join(", ")})` : "")
);
