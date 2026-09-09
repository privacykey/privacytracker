import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { TABLES_IN_INSERT_ORDER } from "../../lib/backup";
import db from "../../lib/db";

const fixtures = fileURLToPath(new URL("../fixtures/v0.1.2/", import.meta.url));
const worker = fileURLToPath(
  new URL("../helpers/upgrade-worker.ts", import.meta.url)
);
function rehearse(dir: string, mode: string) {
  execFileSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", worker, mode],
    {
      env: {
        ...process.env,
        PRIVACYTRACKER_DATA_DIR: dir,
        NEXT_PHASE: "phase-test",
      },
      timeout: 30_000,
    }
  );
  return JSON.parse(
    readFileSync(path.join(dir, "rehearsal-result.json"), "utf8")
  );
}
test("v0.1.2 database upgrades, preserves user data, restores backups and keeps an untouched rollback copy", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-upgrade-"));
  try {
    const file = path.join(dir, "privacy.db");
    const legacy = new Database(file);
    legacy.exec(readFileSync(path.join(fixtures, "database.sql"), "utf8"));
    legacy.close();
    const rollback = path.join(dir, "v012-rollback.db");
    copyFileSync(file, rollback);
    copyFileSync(
      path.join(fixtures, "backup-signing.key"),
      path.join(dir, "backup-signing.key")
    );
    const hash = () =>
      createHash("sha256").update(readFileSync(rollback)).digest("hex");
    const before = hash();
    assert.equal(rehearse(dir, "upgrade").integrity, "ok");
    assert.equal(hash(), before);
    const original = new Database(rollback, { readonly: true });
    assert.equal(
      (
        original
          .prepare("SELECT name FROM devices WHERE id='device'")
          .get() as { name: string }
      ).name,
      "Fixture iPhone"
    );
    assert.equal(original.pragma("integrity_check", { simple: true }), "ok");
    original.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("v0.1.2 JSON on another installation requires explicit trust and restores without unsafe settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-cross-install-"));
  try {
    assert.equal(rehearse(dir, "cross-install").apps, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("full backup table inventory covers every application table", () => {
  const actual = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[]
  )
    .map(({ name }) => name)
    .sort();
  assert.deepEqual([...TABLES_IN_INSERT_ORDER].sort(), actual);
});
