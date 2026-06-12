"use client";

import { useTranslations } from "next-intl";
import type { ResolvedTask, UserTaskId } from "../../lib/tasks";
import { useModalFocus } from "../../lib/use-modal-focus";

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
  const modalCardRef = useModalFocus<HTMLDivElement>({
    open,
    onClose: onCancel,
    closeOnEscape: true,
  });

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
        ref={modalCardRef}
        role="dialog"
        tabIndex={-1}
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
        <footer className="modal-card-footer">
          <button
            className="btn btn-primary"
            onClick={onGotoPrerequisite}
            type="button"
          >
            {tGate("primary", { prerequisite: prereqTitle })}
          </button>
          <button
            className="btn btn-secondary"
            onClick={onContinueAnyway}
            type="button"
          >
            {tGate("secondary")}
          </button>
        </footer>
      </div>
    </div>
  );
}
