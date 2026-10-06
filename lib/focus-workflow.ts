import type { Audience } from "./feature-flag-rules";

export const FOCUS_WORKFLOWS = [
  "self_monitor",
  "self_cleanup",
  "other_handoff",
  "other_monitor",
  "custom",
] as const;

export type FocusWorkflow = (typeof FOCUS_WORKFLOWS)[number];

export const DEFAULT_FOCUS_WORKFLOW: FocusWorkflow = "custom";

export function isFocusWorkflow(value: unknown): value is FocusWorkflow {
  return (
    typeof value === "string" &&
    (FOCUS_WORKFLOWS as readonly string[]).includes(value)
  );
}

export interface FocusWorkflowInput {
  audience: Audience;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

/**
 * Helping someone defaults to a one-off review and handoff. An explicitly
 * stored ongoing workflow still wins at the call site.
 */
export function inferFocusWorkflow(input: FocusWorkflowInput): FocusWorkflow {
  if (input.audience === "loved_one") {
    return "other_handoff";
  }
  if (input.audience === "self") {
    if (input.monitor && !input.cleanup) {
      return "self_monitor";
    }
    if (input.cleanup && !input.monitor) {
      return "self_cleanup";
    }
  }
  return "custom";
}

export function workflowAllowsAuditBundle(
  workflow: FocusWorkflow | null | undefined
): boolean {
  return workflow === "other_handoff";
}
