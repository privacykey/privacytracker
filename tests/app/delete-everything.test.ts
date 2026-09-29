/**
 * "Delete everything": `/api/admin/start-over` (what Settings calls) and
 * `/api/reset` run one wipe (lib/wipe-all-data.ts). Before it, neither
 * removed devices, the device-to-app links, the automatic backup snapshots
 * or the backup signing key, and reset also kept the activity log, flag
 * overrides, audit-bundle imports and the AI debug log.
 *
 * Pinned here for both routes over one seeded install: every table empties,
 * the two process keys stay in `app_settings`, the snapshot files and the
 * key go while an unrelated file in the backups folder stays, and the one
 * activity row is the wipe's own.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import db, { dataDir } from "../../lib/db";
import { USER_DATA_TABLES_TO_TRUNCATE } from "../../lib/reset-tables";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const BACKUPS = path.join(dataDir, "backups");
const KEY = path.join(dataDir, "backup-signing.key");
const SNAPSHOT = "privacytracker-snapshot-2026-09-14T12-00-00-000Z.json";
const PARTIAL = `${SNAPSHOT}.tmp-123-abc`;
const UNRELATED = "notes.txt";

function seedInstall(): void {
  resetTestDb();
  const now = Date.now();
  seedTrackedApp({ id: "9001", name: "Signal" });
  db.prepare(
    `INSERT INTO devices (id, name, ecid, created_at, last_synced_at, owner_label, owner_audience, permission_acknowledged_at)
     VALUES ('dev-mum', 'Mum''s iPad', '0xABC', ?, ?, 'Mum', 'loved_one', ?)`
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) VALUES ('9001', 'dev-mum', ?, ?)"
  ).run(now, now);
  db.prepare(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES ('flag.dashboard.stats', 'off', ?, 'user', NULL, 0)"
  ).run(now);
  db.prepare(
    "INSERT INTO ai_debug_log (id, created_at, app_id, app_name, provider, model, phase, prompt, response, duration_ms, error) VALUES ('ai-1', ?, '9001', 'Signal', 'openai', 'gpt', 'direct', 'p', 'r', 1, NULL)"
  ).run(now);
  db.prepare(
    "INSERT INTO audit_log (id, created_at, action, actor_ip, user_agent, success, detail) VALUES ('audit-1', ?, 'earlier.action', '127.0.0.1', NULL, 1, NULL)"
  ).run(now);
  db.prepare(
    "INSERT INTO activity_log (id, type, status, summary, started_at, ended_at, duration_ms) VALUES ('act-1', 'sync', 'ok', 'earlier', ?, ?, 0)"
  ).run(now, now);
  const setting = db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  );
  setting.run("feature_flag_migration_version", "2");
  setting.run("runtime_environment", "desktop");
  setting.run("sync_schedule", "daily");
  setting.run("welcomed_at", String(now));

  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.writeFileSync(path.join(BACKUPS, SNAPSHOT), "{}");
  fs.writeFileSync(path.join(BACKUPS, PARTIAL), "{");
  fs.writeFileSync(path.join(BACKUPS, UNRELATED), "keep me");
  fs.writeFileSync(KEY, "c2lnbmluZy1rZXktZm9yLXRlc3RzLW9ubHk=\n");
}

function count(table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function assertWiped(mode: string): void {
  for (const table of USER_DATA_TABLES_TO_TRUNCATE) {
    if (table === "activity_log" || table === "audit_log") {
      continue;
    }
    assert.equal(count(table), 0, `${table} should be empty after ${mode}`);
  }
  assert.equal(count("devices"), 0);
  assert.equal(count("app_devices"), 0);

  const settings = db
    .prepare("SELECT key, value FROM app_settings ORDER BY key")
    .all();
  assert.deepEqual(settings, [
    { key: "feature_flag_migration_version", value: "2" },
    { key: "runtime_environment", value: "desktop" },
  ]);

  const activity = db
    .prepare("SELECT type, status, detail FROM activity_log")
    .all() as { type: string; status: string; detail: string }[];
  assert.equal(activity.length, 1);
  assert.equal(activity[0].type, "reset");
  assert.deepEqual(JSON.parse(activity[0].detail), {
    mode,
    backupSnapshotsDeleted: 2,
    signingKeyDeleted: true,
  });
  // The earlier audit row went with the wipe; the route's own came after.
  const audit = db.prepare("SELECT id FROM audit_log").all() as {
    id: string;
  }[];
  assert.equal(audit.length, 1);
  assert.notEqual(audit[0].id, "audit-1");

  assert.equal(fs.existsSync(KEY), false, "signing key should be deleted");
  assert.deepEqual(fs.readdirSync(BACKUPS), [UNRELATED]);
}

test.afterEach(() => {
  fs.rmSync(BACKUPS, { recursive: true, force: true });
  fs.rmSync(KEY, { force: true });
});

test("start over deletes devices, snapshots and the signing key", async () => {
  seedInstall();
  const route = await import("../../app/api/admin/start-over/route");
  const res = await route.POST(
    new Request("http://127.0.0.1/api/admin/start-over", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.40" },
    })
  );
  assert.equal(res.status, 200);
  assertWiped("start-over");
});

test("reset runs the same wipe", async () => {
  seedInstall();
  const route = await import("../../app/api/reset/route");
  const res = await route.POST(
    new Request("http://127.0.0.1/api/reset", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.41" },
    })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assertWiped("reset");
});

test("start over refuses while a sync runs, and deletes nothing", async () => {
  seedInstall();
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sync_running', 'true')"
  ).run();
  const route = await import("../../app/api/admin/start-over/route");
  const res = await route.POST(
    new Request("http://127.0.0.1/api/admin/start-over", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.42" },
    })
  );
  assert.equal(res.status, 409);
  assert.equal(count("devices"), 1);
  assert.equal(count("apps"), 1);
  assert.equal(fs.existsSync(KEY), true);
  assert.equal(fs.existsSync(path.join(BACKUPS, SNAPSHOT)), true);
});
