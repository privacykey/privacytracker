/**
 * Pin the /api/apps pagination contract and the paged query underneath it.
 *
 * The stress report (scripts/stress/REPORT.md) flagged the apps grid +
 * /api/apps as the app's only real scaling bottleneck: both serialised the
 * whole fleet per request. The fix is opt-in pagination — these tests pin:
 *
 *   - the bare form (no params) STILL returns the full array — it's the
 *     documented public contract;
 *   - `?limit=…` switches to a `{ apps, total, limit, offset }` envelope;
 *   - `&meta=grid` bundles the per-app side-band maps scoped to the page;
 *   - `getAppsPage` pages walk the same name-ordered fleet with no gaps or
 *     overlap, with per-page (not per-fleet) aggregate counts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../../app/api/apps/route";
import { createDevice, upsertAppDeviceLink } from "../../lib/devices";
import { countApps, getAllApps, getAppsPage } from "../../lib/scraper";
import {
  resetTestDb,
  seedPrivacyCategory,
  seedTrackedApp,
} from "../helpers/test-db";

test.beforeEach(() => {
  resetTestDb();
});

function getApps(query: string) {
  return GET(
    new Request(`http://127.0.0.1/api/apps${query}`, {
      headers: { host: "127.0.0.1" },
    }) as Parameters<typeof GET>[0]
  );
}

function seedFleet(names: string[]) {
  names.forEach((name, i) => {
    seedTrackedApp({ id: String(1000 + i), name });
  });
}

test("getAppsPage pages cover the fleet in order with no gaps or overlap", () => {
  // Two apps share a name on purpose — the id tiebreak must keep the
  // page boundary deterministic.
  seedFleet(["Alpha", "Bravo", "Charlie", "Same Name", "Same Name", "Zulu"]);

  const pages = [
    getAppsPage({ limit: 2, offset: 0 }),
    getAppsPage({ limit: 2, offset: 2 }),
    getAppsPage({ limit: 2, offset: 4 }),
  ] as Array<Array<{ id: string; name: string }>>;
  const walked = pages.flat().map((a) => a.id);

  assert.equal(walked.length, 6);
  assert.equal(new Set(walked).size, 6, "no app appears on two pages");
  const allIds = (getAllApps() as Array<{ id: string }>).map((a) => a.id);
  assert.deepEqual([...walked].sort(), [...allIds].sort());
  // Name order is preserved across page boundaries.
  const names = pages.flat().map((a) => a.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b))
  );
});

test("getAppsPage rows carry the same aggregate counts as getAllApps", () => {
  seedFleet(["Alpha", "Bravo"]);
  seedPrivacyCategory({
    appId: "1000",
    typeIdentifier: "DATA_USED_TO_TRACK_YOU",
    typeTitle: "Data Used to Track You",
    categoryIdentifier: "LOCATION",
    categoryTitle: "Location",
  });

  const paged = getAppsPage({ limit: 10 }) as Array<{
    id: string;
    categoryCount: number;
    trackCount: number;
  }>;
  const full = getAllApps() as typeof paged;
  for (const row of paged) {
    const ref = full.find((a) => a.id === row.id);
    assert.ok(ref, `app ${row.id} present in getAllApps`);
    assert.equal(row.categoryCount, ref.categoryCount);
    assert.equal(row.trackCount, ref.trackCount);
  }
});

test("countApps matches the fleet size", () => {
  assert.equal(countApps(), 0);
  seedFleet(["Alpha", "Bravo", "Charlie"]);
  assert.equal(countApps(), 3);
});

test("bare GET /api/apps still returns the full array (public contract)", async () => {
  seedFleet(["Alpha", "Bravo", "Charlie", "Delta"]);

  const res = await getApps("");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body), "bare form stays a bare array");
  assert.equal(body.length, 4);
});

test("?limit switches to the envelope shape", async () => {
  seedFleet(["Alpha", "Bravo", "Charlie", "Delta"]);

  const res = await getApps("?limit=2&offset=2");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Array.isArray(body), false);
  assert.equal(body.total, 4);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 2);
  assert.equal(body.apps.length, 2);
  assert.equal(body.meta, undefined, "meta only ships when asked for");
  // Envelope pages must agree with the query layer.
  const expected = (
    getAppsPage({ limit: 2, offset: 2 }) as Array<{ id: string }>
  ).map((a) => a.id);
  assert.deepEqual(
    body.apps.map((a: { id: string }) => a.id),
    expected
  );
});

test("&meta=grid bundles side-band maps scoped to the page's ids", async () => {
  // Names chosen so page 1 = Alpha+Bravo, page 2 = Charlie+Delta.
  seedFleet(["Alpha", "Bravo", "Charlie", "Delta"]);
  const firstPageId = "1000"; // Alpha
  const secondPageId = "1003"; // Delta
  const device = createDevice({ name: "Test Phone" });
  upsertAppDeviceLink(firstPageId, device.id);
  upsertAppDeviceLink(secondPageId, device.id);

  const page1 = await (await getApps("?limit=2&offset=0&meta=grid")).json();
  assert.ok(page1.meta, "meta present when requested");
  assert.deepEqual(page1.meta.appDeviceMap[firstPageId], [device.id]);
  assert.equal(
    page1.meta.appDeviceMap[secondPageId],
    undefined,
    "page 1 meta must not leak page 2 apps"
  );

  const page2 = await (await getApps("?limit=2&offset=2&meta=grid")).json();
  assert.deepEqual(page2.meta.appDeviceMap[secondPageId], [device.id]);
  assert.equal(page2.meta.appDeviceMap[firstPageId], undefined);
});

test("invalid pagination params are rejected with 400", async () => {
  seedFleet(["Alpha"]);
  for (const query of [
    "?limit=0",
    "?limit=-5",
    "?limit=abc",
    "?limit=501",
    "?limit=10&offset=-1",
    "?limit=10&offset=abc",
  ]) {
    const res = await getApps(query);
    assert.equal(res.status, 400, `${query} should be rejected`);
  }
});

test("an offset past the end returns an empty page, not an error", async () => {
  seedFleet(["Alpha", "Bravo"]);
  const body = await (await getApps("?limit=10&offset=50")).json();
  assert.equal(body.apps.length, 0);
  assert.equal(body.total, 2);
});
