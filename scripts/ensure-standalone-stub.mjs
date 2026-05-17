// Pre-tauri-dev guard. Two jobs, both run before `tauri dev` spawns
// the parallel BeforeDevCommand + DevCommand:
//
//   1. Delete any sibling `standalone.tar.ready` marker. The marker is
//      a "this tarball was just written by stage-standalone.mjs"
//      signal. Removing it here means any tarball that happens to be
//      on disk (from a prior session, an interrupted build, or a
//      branch switch) is treated as stale until the current
//      BeforeDevCommand finishes and re-writes the marker. The sidecar
//      polls for this marker, so deleting it forces the wait.
//
//   2. If `standalone.tar` is missing, write a 0-byte placeholder so
//      cargo's resource-path validator passes during the parallel
//      cargo + BeforeDevCommand phase. BeforeDevCommand later atomic-
//      renames the real tarball over it. A real tarball on disk is
//      left untouched — replacing it with a stub would force every
//      dev run to wait ~29s for next-build even when a fresh tarball
//      already exists.
//
// Idempotent on both steps.

import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const tarball = path.join(repo, "src-tauri", "resources", "standalone.tar");
const readyMarker = `${tarball}.ready`;

// Step 1: always clear the freshness marker.
if (existsSync(readyMarker)) {
  rmSync(readyMarker, { force: true });
  console.log(
    `ensure-standalone-stub: cleared stale ${path.basename(readyMarker)}`
  );
}

// Step 2: stub the tarball iff missing.
if (!existsSync(tarball)) {
  // Cargo's validator only checks `Path::exists()`, so an empty file is enough.
  writeFileSync(tarball, "");
  console.log(`ensure-standalone-stub: wrote 0-byte placeholder at ${tarball}`);
} else if (statSync(tarball).size === 0) {
  console.log(
    `ensure-standalone-stub: 0-byte placeholder already present at ${tarball}`
  );
}
// Real (non-zero) tarball on disk — left intact for atomic rename to overwrite.
