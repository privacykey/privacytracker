/**
 * Phase 0 conversion ledger (Rust-core migration — core/README.md on the
 * rust-core branch).
 *
 * Pages listed here have been converted from server components that read
 * the database to client-fetching shells, so they no longer depend on
 * the Node server runtime. This test pins each converted page against
 * regression: no `lib/` imports (the server brain), no `force-dynamic`,
 * no server-side `redirect()` — the three things a conversion removes.
 *
 * Append-only: when a page converts, add it here in the same PR. The
 * ledger doubles as the migration's progress meter (35 pages total —
 * see the Phase 0 plan).
 *
 * Two things this deliberately does NOT assert, both owned by the final
 * layout batch:
 *
 *  - `generateMetadata` may still call `getTranslations`. The locale is
 *    resolved per-request from the NEXT_LOCALE cookie (see i18n.ts), so
 *    a statically prerendered page would bake the English title while
 *    the body still renders translated. Page titles move to the client
 *    with the layout.
 *  - Dropping `force-dynamic` does not by itself make a route static:
 *    the root layout calls headers() (CSP nonce) and cookies() (locale),
 *    which forces the whole tree dynamic. So `next build` shows every
 *    route as ƒ until the layout converts — this ledger, not the build
 *    output, is the per-page proof until then.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const CONVERTED_PAGES = [
  "app/page.tsx",
  "app/dashboard/settings/page.tsx",
  "app/dashboard/settings/you/page.tsx",
  "app/dashboard/settings/sync/page.tsx",
  "app/dashboard/settings/policies/page.tsx",
  "app/dashboard/settings/admin/page.tsx",
  "app/dashboard/settings/import-history/page.tsx",
  "app/dashboard/settings/devices/page.tsx",
  "app/dashboard/settings/focus/page.tsx",
  "app/dashboard/manual-apps/page.tsx",
  "app/changelog/page.tsx",
  "app/dashboard/diagnostics/page.tsx",
  "app/dashboard/about/ai-disclosure/page.tsx",
  "app/dashboard/settings/focus-matrix/page.tsx",
  "app/help/export-app-list/page.tsx",
  "app/help/focus/page.tsx",
  "app/about/page.tsx",
  "app/onboard/goals/page.tsx",
  "app/dashboard/stats/page.tsx",
  "app/dashboard/privacy/page.tsx",
  "app/dashboard/shortlist/page.tsx",
  "app/dashboard/settings/layout/page.tsx",
  "app/manual-apps/[id]/page.tsx",
  "app/dashboard/compare/page.tsx",
  "app/legal/page.tsx",
  "app/privacy-policy/page.tsx",
  "app/welcome/page.tsx",
  "app/onboard/page.tsx",
  "app/onboard/profile/page.tsx",
];

const REPO_ROOT = join(import.meta.dirname, "..", "..");

for (const page of CONVERTED_PAGES) {
  test(`phase0 shell: ${page} has no server-side reads`, () => {
    const src = readFileSync(join(REPO_ROOT, page), "utf8");

    // No lib/ import can reach this page: the server-coupled modules
    // (db, scraper, scheduler, feature-flags-server, …) all live there,
    // and the client-safe lib modules aren't needed by a shell either.
    // Import-specifier match only, so prose in comments doesn't count.
    const libImport = src.match(/from\s+"[^"]*\blib\/[^"]*"/);
    assert.equal(
      libImport,
      null,
      `${page} imports from lib/ again: ${libImport?.[0]}`
    );

    assert.ok(
      !src.includes('export const dynamic = "force-dynamic"'),
      `${page} re-declared force-dynamic`
    );

    // Server navigation helpers, matched on the IMPORT SPECIFIER rather
    // than on the call text — a client shell may legitimately mention
    // `redirect()` in a comment explaining what it replaced, and
    // `router.replace()` is the client equivalent, not a violation.
    const navImport = src.match(
      /import\s*\{([^}]*)\}\s*from\s+"next\/navigation"/
    );
    const navNames = (navImport?.[1] ?? "").split(",").map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
    );
    assert.ok(
      !(
        navNames.includes("redirect") || navNames.includes("permanentRedirect")
      ),
      `${page} uses a server-side redirect() again`
    );
  });
}
