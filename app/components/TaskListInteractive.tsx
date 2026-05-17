"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Audience } from "../../lib/feature-flag-rules";
import type { OptInCandidate, ResolvedTask, UserTaskId } from "../../lib/tasks";
import TaskGateModal from "./TaskGateModal";
import { useUserTasks } from "./UserTasksProvider";

/**
 * Client wrapper for the inline tasks panel. Owns:
 *   - the collapsed-chip ↔ expanded-card toggle (per-session UI state)
 *   - click handling per row (start task, route, or open gate modal)
 *   - gate modal mount (focus-trap modal, dismissable)
 *
 * Reads `tasks` from `UserTasksProvider` so mutations from the nav icon
 * surface here without a poll wait. Falls back to `initialTasks` on the
 * first paint before the provider's first fetch resolves.
 */

interface TaskListInteractiveProps {
  audience: Audience;
  initialCandidates: OptInCandidate[];
  initialTasks: ResolvedTask[];
  visibleRows: ResolvedTask[];
}

const STATE_GLYPH: Record<ResolvedTask["state"], string> = {
  ready: "○",
  in_progress: "◐",
  completed: "✓",
  blocked: "🔒",
  dismissed: "–",
};

export default function TaskListInteractive({
  initialTasks,
  initialCandidates,
  audience,
  visibleRows: initialVisibleRows,
}: TaskListInteractiveProps) {
  const t = useTranslations("tasks");
  const tAudience = useTranslations("tasks.audiences");
  const router = useRouter();
  const provider = useUserTasks();

  // Prefer provider state once it's been populated; before that, render
  // from the server-resolved initialTasks so first paint matches the
  // server HTML.
  const tasks = provider.ready ? provider.tasks : initialTasks;

  // Visible rows: include `completed` (we strike them through to show
  // progress); only `dismissed` is hidden — the user explicitly asked
  // for those to go away. Order: open first, completed at the bottom.
  const visibleRows = useMemo(() => {
    const source = provider.ready
      ? tasks.filter((x) => x.state !== "dismissed")
      : initialVisibleRows.filter((x) => x.state !== "dismissed");
    const open: ResolvedTask[] = [];
    const done: ResolvedTask[] = [];
    for (const t of source) {
      (t.state === "completed" ? done : open).push(t);
    }
    return [...open, ...done];
  }, [provider.ready, tasks, initialVisibleRows]);

  // Use provider candidates after first fetch; before that, render from
  // the server-resolved list so the chip tray appears on first paint.
  const candidates = provider.ready ? provider.candidates : initialCandidates;

  // "All settled" = everything is completed AND there's nothing left to
  // opt into. Otherwise we keep the panel expanded so the user can act.
  const allSettled =
    visibleRows.length > 0 &&
    visibleRows.every((r) => r.state === "completed") &&
    candidates.length === 0;

  // Per-session toggle: when the panel is collapsed-as-chip, the user
  // may click to expand. We track that locally — no need to persist.
  const [chipExpanded, setChipExpanded] = useState(false);
  // Reset chip-expansion when we move out of all-settled state (a new
  // task became actionable).
  useEffect(() => {
    if (!allSettled && chipExpanded) {
      setChipExpanded(false);
    }
  }, [allSettled, chipExpanded]);

  const [gateTask, setGateTask] = useState<ResolvedTask | null>(null);
  const [gatePrerequisiteId, setGatePrerequisiteId] =
    useState<UserTaskId | null>(null);

  const handleTaskClick = useCallback(
    async (task: ResolvedTask) => {
      // Completed tasks: navigate without restamping started_at — the
      // user's just revisiting, not re-doing.
      if (task.state === "completed") {
        router.push(task.route);
        return;
      }
      if (task.state === "blocked") {
        const missing = task.prerequisites.find((prereqId) => {
          const prereq = tasks.find((x) => x.id === prereqId);
          return !prereq || prereq.state !== "completed";
        });
        if (missing) {
          setGateTask(task);
          setGatePrerequisiteId(missing);
          return;
        }
      }
      await provider.startTask(task.id);
      router.push(task.route);
    },
    [tasks, provider, router]
  );

  const handleOptIn = useCallback(
    async (id: UserTaskId) => {
      await provider.optInTask(id);
    },
    [provider]
  );

  const handleDismiss = useCallback(
    async (task: ResolvedTask) => {
      await provider.dismissTask(task.id);
    },
    [provider]
  );

  const handleGotoPrereq = useCallback(async () => {
    if (!gatePrerequisiteId) {
      return;
    }
    const prereq = tasks.find((x) => x.id === gatePrerequisiteId);
    setGateTask(null);
    setGatePrerequisiteId(null);
    if (!prereq) {
      return;
    }
    await provider.startTask(prereq.id);
    router.push(prereq.route);
  }, [gatePrerequisiteId, tasks, provider, router]);

  const handleContinueAnyway = useCallback(async () => {
    if (!(gateTask && gatePrerequisiteId)) {
      return;
    }
    const target = gateTask;
    const missing = gatePrerequisiteId;
    setGateTask(null);
    setGatePrerequisiteId(null);
    await provider.startTask(target.id, { missingPrerequisite: missing });
    router.push(target.route);
  }, [gateTask, gatePrerequisiteId, provider, router]);

  const closeGate = useCallback(() => {
    setGateTask(null);
    setGatePrerequisiteId(null);
  }, []);

  // Collapsed-chip path — everything's done AND no opt-in candidates
  // remain. User can click to expand and review the completed list.
  if (allSettled && !chipExpanded) {
    return (
      <button
        aria-label={t("collapsed_chip_aria")}
        className="task-list-chip"
        onClick={() => setChipExpanded(true)}
        type="button"
      >
        <span aria-hidden="true" className="task-list-chip-glyph">
          ✓
        </span>
        <span>{t("collapsed_chip_label")}</span>
      </button>
    );
  }

  return (
    <>
      <header className="task-list-card-header">
        <div className="task-list-card-titles">
          <h2 className="task-list-card-heading" id="task-list-heading">
            {t("heading")}
          </h2>
          <p className="task-list-card-attribution">
            {t("attribution", { audience: tAudience(audience) })}{" "}
            <Link
              aria-label={t("attribution_change_aria")}
              className="task-list-card-attribution-link"
              href="/dashboard/settings/focus"
            >
              {t("attribution_change_label")}
            </Link>
          </p>
        </div>
      </header>
      {visibleRows.length === 0 ? (
        <p className="task-list-empty">{t("empty_all_dismissed")}</p>
      ) : (
        <ul className="task-list-rows">
          {visibleRows.map((task) => (
            <li
              className={`task-list-row task-list-row-${task.state}`}
              key={task.id}
            >
              <button
                className="task-list-row-btn"
                onClick={() => void handleTaskClick(task)}
                type="button"
              >
                <span aria-hidden="true" className="task-list-row-glyph">
                  {STATE_GLYPH[task.state]}
                </span>
                <span className="task-list-row-text">
                  <span className="task-list-row-title">
                    {t(`${task.id}.title`)}
                  </span>
                  <span className="task-list-row-body">
                    {t(`${task.id}.body`)}
                  </span>
                </span>
                <span aria-hidden="true" className="task-list-row-arrow">
                  →
                </span>
              </button>
              {task.state !== "completed" && (
                <button
                  aria-label={t("dismiss_aria", {
                    task: t(`${task.id}.title`),
                  })}
                  className="task-list-row-dismiss"
                  onClick={() => void handleDismiss(task)}
                  type="button"
                >
                  {t("dismiss_action")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <div className="task-list-add-tray">
          <p className="task-list-add-tray-heading">{t("add_tray_heading")}</p>
          <ul className="task-list-add-tray-chips">
            {candidates.map((candidate) => (
              <li className="task-list-add-tray-chip-li" key={candidate.id}>
                <button
                  aria-label={t("add_tray_chip_aria", {
                    title: t(`${candidate.id}.title`),
                  })}
                  className="task-list-add-tray-chip"
                  onClick={() => void handleOptIn(candidate.id)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="task-list-add-tray-chip-plus"
                  >
                    +
                  </span>
                  <span>{t(`${candidate.id}.title`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TaskGateModal
        onCancel={closeGate}
        onContinueAnyway={handleContinueAnyway}
        onGotoPrerequisite={handleGotoPrereq}
        open={Boolean(gateTask && gatePrerequisiteId)}
        prerequisiteId={gatePrerequisiteId}
        task={gateTask}
      />
    </>
  );
}
