/**
 * The permission attestation: "I have this person's permission to view
 * and act on their device."
 *
 * It exists because matching the mode alone is not enough. Once the
 * uninstall gate keyed on device ownership, "I'm helping someone" would
 * have unlocked deleting apps off ANY device labelled as theirs. The
 * attestation is the second explicit statement the gate now requires for
 * anyone else's device — and, being timestamped and audit-logged, it is
 * the record of who said they were allowed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { checkUninstallGate } from "../../lib/device-actions";
import { createDevice, getDeviceById, setDeviceOwner } from "../../lib/devices";
import type { Audience } from "../../lib/feature-flag-rules";
import { setActiveFocus, setOverride } from "../../lib/feature-flag-storage";
import { resetTestDb } from "../helpers/test-db";

const ECID = "ABCDEF1234567890";
const ack = { acknowledgeNoBackup: true };

function focusAs(audience: Audience): void {
  setActiveFocus({
    audience,
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  });
}

function setup(audience: Audience): void {
  resetTestDb();
  // `devices` survives the reset (as it does /api/reset); clear it or the
  // unique ECID index rejects the next fixture.
  db.prepare("DELETE FROM devices").run();
  focusAs(audience);
  setOverride("flag.devopts.cfgutil_uninstall", "on");
}

// ── storage ──────────────────────────────────────────────────

test("a new device has no attestation", () => {
  setup("self");
  const d = createDevice({ name: "iPad", ecid: ECID });
  assert.equal(d.permissionAcknowledgedAt, null);
});

test("the attestation can be given at create time for someone else's device", () => {
  setup("self");
  const d = createDevice({
    name: "iPad",
    ecid: ECID,
    ownerAudience: "loved_one",
    ownerLabel: "Mum",
    permissionAcknowledged: true,
  });
  assert.ok(d.permissionAcknowledgedAt);
  assert.ok(Date.now() - d.permissionAcknowledgedAt! < 5_000);
});

test("an attestation is never stored for your own device", () => {
  // There is nobody's permission to have for your own phone. Storing a
  // stamp anyway would be a false record.
  setup("self");
  const d = createDevice({
    name: "iPhone",
    ecid: ECID,
    ownerAudience: "self",
    permissionAcknowledged: true,
  });
  assert.equal(d.permissionAcknowledgedAt, null);
});

test("setDeviceOwner stamps and clears the attestation", () => {
  setup("self");
  const d = createDevice({ name: "iPad", ecid: ECID });
  setDeviceOwner(d.id, { audience: "loved_one", label: "Mum" });
  assert.equal(getDeviceById(d.id)?.permissionAcknowledgedAt, null);

  setDeviceOwner(d.id, { permissionAcknowledged: true });
  assert.ok(getDeviceById(d.id)?.permissionAcknowledgedAt);

  setDeviceOwner(d.id, { permissionAcknowledged: false });
  assert.equal(getDeviceById(d.id)?.permissionAcknowledgedAt, null);
});

test("re-assigning a device to yourself clears a previous attestation", () => {
  // Otherwise handing the device back to a relative later would inherit
  // a stale "yes" from the previous owner.
  setup("self");
  const d = createDevice({ name: "iPad", ecid: ECID });
  setDeviceOwner(d.id, {
    audience: "loved_one",
    label: "Mum",
    permissionAcknowledged: true,
  });
  assert.ok(getDeviceById(d.id)?.permissionAcknowledgedAt);

  setDeviceOwner(d.id, { audience: "self" });
  assert.equal(getDeviceById(d.id)?.permissionAcknowledgedAt, null);

  setDeviceOwner(d.id, { audience: "loved_one" });
  assert.equal(getDeviceById(d.id)?.permissionAcknowledgedAt, null);
});

test("clearing the owner entirely clears the attestation", () => {
  setup("self");
  const d = createDevice({ name: "iPad", ecid: ECID });
  setDeviceOwner(d.id, {
    audience: "guardian",
    label: "Leo",
    permissionAcknowledged: true,
  });
  setDeviceOwner(d.id, { audience: null });
  assert.equal(getDeviceById(d.id)?.permissionAcknowledgedAt, null);
});

// ── the gate ─────────────────────────────────────────────────

test("REFUSES someone else's device, mode matching, without the attestation", () => {
  // The case this exists for. Mode matches; nobody has said they are
  // allowed. This is where "I'm helping someone" would otherwise have
  // unlocked deletion on any device labelled as theirs.
  setup("loved_one");
  const d = createDevice({ name: "Mum's iPad", ecid: ECID });
  setDeviceOwner(d.id, { audience: "loved_one", label: "Mum" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "permission_unacknowledged");
    if (gate.reason === "permission_unacknowledged") {
      assert.equal(gate.deviceName, "Mum's iPad");
      assert.equal(gate.ownerLabel, "Mum");
    }
  }
});

test("ALLOWS the same device once the attestation is given", () => {
  setup("loved_one");
  const d = createDevice({ name: "Mum's iPad", ecid: ECID });
  setDeviceOwner(d.id, {
    audience: "loved_one",
    label: "Mum",
    permissionAcknowledged: true,
  });
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});

test("a child's device needs the attestation too", () => {
  setup("guardian");
  const d = createDevice({ name: "Leo's iPad", ecid: ECID });
  setDeviceOwner(d.id, { audience: "guardian", label: "Leo" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "permission_unacknowledged");
  }
});

test("your own device needs no attestation", () => {
  setup("self");
  const d = createDevice({ name: "My iPhone", ecid: ECID });
  setDeviceOwner(d.id, { audience: "self", label: "Me" });
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});

test("a mode mismatch is reported before a missing attestation", () => {
  // Two things wrong; the more fundamental one is the answer the user
  // needs first. Fixing the mode surfaces the attestation next.
  setup("self");
  const d = createDevice({ name: "Mum's iPad", ecid: ECID });
  setDeviceOwner(d.id, { audience: "loved_one", label: "Mum" });
  const gate = checkUninstallGate(ECID, ack);
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "device_owner");
  }
});

test("acknowledgeNoBackup does not stand in for the attestation", () => {
  // The DELETE-to-confirm escape hatch relaxes the backup requirement.
  // It is a statement about risk to data, not about permission, and
  // must not be confused with one.
  setup("loved_one");
  const d = createDevice({ name: "Mum's iPad", ecid: ECID });
  setDeviceOwner(d.id, { audience: "loved_one", label: "Mum" });
  const gate = checkUninstallGate(ECID, { acknowledgeNoBackup: true });
  assert.equal(gate.allowed, false);
  if (gate.allowed === false) {
    assert.equal(gate.reason, "permission_unacknowledged");
  }
});

test("devices with no recorded owner are unaffected", () => {
  // Pre-ownership installs: the legacy rule, exactly as before.
  setup("self");
  createDevice({ name: "Old iPhone", ecid: ECID });
  assert.equal(checkUninstallGate(ECID, ack).allowed, true);
});
