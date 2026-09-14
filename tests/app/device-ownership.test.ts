/**
 * Device ownership — grouping and the audience inference behind the
 * focus-switch prompt.
 *
 * The inference is what this file mostly guards. It drives a prompt
 * suggesting the user change their focus, which rearranges what the
 * whole app shows; offering that on a guess would be worse than not
 * offering it at all. So the rule is: a value ONLY when the scope
 * unambiguously resolves to one owner who has stated an audience.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DeviceScope,
  groupDevicesByOwner,
  SCOPE_ALL,
  type ScopeDevice,
  scopeOwnerAudience,
  scopeOwnerLabel,
  UNASSIGNED_OWNER,
} from "../../lib/device-scope";
import {
  createDevice,
  getDeviceById,
  isDeviceOwnerAudience,
  setDeviceOwner,
} from "../../lib/devices";
import { resetTestDb } from "../helpers/test-db";

const subset = (ids: string[], unattached = false): DeviceScope => ({
  v: 1,
  mode: "subset",
  deviceIds: ids,
  includeUnattached: unattached,
});

const dev = (
  id: string,
  ownerLabel: string | null,
  ownerAudience: ScopeDevice["ownerAudience"] = null
): ScopeDevice => ({ id, name: id, ownerLabel, ownerAudience });

// ── persistence ──────────────────────────────────────────────

test.beforeEach(() => {
  resetTestDb();
});

test("a new device has no owner — ownership is never inferred", () => {
  // Guessing from a device NAME would mislabel a real person's phone and
  // could prompt an unwanted focus change.
  const d = createDevice({ name: "Mum's iPad", deviceClass: "iPad" });
  assert.equal(d.ownerLabel, null);
  assert.equal(d.ownerAudience, null);
});

test("owner label and audience round-trip", () => {
  const d = createDevice({ name: "iPad" });
  setDeviceOwner(d.id, { label: "Mum", audience: "loved_one" });
  const read = getDeviceById(d.id);
  assert.equal(read?.ownerLabel, "Mum");
  assert.equal(read?.ownerAudience, "loved_one");
});

test("omitting a field leaves it alone; null clears it", () => {
  const d = createDevice({ name: "iPad" });
  setDeviceOwner(d.id, { label: "Mum", audience: "loved_one" });

  setDeviceOwner(d.id, { audience: "guardian" });
  assert.equal(getDeviceById(d.id)?.ownerLabel, "Mum");
  assert.equal(getDeviceById(d.id)?.ownerAudience, "guardian");

  setDeviceOwner(d.id, { label: null });
  assert.equal(getDeviceById(d.id)?.ownerLabel, null);
  assert.equal(getDeviceById(d.id)?.ownerAudience, "guardian");
});

test("a blank label is stored as null, not as empty string", () => {
  const d = createDevice({ name: "iPad" });
  setDeviceOwner(d.id, { label: "   " });
  assert.equal(getDeviceById(d.id)?.ownerLabel, null);
});

test("an unrecognised stored audience reads back as null", () => {
  // A junk value would otherwise flow into the focus-switch prompt and
  // offer to set an audience that doesn't exist.
  assert.equal(isDeviceOwnerAudience("sibling"), false);
  const d = createDevice({ name: "iPad" });
  setDeviceOwner(d.id, {
    audience: "sibling" as unknown as "loved_one",
  });
  assert.equal(getDeviceById(d.id)?.ownerAudience, null);
});

test("setting an owner never changes the device name", () => {
  // Several devices can share one owner — that's the whole point of
  // grouping — so "Mum" the owner and "Mum's iPad" the name are
  // different facts.
  const d = createDevice({ name: "iPad Air" });
  setDeviceOwner(d.id, { label: "Mum" });
  assert.equal(getDeviceById(d.id)?.name, "iPad Air");
});

// ── grouping ─────────────────────────────────────────────────

test("devices group under their owner", () => {
  const groups = groupDevicesByOwner([
    dev("a", "Mum"),
    dev("b", "Leo"),
    dev("c", "Mum"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.devices.map((d) => d.id)]),
    [
      ["Mum", ["a", "c"]],
      ["Leo", ["b"]],
    ]
  );
});

test("owner labels match case-insensitively and trimmed", () => {
  // "Mum" and "mum " typed into two rows are one person; two headings
  // would be nonsense. The first spelling wins as the display label.
  const groups = groupDevicesByOwner([dev("a", "Mum"), dev("b", " mum ")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Mum");
  assert.deepEqual(
    groups[0].devices.map((d) => d.id),
    ["a", "b"]
  );
});

test("unowned devices land in a trailing unassigned group", () => {
  // Dropping them would make an unlabelled device unselectable.
  const groups = groupDevicesByOwner([dev("a", null), dev("b", "Mum")]);
  assert.equal(groups.at(-1)?.key, UNASSIGNED_OWNER);
  assert.equal(groups.at(-1)?.label, null);
  assert.deepEqual(
    groups.at(-1)?.devices.map((d) => d.id),
    ["a"]
  );
});

test("a group with conflicting audiences claims none", () => {
  const groups = groupDevicesByOwner([
    dev("a", "Mum", "loved_one"),
    dev("b", "Mum", "guardian"),
  ]);
  assert.equal(groups[0].audience, null);
});

test("grouping preserves the caller's own device fields", () => {
  const rich = [{ ...dev("a", "Mum"), appCount: 12 }];
  const groups = groupDevicesByOwner(rich);
  assert.equal(groups[0].devices[0].appCount, 12);
});

// ── audience inference (the prompt's trigger) ────────────────

const FLEET: ScopeDevice[] = [
  dev("phone", "Me", "self"),
  dev("ipad", "Mum", "loved_one"),
  dev("kid", "Leo", "guardian"),
  dev("bare", null, null),
];

test("a single owned device yields its audience", () => {
  assert.equal(scopeOwnerAudience(subset(["ipad"]), FLEET), "loved_one");
  assert.equal(scopeOwnerAudience(subset(["kid"]), FLEET), "guardian");
});

test("several devices sharing one audience still yield it", () => {
  const shared = [dev("a", "Mum", "loved_one"), dev("b", "Mum", "loved_one")];
  assert.equal(scopeOwnerAudience(subset(["a", "b"]), shared), "loved_one");
});

test("the unrestricted scope implies nothing", () => {
  assert.equal(scopeOwnerAudience(SCOPE_ALL, FLEET), null);
});

test("a mixed-audience selection implies nothing", () => {
  assert.equal(scopeOwnerAudience(subset(["phone", "ipad"]), FLEET), null);
});

test("a device with no stated audience implies nothing", () => {
  assert.equal(scopeOwnerAudience(subset(["bare"]), FLEET), null);
  assert.equal(scopeOwnerAudience(subset(["ipad", "bare"]), FLEET), null);
});

test("including the unattached bucket implies nothing", () => {
  // Unattached apps belong to no device, so the scope no longer says
  // whose apps are on screen.
  assert.equal(scopeOwnerAudience(subset(["ipad"], true), FLEET), null);
});

test("a scope naming a device that no longer exists implies nothing", () => {
  assert.equal(scopeOwnerAudience(subset(["ghost"]), FLEET), null);
});

// ── owner label for display ──────────────────────────────────

test("scopeOwnerLabel names a single owner", () => {
  assert.equal(scopeOwnerLabel(subset(["ipad"]), FLEET), "Mum");
});

test("scopeOwnerLabel is independent of the audience", () => {
  // A device can have a known owner and no stated audience — still worth
  // naming in the UI even though it triggers no prompt.
  const fleet = [dev("a", "Mum", null)];
  assert.equal(scopeOwnerLabel(subset(["a"]), fleet), "Mum");
  assert.equal(scopeOwnerAudience(subset(["a"]), fleet), null);
});

test("scopeOwnerLabel yields null across different owners", () => {
  assert.equal(scopeOwnerLabel(subset(["phone", "ipad"]), FLEET), null);
});
