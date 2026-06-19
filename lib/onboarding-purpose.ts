import type { AgeBandKey } from "./age-rating";
import type { Audience } from "./feature-flag-rules";
import type { FocusWorkflow } from "./focus-workflow";
import { inferFocusWorkflow } from "./focus-workflow";
import type { ProfilePresetKey } from "./privacy-profile";
import type { UserTaskId } from "./tasks";

/**
 * The /welcome primary-purpose vocabulary. Retained for read-only display
 * surfaces (YourFocusCard, the FocusStrip in HomeView, FocusPreviewBanner)
 * and the /help/focus scenes — `describePurpose` collapses a stored focus
 * onto one of these so those surfaces can show a single friendly label.
 *
 * The onboarding + settings editor itself is now MULTI-SELECT (see
 * `PurposeSelection`): the goal tiles map 1:1 to focus booleans and no
 * longer funnel through a single "primary purpose". `describePurpose` is the
 * one-way bridge back to this vocabulary for the read-only surfaces.
 */
export type PrimaryPurpose = "monitor" | "cleanup" | "help" | "custom";

/**
 * The multi-select focus the /welcome + settings form collects directly.
 * Each goal tile maps to a boolean; the "Help a friend" tile is expressed
 * through `audience` (loved_one / guardian) rather than as its own goal.
 * `minimal` ("Keep it minimal") is subtractive and mutually exclusive with
 * the additive goal tiles.
 */
export interface PurposeSelection {
  accessibility: boolean;
  audience: Audience;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  /** Optional explicit workflow; inferred from goals + audience otherwise. */
  workflow?: FocusWorkflow;
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

/**
 * Turn the form's multi-select state into a persisted focus payload plus the
 * follow-up tasks worth offering. Pure — the form layers `childAgeBand` on
 * top before POSTing.
 */
export function resolvePurposeSelection(
  selection: PurposeSelection
): ResolvedPurposeFocus {
  const { audience, accessibility, minimal } = selection;
  // Minimal is subtractive and mutually exclusive with the goal tiles.
  const monitor = minimal ? false : selection.monitor;
  const cleanup = minimal ? false : selection.cleanup;

  const workflow =
    selection.workflow ??
    inferFocusWorkflow({ audience, monitor, cleanup, minimal });

  // Follow-up tasks track what the chosen goals/audience imply. Minimal opts
  // out of all of them (it's the "no extras" surface).
  const taskOptIns = new Set<UserTaskId>();
  if (cleanup) {
    taskOptIns.add("remove_apps_from_phone");
  }
  if (!minimal) {
    if (audience === "loved_one") {
      // Helping another adult — prepare a bundle to hand them.
      taskOptIns.add("export_audit_bundle");
    } else if (monitor) {
      // Monitoring your own (or a managed child's) apps — set up background checks.
      taskOptIns.add("setup_background_mode");
    }
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

export interface DescribedPurpose {
  /**
   * True when the focus doesn't map to a single named purpose (minimal, an
   * empty baseline, or both self goals at once). Display surfaces should fall
   * back to the goal vocabulary in that case rather than show an ill-fitting
   * "Custom" label.
   */
  isCustom: boolean;
  /** The /welcome primary purpose this focus maps to. */
  primary: PrimaryPurpose;
}

/**
 * Map a stored focus to the primary "purpose" the /welcome form would lead
 * with for it (Monitor / Clean up / Help), so read-only display surfaces can
 * speak a single friendly label instead of the underlying goal booleans.
 *
 * The mapping is intentionally one-way and lossy — the editor is multi-select,
 * so any combination that doesn't reduce to a single tile (minimal, both self
 * goals, or an empty baseline) reports `isCustom`.
 */
export function describePurpose(input: PurposeFocusInput): DescribedPurpose {
  // Minimal has no single tile — it's the subtractive switch.
  if (input.minimal) {
    return { primary: "custom", isCustom: true };
  }
  // Any non-self audience is the "Help a friend" tile's territory.
  if (input.audience !== "self") {
    return { primary: "help", isCustom: false };
  }
  if (input.monitor && !input.cleanup) {
    return { primary: "monitor", isCustom: false };
  }
  if (input.cleanup && !input.monitor) {
    return { primary: "cleanup", isCustom: false };
  }
  // self + both goals, or self + nothing — no single tile fits.
  return { primary: "custom", isCustom: true };
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
