import assert from "node:assert/strict";
import test from "node:test";
import { deriveServerBackupState } from "../../lib/device-actions-shared";

const BACKUP = {
  finishedAt: 1_723_000_000_000,
  manifestBytes: 4096,
  path: "/Users/test/Library/Application Support/MobileSync/Backup/udid",
};

test("allowed gate with a backup produces the fresh UI state", () => {
  assert.deepEqual(
    deriveServerBackupState({ allowed: true, lastBackup: BACKUP }),
    { backup: BACKUP, kind: "fresh" }
  );
});

test("allowed gate without a backup never reassures", () => {
  assert.deepEqual(
    deriveServerBackupState({ allowed: true, lastBackup: null }),
    { kind: "not_fresh", reason: "missing" }
  );
});

test("stale and unverified denials preserve an exact UI reason", () => {
  assert.deepEqual(
    deriveServerBackupState({
      allowed: false,
      lastBackup: BACKUP,
      reason: "backup_stale",
    }),
    { kind: "not_fresh", reason: "stale" }
  );
  assert.deepEqual(
    deriveServerBackupState({
      allowed: false,
      lastBackup: BACKUP,
      reason: "backup_unverified",
    }),
    { kind: "not_fresh", reason: "unverified" }
  );
});

test("null and malformed responses fail conservatively", () => {
  assert.deepEqual(deriveServerBackupState(null), {
    kind: "not_fresh",
    reason: "unreachable",
  });
  assert.deepEqual(
    deriveServerBackupState({
      allowed: true,
      lastBackup: { finishedAt: Number.NaN, path: "" },
    }),
    { kind: "not_fresh", reason: "missing" }
  );
});
