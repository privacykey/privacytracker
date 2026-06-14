import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalsFrom } from "../../lib/feature-flag-rules";
import {
  describePurpose,
  recommendedPrivacyPresetForFocus,
  resolvePurposeSelection,
  selectionFromFocus,
} from "../../lib/onboarding-purpose";

test("purpose mappings produce focus payloads and follow-up task opt-ins", () => {
  assert.deepEqual(resolvePurposeSelection({ primary: "monitor" }), {
    audience: "self",
    understand: true,
    declutter: false,
    minimal: false,
    accessibility: false,
    workflow: "self_monitor",
    taskOptIns: ["setup_background_mode"],
  });

  assert.deepEqual(resolvePurposeSelection({ primary: "cleanup" }), {
    audience: "self",
    understand: false,
    declutter: true,
    minimal: false,
    accessibility: false,
    workflow: "self_cleanup",
    taskOptIns: ["remove_apps_from_phone"],
  });

  assert.deepEqual(
    resolvePurposeSelection({
      primary: "help",
      helpRelationship: "adult",
      helpOutcome: "handoff",
    }),
    {
      audience: "loved_one",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: false,
      workflow: "other_handoff",
      taskOptIns: ["export_audit_bundle"],
    }
  );

  assert.deepEqual(
    resolvePurposeSelection({
      primary: "help",
      helpRelationship: "child",
      helpOutcome: "monitor",
    }),
    {
      audience: "guardian",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: false,
      workflow: "other_monitor",
      taskOptIns: ["setup_background_mode"],
    }
  );
});

test("secondary purpose cards layer onto the primary selection", () => {
  const resolved = resolvePurposeSelection({
    primary: "cleanup",
    secondary: { accessibility: true, policy: true },
  });
  assert.equal(resolved.accessibility, true);
  assert.equal(resolved.understand, true);
  assert.equal(resolved.declutter, true);
  assert.deepEqual(resolved.taskOptIns.sort(), [
    "remove_apps_from_phone",
    "setup_background_mode",
  ]);
});

test("advanced minimal stays mutually exclusive with understand and declutter", () => {
  const resolved = resolvePurposeSelection({
    primary: "custom",
    advanced: {
      audience: "self",
      understand: true,
      declutter: true,
      minimal: true,
      accessibility: true,
      workflow: "custom",
    },
  });
  assert.equal(resolved.minimal, true);
  assert.equal(resolved.understand, false);
  assert.equal(resolved.declutter, false);
  assert.equal(resolved.accessibility, true);
  assert.equal(resolved.workflow, "custom");
});

test("focus can be mapped back into a purpose selection", () => {
  assert.deepEqual(
    selectionFromFocus({
      audience: "guardian",
      understand: true,
      declutter: true,
      minimal: false,
      accessibility: true,
      workflow: "other_handoff",
    }),
    {
      primary: "help",
      helpRelationship: "child",
      helpOutcome: "handoff",
      secondary: { accessibility: true },
    }
  );
});

test("recommended privacy preset follows audience and workflow", () => {
  const selfUnderstand = {
    audience: "self" as const,
    goals: activeGoalsFrom({
      understand: true,
      declutter: false,
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
          understand: false,
          declutter: true,
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
      understand: true,
      declutter: true,
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
    understand: false,
    declutter: false,
    minimal: false,
    accessibility: false,
  };

  // Monitor: self + understand-only.
  assert.deepEqual(
    describePurpose({ ...base, understand: true, workflow: "self_monitor" }),
    { primary: "monitor", isCustom: false }
  );

  // Clean up: self + declutter-only.
  assert.deepEqual(
    describePurpose({ ...base, declutter: true, workflow: "self_cleanup" }),
    { primary: "cleanup", isCustom: false }
  );

  // Help: another adult (handoff).
  assert.deepEqual(
    describePurpose({
      ...base,
      audience: "loved_one",
      understand: true,
      declutter: true,
      workflow: "other_handoff",
    }),
    { primary: "help", isCustom: false }
  );

  // Help: a child (guardian).
  assert.deepEqual(
    describePurpose({
      ...base,
      audience: "guardian",
      understand: true,
      declutter: true,
      workflow: "other_monitor",
    }),
    { primary: "help", isCustom: false }
  );

  // Custom: minimal has no single purpose card.
  assert.deepEqual(
    describePurpose({ ...base, minimal: true, workflow: "custom" }),
    { primary: "custom", isCustom: true }
  );

  // Custom: both primary goals at once (advanced combination).
  assert.deepEqual(
    describePurpose({
      ...base,
      understand: true,
      declutter: true,
      workflow: "custom",
    }),
    { primary: "custom", isCustom: true }
  );
});
