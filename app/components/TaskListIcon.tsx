"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResolvedTask, UserTaskId } from "../../lib/tasks";
import TaskGateModal from "./TaskGateModal";
import { useUserTasks } from "./UserTasksProvider";
import "./task-list.css";

/**
 * Persistent ✓ checklist icon in the top-right of the nav. Mirrors the
 * NotificationBell pattern: aria-haspopup="dialog", aria-expanded,
 * outside-click + Escape close. On viewports ≤640px the dropdown
 * switches to a bottom-sheet variant so phone users have room to read.
 */

const MOBILE_QUERY = "(max-width: 640px)";

export default function TaskListIcon() {
  const t = useTranslations("tasks");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const { tasks, ready, startTask } = useUserTasks();

  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Gate-modal state stays local to the icon — the inline panel owns
  // its own copy. Both surfaces can't be interacted with simultaneously,
  // so a shared instance would add lifting cost for no user-visible win.
  const [gateTask, setGateTask] = useState<ResolvedTask | null>(null);
  const [gatePrerequisiteId, setGatePrerequisiteId] =
    useState<UserTaskId | null>(null);

  // Track mobile vs desktop via matchMedia. Updates on resize so an
  // orientation flip or window resize swaps dropdown ↔ bottom-sheet.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia(MOBILE_QUERY);
    const apply = () => setIsMobile(mql.matches);
    apply();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
  }, []);

  // Outside-click close. Bottom-sheet has its own overlay click handler
  // because the wrapper sits behind it — desktop dropdown closes via
  // wrap-ref miss.
  useEffect(() => {
    if (!open || isMobile) {
      return;
    }
    // `pointerdown` (not `mousedown`) so the close-on-outside-tap path
    // works on iOS Safari. Mobile Safari's synthetic `mousedown` from
    // touch input is unreliable on interactive trigger buttons, which
    // left popovers visually broken on iPhone. Pointer events fire
    // consistently for touch + mouse + pen on every modern browser.
    const handler = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open, isMobile]);

  // Escape closes either variant.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Compact view: hide only dismissed. Completed rows stay visible so
  // the user sees their progress (strike-through + ✓), with open tasks
  // first and completed at the bottom.
  const visible = useMemo(() => {
    const kept = tasks.filter((t) => t.state !== "dismissed");
    const open: typeof kept = [];
    const done: typeof kept = [];
    for (const t of kept) {
      (t.state === "completed" ? done : open).push(t);
    }
    return [...open, ...done];
  }, [tasks]);

  const readyCount = useMemo(
    () =>
      tasks.filter((t) => t.state === "ready" || t.state === "in_progress")
        .length,
    [tasks]
  );

  const handleTaskClick = useCallback(
    async (task: ResolvedTask) => {
      if (task.state === "completed") {
        setOpen(false);
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
      // Ready, in_progress, or no unmet prereq → go.
      await startTask(task.id);
      setOpen(false);
      router.push(task.route);
    },
    [tasks, startTask, router]
  );

  const handleGotoPrereq = useCallback(async () => {
    if (!gatePrerequisiteId) {
      return;
    }
    const prereq = tasks.find((t) => t.id === gatePrerequisiteId);
    if (!prereq) {
      return;
    }
    setGateTask(null);
    setGatePrerequisiteId(null);
    setOpen(false);
    await startTask(prereq.id);
    router.push(prereq.route);
  }, [gatePrerequisiteId, tasks, startTask, router]);

  const handleContinueAnyway = useCallback(async () => {
    if (!(gateTask && gatePrerequisiteId)) {
      return;
    }
    const target = gateTask;
    const missing = gatePrerequisiteId;
    setGateTask(null);
    setGatePrerequisiteId(null);
    setOpen(false);
    await startTask(target.id, { missingPrerequisite: missing });
    router.push(target.route);
  }, [gateTask, gatePrerequisiteId, startTask, router]);

  const closeGate = useCallback(() => {
    setGateTask(null);
    setGatePrerequisiteId(null);
  }, []);

  // No tasks ever resolved — hide the icon entirely. Avoids surfacing an
  // empty dropdown on an account that for some reason has no visible
  // tasks (e.g. all hard-gated off).
  if (ready && tasks.length === 0) {
    return null;
  }

  // Dim the icon when everything in the panel is completed (the badge
  // count already handles "0 pending" by going to undefined, but the
  // glyph itself can also signal "nothing left to do" with a softer fill).
  const allDone =
    ready &&
    visible.length > 0 &&
    visible.every((t) => t.state === "completed");

  return (
    <>
      <div className="task-list-icon-wrap" ref={wrapRef}>
        <button
          aria-controls="task-list-dropdown"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={tNav("tasks_icon_aria", { count: readyCount })}
          className={`task-list-icon-btn${allDone ? " is-all-done" : ""}`}
          onClick={() => setOpen((v) => !v)}
          ref={buttonRef}
          type="button"
        >
          <span aria-hidden="true" className="task-list-icon-glyph">
            ✓
          </span>
          {readyCount > 0 && (
            <span aria-hidden="true" className="task-list-icon-badge">
              {readyCount}
            </span>
          )}
        </button>

        {open && !isMobile && (
          <div
            aria-label={t("region_aria")}
            className="task-list-dropdown"
            id="task-list-dropdown"
            role="dialog"
          >
            <TaskListDropdownContent
              allDone={allDone}
              onTaskClick={handleTaskClick}
              tasks={visible}
            />
          </div>
        )}
      </div>

      {open &&
        isMobile &&
        typeof document !== "undefined" &&
        // Portal the sheet overlay out of the nav. The nav uses
        // `backdrop-filter`, which per CSS spec makes it the
        // containing block for *every* `position: fixed` descendant
        // — so the sheet's `inset: 0` was being clipped to the nav's
        // own ~56px-tall box instead of the viewport, leaving only
        // the bottom-aligned Done button visible on iPhone. Mounting
        // at document.body breaks that ancestry and lets the overlay
        // fill the actual viewport. Same trick applies to any future
        // full-screen overlay rendered from inside a backdrop-filter
        // ancestor.
        createPortal(
          <div
            className="task-list-sheet-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setOpen(false);
              }
            }}
            role="presentation"
          >
            <div
              aria-label={t("region_aria")}
              className="task-list-sheet"
              id="task-list-dropdown"
              role="dialog"
            >
              <div aria-hidden="true" className="task-list-sheet-handle" />
              <TaskListDropdownContent
                allDone={allDone}
                onTaskClick={handleTaskClick}
                tasks={visible}
              />
              <div className="task-list-sheet-footer">
                <button
                  className="btn btn-secondary"
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  {t("sheet_done")}
                </button>
              </div>
            </div>
          </div>,
          document.body
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

interface TaskListDropdownContentProps {
  allDone: boolean;
  onTaskClick: (task: ResolvedTask) => void;
  tasks: ResolvedTask[];
}

function TaskListDropdownContent({
  tasks,
  allDone,
  onTaskClick,
}: TaskListDropdownContentProps) {
  const t = useTranslations("tasks");
  if (allDone) {
    return (
      <div className="task-list-empty">
        <p>{t("all_done_short")}</p>
      </div>
    );
  }
  return (
    <ul className="task-list-rows">
      {tasks.map((task) => (
        <TaskRow key={task.id} onClick={() => onTaskClick(task)} task={task} />
      ))}
    </ul>
  );
}

const STATE_GLYPH: Record<ResolvedTask["state"], string> = {
  ready: "○",
  in_progress: "◐",
  completed: "✓",
  blocked: "🔒",
  dismissed: "–",
};

function TaskRow({
  task,
  onClick,
}: {
  task: ResolvedTask;
  onClick: () => void;
}) {
  const t = useTranslations("tasks");
  return (
    <li className={`task-list-row task-list-row-${task.state}`}>
      <button className="task-list-row-btn" onClick={onClick} type="button">
        <span aria-hidden="true" className="task-list-row-glyph">
          {STATE_GLYPH[task.state]}
        </span>
        <span className="task-list-row-text">
          <span className="task-list-row-title">{t(`${task.id}.title`)}</span>
          <span className="task-list-row-body">{t(`${task.id}.body`)}</span>
        </span>
        <span aria-hidden="true" className="task-list-row-arrow">
          →
        </span>
      </button>
    </li>
  );
}
