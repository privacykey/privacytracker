import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyBackupArtifactAtRoot } from "../../lib/device-backup-verification";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "privacytracker-backup-verifier-"));
}

test("backup verifier accepts a direct child with a non-empty Manifest.db", () => {
  const root = fixtureRoot();
  const backup = join(root, "test-udid");
  mkdirSync(backup);
  writeFileSync(join(backup, "Manifest.db"), "sqlite fixture");

  const result = verifyBackupArtifactAtRoot(backup, root);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.path, realpathSync(backup));
    assert.ok(result.manifestBytes > 0);
  }
});

test("backup verifier rejects missing, empty, and directory manifests", () => {
  const root = fixtureRoot();
  const missing = join(root, "missing");
  const empty = join(root, "empty");
  const directory = join(root, "directory");
  mkdirSync(missing);
  mkdirSync(empty);
  mkdirSync(directory);
  writeFileSync(join(empty, "Manifest.db"), "");
  mkdirSync(join(directory, "Manifest.db"));

  assert.deepEqual(verifyBackupArtifactAtRoot(missing, root), {
    ok: false,
    reason: "manifest_missing",
  });
  assert.deepEqual(verifyBackupArtifactAtRoot(empty, root), {
    ok: false,
    reason: "manifest_empty",
  });
  assert.deepEqual(verifyBackupArtifactAtRoot(directory, root), {
    ok: false,
    reason: "manifest_not_file",
  });
});

test("backup verifier rejects paths outside the MobileSync root", () => {
  const root = fixtureRoot();
  const outsideRoot = fixtureRoot();
  const outsideBackup = join(outsideRoot, "other-device");
  mkdirSync(outsideBackup);
  writeFileSync(join(outsideBackup, "Manifest.db"), "sqlite fixture");

  assert.deepEqual(verifyBackupArtifactAtRoot(outsideBackup, root), {
    ok: false,
    reason: "backup_outside_mobile_sync",
  });
});

test("backup verifier rejects nested directories instead of accepting lookalikes", () => {
  const root = fixtureRoot();
  const nested = join(root, "device", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "Manifest.db"), "sqlite fixture");

  assert.deepEqual(verifyBackupArtifactAtRoot(nested, root), {
    ok: false,
    reason: "backup_outside_mobile_sync",
  });
});

test("backup verifier refuses symlinks and future manifest timestamps", () => {
  const root = fixtureRoot();
  const backup = join(root, "device");
  mkdirSync(backup);
  const manifest = join(backup, "Manifest.db");
  writeFileSync(manifest, "fixture");
  const alias = join(root, "alias");
  symlinkSync(backup, alias);
  assert.deepEqual(verifyBackupArtifactAtRoot(alias, root), {
    ok: false,
    reason: "backup_symlink",
  });
  const future = new Date(Date.now() + 86400000);
  utimesSync(manifest, future, future);
  assert.deepEqual(verifyBackupArtifactAtRoot(backup, root), {
    ok: false,
    reason: "manifest_time_invalid",
  });
  const linked = join(root, "linked-manifest");
  mkdirSync(linked);
  symlinkSync(manifest, join(linked, "Manifest.db"));
  assert.deepEqual(verifyBackupArtifactAtRoot(linked, root), {
    ok: false,
    reason: "manifest_symlink",
  });
});
