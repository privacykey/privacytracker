import type {
  Audience,
  FocusState,
  Modifier,
  PrimaryGoal,
} from "../../lib/feature-flag-rules";

function focus(
  audience: Audience,
  goals: Array<PrimaryGoal | Modifier>,
  aiConfigured = false
): FocusState {
  return { audience, goals: new Set(goals), aiConfigured };
}

export const FALLBACK_FOCUS: FocusState = focus("self", ["monitor"]);

export const FOCUS_SELF_UNDERSTAND = focus("self", ["monitor"]);
export const FOCUS_SELF_UNDERSTAND_AI = focus("self", ["monitor"], true);
export const FOCUS_SELF_DECLUTTER = focus("self", ["cleanup"]);
export const FOCUS_SELF_UNDERSTAND_DECLUTTER = focus("self", [
  "monitor",
  "cleanup",
]);
export const FOCUS_SELF_MINIMAL = focus("self", ["minimal"]);
export const FOCUS_SELF_ACCESSIBILITY = focus("self", [
  "monitor",
  "accessibility",
]);
export const FOCUS_LOVED_ONE_UNDERSTAND = focus("loved_one", ["monitor"]);
export const FOCUS_LOVED_ONE_DECLUTTER = focus("loved_one", ["cleanup"]);
export const FOCUS_GUARDIAN_UNDERSTAND = focus("guardian", ["monitor"]);
export const FOCUS_GUARDIAN_DECLUTTER = focus("guardian", ["cleanup"]);
export const FOCUS_GUARDIAN_MINIMAL = focus("guardian", ["minimal"]);

export const FOCUS_FIXTURES = {
  "self / monitor": FOCUS_SELF_UNDERSTAND,
  "self / monitor (AI on)": FOCUS_SELF_UNDERSTAND_AI,
  "self / cleanup": FOCUS_SELF_DECLUTTER,
  "self / monitor + cleanup": FOCUS_SELF_UNDERSTAND_DECLUTTER,
  "self / minimal": FOCUS_SELF_MINIMAL,
  "self / monitor + accessibility": FOCUS_SELF_ACCESSIBILITY,
  "loved_one / monitor": FOCUS_LOVED_ONE_UNDERSTAND,
  "loved_one / cleanup": FOCUS_LOVED_ONE_DECLUTTER,
  "guardian / monitor": FOCUS_GUARDIAN_UNDERSTAND,
  "guardian / cleanup": FOCUS_GUARDIAN_DECLUTTER,
  "guardian / minimal": FOCUS_GUARDIAN_MINIMAL,
};
