import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createBackupSnapshot,
  getBackupSnapshotDir,
  getBackupSnapshotSettings,
  listBackupSnapshots,
  runScheduledBackupSnapshotIfDue,
  saveBackupSnapshotSettings,
} from "../lib/backup-snapshots";
import { setSetting } from "../lib/scheduler";

const LAST_RUN_KEY = "backup_snapshot_last_run_at";

function resetSnapshotState() {
  fs.rmSync(getBackupSnapshotDir(), { recursive: true, force: true });
  saveBackupSnapshotSettings({
    enabled: false,
    intervalHours: 24,
    retentionCount: 10,
  });
  setSetting(LAST_RUN_KEY, "0");
}

test.beforeEach(resetSnapshotState);

test("backup snapshot settings are clamped to safe local bounds", () => {
  saveBackupSnapshotSettings({
    enabled: true,
    intervalHours: 0,
    retentionCount: 999,
  });

  const settings = getBackupSnapshotSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.intervalHours, 1);
  assert.equal(settings.retentionCount, 100);
});

test("createBackupSnapshot writes a versioned JSON file and prunes old rows", async () => {
  saveBackupSnapshotSettings({
    enabled: true,
    intervalHours: 24,
    retentionCount: 2,
  });

  const first = createBackupSnapshot("manual");
  await new Promise((resolve) => setTimeout(resolve, 2));
  createBackupSnapshot("manual");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const third = createBackupSnapshot("manual");

  const snapshots = listBackupSnapshots();
  assert.equal(snapshots.length, 2);
  assert.equal(third.pruned.length, 1);
  assert.equal(fs.existsSync(first.snapshot.path), false);

  const body = JSON.parse(fs.readFileSync(third.snapshot.path, "utf8")) as {
    version?: number;
    tables?: Record<string, unknown>;
  };
  assert.equal(body.version, 1);
  assert.ok(body.tables);
});

test("scheduled snapshots only run when enabled and due", () => {
  assert.equal(runScheduledBackupSnapshotIfDue(Date.now()), null);

  const now = Date.now();
  saveBackupSnapshotSettings({
    enabled: true,
    intervalHours: 1,
    retentionCount: 5,
  });
  setSetting(LAST_RUN_KEY, String(now));
  assert.equal(runScheduledBackupSnapshotIfDue(now + 30 * 60_000), null);

  setSetting(LAST_RUN_KEY, String(now - 2 * 60 * 60_000));
  const result = runScheduledBackupSnapshotIfDue(now);
  assert.ok(result);
  assert.equal(listBackupSnapshots().length, 1);
});
