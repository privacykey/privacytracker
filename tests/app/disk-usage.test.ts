import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dataDir } from "../../lib/db";
import { snapshotDisk } from "../../lib/disk-usage";

/**
 * Tests for lib/disk-usage.ts. We exercise the real fs APIs against
 * the per-test data directory established by tests/helpers/setup-env.ts; the
 * SQLite file already lives there from `import '../../lib/db'` (any test
 * importing this module triggers the singleton). Anything else we
 * need (fake backups, fake siblings) gets dropped in directly.
 */

test("returns the configured data directory", () => {
  const snap = snapshotDisk();
  assert.equal(snap.dataDir, dataDir);
});

test("reports non-zero db size after the singleton has been imported", () => {
  // tests/helpers/setup-env.ts gives us a fresh dataDir. The act of importing
  // ../../lib/db (transitively, via lib/db-health → lib/db, or via this
  // file's import chain) creates privacy.db with the schema applied.
  const snap = snapshotDisk();
  assert.ok(snap.files.db > 0, `expected db size > 0, got ${snap.files.db}`);
});

test("counts backup snapshots in data/backups/*.json", () => {
  const backupsDir = join(dataDir, "backups");
  mkdirSync(backupsDir, { recursive: true });
  // Three test files: two .json snapshots that count toward
  // `backupSnapshotCount`, plus a README.txt that adds to `files.backups`
  // bytes but doesn't count as a snapshot.
  const j1 = '{"v":1}'; // 7 bytes
  const j2 = '{"v":2}'; // 7 bytes
  const readme = "not a snapshot"; // 14 bytes
  writeFileSync(join(backupsDir, "privacytracker-snapshot-test1.json"), j1);
  writeFileSync(join(backupsDir, "privacytracker-snapshot-test2.json"), j2);
  writeFileSync(join(backupsDir, "README.txt"), readme);
  const expectedMinBytes = j1.length + j2.length + readme.length; // 28

  const snap = snapshotDisk();
  assert.equal(snap.backupSnapshotCount, 2);
  assert.ok(
    snap.files.backups >= expectedMinBytes,
    `expected backups bytes ≥ ${expectedMinBytes}, got ${snap.files.backups}`
  );
});

test("freePct is between 0 and 100 (or 0 when statfs is unavailable)", () => {
  const snap = snapshotDisk();
  assert.ok(snap.freePct >= 0 && snap.freePct <= 100);
  // Volume total + free should both be either zero (statfs failed,
  // unlikely on a normal CI box) or positive.
  if (snap.totalBytes > 0) {
    assert.ok(snap.freeBytes >= 0);
    assert.ok(snap.freeBytes <= snap.totalBytes);
  }
});

test("handles a missing wal/shm sibling without throwing", () => {
  // The WAL file may not exist on a quiet DB. The helper must not
  // throw and must report 0 bytes for whichever sibling is absent.
  const snap = snapshotDisk();
  assert.ok(snap.files.wal >= 0);
  assert.ok(snap.files.shm >= 0);
});

test("lastBackupSnapshotAt is null when the setting is unset", () => {
  // Assumes no other test has written backup_snapshot_last_run_at;
  // safe in this small suite. If the assumption breaks, this becomes
  // a `>= 0` check.
  const snap = snapshotDisk();
  assert.equal(snap.lastBackupSnapshotAt, null);
});
