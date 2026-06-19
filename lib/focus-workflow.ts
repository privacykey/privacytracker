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
 * Infer a workflow only when the existing audience/goals state points at one
 * unambiguously. Someone-else flows need the extra handoff-vs-monitor answer,
 * so they intentionally collapse to custom unless a caller supplies workflow.
 */
export function inferFocusWorkflow(input: FocusWorkflowInput): FocusWorkflow {
  if (input.minimal) {
    return "custom";
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
