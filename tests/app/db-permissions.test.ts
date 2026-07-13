import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import db, { dataDir, dbPath } from "../../lib/db";

test("data directory and SQLite files are private", {
  skip: process.platform === "win32",
}, () => {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  ).run("permissions_test", "ok");

  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  for (const file of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(file)) {
      assert.equal(statSync(file).mode & 0o777, 0o600, file);
    }
  }
});
