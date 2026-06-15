/**
 * Pin the "Remove apps from your phone" gate's bypass path.
 *
 * `checkUninstallGate(ecid)` enforces three gates in order — audience,
 * flag, backup-freshness. The wizard's no-backup modal sets
 * `acknowledgeNoBackup: true` after the user has typed DELETE in the
 * "at your own risk" prompt. That flag relaxes the backup gate ONLY;
 * audience + flag stay enforced (a guardian or a user without the
 * feature flag on can't bypass anything).
 *
 * Also covers `getDeviceEcidsForApps` since the same wizard uses it
 * for the device-match warning.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkUninstallGate } from "../../lib/device-actions";
import {
  createDevice,
  getDeviceEcidsForApps,
  upsertAppDeviceLink,
} from "../../lib/devices";
import { setActiveFocus, setOverride } from "../../lib/feature-flag-storage";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const ECID = "ABCDEF1234567890";

function beforeEach(): void {
  resetTestDb();
  // Required pre-conditions for the gate to even consider us — set
  // these explicitly so the test focuses on the bypass logic.
  setActiveFocus({
    audience: "self",
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  });
  setOverride("flag.devopts.cfgutil_uninstall", "on");
}

test("checkUninstallGate refuses without a backup by default", () => {
  beforeEach();
  const gate = checkUninstallGate(ECID);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "backup_missing");
  }
});

test("checkUninstallGate allows the call when acknowledgeNoBackup is set", () => {
  beforeEach();
  const gate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(gate.allowed, true);
});

test("acknowledgeNoBackup does NOT bypass the audience gate", () => {
  beforeEach();
  setActiveFocus({
    audience: "loved_one",
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  }); // audience gate denies
  const gate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "audience");
  }
});

test("acknowledgeNoBackup does NOT bypass the flag gate", () => {
  beforeEach();
  setOverride("flag.devopts.cfgutil_uninstall", "off"); // flag gate denies
  const gate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "flag");
  }
});

test("a fresh backup lets the gate pass without acknowledgeNoBackup", () => {
  beforeEach();
  setSetting(
    `cfgutil_last_backup_${ECID}`,
    JSON.stringify({
      finishedAt: Date.now() - 60_000, // 1 minute ago
      path: "/tmp/backup",
    })
  );
  const gate = checkUninstallGate(ECID);
  assert.equal(gate.allowed, true);
});

test("a stale backup (>24h) is denied unless acknowledgeNoBackup overrides", () => {
  beforeEach();
  setSetting(
    `cfgutil_last_backup_${ECID}`,
    JSON.stringify({
      finishedAt: Date.now() - 48 * 60 * 60 * 1000, // 2 days ago
      path: "/tmp/backup",
    })
  );
  const deniedGate = checkUninstallGate(ECID);
  assert.equal(deniedGate.allowed, false);
  if (deniedGate.allowed === false) {
    assert.equal(deniedGate.reason, "backup_stale");
  }

  const overrideGate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(overrideGate.allowed, true);
});

// ─── getDeviceEcidsForApps ────────────────────────────────────────

test("getDeviceEcidsForApps returns ECIDs only for apps with cfgutil-imported devices", () => {
  resetTestDb();
  const phoneA = createDevice({ name: "Phone A", ecid: ECID });
  const phoneB = createDevice({ name: "Phone B", ecid: "1111222233334444" });
  const csvDevice = createDevice({ name: "CSV Import", ecid: null });

  seedTrackedApp({ id: "app-1", name: "App One" });
  seedTrackedApp({ id: "app-2", name: "App Two" });
  seedTrackedApp({ id: "app-3", name: "App Three" });

  upsertAppDeviceLink("app-1", phoneA.id);
  upsertAppDeviceLink("app-2", phoneA.id);
  upsertAppDeviceLink("app-2", phoneB.id);
  upsertAppDeviceLink("app-3", csvDevice.id); // NULL ecid — excluded

  const map = getDeviceEcidsForApps(["app-1", "app-2", "app-3", "unknown"]);

  assert.deepEqual(map.get("app-1"), [ECID]);
  assert.deepEqual(
    [...(map.get("app-2") ?? [])].sort(),
    [ECID, "1111222233334444"].sort()
  );
  // app-3 is linked only to a NULL-ecid device → absent.
  assert.equal(map.has("app-3"), false);
  // unknown app id → absent.
  assert.equal(map.has("unknown"), false);
});

test("getDeviceEcidsForApps returns an empty map for an empty input", () => {
  resetTestDb();
  const map = getDeviceEcidsForApps([]);
  assert.equal(map.size, 0);
});
