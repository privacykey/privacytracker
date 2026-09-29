/**
 * The uninstall gate, keyed on whose device is being acted on.
 *
 * This is the most destructive path in the app, so the rule is pinned
 * from both directions — what it now REFUSES that it used to allow, and
 * what it now ALLOWS that it used to refuse:
 *
 *   - Refuses acting on a device explicitly owned by someone else while
 *     you are in your own mode. The old rule keyed on the global focus
 *     and never asked whose device was plugged in, so this case simply
 *     could not be expressed.
 *   - Allows acting on a device owned by the person you are helping
 *     while you are in helping mode. That is a deliberate expansion of
 *     a destructive capability (see `checkDeviceOwnershipGate`), which
 *     is precisely why it has a test naming it as such.
 *
 * And above all: an install with NO ownership recorded must behave
 * exactly as it did before ownership existed. Most of this file is
 * about that.
 */

import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { checkUninstallGate } from "../../lib/device-actions";
import { createDevice, setDeviceOwner } from "../../lib/devices";
import type { Audience } from "../../lib/feature-flag-rules";
import { setActiveFocus, setOverride } from "../../lib/feature-flag-storage";
import { resetTestDb } from "../helpers/test-db";

const ECID = "ABCDEF1234567890";

function focusAs(audience: Audience): void {
  setActiveFocus({
    audience,
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  });
}

/** Every precondition except ownership satisfied, so each test below is
 *  about the ownership rule alone. `acknowledgeNoBackup` stands in for a
 *  fresh backup — the backup gate has its own file. */
function setup(audience: Audience = "self"): void {
  resetTestDb();
  // resetTestDb empties `devices` too (as "Delete everything" does); kept
  // explicit because the unique partial index on `ecid` would reject the
  // next fixture if a device row ever survived.
  db.prepare("DELETE FROM devices").run();
  focusAs(audience);
  setOverride("flag.devopts.cfgutil_uninstall", "on");
}

const ack = { acknowledgeNoBackup: true };

function ownedDevice(
  owner: Audience | null,
  { label = "Mum", name = "Mum's iPad", ecid = ECID } = {}
) {
  const device = createDevice({ name, ecid, deviceClass: "iPad" });
  if (owner) {
    // This file is about the MODE MATCH. The permission attestation the
    // gate also requires for anyone else's device is given here so it
    // does not confound these cases; tests/app/device-permission.test.ts
    // owns the attestation-missing path.
    setDeviceOwner(device.id, {
      audience: owner,
      label,
      permissionAcknowledged: owner !== "self",
    });
  }
  return device;
}

// ── back-compat: no ownership recorded ───────────────────────

test("an ECID with no device row behaves exactly as before", () => {
  // The single most important property of this change: installs that
  // predate ownership must be neither newly blocked nor newly permitted.
  setup("self");
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);

  focusAs("loved_one");
  const denied = checkUninstallGate(ECID, ack);
  assert.equal(denied.allowed, false);
  if (denied.allowed === false) {
    assert.equal(denied.reason, "audience");
  }
});

test("a device with no owner recorded falls back to the focus rule", () => {
  setup("self");
  ownedDevice(null);
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);

  focusAs("guardian");
  const denied = checkUninstallGate(ECID, ack);
  assert.equal(denied.allowed, false);
  if (denied.allowed === false) {
    assert.equal(denied.reason, "audience");
  }
});

// ── the hole this closes ─────────────────────────────────────

test("REFUSES a device owned by someone else while you're in self mode", () => {
  // Previously allowed: the focus said 'self', nothing asked whose
  // phone was plugged in, and the removal went ahead.
  setup("self");
  ownedDevice("loved_one");
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("REFUSES your own device while you're in helping mode", () => {
  setup("loved_one");
  ownedDevice("self", { label: "Me", name: "My iPhone" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("REFUSES a child's device while you're in loved-one mode", () => {
  setup("loved_one");
  ownedDevice("guardian", { label: "Leo", name: "Leo's iPad" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("the refusal carries what the message needs to name the device", () => {
  // Without this the wizard can only say "not allowed", which is the
  // arbitrary-looking block the whole ownership feature set out to fix.
  setup("self");
  ownedDevice("loved_one", { label: "Mum", name: "Mum's iPad" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false && gate.reason === "device_owner") {
    assert.equal(gate.deviceName, "Mum's iPad");
    assert.equal(gate.ownerLabel, "Mum");
    assert.equal(gate.ownerAudience, "loved_one");
    assert.equal(gate.activeAudience, "self");
  }
});

// ── the expansion ────────────────────────────────────────────

test("ALLOWS the helped person's device while you're in helping mode", () => {
  // Deliberate expansion: deleting apps off another person's phone is
  // now reachable. It requires the user to have recorded that the
  // device is theirs AND switched into the matching mode, and still
  // runs the flag, backup and per-app Touch ID chain behind this.
  setup("loved_one");
  ownedDevice("loved_one");
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});

test("ALLOWS a child's device while you're in guardian mode", () => {
  setup("guardian");
  ownedDevice("guardian", { label: "Leo", name: "Leo's iPad" });
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});

test("ALLOWS your own device in self mode", () => {
  setup("self");
  ownedDevice("self", { label: "Me", name: "My iPhone" });
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});

// ── the ownership gate cannot be bypassed ────────────────────

test("acknowledgeNoBackup does NOT bypass the ownership gate", () => {
  // The DELETE-to-confirm escape hatch relaxes the BACKUP requirement
  // only. It must never unlock acting on someone else's device.
  setup("self");
  ownedDevice("loved_one");
  const gate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("passing ownership does not skip the feature flag", () => {
  setup("loved_one");
  ownedDevice("loved_one");
  setOverride("flag.devopts.cfgutil_uninstall", "off");
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "flag");
  }
});

test("ownership is evaluated before the flag gate", () => {
  // Both would deny; "this isn't your device" is the more fundamental
  // answer and the one the user needs to act on.
  setup("self");
  ownedDevice("loved_one");
  setOverride("flag.devopts.cfgutil_uninstall", "off");
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

// ── ECID spelling ────────────────────────────────────────────

test("matches a device stored with an 0x-prefixed ECID", () => {
  // cfgutil prints ECIDs `0x`-prefixed and mixed-case, and whichever
  // spelling the import saw is what got stored. A missed match here
  // silently downgrades the gate to the older, coarser rule — so it
  // must be tolerant in both directions.
  setup("self");
  ownedDevice("loved_one", { ecid: "0xabcdef1234567890" });
  const gate = checkUninstallGate("ABCDEF1234567890", ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("matches when the CALLER supplies the 0x-prefixed spelling", () => {
  setup("self");
  ownedDevice("loved_one", { ecid: "ABCDEF1234567890" });
  const gate = checkUninstallGate("0xabcdef1234567890", ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("an unparseable ECID falls back to the focus rule, not open", () => {
  setup("self");
  ownedDevice("loved_one");
  // Garbage in: no device resolves, so the legacy rule applies. With a
  // 'self' focus that is ALLOW — matching pre-ownership behaviour
  // exactly rather than inventing a new refusal.
  assert.equal(checkUninstallGate("not-an-ecid", ack).allowed, true);

  focusAs("loved_one");
  const denied = checkUninstallGate("not-an-ecid", ack);
  assert.equal(denied.allowed, false);
  if (denied.allowed === false) {
    assert.equal(denied.reason, "audience");
  }
});

test("a different device's ECID does not inherit this device's owner", () => {
  setup("self");
  ownedDevice("loved_one");
  // Another plausible ECID with no row of its own → legacy rule.
  assert.equal(checkUninstallGate("1111222233334444", ack).allowed, true);
});
