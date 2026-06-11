/**
 * DB-touching tests for `lib/devices.ts` + schema migration.
 *
 * Each test starts from a clean slate by emptying the tables we touch.
 * The per-test SQLite file is created by `tests/helpers/setup-env.ts` via the
 * `PRIVACYTRACKER_DATA_DIR` env var.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import db from "../../lib/db";
import {
  createDevice,
  deleteDevice,
  findOrCreateDeviceByEcid,
  getAllDevices,
  getDeviceAppCounts,
  getDeviceById,
  getDevicesForApp,
  getMostRecentlySyncedDeviceId,
  orphanSweepApp,
  renameDevice,
  setDeviceLastSyncedAt,
  unlinkAppFromDevice,
  upsertAppDeviceLink,
} from "../../lib/devices";

function reset() {
  db.exec("DELETE FROM app_devices");
  db.exec("DELETE FROM devices");
  db.exec("DELETE FROM apps");
  // User-data tables that gate orphan deletion — wipe so each test
  // starts with no attached user data.
  try {
    db.exec("DELETE FROM app_verdicts");
  } catch {
    /* table may not exist */
  }
  try {
    db.exec("DELETE FROM annotations");
  } catch {
    /* table may not exist */
  }
  try {
    db.exec("DELETE FROM shortlist_entries");
  } catch {
    /* table may not exist */
  }
}

function seedApp(id: string, name = `App ${id}`): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO apps (id, name, url, lastSynced, firstSeen)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, `https://apps.apple.com/app/id${id}`, now, now);
}

afterEach(() => reset());

test("schema: devices table exists with the expected columns", () => {
  reset();
  const cols = (
    db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]
  )
    .map((c) => c.name)
    .sort();
  assert.deepEqual(cols, [
    "created_at",
    "device_class",
    "ecid",
    "id",
    "ios_version",
    "is_unknown_placeholder",
    "last_synced_at",
    "model",
    "name",
  ]);
});

test("schema: app_devices junction exists and cascades on app delete", () => {
  reset();
  seedApp("111");
  const d = createDevice({ name: "My iPhone" });
  upsertAppDeviceLink("111", d.id);
  assert.equal(getDevicesForApp("111").length, 1);
  db.prepare("DELETE FROM apps WHERE id = ?").run("111");
  // Junction row should be gone via FK cascade.
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM app_devices")
    .get() as { n: number };
  assert.equal(remaining.n, 0);
});

test("schema: app_devices junction cascades on device delete (via deleteDevice)", () => {
  reset();
  seedApp("222");
  const d = createDevice({ name: "My iPhone" });
  upsertAppDeviceLink("222", d.id);
  deleteDevice(d.id);
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM app_devices")
    .get() as { n: number };
  assert.equal(remaining.n, 0);
});

test("createDevice rejects empty names", () => {
  reset();
  assert.throws(() => createDevice({ name: "" }), /name must not be empty/);
  assert.throws(() => createDevice({ name: "   " }), /name must not be empty/);
});

test("findOrCreateDeviceByEcid: creates first time, re-uses second time", () => {
  reset();
  const first = findOrCreateDeviceByEcid("ECID-ABC", "Aria’s iPhone", {
    model: "iPhone 15 Pro",
  });
  const second = findOrCreateDeviceByEcid(
    "ECID-ABC",
    "Different fallback name"
  );
  assert.equal(first.id, second.id);
  // Second call shouldn't rename — user may have changed the name.
  assert.equal(second.name, first.name);
});

test("findOrCreateDeviceByEcid: refreshes metadata when newer reading arrives", () => {
  reset();
  const first = findOrCreateDeviceByEcid("ECID-XYZ", "Phone", {
    iosVersion: "17.0",
  });
  findOrCreateDeviceByEcid("ECID-XYZ", "Phone", {
    iosVersion: "18.1",
    model: "iPhone 16",
  });
  const after = getDeviceById(first.id)!;
  assert.equal(after.iosVersion, "18.1");
  assert.equal(after.model, "iPhone 16");
});

test("ECID unique index: distinct ECIDs allowed; duplicate rejected", () => {
  reset();
  createDevice({ name: "A", ecid: "ECID-1" });
  createDevice({ name: "B", ecid: "ECID-2" });
  assert.throws(() => createDevice({ name: "C", ecid: "ECID-1" }), /UNIQUE/);
});

test("multiple devices with NULL ecid are allowed (CSV/manual imports)", () => {
  reset();
  const a = createDevice({ name: "CSV import" });
  const b = createDevice({ name: "Manual import" });
  assert.notEqual(a.id, b.id);
  assert.equal(getAllDevices().length, 2);
});

test("unlinkAppFromDevice: drops junction; orphan-sweeps when last device + no user data", () => {
  reset();
  seedApp("app-1");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("app-1", d.id);
  const result = unlinkAppFromDevice("app-1", d.id);
  assert.equal(result.orphaned, true);
  // App row should be gone.
  const row = db.prepare("SELECT id FROM apps WHERE id = ?").get("app-1");
  assert.equal(row, undefined);
});

test("unlinkAppFromDevice: keeps app alive when it has another device link", () => {
  reset();
  seedApp("app-2");
  const iphone = createDevice({ name: "iPhone" });
  const ipad = createDevice({ name: "iPad" });
  upsertAppDeviceLink("app-2", iphone.id);
  upsertAppDeviceLink("app-2", ipad.id);
  const result = unlinkAppFromDevice("app-2", iphone.id);
  assert.equal(result.orphaned, false);
  // App row still present, link to iPad remains.
  const row = db.prepare("SELECT id FROM apps WHERE id = ?").get("app-2");
  assert.ok(row);
  assert.equal(getDevicesForApp("app-2").length, 1);
});

test("unlinkAppFromDevice: keeps app alive when user has set a verdict", () => {
  reset();
  seedApp("app-3");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("app-3", d.id);
  // Attach a user verdict so orphan sweep should skip the delete.
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_verdicts (id, app_id, verdict, source, source_name, set_at, updated_at)
    VALUES (?, ?, 'safe', 'user', NULL, ?, ?)
  `).run("v1", "app-3", now, now);
  const result = unlinkAppFromDevice("app-3", d.id);
  assert.equal(result.orphaned, false);
  const row = db.prepare("SELECT id FROM apps WHERE id = ?").get("app-3");
  assert.ok(row);
});

test("unlinkAppFromDevice: imported verdicts do NOT keep the app alive", () => {
  reset();
  seedApp("app-4");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("app-4", d.id);
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_verdicts (id, app_id, verdict, source, source_name, set_at, updated_at)
    VALUES (?, ?, 'safe', 'imported', 'recommender', ?, ?)
  `).run("v2", "app-4", now, now);
  const result = unlinkAppFromDevice("app-4", d.id);
  assert.equal(result.orphaned, true);
});

test("unlinkAppFromDevice with allowOrphanDelete=false never deletes", () => {
  reset();
  seedApp("app-5");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("app-5", d.id);
  const result = unlinkAppFromDevice("app-5", d.id, {
    allowOrphanDelete: false,
  });
  assert.equal(result.orphaned, false);
  const row = db.prepare("SELECT id FROM apps WHERE id = ?").get("app-5");
  assert.ok(row);
});

test("deleteDevice with reassignToDeviceId moves links instead of deleting", () => {
  reset();
  seedApp("app-6");
  seedApp("app-7");
  const src = createDevice({ name: "Old iPhone" });
  const dst = createDevice({ name: "New iPhone" });
  upsertAppDeviceLink("app-6", src.id);
  upsertAppDeviceLink("app-7", src.id);
  const result = deleteDevice(src.id, { reassignToDeviceId: dst.id });
  assert.equal(result.orphanedAndDeleted, 0);
  assert.equal(getDevicesForApp("app-6")[0].id, dst.id);
  assert.equal(getDevicesForApp("app-7")[0].id, dst.id);
  assert.equal(getDeviceById(src.id), null);
});

test("deleteDevice with reassignment merges existing target links cleanly", () => {
  reset();
  seedApp("shared");
  const src = createDevice({ name: "Old" });
  const dst = createDevice({ name: "New" });
  upsertAppDeviceLink("shared", src.id);
  upsertAppDeviceLink("shared", dst.id);
  deleteDevice(src.id, { reassignToDeviceId: dst.id });
  // No PK collision; one row on dst.
  const links = getDevicesForApp("shared");
  assert.equal(links.length, 1);
  assert.equal(links[0].id, dst.id);
});

test("deleteDevice without reassignment orphan-sweeps apps with no other links", () => {
  reset();
  seedApp("lonely-app");
  seedApp("shared-app");
  const a = createDevice({ name: "A" });
  const b = createDevice({ name: "B" });
  upsertAppDeviceLink("lonely-app", a.id);
  upsertAppDeviceLink("shared-app", a.id);
  upsertAppDeviceLink("shared-app", b.id);
  const result = deleteDevice(a.id);
  assert.equal(result.orphanedAndDeleted, 1);
  // lonely-app is gone; shared-app still tracked under B.
  assert.equal(
    db.prepare("SELECT id FROM apps WHERE id = ?").get("lonely-app"),
    undefined
  );
  assert.ok(db.prepare("SELECT id FROM apps WHERE id = ?").get("shared-app"));
});

test("getDeviceAppCounts returns per-device counts", () => {
  reset();
  seedApp("x");
  seedApp("y");
  seedApp("z");
  const a = createDevice({ name: "A" });
  const b = createDevice({ name: "B" });
  upsertAppDeviceLink("x", a.id);
  upsertAppDeviceLink("y", a.id);
  upsertAppDeviceLink("z", b.id);
  const counts = getDeviceAppCounts();
  assert.equal(counts.get(a.id), 2);
  assert.equal(counts.get(b.id), 1);
});

test("renameDevice updates the name; rejects empty", () => {
  reset();
  const d = createDevice({ name: "Old name" });
  renameDevice(d.id, "New name");
  assert.equal(getDeviceById(d.id)!.name, "New name");
  assert.throws(() => renameDevice(d.id, "   "));
});

test("setDeviceLastSyncedAt + getMostRecentlySyncedDeviceId reflect order", () => {
  reset();
  const older = createDevice({ name: "Older" });
  const newer = createDevice({ name: "Newer" });
  setDeviceLastSyncedAt(older.id, 1_000_000);
  setDeviceLastSyncedAt(newer.id, 2_000_000);
  assert.equal(getMostRecentlySyncedDeviceId(), newer.id);
});

test("orphanSweepApp leaves apps that still have device links", () => {
  reset();
  seedApp("keep-me");
  const d = createDevice({ name: "iPad" });
  upsertAppDeviceLink("keep-me", d.id);
  assert.equal(orphanSweepApp("keep-me"), false);
  assert.ok(db.prepare("SELECT id FROM apps WHERE id = ?").get("keep-me"));
});

test("upsertAppDeviceLink is idempotent; later last_seen overwrites", () => {
  reset();
  seedApp("idem");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("idem", d.id, 100);
  upsertAppDeviceLink("idem", d.id, 200);
  const row = db
    .prepare(
      "SELECT first_seen_at, last_seen_at FROM app_devices WHERE app_id = ? AND device_id = ?"
    )
    .get("idem", d.id) as { first_seen_at: number; last_seen_at: number };
  assert.equal(row.first_seen_at, 100);
  assert.equal(row.last_seen_at, 200);
});
