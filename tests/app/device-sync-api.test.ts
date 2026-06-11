/**
 * API round-trip tests for the device-sync endpoints. Calls the route
 * handlers directly via `new Request(...)` (no HTTP server).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import * as commitRoute from "../../app/api/device-sync/commit/route";
import * as previewRoute from "../../app/api/device-sync/preview/route";
import * as deviceItemRoute from "../../app/api/devices/[id]/route";
import * as devicesRoute from "../../app/api/devices/route";
import db from "../../lib/db";
import { createDevice, upsertAppDeviceLink } from "../../lib/devices";

function reset() {
  db.exec("DELETE FROM app_devices");
  db.exec("DELETE FROM devices");
  db.exec("DELETE FROM apps");
  try {
    db.exec("DELETE FROM app_verdicts");
  } catch {
    /* missing */
  }
}
function seedApp(id: string) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO apps (id, name, url, lastSynced, firstSeen) VALUES (?, ?, ?, ?, ?)"
  ).run(id, `App ${id}`, `https://apps.apple.com/app/id${id}`, now, now);
}
afterEach(() => reset());

function makeJsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-real-ip": "device-sync-test",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET /api/devices returns the device list with app counts", async () => {
  reset();
  seedApp("a");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("a", d.id);
  const res = await devicesRoute.GET(
    new Request("http://127.0.0.1/api/devices", {
      headers: { "x-real-ip": "device-sync-test" },
    }) as never
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].appCount, 1);
});

test("GET /api/devices?ecid=… returns matching device + import history", async () => {
  reset();
  const d = createDevice({ name: "Phone", ecid: "ECID-LOOKUP" });
  const res = await devicesRoute.GET(
    new Request("http://127.0.0.1/api/devices?ecid=ECID-LOOKUP", {
      headers: { "x-real-ip": "device-sync-test" },
    }) as never
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.device?.id, d.id);
  assert.equal(body.importHistory.count, 0);
  assert.equal(body.importHistory.lastCompletedAt, null);
});

test("GET /api/devices?ecid=… returns device:null when no match", async () => {
  reset();
  const res = await devicesRoute.GET(
    new Request("http://127.0.0.1/api/devices?ecid=ECID-MISSING", {
      headers: { "x-real-ip": "device-sync-test" },
    }) as never
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.device, null);
  assert.equal(body.importHistory, null);
});

test("POST /api/devices creates a device by name", async () => {
  reset();
  const res = await devicesRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/devices", "POST", {
      name: "My iPad",
    }) as never
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.device.name, "My iPad");
  assert.equal(body.device.ecid, null);
});

test("POST /api/devices with ecid re-uses an existing row", async () => {
  reset();
  const r1 = await devicesRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/devices", "POST", {
      name: "Phone",
      ecid: "ECID-RE-USE",
    }) as never
  );
  const b1 = await r1.json();
  const r2 = await devicesRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/devices", "POST", {
      name: "Other name",
      ecid: "ECID-RE-USE",
    }) as never
  );
  const b2 = await r2.json();
  assert.equal(b1.device.id, b2.device.id);
});

test("POST /api/devices rejects missing name", async () => {
  reset();
  const res = await devicesRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/devices", "POST", {}) as never
  );
  assert.equal(res.status, 400);
});

test("PATCH /api/devices/[id] renames", async () => {
  reset();
  const d = createDevice({ name: "Old" });
  const res = await deviceItemRoute.PATCH(
    makeJsonRequest(`http://127.0.0.1/api/devices/${d.id}`, "PATCH", {
      name: "New",
    }) as never,
    { params: Promise.resolve({ id: d.id }) }
  );
  const body = await res.json();
  assert.equal(body.device.name, "New");
});

test("PATCH /api/devices/[id] returns 404 for an unknown id", async () => {
  reset();
  const res = await deviceItemRoute.PATCH(
    makeJsonRequest("http://127.0.0.1/api/devices/zzz", "PATCH", {
      name: "x",
    }) as never,
    { params: Promise.resolve({ id: "zzz" }) }
  );
  assert.equal(res.status, 404);
});

test("DELETE /api/devices/[id] removes the device and orphan-sweeps", async () => {
  reset();
  seedApp("orphan");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("orphan", d.id);
  const res = await deviceItemRoute.DELETE(
    makeJsonRequest(`http://127.0.0.1/api/devices/${d.id}`, "DELETE") as never,
    { params: Promise.resolve({ id: d.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.orphanedAndDeleted, 1);
  assert.equal(
    db.prepare("SELECT id FROM apps WHERE id = ?").get("orphan"),
    undefined
  );
});

test("preview → commit round-trip applies adds + removes", async () => {
  reset();
  seedApp("keep");
  seedApp("gone");
  seedApp("new");
  const d = createDevice({ name: "iPhone" });
  upsertAppDeviceLink("keep", d.id);
  upsertAppDeviceLink("gone", d.id);

  const prev = await previewRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/device-sync/preview", "POST", {
      deviceId: d.id,
      currentImport: [
        { appId: "keep", name: "Keep" },
        { appId: "new", name: "New" },
      ],
    }) as never
  );
  const prevBody = await prev.json();
  assert.equal(prev.status, 200);
  assert.deepEqual(
    prevBody.diff.adds.map((a: { appId: string }) => a.appId).sort(),
    ["new"]
  );
  assert.deepEqual(
    prevBody.diff.removes.map((r: { appId: string }) => r.appId).sort(),
    ["gone"]
  );
  assert.equal(prevBody.diff.unchanged, 1);

  const commit = await commitRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/device-sync/commit", "POST", {
      deviceId: d.id,
      addAppIds: ["new"],
      removeAppIds: ["gone"],
    }) as never
  );
  const commitBody = await commit.json();
  assert.equal(commit.status, 200);
  assert.equal(commitBody.added, 1);
  assert.equal(commitBody.removed, 1);
  assert.equal(commitBody.orphanedAndDeleted, 1);
});

test("preview returns 404 for unknown deviceId", async () => {
  reset();
  const res = await previewRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/device-sync/preview", "POST", {
      deviceId: "ghost",
      currentImport: [],
    }) as never
  );
  assert.equal(res.status, 404);
});

test("preview rejects > 2000 currentImport entries", async () => {
  reset();
  const d = createDevice({ name: "X" });
  const big = Array.from({ length: 2001 }, (_, i) => ({
    appId: `a${i}`,
    name: "x",
  }));
  const res = await previewRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/device-sync/preview", "POST", {
      deviceId: d.id,
      currentImport: big,
    }) as never
  );
  assert.equal(res.status, 400);
});

test("commit rejects non-array addAppIds / removeAppIds", async () => {
  reset();
  const d = createDevice({ name: "X" });
  const res = await commitRoute.POST(
    makeJsonRequest("http://127.0.0.1/api/device-sync/commit", "POST", {
      deviceId: d.id,
      addAppIds: "nope",
      removeAppIds: [],
    }) as never
  );
  assert.equal(res.status, 400);
});
