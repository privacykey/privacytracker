import assert from "node:assert/strict";
import test from "node:test";
import {
  CALLOUT_CARDS,
  CANONICAL_ORDER,
  DASHBOARD_PRESET_KEYS,
  DASHBOARD_PRESET_META,
  DASHBOARD_PRESETS,
  type DashboardCardId,
  type DashboardLayout,
  DEFAULT_LAYOUT,
  describeLayoutTransition,
  FIRST_CLASS_CARDS,
  isCardVisible,
  matchDashboardPreset,
  reconcileLayout,
} from "../../lib/dashboard-layout";

// ── Preset invariants ─────────────────────────────────────────────────

test("every preset has metadata in DASHBOARD_PRESET_META", () => {
  for (const key of DASHBOARD_PRESET_KEYS) {
    const meta = DASHBOARD_PRESET_META[key];
    assert.equal(meta.key, key, `meta.key mismatch for ${key}`);
    assert.ok(meta.label.length > 0, `${key} missing label`);
    assert.ok(meta.description.length > 0, `${key} missing description`);
    assert.ok(meta.icon.length > 0, `${key} missing icon`);
    assert.ok(meta.severityCls.length > 0, `${key} missing severityCls`);
  }
});

test("every preset covers every canonical card exactly once in order", () => {
  for (const key of DASHBOARD_PRESET_KEYS) {
    const preset = DASHBOARD_PRESETS[key];
    assert.equal(preset.v, 1, `${key} version mismatch`);
    const orderSet = new Set(preset.order);
    assert.equal(
      preset.order.length,
      orderSet.size,
      `${key} order has duplicates`
    );
    assert.equal(
      preset.order.length,
      CANONICAL_ORDER.length,
      `${key} order length doesn't match canonical (${preset.order.length} vs ${CANONICAL_ORDER.length})`
    );
    for (const id of CANONICAL_ORDER) {
      assert.ok(orderSet.has(id), `${key} order is missing ${id}`);
    }
  }
});

test("default preset is canonical order with nothing hidden", () => {
  const p = DASHBOARD_PRESETS.default;
  assert.deepEqual(p.order, CANONICAL_ORDER);
  assert.deepEqual(p.hidden, []);
});

test("preset hidden-set contains only first-class cards (never callouts)", () => {
  for (const key of DASHBOARD_PRESET_KEYS) {
    for (const id of DASHBOARD_PRESETS[key].hidden) {
      assert.ok(
        FIRST_CLASS_CARDS.has(id),
        `${key} hides ${id}, which is not a first-class card`
      );
      assert.ok(
        !CALLOUT_CARDS.has(id),
        `${key} hides ${id}, a callout — callouts must not be in hidden[]`
      );
    }
  }
});

test("FIRST_CLASS_CARDS and CALLOUT_CARDS are disjoint and exhaustive", () => {
  for (const id of CANONICAL_ORDER) {
    const inFC = FIRST_CLASS_CARDS.has(id);
    const inCO = CALLOUT_CARDS.has(id);
    assert.ok(
      inFC !== inCO,
      `${id} should be in exactly one of FIRST_CLASS_CARDS / CALLOUT_CARDS (got fc=${inFC}, callout=${inCO})`
    );
  }
});

// ── matchDashboardPreset round-trip ───────────────────────────────────

test("matchDashboardPreset returns each preset for its own layout", () => {
  for (const key of DASHBOARD_PRESET_KEYS) {
    assert.equal(
      matchDashboardPreset(DASHBOARD_PRESETS[key]),
      key,
      `${key} should round-trip via matchDashboardPreset`
    );
  }
});

test("a single edit drops the active preset match", () => {
  // Take the default preset, swap two cards in order — should no longer match.
  const tweaked: DashboardLayout = {
    v: 1,
    order: [
      DASHBOARD_PRESETS.default.order[1],
      DASHBOARD_PRESETS.default.order[0],
      ...DASHBOARD_PRESETS.default.order.slice(2),
    ],
    hidden: [],
  };
  assert.equal(matchDashboardPreset(tweaked), null);
});

test("matchDashboardPreset returns null for empty / malformed layouts", () => {
  assert.equal(matchDashboardPreset(null), null);
  assert.equal(matchDashboardPreset(undefined), null);
  assert.equal(matchDashboardPreset({ v: 1, order: [], hidden: [] }), null);
});

// ── reconcileLayout ───────────────────────────────────────────────────

test("reconcileLayout(null) returns canonical default", () => {
  const out = reconcileLayout(null);
  assert.deepEqual(out.order, CANONICAL_ORDER);
  assert.deepEqual(out.hidden, []);
});

test("reconcileLayout strips unknown card ids", () => {
  const stored = {
    v: 1,
    order: ["risk_section", "phantom_card", "hero"],
    hidden: ["nonexistent"],
  };
  const out = reconcileLayout(stored);
  for (const id of out.order) {
    assert.ok(
      CANONICAL_ORDER.includes(id),
      `${id} should not survive reconcile`
    );
  }
  for (const id of out.hidden) {
    assert.ok(
      FIRST_CLASS_CARDS.has(id),
      `${id} survived in hidden but isn't first-class`
    );
  }
});

test("reconcileLayout appends new canonical cards next to their neighbour", () => {
  // Simulate a "pre-new-card" stored layout. Drop `activity_section`
  // from a stored layout, reconcile against the current canonical list,
  // and confirm activity_section comes back right after its canonical
  // predecessor `stale_section`.
  const trimmed: readonly DashboardCardId[] = CANONICAL_ORDER.filter(
    (id) => id !== "activity_section"
  );
  const stored: DashboardLayout = { v: 1, order: [...trimmed], hidden: [] };
  const out = reconcileLayout(stored);
  const staleIdx = out.order.indexOf("stale_section");
  const activityIdx = out.order.indexOf("activity_section");
  assert.ok(staleIdx >= 0, "stale_section missing from reconciled output");
  assert.equal(
    activityIdx,
    staleIdx + 1,
    "activity_section should slot right after stale_section"
  );
});

test("reconcileLayout deduplicates repeated ids", () => {
  const stored = {
    v: 1,
    order: ["hero", "hero", "risk_section"],
    hidden: ["hero", "hero"],
  };
  const out = reconcileLayout(stored);
  const seen = new Set<string>();
  for (const id of out.order) {
    assert.ok(!seen.has(id), `${id} appears twice in reconciled order`);
    seen.add(id);
  }
  const seenHidden = new Set<string>();
  for (const id of out.hidden) {
    assert.ok(!seenHidden.has(id), `${id} appears twice in reconciled hidden`);
    seenHidden.add(id);
  }
});

test("reconcileLayout drops callouts from hidden[]", () => {
  // Even if a malformed caller put a callout in `hidden`, reconcile
  // strips it — callouts are reorder-only.
  const stored = {
    v: 1,
    order: [...CANONICAL_ORDER],
    hidden: ["hero", "family_callout", "manual_apps_banner"],
  };
  const out = reconcileLayout(stored);
  for (const id of out.hidden) {
    assert.ok(
      FIRST_CLASS_CARDS.has(id),
      `${id} is in hidden[] but is a callout`
    );
  }
  assert.ok(
    out.hidden.includes("hero"),
    "first-class hidden entries should survive"
  );
});

test("reconcileLayout preserves user-chosen order for known cards", () => {
  // Reverse the canonical order; reconcile shouldn't re-canonicalise it.
  const reversed = [...CANONICAL_ORDER].reverse();
  const stored: DashboardLayout = { v: 1, order: reversed, hidden: [] };
  const out = reconcileLayout(stored);
  assert.deepEqual(out.order, reversed);
});

// ── describeLayoutTransition ──────────────────────────────────────────

test("describeLayoutTransition fires when crossing a preset boundary", () => {
  const t = describeLayoutTransition(
    DASHBOARD_PRESETS.default,
    DASHBOARD_PRESETS.minimal
  );
  assert.ok(t, "transition should be recorded");
  assert.equal(t?.detail.from, "default");
  assert.equal(t?.detail.to, "minimal");
  assert.match(t?.summary ?? "", /Minimal/);
});

test("describeLayoutTransition is silent for custom-to-custom edits", () => {
  const customA: DashboardLayout = {
    v: 1,
    order: [...CANONICAL_ORDER].reverse(),
    hidden: ["hero"],
  };
  const customB: DashboardLayout = {
    v: 1,
    order: [...CANONICAL_ORDER].reverse(),
    hidden: ["hero", "activity_section"],
  };
  assert.equal(describeLayoutTransition(customA, customB), null);
});

test("describeLayoutTransition is silent for re-saves of the same preset", () => {
  assert.equal(
    describeLayoutTransition(
      DASHBOARD_PRESETS.minimal,
      DASHBOARD_PRESETS.minimal
    ),
    null
  );
});

// ── isCardVisible helper ──────────────────────────────────────────────

test("isCardVisible: hidden first-class card returns false", () => {
  const layout: DashboardLayout = {
    v: 1,
    order: [...CANONICAL_ORDER],
    hidden: ["hero"],
  };
  assert.equal(isCardVisible("hero", layout, "on"), false);
  assert.equal(isCardVisible("risk_section", layout, "on"), true);
});

test("isCardVisible: callout ignores hidden[] but respects the flag gate", () => {
  const layout: DashboardLayout = {
    v: 1,
    order: [...CANONICAL_ORDER],
    hidden: [],
  };
  // Even if some malformed caller listed a callout in hidden, the
  // helper still considers them visible (reconcile strips them anyway).
  assert.equal(isCardVisible("family_callout", layout, "on"), true);
  // Flag-off still hides.
  assert.equal(isCardVisible("family_callout", layout, "off"), false);
});

test("DEFAULT_LAYOUT round-trips to the default preset", () => {
  assert.equal(matchDashboardPreset(DEFAULT_LAYOUT), "default");
});
