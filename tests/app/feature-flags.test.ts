import assert from "node:assert/strict";
import test from "node:test";
import type { FlagKey, FlagValue } from "../../lib/feature-flag-rules";
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
  assert.equal(resolveFlag("flag.page.stats", c), "off");
  assert.equal(resolveFlag("flag.page.shortlist", c), "off");
});

test("empty goal set leaves flags at their hard defaults (no overlay)", () => {
  const c = focusCtx([]);
  // ai_summary is off by default — no goal turns it on.
  assert.equal(resolveFlag("flag.detail.policy.ai_summary", c), "off");
  // compare is on by default and nothing subtracts it.
  assert.equal(resolveFlag("flag.page.compare", c), "on");
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
