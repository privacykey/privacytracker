/**
 * Parity-manifest coverage (Rust-core migration — core/README.md).
 *
 * scripts/parity/manifest.mjs must classify every `app/api/**\/route.ts` as
 * a READS, VOLATILE_READS, MUTATIONS, TEARDOWN or QUARANTINE entry, and must
 * not keep entries for routes that no longer exist. parity-diff.mjs enforces
 * that at startup, but the Rust read gate (read-parity.mjs) invokes it with
 * --skip-coverage and CI never walked the tree, so a new route could ship
 * unclassified — /api/device-scope did (PR #242) until the Phase 2 inventory
 * pass in PR #247 noticed. This runs the same walk
 * (scripts/parity/manifest-check.mjs) against the real tree on every
 * `pnpm test`; the core-parity CI job runs it as `pnpm parity:manifest`.
 *
 * Adding a route therefore means classifying it in the same PR.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  coverageReport,
  diskRoutes,
  formatCoverageFailure,
} from "../../scripts/parity/manifest-check.mjs";

test("every app/api route is classified in the parity manifest, and nothing phantom is listed", () => {
  const report = coverageReport();
  assert.equal(
    report.missing.length + report.phantom.length,
    0,
    formatCoverageFailure(report)
  );
  // A walk that found nothing (wrong directory) would already surface as
  // every manifest route being phantom; pin the floor explicitly anyway.
  assert.ok(
    report.disk.size >= 100,
    `only ${report.disk.size} routes found under app/api`
  );
});

test("the check names an unclassified route and a listed route that is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "parity-manifest-"));
  try {
    for (const route of ["apps/[id]", "new-thing"]) {
      mkdirSync(join(root, route), { recursive: true });
      writeFileSync(
        join(root, route, "route.ts"),
        "export const GET = () => null;\n"
      );
    }
    // A stray non-route file must not count as a route.
    writeFileSync(join(root, "apps", "helpers.ts"), "");
    assert.deepEqual([...diskRoutes(root)].sort(), [
      "/api/apps/[id]",
      "/api/new-thing",
    ]);

    const report = coverageReport({
      apiDir: root,
      groups: [[{ route: "/api/apps/[id]" }], [{ route: "/api/gone" }]],
    });
    assert.deepEqual(report.missing, ["/api/new-thing"]);
    assert.deepEqual(report.phantom, ["/api/gone"]);
    assert.equal(report.ok, false);
    assert.match(
      formatCoverageFailure(report),
      /COVERAGE GATE FAILED[\s\S]*\/api\/new-thing[\s\S]*\/api\/gone/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
