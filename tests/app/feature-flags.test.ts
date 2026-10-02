import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAG_DEPENDENCIES,
  type FlagKey,
  type FlagValue,
  isTriStateFlag,
  parentHidesDependents,
} from "../../lib/feature-flag-rules";
import { type ResolverContext, resolveFlag } from "../../lib/feature-flags";

function ctx(
  overrides: ResolverContext["overrides"] = new Map()
): ResolverContext {
  return {
    focus: {
      audience: "self",
      goals: new Set(["monitor"]),
      aiConfigured: false,
    },
    overrides,
    killSwitchOff: false,
  };
}

/** Build a self-audience context with an arbitrary goal set + overrides. */
function focusCtx(
  goals: Array<"monitor" | "cleanup" | "minimal" | "accessibility">,
  overrides: ResolverContext["overrides"] = new Map()
): ResolverContext {
  return {
    focus: { audience: "self", goals: new Set(goals), aiConfigured: false },
    overrides,
    killSwitchOff: false,
  };
}

test("Apple Configurator onboarding method is desktop-runtime only by default", () => {
  assert.equal(
    resolveFlag("flag.onboarding.method.configurator", ctx()),
    "off"
  );
  assert.equal(
    resolveFlag("flag.onboarding.method.configurator", {
      ...ctx(),
      runtimeEnvironment: "desktop",
    }),
    "on"
  );
});

test("Apple Configurator onboarding method still honours explicit user override", () => {
  assert.equal(
    resolveFlag("flag.onboarding.method.configurator", {
      ...ctx(
        new Map([["flag.onboarding.method.configurator", "off"] as const])
      ),
      runtimeEnvironment: "desktop",
    }),
    "off"
  );
});

// ── guardian age-rating feature ───────────────────────────────────────

function guardianCtx(
  overrides: ResolverContext["overrides"] = new Map()
): ResolverContext {
  return {
    focus: {
      audience: "guardian",
      goals: new Set(["monitor"]),
      aiConfigured: false,
    },
    overrides,
    killSwitchOff: false,
  };
}

test("guardian age-rating flags are off for the self audience", () => {
  assert.equal(resolveFlag("flag.guardian.age_rating", ctx()), "off");
  assert.equal(resolveFlag("flag.dashboard.callout.age_rating", ctx()), "off");
});

test("guardian audience turns the age-rating master + callout on", () => {
  assert.equal(resolveFlag("flag.guardian.age_rating", guardianCtx()), "on");
  assert.equal(
    resolveFlag("flag.dashboard.callout.age_rating", guardianCtx()),
    "on"
  );
});

test("age-rating callout chains off the master via FLAG_DEPENDENCIES", () => {
  // Master overridden off → the callout collapses too, even though the
  // guardian audience rule would otherwise turn it on.
  const overrides = new Map([["flag.guardian.age_rating", "off"] as const]);
  assert.equal(
    resolveFlag("flag.dashboard.callout.age_rating", guardianCtx(overrides)),
    "off"
  );
});

test("a 'collapsed' two-state parent still turns its dependents off", () => {
  // Dev Options can set any flag to 'collapsed'. Clients read a two-state
  // flag at 'collapsed' as off, so the callout must follow the master.
  const overrides = new Map([
    ["flag.guardian.age_rating", "collapsed"] as const,
  ]);
  assert.equal(
    resolveFlag("flag.dashboard.callout.age_rating", guardianCtx(overrides)),
    "off"
  );
});

// ── dependencies on a tri-state parent ────────────────────────────────

test("parentHidesDependents: 'collapsed' hides only under a two-state parent", () => {
  assert.equal(isTriStateFlag("flag.detail.a11y.panel"), true);
  assert.equal(isTriStateFlag("flag.detail.policy.run_log_strip"), true);
  assert.equal(isTriStateFlag("flag.guardian.age_rating"), false);
  for (const parent of [
    "flag.detail.a11y.panel",
    "flag.detail.policy.run_log_strip",
  ] as const) {
    assert.equal(parentHidesDependents(parent, "on"), false);
    assert.equal(parentHidesDependents(parent, "collapsed"), false);
    assert.equal(parentHidesDependents(parent, "off"), true);
  }
  assert.equal(parentHidesDependents("flag.guardian.age_rating", "on"), false);
  assert.equal(
    parentHidesDependents("flag.guardian.age_rating", "collapsed"),
    true
  );
  assert.equal(parentHidesDependents("flag.guardian.age_rating", "off"), true);
});

test("every tri-state dependency parent is one of the two the rule was decided for", () => {
  // The dependency rule was changed for these two edges after checking
  // what their dependents show. A new tri-state parent needs the same
  // check before it joins the list.
  const triStateParents = Object.entries(FLAG_DEPENDENCIES)
    .filter(([, parent]) => isTriStateFlag(parent as FlagKey))
    .map(([child, parent]) => `${child} -> ${parent}`)
    .sort();
  assert.deepEqual(triStateParents, [
    "flag.detail.a11y.preference_highlights -> flag.detail.a11y.panel",
    "flag.detail.policy.run_log_details -> flag.detail.policy.run_log_strip",
  ]);
});

test("a 'collapsed' accessibility panel keeps the preference highlights on", () => {
  // Without the accessibility modifier the panel stays at its 'collapsed'
  // default: the tab shows, so the preferences saved in Settings must
  // still highlight. It used to resolve 'off' here.
  for (const goals of [[], ["monitor"], ["cleanup"], ["minimal"]] as const) {
    const c = focusCtx([...goals]);
    assert.equal(resolveFlag("flag.detail.a11y.panel", c), "collapsed");
    assert.equal(
      resolveFlag("flag.detail.a11y.preference_highlights", c),
      "on",
      `goals: ${goals.join("+") || "none"}`
    );
  }
  // The modifier expands the panel; the highlights stay on.
  const a11y = focusCtx(["accessibility"]);
  assert.equal(resolveFlag("flag.detail.a11y.panel", a11y), "on");
  assert.equal(
    resolveFlag("flag.detail.a11y.preference_highlights", a11y),
    "on"
  );
  // An 'off' panel hides the tab, and the highlights with it.
  const off = focusCtx(
    ["monitor"],
    new Map([["flag.detail.a11y.panel", "off"] as const])
  );
  assert.equal(
    resolveFlag("flag.detail.a11y.preference_highlights", off),
    "off"
  );
});

test("a 'collapsed' run-log strip keeps its full trace at 'collapsed'", () => {
  // The strip shows at its default, so the trace inside it shows too,
  // closed. It used to resolve 'off' for every focus.
  const c = focusCtx(["monitor"]);
  assert.equal(resolveFlag("flag.detail.policy.run_log_strip", c), "collapsed");
  assert.equal(
    resolveFlag("flag.detail.policy.run_log_details", c),
    "collapsed"
  );
  // Minimal and guardian turn both off with their own rules.
  assert.equal(
    resolveFlag("flag.detail.policy.run_log_details", focusCtx(["minimal"])),
    "off"
  );
  assert.equal(
    resolveFlag("flag.detail.policy.run_log_details", guardianCtx()),
    "off"
  );
  // An 'off' strip takes the trace with it, and an override on the trace
  // still beats that.
  const stripOff = new Map<FlagKey, FlagValue>([
    ["flag.detail.policy.run_log_strip", "off"],
  ]);
  assert.equal(
    resolveFlag("flag.detail.policy.run_log_details", focusCtx([], stripOff)),
    "off"
  );
  stripOff.set("flag.detail.policy.run_log_details", "on");
  assert.equal(
    resolveFlag("flag.detail.policy.run_log_details", focusCtx([], stripOff)),
    "on"
  );
});

test("kill-switch collapses the age-rating flags to their hard defaults", () => {
  const killed: ResolverContext = { ...guardianCtx(), killSwitchOff: true };
  assert.equal(resolveFlag("flag.guardian.age_rating", killed), "off");
  assert.equal(resolveFlag("flag.dashboard.callout.age_rating", killed), "off");
});

// ── re-keyed goal taxonomy (monitor / cleanup / minimal) ──────────────

test("monitor goal turns on the comprehension bundle", () => {
  const c = focusCtx(["monitor"]);
  assert.equal(resolveFlag("flag.detail.policy.ai_summary", c), "on");
  assert.equal(resolveFlag("flag.detail.charts.category_trend", c), "on");
  // The 'how much to trust this label' card follows the Monitor goal only.
  assert.equal(resolveFlag("flag.detail.labels.trust_card", c), "on");
});

test("cleanup goal turns on the cleanup bundle", () => {
  const c = focusCtx(["cleanup"]);
  assert.equal(resolveFlag("flag.page.compare", c), "on");
  assert.equal(resolveFlag("flag.appgrid.card.risk_pill", c), "on");
  // cleanup also surfaces AI summaries (helps justify a delete).
  assert.equal(resolveFlag("flag.detail.policy.ai_summary", c), "on");
});

test("monitor + cleanup multi-select applies both bundles", () => {
  const c = focusCtx(["monitor", "cleanup"]);
  // monitor-only flag
  assert.equal(resolveFlag("flag.detail.charts.category_trend", c), "on");
  // cleanup-only flag
  assert.equal(resolveFlag("flag.appgrid.card.risk_pill", c), "on");
  // shared flag set by both
  assert.equal(resolveFlag("flag.detail.policy.ai_summary", c), "on");
});

test("minimal strips the surface back", () => {
  const c = focusCtx(["minimal"]);
  assert.equal(resolveFlag("flag.page.compare", c), "off");
  assert.equal(resolveFlag("flag.detail.labels.trust_card", c), "off");
  assert.equal(resolveFlag("flag.page.stats", c), "on");
  assert.equal(resolveFlag("flag.page.shortlist", c), "off");
});

test("empty goal set leaves flags at their hard defaults (no overlay)", () => {
  const c = focusCtx([]);
  // ai_summary is off by default — no goal turns it on.
  assert.equal(resolveFlag("flag.detail.policy.ai_summary", c), "off");
  // Same for the label trust card: cleanup alone does not surface it either.
  assert.equal(resolveFlag("flag.detail.labels.trust_card", c), "off");
  assert.equal(
    resolveFlag("flag.detail.labels.trust_card", focusCtx(["cleanup"])),
    "off"
  );
  // Comparison follows Cleanup or Helping someone.
  assert.equal(resolveFlag("flag.page.compare", c), "off");
});

test("a user override beats the goal rule (feature-toggle contract)", () => {
  // minimal would force compare off; an explicit override flips it back on.
  // This is exactly what FeatureToggleRow relies on — overrides win last.
  const overrides = new Map<FlagKey, FlagValue>([["flag.page.compare", "on"]]);
  assert.equal(
    resolveFlag("flag.page.compare", focusCtx(["minimal"], overrides)),
    "on"
  );
  // ...and the inverse: turn a goal-enabled flag off.
  const off = new Map<FlagKey, FlagValue>([
    ["flag.detail.policy.ai_summary", "off"],
  ]);
  assert.equal(
    resolveFlag("flag.detail.policy.ai_summary", focusCtx(["monitor"], off)),
    "off"
  );
});
