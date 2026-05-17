/**
 * Lock the device→apps junction lookup used by the apps page filter.
 *
 * `getAppDeviceMap()` underwrites the dropdown in `AppGrid` — it has to
 * return a dense `appId → deviceId[]` map (no entries for apps with
 * zero junction rows) and tolerate apps linked to multiple devices.
 * These tests pin both shapes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import db from "../lib/db";
import {
  createDevice,
  getAppDeviceMap,
  upsertAppDeviceLink,
} from "../lib/devices";
import { resetTestDb, seedTrackedApp } from "./test-db";

test.beforeEach(() => {
  resetTestDb();
});

test("getAppDeviceMap returns a deviceId[] for every linked app", () => {
  const phone = createDevice({ name: "Phone A" });
  const tablet = createDevice({ name: "Tablet B" });
  seedTrackedApp({ id: "app-1", name: "App One" });
  seedTrackedApp({ id: "app-2", name: "App Two" });
  upsertAppDeviceLink("app-1", phone.id);
  upsertAppDeviceLink("app-2", tablet.id);

  const map = getAppDeviceMap();
  assert.deepEqual(map.get("app-1"), [phone.id]);
  assert.deepEqual(map.get("app-2"), [tablet.id]);
});

test("an app linked to multiple devices appears with all ids", () => {
  const phone = createDevice({ name: "Phone A" });
  const tablet = createDevice({ name: "Tablet B" });
  seedTrackedApp({ id: "shared-app", name: "Shared App" });
  upsertAppDeviceLink("shared-app", phone.id);
  upsertAppDeviceLink("shared-app", tablet.id);

  const map = getAppDeviceMap();
  const ids = map.get("shared-app") ?? [];
  // Order isn't guaranteed by the underlying SELECT, so sort before compare.
  assert.deepEqual([...ids].sort(), [phone.id, tablet.id].sort());
});

test("an unattached app (no junction rows) is absent from the map", () => {
  // Clear any backfill links from the seed-app helper (which may auto-link
  // to the "Unknown device" placeholder on first boot).
  db.prepare("DELETE FROM app_devices").run();
  seedTrackedApp({ id: "orphan-app", name: "Orphan" });

  const map = getAppDeviceMap();
  assert.equal(map.has("orphan-app"), false);
});

test("empty database returns an empty map (no nulls, no exceptions)", () => {
  // No apps, no devices, no junction rows.
  const map = getAppDeviceMap();
  assert.equal(map.size, 0);
});
