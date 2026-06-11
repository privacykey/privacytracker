/**
 * DB-touching tests for the device-sync diff engine. Each test seeds a
 * known device + apps state, then asserts on the diff output and the
 * side-effects of committing a chosen subset.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import db from "../../lib/db";
import {
  applyDeviceSyncDiff,
  computeDeviceSyncDiff,
  type ImportedAppRef,
} from "../../lib/device-sync";
import {
  createDevice,
  type Device,
  upsertAppDeviceLink,
} from "../../lib/devices";

function reset() {
  db.exec("DELETE FROM app_devices");
  db.exec("DELETE FROM devices");
  db.exec("DELETE FROM apps");
  try {
    db.exec("DELETE FROM app_verdicts");
  } catch {
    /* missing */
  }
  try {
    db.exec("DELETE FROM annotations");
  } catch {
    /* missing */
  }
  try {
    db.exec("DELETE FROM shortlist_entries");
  } catch {
    /* missing */
  }
}

function seedApp(
  id: string,
  name = `App ${id}`,
  bundleId: string | null = null
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO apps (id, name, url, lastSynced, firstSeen, bundleId)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, `https://apps.apple.com/app/id${id}`, now, now, bundleId);
}

function setup(): Device {
  reset();
  return createDevice({ name: "Test iPhone" });
}

function makeIncoming(
  rows: Array<{ id: string; name?: string }>
): ImportedAppRef[] {
  return rows.map((r) => ({
    appId: r.id,
    name: r.name ?? `App ${r.id}`,
  }));
}

afterEach(() => reset());

test("computeDeviceSyncDiff: empty device — everything is an add", () => {
  const device = setup();
  seedApp("a");
  seedApp("b");
  const diff = computeDeviceSyncDiff(
    device.id,
    makeIncoming([{ id: "a" }, { id: "b" }])
  );
  assert.equal(diff.adds.length, 2);
  assert.equal(diff.removes.length, 0);
  assert.equal(diff.unchanged, 0);
});

test("computeDeviceSyncDiff: empty incoming — everything is a remove", () => {
  const device = setup();
  seedApp("a");
  seedApp("b");
  upsertAppDeviceLink("a", device.id);
  upsertAppDeviceLink("b", device.id);
  const diff = computeDeviceSyncDiff(device.id, []);
  assert.equal(diff.adds.length, 0);
  assert.equal(diff.removes.length, 2);
  assert.equal(diff.unchanged, 0);
});

test("computeDeviceSyncDiff: mixed adds / removes / unchanged", () => {
  const device = setup();
  seedApp("keep");
  seedApp("gone");
  seedApp("new");
  upsertAppDeviceLink("keep", device.id);
  upsertAppDeviceLink("gone", device.id);
  const diff = computeDeviceSyncDiff(
    device.id,
    makeIncoming([{ id: "keep" }, { id: "new" }])
  );
  assert.deepEqual(diff.adds.map((a) => a.appId).sort(), ["new"]);
  assert.deepEqual(diff.removes.map((r) => r.appId).sort(), ["gone"]);
  assert.equal(diff.unchanged, 1);
});

test("computeDeviceSyncDiff: dedupes a duplicate incoming row", () => {
  const device = setup();
  seedApp("twin");
  const diff = computeDeviceSyncDiff(
    device.id,
    makeIncoming([{ id: "twin" }, { id: "twin" }])
  );
  assert.equal(diff.adds.length, 1);
});

test("computeDeviceSyncDiff: wouldOrphan=true when app is only on this device + no user data", () => {
  const device = setup();
  seedApp("lonely");
  upsertAppDeviceLink("lonely", device.id);
  const diff = computeDeviceSyncDiff(device.id, []);
  assert.equal(diff.removes.length, 1);
  assert.equal(diff.removes[0].wouldOrphan, true);
});

test("computeDeviceSyncDiff: wouldOrphan=false when app is also on another device", () => {
  const device = setup();
  const other = createDevice({ name: "iPad" });
  seedApp("shared");
  upsertAppDeviceLink("shared", device.id);
  upsertAppDeviceLink("shared", other.id);
  const diff = computeDeviceSyncDiff(device.id, []);
  assert.equal(diff.removes[0].wouldOrphan, false);
});

test("computeDeviceSyncDiff: wouldOrphan=false when app has user verdict", () => {
  const device = setup();
  seedApp("verdicted");
  upsertAppDeviceLink("verdicted", device.id);
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_verdicts (id, app_id, verdict, source, source_name, set_at, updated_at)
    VALUES (?, ?, 'replace', 'user', NULL, ?, ?)
  `).run("v1", "verdicted", now, now);
  const diff = computeDeviceSyncDiff(device.id, []);
  assert.equal(diff.removes[0].wouldOrphan, false);
});

test("computeDeviceSyncDiff: imported verdicts do NOT prevent orphan", () => {
  const device = setup();
  seedApp("rec-only");
  upsertAppDeviceLink("rec-only", device.id);
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_verdicts (id, app_id, verdict, source, source_name, set_at, updated_at)
    VALUES (?, ?, 'replace', 'imported', 'a friend', ?, ?)
  `).run("v2", "rec-only", now, now);
  const diff = computeDeviceSyncDiff(device.id, []);
  assert.equal(diff.removes[0].wouldOrphan, true);
});

test("computeDeviceSyncDiff: throws on unknown deviceId", () => {
  reset();
  assert.throws(
    () => computeDeviceSyncDiff("does-not-exist", []),
    /unknown deviceId/
  );
});

test("applyDeviceSyncDiff: adds and removes apply atomically", () => {
  const device = setup();
  seedApp("keep");
  seedApp("gone");
  seedApp("new");
  upsertAppDeviceLink("keep", device.id);
  upsertAppDeviceLink("gone", device.id);
  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: ["new"],
    removeAppIds: ["gone"],
  });
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.orphanedAndDeleted, 1); // 'gone' had no other devices, no user data
  // Junction state: 'keep' + 'new', not 'gone'.
  const ids = (
    db
      .prepare("SELECT app_id FROM app_devices WHERE device_id = ?")
      .all(device.id) as { app_id: string }[]
  )
    .map((r) => r.app_id)
    .sort();
  assert.deepEqual(ids, ["keep", "new"]);
  // 'gone' should be fully removed from apps.
  assert.equal(
    db.prepare("SELECT id FROM apps WHERE id = ?").get("gone"),
    undefined
  );
});

test("applyDeviceSyncDiff: removed app survives when also on another device", () => {
  const device = setup();
  const other = createDevice({ name: "iPad" });
  seedApp("shared");
  upsertAppDeviceLink("shared", device.id);
  upsertAppDeviceLink("shared", other.id);
  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: [],
    removeAppIds: ["shared"],
  });
  assert.equal(result.orphanedAndDeleted, 0);
  assert.ok(db.prepare("SELECT id FROM apps WHERE id = ?").get("shared"));
  // Still linked to iPad.
  const links = db
    .prepare("SELECT device_id FROM app_devices WHERE app_id = ?")
    .all("shared");
  assert.equal(links.length, 1);
});

test("applyDeviceSyncDiff: silently skips ids that don't reference real apps", () => {
  const device = setup();
  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: ["ghost"],
    removeAppIds: ["phantom"],
  });
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
});

test("applyDeviceSyncDiff: updates devices.last_synced_at on commit", () => {
  const device = setup();
  const before = device.lastSyncedAt;
  // Tick the clock so we can detect the bump.
  const ts = Date.now() + 1000;
  db.prepare("UPDATE devices SET last_synced_at = ? WHERE id = ?").run(
    0,
    device.id
  );
  applyDeviceSyncDiff(device.id, { addAppIds: [], removeAppIds: [] });
  const after = (
    db
      .prepare("SELECT last_synced_at FROM devices WHERE id = ?")
      .get(device.id) as { last_synced_at: number }
  ).last_synced_at;
  assert.ok(after > 0);
  // Avoid unused-var warnings on `before` / `ts`.
  void before;
  void ts;
});

test("applyDeviceSyncDiff: no-op selection is allowed", () => {
  const device = setup();
  seedApp("a");
  upsertAppDeviceLink("a", device.id);
  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: [],
    removeAppIds: [],
  });
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.orphanedAndDeleted, 0);
});

// ─── Bundle-ID dedupe (migration artifact) ─────────────────────────
//
// Two legacy import paths can leave the apps table with two rows for
// the same physical app: a name-search row and a cfgutil bundle-ID
// row. The diff matches them by bundleId and surfaces a "merge" pair;
// applyDeviceSyncDiff collapses the duplicate by transferring user
// data from the old appId onto the incoming appId.

test("computeDeviceSyncDiff: same bundle ID + different track ID counts as unchanged", () => {
  const device = setup();
  // Legacy row — what was imported originally via a different path.
  seedApp("old-track", "Microsoft Excel", "com.microsoft.Office.Excel");
  upsertAppDeviceLink("old-track", device.id);
  // Incoming row — the new cfgutil import resolved the same bundle
  // ID to a different track ID and created a new apps row.
  seedApp("new-track", "Excel", "com.microsoft.Office.Excel");

  const diff = computeDeviceSyncDiff(device.id, [
    {
      appId: "new-track",
      name: "Excel",
      bundleId: "com.microsoft.Office.Excel",
    },
  ]);

  // The user-visible counts should reflect "no real change".
  assert.equal(diff.adds.length, 0);
  assert.equal(diff.removes.length, 0);
  assert.equal(diff.unchanged, 1);
  // …but the merges array carries the pair so the commit can collapse.
  assert.equal(diff.bundleIdMerges.length, 1);
  assert.equal(diff.bundleIdMerges[0].previousAppId, "old-track");
  assert.equal(diff.bundleIdMerges[0].incomingAppId, "new-track");
  assert.equal(diff.bundleIdMerges[0].bundleId, "com.microsoft.Office.Excel");
});

test("computeDeviceSyncDiff: same track ID always wins over bundle-ID fallback", () => {
  const device = setup();
  seedApp("a", "App A", "com.example.a");
  upsertAppDeviceLink("a", device.id);
  const diff = computeDeviceSyncDiff(device.id, [
    { appId: "a", name: "App A", bundleId: "com.example.a" },
  ]);
  assert.equal(diff.unchanged, 1);
  assert.equal(diff.bundleIdMerges.length, 0);
});

test("computeDeviceSyncDiff: bundle-ID match only fires when the previous app is linked to THIS device", () => {
  // A duplicate apps row that's NOT on the device shouldn't get
  // pulled into the merges (the diff scope is per-device).
  const device = setup();
  seedApp("orphan-track", "Stale Excel", "com.microsoft.Office.Excel");
  // No upsertAppDeviceLink for 'orphan-track' — it's just floating.
  seedApp("new-track", "Excel", "com.microsoft.Office.Excel");

  const diff = computeDeviceSyncDiff(device.id, [
    {
      appId: "new-track",
      name: "Excel",
      bundleId: "com.microsoft.Office.Excel",
    },
  ]);

  // Should be a plain add — the orphan row isn't on this device, so
  // there's no migration artifact for the device-sync to collapse.
  assert.equal(diff.adds.length, 1);
  assert.equal(diff.bundleIdMerges.length, 0);
});

test("applyDeviceSyncDiff: bundle-ID merge transfers verdicts + annotations + device links", () => {
  const device = setup();
  seedApp("old-track", "Microsoft Excel", "com.microsoft.Office.Excel");
  seedApp("new-track", "Excel", "com.microsoft.Office.Excel");
  upsertAppDeviceLink("old-track", device.id);

  // Attach a verdict + an annotation to the old row.
  const now = Date.now();
  db.prepare(`
    INSERT INTO app_verdicts (id, app_id, verdict, source, source_name, set_at, updated_at)
    VALUES (?, ?, 'safe', 'user', NULL, ?, ?)
  `).run("v-merge", "old-track", now, now);
  db.prepare(`
    INSERT INTO annotations (id, app_id, content, source, visibility, created_at, updated_at)
    VALUES (?, ?, 'kept for testing', 'user', 'private', ?, ?)
  `).run("ann-merge", "old-track", now, now);

  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: [],
    removeAppIds: [],
    bundleIdMerges: [
      { previousAppId: "old-track", incomingAppId: "new-track" },
    ],
  });

  assert.equal(result.merged, 1);

  // Old row is gone, new row is on the device.
  const oldRow = db.prepare("SELECT 1 FROM apps WHERE id = ?").get("old-track");
  assert.equal(oldRow, undefined, "old apps row should be deleted");
  const newRowOnDevice = db
    .prepare("SELECT 1 FROM app_devices WHERE app_id = ? AND device_id = ?")
    .get("new-track", device.id);
  assert.ok(newRowOnDevice, "new appId should be linked to the device");

  // Verdict + annotation moved to the new id.
  const verdict = db
    .prepare("SELECT app_id FROM app_verdicts WHERE id = ?")
    .get("v-merge") as { app_id: string } | undefined;
  assert.equal(verdict?.app_id, "new-track");
  const annotation = db
    .prepare("SELECT app_id FROM annotations WHERE id = ?")
    .get("ann-merge") as { app_id: string } | undefined;
  assert.equal(annotation?.app_id, "new-track");
});

test("applyDeviceSyncDiff: merge is a no-op when previous and incoming ids are the same", () => {
  const device = setup();
  seedApp("same", "App", "com.example");
  upsertAppDeviceLink("same", device.id);

  const result = applyDeviceSyncDiff(device.id, {
    addAppIds: [],
    removeAppIds: [],
    bundleIdMerges: [{ previousAppId: "same", incomingAppId: "same" }],
  });

  assert.equal(result.merged, 0);
  // Row still exists.
  const row = db.prepare("SELECT id FROM apps WHERE id = ?").get("same");
  assert.ok(row);
});
