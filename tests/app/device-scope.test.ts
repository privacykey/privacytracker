/**
 * Pure device-scope model.
 *
 * The scope decides which apps every surface counts, so the two rules
 * that keep a user from getting stuck are pinned hardest here:
 *
 *   1. A scope that resolves to nothing selectable collapses back to
 *      "all". Showing too much is one click from being fixed; showing
 *      nothing looks like the app lost their data.
 *   2. A subset naming every device collapses to "all", so a device
 *      imported later is included rather than silently hidden behind a
 *      scope the user thought meant "everything".
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  appMatchesScope,
  type DeviceScope,
  describeScope,
  deviceGlyphKind,
  expandScope,
  parseScopeParam,
  reconcileScope,
  SCOPE_ALL,
  scopeFromSelection,
  serialiseScopeParam,
  toggleScopeDevice,
  UNATTACHED_ID,
} from "../../lib/device-scope";

const KNOWN = ["dev-a", "dev-b", "dev-c"];

const subset = (ids: string[], unattached = false): DeviceScope => ({
  v: 1,
  mode: "subset",
  deviceIds: ids,
  includeUnattached: unattached,
});

// ── reconcile ────────────────────────────────────────────────

test("malformed input reconciles to the unrestricted scope", () => {
  for (const bad of [null, undefined, 42, "subset", {}, { mode: "nope" }]) {
    assert.equal(reconcileScope(bad, KNOWN).mode, "all");
  }
});

test("ids that no longer exist are dropped", () => {
  const scope = reconcileScope(subset(["dev-a", "ghost"]), KNOWN);
  assert.equal(scope.mode, "subset");
  assert.deepEqual(scope.deviceIds, ["dev-a"]);
});

test("a subset whose every id is stale collapses to all, not to empty", () => {
  // The failure this guards: deleting the device you were scoped to and
  // being left with a permanently empty grid.
  const scope = reconcileScope(subset(["ghost-1", "ghost-2"]), KNOWN);
  assert.equal(scope.mode, "all");
});

test("a subset naming every device plus unattached collapses to all", () => {
  const scope = reconcileScope(subset([...KNOWN], true), KNOWN);
  assert.equal(scope.mode, "all");
});

test("every device WITHOUT unattached stays a subset", () => {
  // Not the same as "all": the user has deliberately excluded the
  // manual/CSV apps, and importing a new device shouldn't change that.
  const scope = reconcileScope(subset([...KNOWN], false), KNOWN);
  assert.equal(scope.mode, "subset");
  assert.equal(scope.includeUnattached, false);
});

test("duplicate ids are de-duplicated", () => {
  const scope = reconcileScope(subset(["dev-a", "dev-a", "dev-b"]), KNOWN);
  assert.deepEqual(scope.deviceIds, ["dev-a", "dev-b"]);
});

test("unattached alone is a valid subset", () => {
  const scope = reconcileScope(subset([], true), KNOWN);
  assert.equal(scope.mode, "subset");
  assert.deepEqual(scope.deviceIds, []);
  assert.equal(scope.includeUnattached, true);
});

// ── matching ─────────────────────────────────────────────────

test("the all scope matches every app, linked or not", () => {
  assert.equal(appMatchesScope(SCOPE_ALL, ["dev-a"]), true);
  assert.equal(appMatchesScope(SCOPE_ALL, []), true);
  assert.equal(appMatchesScope(SCOPE_ALL, undefined), true);
});

test("a subset matches an app linked to ANY of its devices", () => {
  const scope = subset(["dev-a", "dev-b"]);
  assert.equal(appMatchesScope(scope, ["dev-b"]), true);
  assert.equal(appMatchesScope(scope, ["dev-c", "dev-a"]), true);
  assert.equal(appMatchesScope(scope, ["dev-c"]), false);
});

test("unlinked apps follow includeUnattached, not the device list", () => {
  assert.equal(appMatchesScope(subset(["dev-a"], false), []), false);
  assert.equal(appMatchesScope(subset(["dev-a"], true), []), true);
  assert.equal(appMatchesScope(subset(["dev-a"], true), undefined), true);
});

// ── selection / toggling ─────────────────────────────────────

test("all expands to every device plus the unattached bucket", () => {
  const set = expandScope(SCOPE_ALL, KNOWN);
  assert.deepEqual([...set].sort(), [...KNOWN, UNATTACHED_ID].sort());
});

test("unticking one row from all leaves everything else", () => {
  // A fully-ticked list is what the user sees under "all"; unticking one
  // row has to mean "everything except this", not "only this".
  const next = toggleScopeDevice(SCOPE_ALL, "dev-b", KNOWN);
  assert.equal(next.mode, "subset");
  assert.deepEqual(next.deviceIds, ["dev-a", "dev-c"]);
  assert.equal(next.includeUnattached, true);
});

test("re-ticking the last unticked row returns to all", () => {
  const off = toggleScopeDevice(SCOPE_ALL, "dev-b", KNOWN);
  const back = toggleScopeDevice(off, "dev-b", KNOWN);
  assert.equal(back.mode, "all");
});

test("scope ids are canonicalised to the known-device order", () => {
  // One representation per scope. {A,C} and {C,A} must produce the same
  // `?devices=` param and the same scopeKey — that key is a React key and
  // a fetch dependency, so an unstable one causes spurious remounts.
  const fromSelection = scopeFromSelection(new Set(["dev-c", "dev-a"]), KNOWN);
  assert.deepEqual(fromSelection.deviceIds, ["dev-a", "dev-c"]);
  const reversed = reconcileScope(subset(["dev-c", "dev-a"]), KNOWN);
  assert.deepEqual(reversed.deviceIds, ["dev-a", "dev-c"]);
  assert.equal(
    serialiseScopeParam(fromSelection),
    serialiseScopeParam(reversed)
  );
});

// ── param round-trip ─────────────────────────────────────────

test("the all scope serialises to null so the param is omitted", () => {
  // An unscoped request must be byte-identical to one from a client
  // that has never heard of scoping — that's the API contract.
  assert.equal(serialiseScopeParam(SCOPE_ALL), null);
});

test("a subset round-trips through the param", () => {
  const scope = subset(["dev-a", "dev-c"], true);
  const param = serialiseScopeParam(scope);
  assert.equal(param, `dev-a,dev-c,${UNATTACHED_ID}`);
  assert.deepEqual(parseScopeParam(param, KNOWN), scope);
});

test("parse accepts the literal 'all'", () => {
  assert.equal(parseScopeParam("all", KNOWN)?.mode, "all");
});

test("a param naming only unknown ids parses to null, not an empty scope", () => {
  // A bookmark to a deleted device must render the fleet. Returning an
  // empty scope here would render nothing.
  assert.equal(parseScopeParam("ghost-1,ghost-2", KNOWN), null);
  assert.equal(parseScopeParam("", KNOWN), null);
  assert.equal(parseScopeParam(null, KNOWN), null);
});

test("a param mixing known and unknown ids keeps the known ones", () => {
  const scope = parseScopeParam("dev-a,ghost", KNOWN);
  assert.deepEqual(scope?.deviceIds, ["dev-a"]);
});

test("whitespace and empty segments are tolerated", () => {
  const scope = parseScopeParam(" dev-a , , dev-b ", KNOWN);
  assert.deepEqual(scope?.deviceIds, ["dev-a", "dev-b"]);
});

// ── display ──────────────────────────────────────────────────

const DEVICES = [
  {
    id: "dev-a",
    name: "My iPhone",
    deviceClass: "iPhone",
    model: "iPhone15,2",
  },
  { id: "dev-b", name: "Mum's iPad", deviceClass: "iPad", model: "iPad13,4" },
  { id: "dev-c", name: "Old Watch", deviceClass: null, model: "Watch6,1" },
];

test("a single-device scope describes itself by name", () => {
  // This is the case the whole feature exists for: answering "whose
  // phone am I looking at?" with a name rather than a count.
  const d = describeScope(subset(["dev-b"]), DEVICES);
  assert.equal(d.kind, "single");
  assert.equal(d.name, "Mum's iPad");
  assert.equal(d.device?.id, "dev-b");
});

test("one device PLUS unattached is a multi scope, not a single one", () => {
  const d = describeScope(subset(["dev-b"], true), DEVICES);
  assert.equal(d.kind, "multi");
  assert.equal(d.count, 2);
});

test("unattached alone describes as unattached", () => {
  assert.equal(describeScope(subset([], true), DEVICES).kind, "unattached");
});

test("the all scope reports the device count", () => {
  const d = describeScope(SCOPE_ALL, DEVICES);
  assert.equal(d.kind, "all");
  assert.equal(d.count, 3);
});

test("glyph kind separates phone from tablet", () => {
  // The toast helper returns the same emoji for both; a picker whose job
  // is telling them apart cannot.
  assert.equal(deviceGlyphKind(DEVICES[0]), "phone");
  assert.equal(deviceGlyphKind(DEVICES[1]), "tablet");
  assert.equal(deviceGlyphKind(DEVICES[2]), "watch");
});

test("glyph kind falls back to the model when deviceClass is absent", () => {
  assert.equal(
    deviceGlyphKind({ deviceClass: null, model: "iPad8,1" }),
    "tablet"
  );
  assert.equal(
    deviceGlyphKind({ deviceClass: null, model: "iPod9,1" }),
    "player"
  );
});

test("an unrecognised device is 'other', never a confident phone", () => {
  assert.equal(deviceGlyphKind({ deviceClass: null, model: null }), "other");
  assert.equal(
    deviceGlyphKind({ deviceClass: "Mac", model: "Mac14,2" }),
    "other"
  );
});
