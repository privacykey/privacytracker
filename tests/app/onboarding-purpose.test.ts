import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalsFrom } from "../../lib/feature-flag-rules";
import {
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

test("cleanup + policy focus round-trips without dropping understand", () => {
  // Persisted focus a user gets from picking "Clean up my phone" AND
  // toggling the Policy secondary: cleanup's base is declutter-only, and
  // Policy layers understand on top. Re-opening the settings editor maps
  // this back through selectionFromFocus, and a no-op re-save runs it back
  // through resolvePurposeSelection — understand must survive that loop.
  const persisted = {
    audience: "self" as const,
    understand: true,
    declutter: true,
    minimal: false,
    accessibility: false,
    workflow: "self_cleanup" as const,
  };

  const selection = selectionFromFocus(persisted);
  assert.deepEqual(selection, {
    primary: "cleanup",
    secondary: { policy: true },
  });

  const resolved = resolvePurposeSelection(selection);
  assert.equal(resolved.understand, true);
  assert.equal(resolved.declutter, true);
  assert.equal(resolved.minimal, false);
  assert.equal(resolved.workflow, "self_cleanup");
  assert.equal(resolved.audience, "self");
});

test("plain cleanup focus does not light the Policy secondary", () => {
  // Guard the other direction: a cleanup focus WITHOUT understand (Policy
  // never toggled) must not spuriously reconstruct the Policy card.
  const selection = selectionFromFocus({
    audience: "self",
    understand: false,
    declutter: true,
    minimal: false,
    accessibility: false,
    workflow: "self_cleanup",
  });
  assert.deepEqual(selection, { primary: "cleanup", secondary: {} });
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
