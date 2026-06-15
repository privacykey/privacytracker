import type { AgeBandKey } from "./age-rating";
import type { Audience } from "./feature-flag-rules";
import type { FocusWorkflow } from "./focus-workflow";
import { inferFocusWorkflow } from "./focus-workflow";
import type { ProfilePresetKey } from "./privacy-profile";
import type { UserTaskId } from "./tasks";

export type PrimaryPurpose = "monitor" | "cleanup" | "help" | "custom";
export type HelpRelationship = "adult" | "child";
export type HelpOutcome = "handoff" | "monitor";
export type SecondaryPurpose = "accessibility" | "policy";

export interface PurposeSelection {
  advanced?: {
    accessibility: boolean;
    audience: Audience;
    cleanup: boolean;
    minimal: boolean;
    monitor: boolean;
    workflow?: FocusWorkflow;
  };
  helpOutcome?: HelpOutcome;
  helpRelationship?: HelpRelationship;
  primary: PrimaryPurpose;
  secondary?: Partial<Record<SecondaryPurpose, boolean>>;
}

export interface ResolvedPurposeFocus {
  accessibility: boolean;
  audience: Audience;
  /**
   * Guardian child age band, attached by the form (not derived here).
   * `undefined` = leave the stored value unchanged; `null` = explicit clear.
   */
  childAgeBand?: AgeBandKey | null;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  taskOptIns: UserTaskId[];
  workflow: FocusWorkflow;
}

export interface PurposeFocusInput {
  accessibility: boolean;
  audience: Audience;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  workflow?: FocusWorkflow;
}

export function resolvePurposeSelection(
  selection: PurposeSelection
): ResolvedPurposeFocus {
  const taskOptIns = new Set<UserTaskId>();
  let audience: Audience = "self";
  let monitor = true;
  let cleanup = false;
  let minimal = false;
  let accessibility = false;
  let workflow: FocusWorkflow = "self_monitor";

  if (selection.primary === "cleanup") {
    monitor = false;
    cleanup = true;
    workflow = "self_cleanup";
    taskOptIns.add("remove_apps_from_phone");
  } else if (selection.primary === "help") {
    audience =
      selection.helpRelationship === "child" ? "guardian" : "loved_one";
    monitor = true;
    cleanup = true;
    workflow =
      selection.helpOutcome === "monitor" ? "other_monitor" : "other_handoff";
    taskOptIns.add(
      workflow === "other_monitor"
        ? "setup_background_mode"
        : "export_audit_bundle"
    );
  } else if (selection.primary === "custom" && selection.advanced) {
    audience = selection.advanced.audience;
    monitor = selection.advanced.monitor;
    cleanup = selection.advanced.cleanup;
    minimal = selection.advanced.minimal;
    accessibility = selection.advanced.accessibility;
    workflow =
      selection.advanced.workflow ??
      inferFocusWorkflow({ audience, monitor, cleanup, minimal });
  } else {
    taskOptIns.add("setup_background_mode");
  }

  if (selection.secondary?.accessibility) {
    accessibility = true;
  }
  if (selection.secondary?.policy && !minimal) {
    monitor = true;
    taskOptIns.add("setup_background_mode");
  }
  if (minimal) {
    monitor = false;
    cleanup = false;
    workflow = workflow === "custom" ? workflow : "custom";
  } else if (!(monitor || cleanup)) {
    monitor = true;
  } else if (selection.primary === "custom" && !selection.advanced?.workflow) {
    workflow = inferFocusWorkflow({ audience, monitor, cleanup, minimal });
  }

  return {
    audience,
    monitor,
    cleanup,
    minimal,
    accessibility,
    workflow,
    taskOptIns: [...taskOptIns],
  };
}

export function selectionFromFocus(input: PurposeFocusInput): PurposeSelection {
  const workflow =
    input.workflow ??
    inferFocusWorkflow({
      audience: input.audience,
      monitor: input.monitor,
      cleanup: input.cleanup,
      minimal: input.minimal,
    });

  const secondary: Partial<Record<SecondaryPurpose, boolean>> = {};
  if (input.accessibility) {
    secondary.accessibility = true;
  }
  if (workflow === "self_monitor" || workflow === "other_monitor") {
    secondary.policy = true;
  }

  if (workflow === "self_monitor") {
    return { primary: "monitor", secondary };
  }
  if (workflow === "self_cleanup") {
    return { primary: "cleanup", secondary };
  }
  if (workflow === "other_handoff" || workflow === "other_monitor") {
    return {
      primary: "help",
      helpRelationship: input.audience === "guardian" ? "child" : "adult",
      helpOutcome: workflow === "other_monitor" ? "monitor" : "handoff",
      secondary,
    };
  }

  return {
    primary: "custom",
    secondary,
    advanced: {
      audience: input.audience,
      monitor: input.monitor,
      cleanup: input.cleanup,
      minimal: input.minimal,
      accessibility: input.accessibility,
      workflow,
    },
  };
}

export interface DescribedPurpose {
  /**
   * True when the focus doesn't map to a single named purpose (advanced
   * combinations, minimal, or both goals at once). Display surfaces should
   * fall back to the goal vocabulary in that case rather than show an
   * ill-fitting "Custom" label.
   */
  isCustom: boolean;
  /** The /welcome primary purpose this focus maps to. */
  primary: PrimaryPurpose;
}

/**
 * Map a stored focus to the primary "purpose" the /welcome form would show
 * for it (Monitor / Clean up / Help), so read-only display surfaces can
 * speak the same purpose vocabulary as the onboarding + settings editor
 * instead of the underlying goal vocabulary. Thin wrapper over
 * `selectionFromFocus` — the single source of truth for the
 * purpose↔focus mapping.
 */
export function describePurpose(input: PurposeFocusInput): DescribedPurpose {
  const { primary } = selectionFromFocus(input);
  return { primary, isCustom: primary === "custom" };
}

export function recommendedPrivacyPresetForFocus(
  focus: {
    audience: Audience;
    goals: Set<string>;
  },
  workflow: FocusWorkflow | null | undefined
): ProfilePresetKey | null {
  if (focus.audience === "guardian") {
    return "strict";
  }
  if (
    workflow === "self_cleanup" ||
    workflow === "other_handoff" ||
    focus.goals.has("cleanup")
  ) {
    return "balanced";
  }
  return null;
}
