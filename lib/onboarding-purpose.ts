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
    declutter: boolean;
    minimal: boolean;
    understand: boolean;
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
  declutter: boolean;
  minimal: boolean;
  taskOptIns: UserTaskId[];
  understand: boolean;
  workflow: FocusWorkflow;
}

export interface PurposeFocusInput {
  accessibility: boolean;
  audience: Audience;
  declutter: boolean;
  minimal: boolean;
  understand: boolean;
  workflow?: FocusWorkflow;
}

export function resolvePurposeSelection(
  selection: PurposeSelection
): ResolvedPurposeFocus {
  const taskOptIns = new Set<UserTaskId>();
  let audience: Audience = "self";
  let understand = true;
  let declutter = false;
  let minimal = false;
  let accessibility = false;
  let workflow: FocusWorkflow = "self_monitor";

  if (selection.primary === "cleanup") {
    understand = false;
    declutter = true;
    workflow = "self_cleanup";
    taskOptIns.add("remove_apps_from_phone");
  } else if (selection.primary === "help") {
    audience =
      selection.helpRelationship === "child" ? "guardian" : "loved_one";
    understand = true;
    declutter = true;
    workflow =
      selection.helpOutcome === "monitor" ? "other_monitor" : "other_handoff";
    taskOptIns.add(
      workflow === "other_monitor"
        ? "setup_background_mode"
        : "export_audit_bundle"
    );
  } else if (selection.primary === "custom" && selection.advanced) {
    audience = selection.advanced.audience;
    understand = selection.advanced.understand;
    declutter = selection.advanced.declutter;
    minimal = selection.advanced.minimal;
    accessibility = selection.advanced.accessibility;
    workflow =
      selection.advanced.workflow ??
      inferFocusWorkflow({ audience, understand, declutter, minimal });
  } else {
    taskOptIns.add("setup_background_mode");
  }

  if (selection.secondary?.accessibility) {
    accessibility = true;
  }
  if (selection.secondary?.policy && !minimal) {
    understand = true;
    taskOptIns.add("setup_background_mode");
  }
  if (minimal) {
    understand = false;
    declutter = false;
    workflow = workflow === "custom" ? workflow : "custom";
  } else if (!(understand || declutter)) {
    understand = true;
  } else if (selection.primary === "custom" && !selection.advanced?.workflow) {
    workflow = inferFocusWorkflow({ audience, understand, declutter, minimal });
  }

  return {
    audience,
    understand,
    declutter,
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
      understand: input.understand,
      declutter: input.declutter,
      minimal: input.minimal,
    });

  const secondary: Partial<Record<SecondaryPurpose, boolean>> = {};
  if (input.accessibility) {
    secondary.accessibility = true;
  }
  if (workflow === "self_monitor" || workflow === "other_monitor") {
    secondary.policy = true;
  } else if (workflow === "self_cleanup" && input.understand) {
    // Cleanup's base goal is declutter only — the Policy secondary is the
    // one control that layers `understand` onto a cleanup primary (see the
    // `secondary.policy` branch in resolvePurposeSelection). So a persisted
    // cleanup focus that ALSO carries `understand` means Policy was on;
    // reconstruct it here. Without this, re-opening the editor shows the
    // Policy card unchecked and a no-op re-save resolves cleanup back to
    // understand=false, silently dropping the goal.
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
      understand: input.understand,
      declutter: input.declutter,
      minimal: input.minimal,
      accessibility: input.accessibility,
      workflow,
    },
  };
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
    focus.goals.has("declutter")
  ) {
    return "balanced";
  }
  return null;
}
