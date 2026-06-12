"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { ResolvedTask, UserTaskId } from "../../lib/tasks";

/**
 * Soft-gate modal. Shown when the user clicks a task whose prerequisite
 * isn't completed. Reuses the .modal-overlay/.modal-card chrome already
 * used by 6+ surfaces (delete-confirm, migrate, share, etc).
 *
 * Focus-trap is intentionally minimal: we focus the recommended-first
 * button on open, and Escape cancels. Tab cycles between the two
 * buttons because the modal has no other focusable elements. Restores
 * focus to the previously-focused element on close.
 */

export interface TaskGateModalProps {
  /** Close without taking action (Esc, overlay click, ✕). */
  onCancel: () => void;
  /** Continue-anyway path. */
  onContinueAnyway: () => void;
  /** Take-me-to-prereq path. */
  onGotoPrerequisite: () => void;
  open: boolean;
  /** The first unmet prerequisite — what we recommend doing first. */
  prerequisiteId: UserTaskId | null;
  /** The task the user tried to start. */
  task: ResolvedTask | null;
}

export default function TaskGateModal({
  open,
  task,
  prerequisiteId,
  onGotoPrerequisite,
  onContinueAnyway,
  onCancel,
}: TaskGateModalProps) {
  const t = useTranslations("tasks");
  const tGate = useTranslations("tasks.gate");
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current =
      typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement | null);
    // Defer focus to next tick so the modal is mounted.
    const id = window.setTimeout(() => primaryRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!(open && task && prerequisiteId)) {
    return null;
  }

  // Resolve copy for both the gated task and the missing prereq.
  // The `tasks.<id>.title` lookups exist for every task id.
  const prereqTitle = t(`${prerequisiteId}.title`);
  const taskTitle = t(`${task.id}.title`);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby="task-gate-title"
        aria-modal="true"
        className="modal-card task-gate-modal"
        role="dialog"
      >
        <header className="modal-card-header">
          <h2 id="task-gate-title">{tGate("title")}</h2>
          <button
            aria-label={tGate("close_aria")}
            className="modal-close"
            onClick={onCancel}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="modal-card-body">
          <p>{tGate("body", { prerequisite: prereqTitle, task: taskTitle })}</p>
        </div>
        <footer
          className="modal-card-footer"
          style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
        >
          <button
            className="btn btn-secondary"
            onClick={onContinueAnyway}
            type="button"
          >
            {tGate("secondary")}
          </button>
          {/* Primary stays on the right (app-wide convention) but keeps
              the open-focus ref, so the recommended action is both the
              visually-emphasised and the keyboard-default choice. */}
          <button
            className="btn btn-primary"
            onClick={onGotoPrerequisite}
            ref={primaryRef}
            type="button"
          >
            {tGate("primary", { prerequisite: prereqTitle })}
          </button>
        </footer>
      </div>
    </div>
  );
}
