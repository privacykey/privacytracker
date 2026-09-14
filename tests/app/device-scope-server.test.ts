/**
 * Server-side device scoping: persistence, SQL fragments, and the rule
 * that keeps the public API honest.
 *
 * The contract worth guarding hardest is the LAST one in this file — a
 * stored scope must not change what a bare request returns. The scope is
 * a UI preference; letting it silently reshape `GET /api/apps` would
 * make a documented response depend on what the user last clicked in the
 * nav, which no API consumer can see or reason about.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DeviceScope,
  SCOPE_ALL,
  serialiseScopeParam,
} from "../../lib/device-scope";
import {
  getDeviceScope,
  getScopedAppIds,
  resetDeviceScope,
  saveDeviceScope,
  scopeFromRequest,
  scopeSqlClause,
} from "../../lib/device-scope-server";
import { createDevice, upsertAppDeviceLink } from "../../lib/devices";
import { countApps, getAllApps, getAppsPage } from "../../lib/scraper";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

/**
 * Two devices and three apps: one on the phone, one on the tablet, one
 * with no device link at all (the manual / CSV case).
 */
function seedFleet() {
  const phone = createDevice({ name: "My iPhone", deviceClass: "iPhone" });
  const tablet = createDevice({ name: "Mum's iPad", deviceClass: "iPad" });
  seedTrackedApp({ id: "app-phone", name: "Phone App" });
  seedTrackedApp({ id: "app-tablet", name: "Tablet App" });
  seedTrackedApp({ id: "app-manual", name: "Manual App" });
  upsertAppDeviceLink("app-phone", phone.id);
  upsertAppDeviceLink("app-tablet", tablet.id);
  return { phone, tablet };
}

const subset = (ids: string[], unattached = false): DeviceScope => ({
  v: 1,
  mode: "subset",
  deviceIds: ids,
  includeUnattached: unattached,
});

test.beforeEach(() => {
  resetTestDb();
});

// ── persistence ──────────────────────────────────────────────

test("an unset scope reads back as all devices", () => {
  assert.equal(getDeviceScope().mode, "all");
});

test("a saved subset round-trips", () => {
  const { phone } = seedFleet();
  saveDeviceScope(subset([phone.id]));
  const read = getDeviceScope();
  assert.equal(read.mode, "subset");
  assert.deepEqual(read.deviceIds, [phone.id]);
});

test("save reconciles unknown ids away before persisting", () => {
  const { phone } = seedFleet();
  const saved = saveDeviceScope(subset([phone.id, "ghost"]));
  assert.deepEqual(saved.deviceIds, [phone.id]);
  assert.deepEqual(getDeviceScope().deviceIds, [phone.id]);
});

test("a scope pointing only at a deleted device reads back as all", () => {
  // Deleting a device you were scoped to must not strand you on an
  // empty view with no way back.
  const { phone } = seedFleet();
  saveDeviceScope(subset([phone.id]));
  resetTestDb();
  seedFleet();
  assert.equal(getDeviceScope().mode, "all");
});

test("reset clears back to all devices", () => {
  const { phone } = seedFleet();
  saveDeviceScope(subset([phone.id]));
  assert.equal(resetDeviceScope().mode, "all");
  assert.equal(getDeviceScope().mode, "all");
});

// ── SQL scoping ──────────────────────────────────────────────

test("the all scope produces no SQL fragment", () => {
  assert.equal(scopeSqlClause(SCOPE_ALL), null);
});

test("scoped app ids cover exactly the linked apps", () => {
  const { phone } = seedFleet();
  const ids = getScopedAppIds(subset([phone.id]));
  assert.deepEqual([...(ids ?? [])], ["app-phone"]);
});

test("includeUnattached adds apps with no device link", () => {
  const { phone } = seedFleet();
  const ids = getScopedAppIds(subset([phone.id], true));
  assert.deepEqual([...(ids ?? [])].sort(), ["app-manual", "app-phone"]);
});

test("unattached alone selects only unlinked apps", () => {
  seedFleet();
  const ids = getScopedAppIds(subset([], true));
  assert.deepEqual([...(ids ?? [])], ["app-manual"]);
});

test("a multi-device subset unions its devices", () => {
  const { phone, tablet } = seedFleet();
  const ids = getScopedAppIds(subset([phone.id, tablet.id]));
  assert.deepEqual([...(ids ?? [])].sort(), ["app-phone", "app-tablet"]);
});

test("getScopedAppIds returns null for an unrestricted scope", () => {
  seedFleet();
  assert.equal(getScopedAppIds(SCOPE_ALL), null);
});

// ── query integration ────────────────────────────────────────

test("countApps and getAppsPage agree under the same scope", () => {
  // The grid pages against `total`; if the count and the page disagree
  // the hydration loop either stops early or spins on empty pages.
  const { phone } = seedFleet();
  const scope = subset([phone.id]);
  assert.equal(countApps(scope), 1);
  const page = getAppsPage({ limit: 50, scope }) as Array<{ id: string }>;
  assert.deepEqual(
    page.map((a) => a.id),
    ["app-phone"]
  );
});

test("scoped paging applies the filter before limit/offset", () => {
  // Filtering after the fact would return short or empty pages and
  // break the grid's offset arithmetic.
  const phone = createDevice({ name: "Phone" });
  for (const n of [1, 2, 3, 4]) {
    seedTrackedApp({ id: `linked-${n}`, name: `Linked ${n}` });
    upsertAppDeviceLink(`linked-${n}`, phone.id);
    seedTrackedApp({ id: `loose-${n}`, name: `Loose ${n}` });
  }
  const scope = subset([phone.id]);
  const first = getAppsPage({ limit: 2, offset: 0, scope }) as Array<{
    id: string;
  }>;
  const second = getAppsPage({ limit: 2, offset: 2, scope }) as Array<{
    id: string;
  }>;
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual([...first, ...second].map((a) => a.id).sort(), [
    "linked-1",
    "linked-2",
    "linked-3",
    "linked-4",
  ]);
});

test("getAllApps narrows to the scope", () => {
  const { tablet } = seedFleet();
  const apps = getAllApps(subset([tablet.id])) as Array<{ id: string }>;
  assert.deepEqual(
    apps.map((a) => a.id),
    ["app-tablet"]
  );
});

// ── request resolution: the API contract ─────────────────────

test("a request without ?devices= is unrestricted", () => {
  seedFleet();
  assert.equal(scopeFromRequest("http://x/api/apps").mode, "all");
});

test("?devices= narrows the request", () => {
  const { phone } = seedFleet();
  const scope = scopeFromRequest(`http://x/api/apps?devices=${phone.id}`);
  assert.equal(scope.mode, "subset");
  assert.deepEqual(scope.deviceIds, [phone.id]);
});

test("a stale ?devices= falls back to the full fleet", () => {
  seedFleet();
  assert.equal(scopeFromRequest("http://x/api/apps?devices=ghost").mode, "all");
});

test("a STORED scope does not narrow a bare request", () => {
  // The contract. `GET /api/apps` with no params returns the whole fleet
  // whatever the user last picked in the nav — persisted UI state must
  // never reshape a documented response. The client passes ?devices=
  // when it wants scoping; nothing else does it on its behalf.
  const { phone } = seedFleet();
  saveDeviceScope(subset([phone.id]));
  assert.equal(getDeviceScope().mode, "subset");

  const bare = scopeFromRequest("http://x/api/apps");
  assert.equal(bare.mode, "all");
  assert.equal(countApps(), 3);
  assert.equal((getAllApps() as unknown[]).length, 3);
});

test("the param a stored scope serialises to reproduces it on the wire", () => {
  const { phone, tablet } = seedFleet();
  saveDeviceScope(subset([phone.id, tablet.id], true));
  const param = serialiseScopeParam(getDeviceScope());
  assert.ok(param);
  const viaRequest = scopeFromRequest(`http://x/api/apps?devices=${param}`);
  assert.deepEqual(viaRequest, getDeviceScope());
});
