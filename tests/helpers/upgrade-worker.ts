// A separate process ensures lib/db.ts opens and migrates the legacy file
// before any current-code helper can accidentally create a fresh schema.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackupUntrustedError,
  exportBackup,
  restoreBackup,
} from "../../lib/backup";
import db from "../../lib/db";
import { runFeatureFlagMigration } from "../../lib/migrations/v1_feature_flags";

const fixtures = fileURLToPath(new URL("../fixtures/v0.1.2/", import.meta.url));
const backup = JSON.parse(
  readFileSync(path.join(fixtures, "backup.json"), "utf8")
);
const mode = process.argv[2];
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const setting = (key: string) =>
  (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value;
if (mode === "upgrade") {
  runFeatureFlagMigration();
  assert.equal(count("apps"), 1);
  assert.equal(count("devices"), 1);
  assert.equal(count("app_devices"), 1);
  assert.equal(count("change_review_actions"), 1);
  assert.equal(count("privacy_snapshots"), 1);
  assert.equal(setting("flag.focus.goal.monitor"), "true");
  assert.equal(setting("flag.focus.goal.understand"), undefined);
  assert.equal(setting("sync_bulk_state"), '{"fixture":"pending-sync"}');
  assert.equal(
    (db.prepare("SELECT content FROM annotations").get() as { content: string })
      .content,
    "Synthetic private note"
  );
  const exported = exportBackup();
  assert.equal(exported.tables.devices.rows.length, 1);
  assert.equal(exported.tables.app_devices.rows.length, 1);
  assert.equal(exported.tables.change_review_actions.rows.length, 1);
  assert.ok(!JSON.stringify(exported).includes("SYNTHETIC-SECRET-NEVER-REAL"));
  const restored = restoreBackup(exported);
  assert.equal(restored.trust, "trusted");
  assert.equal(count("devices"), 1);
  assert.equal(count("app_devices"), 1);
  assert.equal(count("privacy_snapshots"), 1);
  assert.deepEqual(runFeatureFlagMigration(), []);
  // Restoring a legacy backup must wipe newer children, never leave orphan
  // device/review links to apps absent from that backup.
  db.prepare(
    "INSERT INTO apps (id,name,url,lastSynced) VALUES ('discard','Discard','',0)"
  ).run();
  db.prepare("INSERT INTO app_devices VALUES ('discard','device',0,0)").run();
  const legacyRestore = restoreBackup(backup);
  assert.equal(legacyRestore.trust, "trusted");
  assert.equal(count("apps"), 1);
  assert.equal(count("app_devices"), 0); // v0.1.2 never exported devices.
  assert.equal(setting("flag.devopts.cfgutil_uninstall"), undefined);
} else if (mode === "cross-install") {
  assert.throws(() => restoreBackup(backup), BackupUntrustedError);
  assert.equal(count("apps"), 0);
  const restored = restoreBackup(backup, { allowUntrusted: true });
  assert.equal(restored.trust, "untrusted");
  assert.equal(count("apps"), 1);
  assert.equal(count("annotations"), 1);
  assert.equal(count("privacy_snapshots"), 1);
  assert.equal(setting("flag.devopts.cfgutil_uninstall"), undefined);
  assert.ok(
    !JSON.stringify(exportBackup()).includes("SYNTHETIC-SECRET-NEVER-REAL")
  );
} else {
  throw new Error(`Unknown rehearsal mode ${mode}`);
}
assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
assert.deepEqual(db.pragma("foreign_key_check"), []);
writeFileSync(
  path.join(process.env.PRIVACYTRACKER_DATA_DIR!, "rehearsal-result.json"),
  JSON.stringify({ mode, integrity: "ok", apps: count("apps") })
);
db.close();
