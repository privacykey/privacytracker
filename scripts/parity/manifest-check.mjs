/**
 * Manifest coverage check — the walk behind parity-diff's coverage gate,
 * runnable on its own.
 *
 * scripts/parity/manifest.mjs must classify every `app/api/**‍/route.ts`
 * (READS, VOLATILE_READS, MUTATIONS, TEARDOWN or QUARANTINE) and must not
 * keep an entry for a route that no longer exists. parity-diff.mjs enforces
 * that at startup, but the only harness that runs routinely — the Rust read
 * gate, read-parity.mjs — invokes it with --skip-coverage, and nothing in CI
 * walked the tree at all. So a route could ship unclassified: /api/device-scope
 * (PR #242) did, until the Phase 2 inventory pass in PR #247 noticed.
 *
 * This module is that walk with no servers attached. parity-diff.mjs imports
 * it (one implementation), `pnpm parity:manifest` runs it in the core-parity
 * CI job, and tests/app/parity-manifest-coverage.test.ts runs it under
 * `pnpm test`.
 *
 * CLI exit code: 0 when every route is classified, 2 on a coverage failure —
 * the code parity-diff.mjs uses for the same failure.
 */

import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MUTATIONS,
  QUARANTINE,
  READS,
  TEARDOWN,
  VOLATILE_READS,
} from "./manifest.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/** The route tree the manifest describes. */
export const API_DIR = path.join(REPO_ROOT, "app", "api");

/** Every group whose `route` fields count as a classification. */
export const MANIFEST_GROUPS = [
  READS,
  VOLATILE_READS,
  MUTATIONS,
  TEARDOWN,
  QUARANTINE,
];

/** `/api/...` for every `route.ts` under `apiDir`, recursively. */
export function diskRoutes(apiDir = API_DIR) {
  const routes = new Set();
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(apiDir, rel), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        walk(path.join(rel, entry.name));
      } else if (entry.name === "route.ts") {
        routes.add(path.posix.join("/api", ...rel.split(path.sep)));
      }
    }
  };
  walk("");
  return routes;
}

/** Every `route` the manifest classifies, across the given groups. */
export function manifestRoutes(groups = MANIFEST_GROUPS) {
  const listed = new Set();
  for (const group of groups) {
    for (const entry of group) {
      listed.add(entry.route);
    }
  }
  return listed;
}

/**
 * Compare the tree with the manifest. `missing` are routes on disk with no
 * manifest entry; `phantom` are manifest routes with no route.ts. Both
 * sorted, both empty when the manifest is current.
 */
export function coverageReport({
  apiDir = API_DIR,
  groups = MANIFEST_GROUPS,
} = {}) {
  const disk = diskRoutes(apiDir);
  const listed = manifestRoutes(groups);
  const missing = [...disk].filter((route) => !listed.has(route)).sort();
  const phantom = [...listed].filter((route) => !disk.has(route)).sort();
  return {
    disk,
    listed,
    missing,
    phantom,
    ok: missing.length === 0 && phantom.length === 0,
  };
}

/** The failure text parity-diff.mjs has always printed, as one string. */
export function formatCoverageFailure({ missing, phantom }) {
  const lines = ["COVERAGE GATE FAILED"];
  if (missing.length) {
    lines.push(
      "",
      `${missing.length} route(s) exist under app/api but are not in scripts/parity/manifest.mjs:`
    );
    for (const route of missing) {
      lines.push(`  ${route}`);
    }
    lines.push(
      "",
      "Add each to READS, VOLATILE_READS, MUTATIONS, TEARDOWN or QUARANTINE."
    );
  }
  if (phantom.length) {
    lines.push("", `${phantom.length} manifest route(s) no longer exist:`);
    for (const route of phantom) {
      lines.push(`  ${route}`);
    }
  }
  return lines.join("\n");
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const report = coverageReport();
  if (report.ok) {
    console.log(
      `manifest coverage OK: ${report.disk.size} routes under app/api, every one classified in scripts/parity/manifest.mjs`
    );
  } else {
    console.error(formatCoverageFailure(report));
    process.exit(2);
  }
}
