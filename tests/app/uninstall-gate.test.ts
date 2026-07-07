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
import {
  checkUninstallGate,
  getLastBackup,
  normalizeEcid,
  recordBackup,
} from "../../lib/device-actions";
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

// ─── ECID normalisation ───────────────────────────────────────────
// cfgutil keys its JSON `Output` by `0x`-prefixed hex ECIDs (e.g.
// `0x9118908BB6027`), and the webview passes that spelling through
// verbatim. The stamp store must accept it — and read back the same
// stamp under any prefix/case spelling of the same ECID.

const RAW_CFGUTIL_ECID = "0x9118908BB6027";

test("recordBackup + gate accept cfgutil's 0x-prefixed ECIDs", () => {
  beforeEach();
  recordBackup({
    ecid: RAW_CFGUTIL_ECID,
    path: "/tmp/backup",
    finishedAt: Date.now() - 60_000,
    deviceName: "Test iPhone",
  });
  const gate = checkUninstallGate(RAW_CFGUTIL_ECID);
  assert.equal(gate.allowed, true);
});

test("a stamp reads back regardless of 0x prefix or hex case", () => {
  beforeEach();
  recordBackup({
    ecid: "0x9118908bb6027",
    path: "/tmp/backup",
    finishedAt: Date.now() - 60_000,
    deviceName: null,
  });
  assert.notEqual(getLastBackup("9118908BB6027"), null);
  assert.equal(checkUninstallGate("0X9118908BB6027").allowed, true);
});

test("normalizeEcid canonicalises valid spellings and rejects the rest", () => {
  assert.equal(normalizeEcid("0x9118908BB6027"), "9118908BB6027");
  assert.equal(normalizeEcid("0X9118908bb6027"), "9118908BB6027");
  assert.equal(normalizeEcid(" ABCDEF1234567890 "), "ABCDEF1234567890");
  // Settings-key injection shapes and non-hex garbage must not pass.
  assert.equal(normalizeEcid("flag.devopts.cfgutil_uninstall"), null);
  assert.equal(normalizeEcid("0x"), null);
  assert.equal(normalizeEcid(""), null);
  assert.equal(normalizeEcid("zzzz11112222"), null);
  assert.equal(normalizeEcid("0x123"), null); // hex body too short
});

test("recordBackup throws on a malformed ECID", () => {
  beforeEach();
  assert.throws(() =>
    recordBackup({
      ecid: "not-an-ecid",
      path: "/tmp/backup",
      finishedAt: Date.now(),
      deviceName: null,
    })
  );
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
