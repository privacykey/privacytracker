import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalsFrom } from "../../lib/feature-flag-rules";
import {
  describePurpose,
  recommendedPrivacyPresetForFocus,
  resolvePurposeSelection,
} from "../../lib/onboarding-purpose";

const BASE = {
  audience: "self" as const,
  monitor: false,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

test("monitor goal maps to a self_monitor focus with background-mode opt-in", () => {
  assert.deepEqual(resolvePurposeSelection({ ...BASE, monitor: true }), {
    audience: "self",
    monitor: true,
    cleanup: false,
    minimal: false,
    accessibility: false,
    workflow: "self_monitor",
    taskOptIns: ["setup_background_mode"],
  });
});

test("cleanup goal maps to a self_cleanup focus with remove-apps opt-in", () => {
  assert.deepEqual(resolvePurposeSelection({ ...BASE, cleanup: true }), {
    audience: "self",
    monitor: false,
    cleanup: true,
    minimal: false,
    accessibility: false,
    workflow: "self_cleanup",
    taskOptIns: ["remove_apps_from_phone"],
  });
});

test("monitor + cleanup together collapse to a custom workflow", () => {
  assert.deepEqual(
    resolvePurposeSelection({ ...BASE, monitor: true, cleanup: true }),
    {
      audience: "self",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: false,
      workflow: "custom",
      taskOptIns: ["remove_apps_from_phone", "setup_background_mode"],
    }
  );
});

test("loved_one audience (Help tile) opts into the audit-bundle handoff", () => {
  assert.deepEqual(
    resolvePurposeSelection({
      ...BASE,
      audience: "loved_one",
      monitor: true,
      cleanup: true,
    }),
    {
      audience: "loved_one",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: false,
      workflow: "custom",
      taskOptIns: ["remove_apps_from_phone", "export_audit_bundle"],
    }
  );
});

test("guardian audience monitoring opts into background mode", () => {
  assert.deepEqual(
    resolvePurposeSelection({ ...BASE, audience: "guardian", monitor: true }),
    {
      audience: "guardian",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
      workflow: "custom",
      taskOptIns: ["setup_background_mode"],
    }
  );
});

test("accessibility layers onto any selection without changing goals", () => {
  const resolved = resolvePurposeSelection({
    ...BASE,
    cleanup: true,
    accessibility: true,
  });
  assert.equal(resolved.accessibility, true);
  assert.equal(resolved.cleanup, true);
  assert.equal(resolved.monitor, false);
  assert.deepEqual(resolved.taskOptIns, ["remove_apps_from_phone"]);
});

test("minimal stays mutually exclusive with monitor and cleanup", () => {
  const resolved = resolvePurposeSelection({
    ...BASE,
    monitor: true,
    cleanup: true,
    minimal: true,
    accessibility: true,
  });
  assert.equal(resolved.minimal, true);
  assert.equal(resolved.monitor, false);
  assert.equal(resolved.cleanup, false);
  assert.equal(resolved.accessibility, true);
  assert.equal(resolved.workflow, "custom");
  assert.deepEqual(resolved.taskOptIns, []);
});

test("empty selection is a valid baseline with no opt-ins", () => {
  assert.deepEqual(resolvePurposeSelection({ ...BASE }), {
    audience: "self",
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
    workflow: "custom",
    taskOptIns: [],
  });
});

test("recommended privacy preset follows audience and workflow", () => {
  const selfUnderstand = {
    audience: "self" as const,
    goals: activeGoalsFrom({
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
    }),
  };
  assert.equal(
    recommendedPrivacyPresetForFocus(selfUnderstand, "self_monitor"),
    null
  );
  assert.equal(
    recommendedPrivacyPresetForFocus(selfUnderstand, "other_handoff"),
    "balanced"
  );
  assert.equal(
    recommendedPrivacyPresetForFocus(
      {
        audience: "self",
        goals: activeGoalsFrom({
          monitor: false,
          cleanup: true,
          minimal: false,
          accessibility: false,
        }),
      },
      "self_cleanup"
    ),
    "balanced"
  );

  const guardian = {
    audience: "guardian" as const,
    goals: activeGoalsFrom({
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: false,
    }),
  };
  assert.equal(
    recommendedPrivacyPresetForFocus(guardian, "other_monitor"),
    "strict"
  );
});

test("describePurpose maps a stored focus back to its /welcome purpose", () => {
  const base = {
    audience: "self" as const,
    monitor: false,
    cleanup: false,
    minimal: false,
    accessibility: false,
  };

  // Monitor: self + monitor-only.
  assert.deepEqual(describePurpose({ ...base, monitor: true }), {
    primary: "monitor",
    isCustom: false,
  });

  // Clean up: self + cleanup-only.
  assert.deepEqual(describePurpose({ ...base, cleanup: true }), {
    primary: "cleanup",
    isCustom: false,
  });

  // Help: another adult (loved_one audience).
  assert.deepEqual(
    describePurpose({
      ...base,
      audience: "loved_one",
      monitor: true,
      cleanup: true,
    }),
    { primary: "help", isCustom: false }
  );

  // Help: a child (guardian audience).
  assert.deepEqual(
    describePurpose({
      ...base,
      audience: "guardian",
      monitor: true,
      cleanup: true,
    }),
    { primary: "help", isCustom: false }
  );

  // Custom: minimal has no single purpose tile.
  assert.deepEqual(describePurpose({ ...base, minimal: true }), {
    primary: "custom",
    isCustom: true,
  });

  // Custom: both self goals at once.
  assert.deepEqual(describePurpose({ ...base, monitor: true, cleanup: true }), {
    primary: "custom",
    isCustom: true,
  });

  // Custom: empty baseline (no goals selected).
  assert.deepEqual(describePurpose({ ...base }), {
    primary: "custom",
    isCustom: true,
  });
});
