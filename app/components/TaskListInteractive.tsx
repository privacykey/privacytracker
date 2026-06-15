"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Audience } from "../../lib/feature-flag-rules";
import type { OptInCandidate, ResolvedTask, UserTaskId } from "../../lib/tasks";
import TaskDiorama, { DIORAMA_TASK_IDS } from "./TaskDiorama";
import TaskGateModal from "./TaskGateModal";
import UserTasksMutationAlert from "./UserTasksMutationAlert";
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
  /** Journey-strip vs legacy flat-list rendering — see TaskList. */
  variant?: "journey" | "list";
  visibleRows: ResolvedTask[];
}

/* Collapsed glyph alphabet: done / not-done is the only distinction a
 * row needs to carry visually. `blocked` deliberately renders like
 * `ready` — the gate modal explains the prerequisite when clicked,
 * and a padlock on a first-run surface punished exploration. */
const STATE_GLYPH: Record<ResolvedTask["state"], string> = {
  ready: "○",
  in_progress: "○",
  completed: "✓",
  blocked: "○",
  dismissed: "–",
};

export default function TaskListInteractive({
  initialTasks,
  initialCandidates,
  audience,
  variant = "list",
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

  // The first actionable row that ships an inline diorama gets the at-rest
  // "start here" breathing cue. Scoped to diorama rows (not just the first
  // actionable row overall) so the cue is visible while only some rows have
  // dioramas — once every row has one this converges to "first actionable
  // row".
  const recommendedDioramaId = useMemo(() => {
    const first = visibleRows.find(
      (r) =>
        (r.state === "ready" || r.state === "in_progress") &&
        DIORAMA_TASK_IDS.has(r.id)
    );
    return first?.id ?? null;
  }, [visibleRows]);

  // Use provider candidates after first fetch; before that, render from
  // the server-resolved list so the chip tray appears on first paint.
  const candidates = provider.ready ? provider.candidates : initialCandidates;

  // Journey-mode partition, in TASK_DEFS order (NOT the open-first sort
  // above — the strip's geometry is the sequence). Core tasks
  // (optedInAt == null) are the path; opted-in extras render as rows
  // under the "more things" tray.
  const journeySource = provider.ready ? tasks : initialTasks;
  const journeySteps = useMemo(
    () =>
      journeySource.filter(
        (x) => x.state !== "dismissed" && x.optedInAt == null
      ),
    [journeySource]
  );
  const journeyExtras = useMemo(
    () =>
      journeySource.filter(
        (x) => x.state !== "dismissed" && x.optedInAt != null
      ),
    [journeySource]
  );
  const currentIdx = journeySteps.findIndex((x) => x.state !== "completed");
  const doneCount = journeySteps.filter((x) => x.state === "completed").length;
  const anyCompleted = journeySource.some((x) => x.state === "completed");

  // Tick-pop choreography: a step that flips to completed DURING this
  // session gets a one-shot pop animation. First paint never pops —
  // returning users shouldn't see their old progress re-celebrate.
  const prevCompletedRef = useRef<Set<UserTaskId> | null>(null);
  const [poppedIds, setPoppedIds] = useState<ReadonlySet<UserTaskId>>(
    new Set()
  );
  useEffect(() => {
    const completedNow = new Set(
      tasks.filter((x) => x.state === "completed").map((x) => x.id)
    );
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completedNow;
    if (!prev) {
      return;
    }
    const fresh = [...completedNow].filter((id) => !prev.has(id));
    if (fresh.length === 0) {
      return;
    }
    setPoppedIds(new Set(fresh));
    const timer = window.setTimeout(() => setPoppedIds(new Set()), 700);
    return () => window.clearTimeout(timer);
  }, [tasks]);

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
          return prereq?.state !== "completed";
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

  const renderRow = (task: ResolvedTask) => (
    <li className={`task-list-row task-list-row-${task.state}`} key={task.id}>
      <button
        className="task-list-row-btn"
        onClick={() => void handleTaskClick(task)}
        type="button"
      >
        {DIORAMA_TASK_IDS.has(task.id) ? (
          <TaskDiorama
            id={task.id}
            recommended={task.id === recommendedDioramaId}
            state={task.state}
          />
        ) : (
          <span aria-hidden="true" className="task-list-row-glyph">
            {STATE_GLYPH[task.state]}
          </span>
        )}
        <span className="task-list-row-text">
          <span className="task-list-row-title">{t(`${task.id}.title`)}</span>
          <span className="task-list-row-body">{t(`${task.id}.body`)}</span>
        </span>
        <span aria-hidden="true" className="task-list-row-arrow">
          →
        </span>
      </button>
      {task.state !== "completed" && (
        <button
          aria-label={t("dismiss_aria", { task: t(`${task.id}.title`) })}
          className="task-list-row-dismiss"
          onClick={() => void handleDismiss(task)}
          type="button"
        >
          {t("dismiss_action")}
        </button>
      )}
    </li>
  );

  const renderChips = () => (
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
            <span aria-hidden="true" className="task-list-add-tray-chip-plus">
              +
            </span>
            <span>{t(`${candidate.id}.title`)}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  const headerEl = (progress: { done: number; total: number } | null) => (
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
      {progress && progress.total > 0 && (
        <span className="task-list-progress-pill">
          {t("journey.progress", progress)}
        </span>
      )}
    </header>
  );

  // The opt-in tray waits until the user has completed at least one
  // task — asking a brand-new user "what else do you want to do?"
  // before they've done anything was part of why the panel read as a
  // chore list. Already-opted-in extras always stay visible.
  const trayChipsVisible = candidates.length > 0 && anyCompleted;

  if (variant === "journey") {
    const current = currentIdx >= 0 ? journeySteps[currentIdx] : null;
    const showExtras = journeyExtras.length > 0 || trayChipsVisible;
    return (
      <>
        {headerEl({ done: doneCount, total: journeySteps.length })}
        <UserTasksMutationAlert />
        {journeySteps.length === 0 ? (
          <p className="task-list-empty">{t("empty_all_dismissed")}</p>
        ) : (
          <>
            <ol
              aria-label={t("journey.strip_aria")}
              className="task-journey-strip"
            >
              {journeySteps.map((task, i) => (
                <li className="task-journey-step" key={task.id}>
                  {i > 0 && (
                    <span
                      aria-hidden="true"
                      className={`task-journey-seg${
                        journeySteps[i - 1].state === "completed"
                          ? " is-filled"
                          : ""
                      }`}
                    >
                      <span className="task-journey-seg-fill" />
                    </span>
                  )}
                  <button
                    aria-current={i === currentIdx ? "step" : undefined}
                    aria-label={t(`${task.id}.title`)}
                    className={`task-journey-node${
                      task.state === "completed" ? " is-done" : ""
                    }${i === currentIdx ? " is-current" : ""}${
                      poppedIds.has(task.id) ? " is-popped" : ""
                    }`}
                    onClick={() => void handleTaskClick(task)}
                    title={t(`${task.id}.title`)}
                    type="button"
                  >
                    {task.state === "completed" ? "✓" : i + 1}
                  </button>
                </li>
              ))}
            </ol>
            {current && (
              <div className="task-journey-detail" key={current.id}>
                <div className="task-journey-detail-main">
                  {DIORAMA_TASK_IDS.has(current.id) && (
                    <TaskDiorama
                      id={current.id}
                      recommended={false}
                      state={current.state}
                    />
                  )}
                  <div className="task-journey-detail-text">
                    <p className="task-journey-detail-title">
                      {t(`${current.id}.title`)}
                    </p>
                    <p className="task-journey-detail-body">
                      {t(`${current.id}.body`)}
                    </p>
                  </div>
                </div>
                <div className="task-journey-detail-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleTaskClick(current)}
                    type="button"
                  >
                    {t("journey.cta")}
                  </button>
                  <button
                    className="task-journey-skip"
                    onClick={() => void handleDismiss(current)}
                    type="button"
                  >
                    {t("journey.skip")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {showExtras && (
          <div className="task-list-add-tray">
            <p className="task-list-add-tray-heading">
              {t("add_tray_heading")}
            </p>
            {journeyExtras.length > 0 && (
              <ul className="task-list-rows task-journey-extras">
                {journeyExtras.map(renderRow)}
              </ul>
            )}
            {trayChipsVisible && renderChips()}
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

  return (
    <>
      {headerEl({ done: doneCount, total: journeySteps.length })}
      <UserTasksMutationAlert />
      {visibleRows.length === 0 ? (
        <p className="task-list-empty">{t("empty_all_dismissed")}</p>
      ) : (
        <ul className="task-list-rows">{visibleRows.map(renderRow)}</ul>
      )}

      {trayChipsVisible && (
        <div className="task-list-add-tray">
          <p className="task-list-add-tray-heading">{t("add_tray_heading")}</p>
          {renderChips()}
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
