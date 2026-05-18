import type { FlagKey, FlagValue } from "../../lib/feature-flag-rules";

function overrides(entries: [FlagKey, FlagValue][]): Map<FlagKey, FlagValue> {
  return new Map(entries);
}

export const OVERRIDES_NONE = overrides([]);

export const OVERRIDES_AI_ON = overrides([
  ["flag.detail.policy.ai_summary", "on"],
  ["flag.detail.policy.lens_grid", "on"],
  ["flag.detail.policy.highlights", "on"],
]);

export const OVERRIDES_AI_OFF = overrides([
  ["flag.detail.policy.ai_summary", "off"],
  ["flag.detail.policy.lens_grid", "off"],
  ["flag.detail.policy.highlights", "off"],
]);

export const OVERRIDES_DEVOPTS_VISIBLE = overrides([
  ["flag.devopts.visible", "on"],
  ["flag.devopts.feature_flag_panel", "on"],
  ["flag.devopts.activity_log", "on"],
]);

export const OVERRIDES_TOUR_RESET = overrides([
  ["flag.onboarding.coachmark_tour", "on"],
]);

export const OVERRIDES_NOTIFICATIONS_QUIET = overrides([
  ["flag.notifications.quiet_hours", "on"],
]);

export const OVERRIDES_BACKGROUND_WIZARD = overrides([
  ["flag.dashboard.background_mode_wizard", "on"],
]);

export const OVERRIDES_KILL_SWITCH = overrides([
  ["flag.devopts.feature_flag_system.enabled", "off"],
]);
