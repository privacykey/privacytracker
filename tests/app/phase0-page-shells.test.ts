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

    assert.ok(
      !(
        /from\s+"next\/navigation"[^;]*;?/.test(src) &&
        src.includes("redirect(")
      ),
      `${page} uses a server-side redirect() again`
    );
  });
}
