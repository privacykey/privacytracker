import assert from "node:assert/strict";
import test from "node:test";
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
