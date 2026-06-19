import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalsFrom, type FlagValue } from "../../lib/feature-flag-rules";
import {
  type ResolverContext,
  resolveFlag,
  resolveFocusBaseline,
} from "../../lib/feature-flags";

/**
 * Pins the focus-only baseline that FeatureToggleRow compares against to decide
 * whether flipping a feature should WRITE an override or CLEAR one (review
 * finding #5), plus the in-progress reflection the resolve-preview route serves
 * (#4). The contract lives in resolveFocusBaseline, so it's unit-testable
 * without HTTP — the routes are thin wrappers over it.
 */

type Goal = "monitor" | "cleanup" | "minimal" | "accessibility";

function focusCtx(
  goals: Goal[],
  overrides: ResolverContext["overrides"] = new Map()
): ResolverContext {
  return {
    focus: { audience: "self", goals: new Set(goals), aiConfigured: false },
    overrides,
    killSwitchOff: false,
  };
}

test("resolveFocusBaseline ignores THIS key's own override (#5 baseline)", () => {
  const focusValue = resolveFlag("flag.page.stats", focusCtx(["monitor"]));
  assert.equal(focusValue, "on");
  const c = focusCtx(
    ["monitor"],
    new Map([["flag.page.stats", "off"] as const])
  );
  // The override wins for the resolved value...
  assert.equal(resolveFlag("flag.page.stats", c), "off");
  // ...but the focus baseline ignores it and reports what the goals alone give.
  assert.equal(resolveFocusBaseline("flag.page.stats", c), "on");
});

test("a flip matching the focus baseline clears instead of pinning (#5 decision)", () => {
  // The component's rule, verbatim: target === resolveFocusBaseline ? DELETE : POST.
  const decision = (target: FlagValue, baseline: FlagValue) =>
    target === baseline ? "DELETE" : "POST";
  const baseline = resolveFocusBaseline(
    "flag.page.stats",
    focusCtx(["monitor"])
  );
  assert.equal(baseline, "on");
  assert.equal(decision("on", baseline), "DELETE"); // desired matches focus → clear, no redundant override
  assert.equal(decision("off", baseline), "POST"); // desired diverges → pin
});

test("resolveFocusBaseline strips ONLY this key — a dependency parent's override survives", () => {
  const childFocus = resolveFlag(
    "flag.detail.policy.summarise_button",
    focusCtx(["monitor"])
  );
  assert.equal(childFocus, "on");
  const c = focusCtx(
    ["monitor"],
    new Map([
      ["flag.detail.policy.panel", "off"] as const,
      ["flag.detail.policy.summarise_button", "on"] as const,
    ])
  );
  // Child override wins over the dependency for the resolved value.
  assert.equal(resolveFlag("flag.detail.policy.summarise_button", c), "on");
  // Baseline strips only the child override; the parent override stays, so the
  // dependency forces the child off. A strip-ALL baseline would wrongly return
  // the child's focus value ('on') — this guards strip-this vs strip-all.
  assert.equal(
    resolveFocusBaseline("flag.detail.policy.summarise_button", c),
    "off"
  );
});

test("baseline tracks the in-progress goal selection, not persisted focus (#4)", () => {
  const minimalGoals = [
    ...activeGoalsFrom({
      monitor: false,
      cleanup: false,
      minimal: true,
      accessibility: false,
    }),
  ] as Goal[];
  const monitorGoals = [
    ...activeGoalsFrom({
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
    }),
  ] as Goal[];
  // resolve-preview resolves exactly this against the unsaved selection:
  // 'Keep it minimal' turns Stats off; a monitor selection leaves it on.
  assert.equal(
    resolveFocusBaseline("flag.page.stats", focusCtx(minimalGoals)),
    "off"
  );
  assert.equal(
    resolveFocusBaseline("flag.page.stats", focusCtx(monitorGoals)),
    "on"
  );
});
