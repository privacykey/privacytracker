"use client";

import type { OptInCandidate, ResolvedTask } from "../../lib/tasks";
import TaskListInteractive from "./TaskListInteractive";
import { useUserTasks } from "./UserTasksProvider";
import "./task-list.css";

/**
 * Inline tasks panel — first child of HomeView.
 *
 * Rust-core Phase 0: this was a server component that resolved its rows
 * with lib/tasks-server and was handed into the client HomeView as a
 * ReactNode slot. It now reads the UserTasksProvider that app/layout.tsx
 * already mounts (it polls /api/user-tasks every 60s), so the dashboard
 * shell needs no task fetch of its own.
 *
 * It renders nothing until the provider reports `ready`: `audience` is
 * derived from tasks[0], so painting before the data lands would show
 * "self" copy to a guardian for a frame and — because
 * TaskListInteractive seeds its state from these props at mount — keep
 * showing it. Callers may still seed `tasks` / `candidates` directly
 * (Storybook does); that path skips the provider entirely.
 *
 * Returns null when there's nothing to show — neither active/completed
 * tasks nor opt-in candidates. The chip tray surfaces extras even when
 * the auto-included task list is empty.
 */

interface TaskListProps {
  /** Seed opt-in candidates; omit to read the provider. */
  candidates?: OptInCandidate[];
  /** Seed tasks; omit to read the provider. */
  tasks?: ResolvedTask[];
  /** Journey-strip vs legacy flat-list rendering. Resolved from
   *  `flag.dashboard.task_journey` by the dashboard loader; defaults to
   *  the legacy list so non-dashboard callers are unaffected. */
  variant?: "journey" | "list";
}

export default function TaskList({
  tasks: tasksProp,
  candidates: candidatesProp,
  variant = "list",
}: TaskListProps) {
  const provider = useUserTasks();
  const seeded = tasksProp !== undefined || candidatesProp !== undefined;
  const tasks = tasksProp ?? provider.tasks;
  const candidates = candidatesProp ?? provider.candidates;

  if (!(seeded || provider.ready)) {
    return null;
  }
  if (tasks.length === 0 && candidates.length === 0) {
    return null;
  }

  const audience = tasks[0]?.audience ?? "self";
  // Everything that's not dismissed. Completed rows stay visible so
  // users see progress (CSS strikes the title through and the glyph
  // flips to ✓).
  const visibleRows = tasks.filter((x) => x.state !== "dismissed");

  return (
    <section
      aria-labelledby="task-list-heading"
      className="task-list-card"
      data-tour="task-list"
    >
      <TaskListInteractive
        audience={audience}
        initialCandidates={candidates}
        initialTasks={tasks}
        variant={variant}
        visibleRows={visibleRows}
      />
    </section>
  );
}
