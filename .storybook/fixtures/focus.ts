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

export const FALLBACK_FOCUS: FocusState = focus("self", ["understand"]);

export const FOCUS_SELF_UNDERSTAND = focus("self", ["understand"]);
export const FOCUS_SELF_UNDERSTAND_AI = focus("self", ["understand"], true);
export const FOCUS_SELF_DECLUTTER = focus("self", ["declutter"]);
export const FOCUS_SELF_UNDERSTAND_DECLUTTER = focus("self", [
  "understand",
  "declutter",
]);
export const FOCUS_SELF_MINIMAL = focus("self", ["minimal"]);
export const FOCUS_SELF_ACCESSIBILITY = focus("self", [
  "understand",
  "accessibility",
]);
export const FOCUS_LOVED_ONE_UNDERSTAND = focus("loved_one", ["understand"]);
export const FOCUS_LOVED_ONE_DECLUTTER = focus("loved_one", ["declutter"]);
export const FOCUS_GUARDIAN_UNDERSTAND = focus("guardian", ["understand"]);
export const FOCUS_GUARDIAN_DECLUTTER = focus("guardian", ["declutter"]);
export const FOCUS_GUARDIAN_MINIMAL = focus("guardian", ["minimal"]);

export const FOCUS_FIXTURES = {
  "self / understand": FOCUS_SELF_UNDERSTAND,
  "self / understand (AI on)": FOCUS_SELF_UNDERSTAND_AI,
  "self / declutter": FOCUS_SELF_DECLUTTER,
  "self / understand + declutter": FOCUS_SELF_UNDERSTAND_DECLUTTER,
  "self / minimal": FOCUS_SELF_MINIMAL,
  "self / understand + accessibility": FOCUS_SELF_ACCESSIBILITY,
  "loved_one / understand": FOCUS_LOVED_ONE_UNDERSTAND,
  "loved_one / declutter": FOCUS_LOVED_ONE_DECLUTTER,
  "guardian / understand": FOCUS_GUARDIAN_UNDERSTAND,
  "guardian / declutter": FOCUS_GUARDIAN_DECLUTTER,
  "guardian / minimal": FOCUS_GUARDIAN_MINIMAL,
};
