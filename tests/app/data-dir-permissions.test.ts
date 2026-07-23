import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import db, { dataDir, dbPath, tightenDataPermissions } from "../../lib/db";

/**
 * Pins the private-permissions contract on the SQLite data directory
 * (lib/db.ts): 0700 on the dir, 0600 on the DB + WAL/SHM sidecars,
 * applied on every open so pre-existing loose installs are tightened on
 * their next boot. POSIX-only — chmod modes are meaningless on Windows,
 * where tightenDataPermissions is deliberately a best-effort no-op.
 */

const posixTest = process.platform === "win32" ? test.skip : test;

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

posixTest("data dir and DB file are private after open", () => {
  // Importing lib/db above opened the singleton, which runs the
  // tightening pass — no further setup needed.
  assert.equal(mode(dataDir), 0o700, "data dir must be 0700");
  assert.equal(mode(dbPath), 0o600, "privacy.db must be 0600");
});

posixTest(
  "pre-existing world-readable install is tightened (migration path)",
  () => {
    // Simulate an install created before the permissions change: loosen
    // everything, then run the same pass open() runs.
    fs.chmodSync(dataDir, 0o755);
    fs.chmodSync(dbPath, 0o644);
    const wal = `${dbPath}-wal`;
    if (fs.existsSync(wal)) {
      fs.chmodSync(wal, 0o644);
    }

    tightenDataPermissions();

    assert.equal(mode(dataDir), 0o700);
    assert.equal(mode(dbPath), 0o600);
    if (fs.existsSync(wal)) {
      assert.equal(mode(wal), 0o600);
    }
  }
);

posixTest("WAL sidecar files created after open inherit 0600", () => {
  // Force a write so the -wal file exists (journal_mode=WAL creates it
  // lazily on the first write transaction). SQLite copies the main DB
  // file's mode onto sidecar files, and the DB was chmodded 0600 before
  // the WAL pragma ran.
  db.exec("CREATE TABLE IF NOT EXISTS _perm_probe (id INTEGER)");
  db.exec("INSERT INTO _perm_probe (id) VALUES (1)");
  db.exec("DROP TABLE _perm_probe");

  const wal = `${dbPath}-wal`;
  assert.ok(fs.existsSync(wal), "expected a -wal file after a write");
  assert.equal(mode(wal), 0o600, "-wal must inherit the private mode");
});
