"use client";

/**
 * Task Center
 *
 * Global, layout-level context + dropdown menu in the nav bar that tracks
 * every long-running action the user kicks off (sync all, re-sync app,
 * regenerate a privacy policy, bulk policy regeneration). Because the context
 * lives in the root layout it survives in-app navigation, so:
 *
 *   - A user can kick off a re-sync on the App Detail page, navigate to
 *     Privacy Map, and still see the spinner + cancel button in the nav.
 *   - Each task carries its own AbortController (or custom cancel hook),
 *     surfaced in the menu so the user can stop it from anywhere.
 *
 * A few things to note:
 *   - Tasks kicked off from a page that runs the work *inside* its own
 *     component (e.g. OnboardWizard's per-app loop) will pause/abort if that
 *     page unmounts — they're only persistent if the caller uses
 *     `runBackgroundFetch` from here, which keeps the fetch promise alive in
 *     the context itself.
 *   - Finished tasks auto-dismiss after AUTO_DISMISS_MS. The user can pin by
 *     clearing them manually; we also keep the last MAX_RECENT regardless so
 *     they can scroll back a little.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFlag } from "../../lib/feature-flags-hooks";

type TaskKind = "sync" | "scrape" | "policy" | "import" | "other";
export type TaskStatus = "running" | "done" | "error" | "cancelled";

/**
 * Shape returned by GET /api/sync/status. We only need the subset the
 * Task Center cares about (schedule + next run timestamp + currently-running
 * flag). `nextRun` is a wall-clock ms timestamp, or null when the user has
 * the sync set to "manual".
 */
interface SchedulerStatus {
  isDue: boolean;
  isRunning: boolean;
  lastRun: number;
  nextRun: number | null;
  schedule: "manual" | "daily" | "weekly";
}

// Lightweight background poll for the scheduler. 60s resolution is plenty
// for a "next sync in …" countdown — the row itself ticks at 1s cadence
// off the wall clock, so we only need the server fetch to correct drift
// and catch schedule changes the user made in Settings.
const SCHEDULER_POLL_MS = 60_000;

// Tighter cadence for /api/tasks/active so a resumed run feels live. 4s
// is slow enough that the poll itself is negligible cost (three tiny
// SELECTs server-side), fast enough that the progress counter doesn't
// look stuck.
const ACTIVE_TASKS_POLL_MS = 4000;

interface ActiveJobView {
  currentAppName: string | null;
  initiator: "manual" | "scheduled" | "automatic" | "resume" | null;
  mutexHeld: boolean;
  runId: string | null;
  running: boolean;
  stale: boolean;
  startedAt: number | null;
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    done: number;
    failed: number;
    remaining: number;
  } | null;
  updatedAt: number | null;
}

interface ActiveTasksResponse {
  policy: ActiveJobView;
  policyRuns?: ActivePolicyRunView[];
  sync: ActiveJobView;
  wayback: ActiveJobView;
}

interface ActivePolicyRunView {
  appId: string;
  appName: string | null;
  lastPhase: string | null;
  lastPhaseNote: string | null;
  runStartedAt: number | null;
  updatedAt: number | null;
}

type ServerJobKey = "wayback" | "sync" | "policy";

const SERVER_JOB_KIND: Record<ServerJobKey, TaskKind> = {
  wayback: "import",
  sync: "sync",
  policy: "policy",
};

const SERVER_JOB_HREF: Record<ServerJobKey, string> = {
  wayback: "/dashboard/settings#import-history",
  sync: "/dashboard/settings#sync-schedule",
  policy: "/dashboard/settings#privacy-policies-bulk",
};

export interface TaskProgress {
  current: number;
  label?: string;
  total: number;
}

export interface Task {
  endedAt?: number;
  /** Optional link to the page that kicked the task off. */
  href?: string;
  id: string;
  kind: TaskKind;
  /** Human-readable error/result message, shown in the menu row. */
  message?: string;
  progress?: TaskProgress;
  startedAt: number;
  status: TaskStatus;
  subtitle?: string;
  title: string;
}

export interface TaskHandle {
  complete(status: "done" | "error" | "cancelled", message?: string): void;
  id: string;
  setProgress(current: number, total: number, label?: string): void;
  update(patch: Partial<Omit<Task, "id" | "startedAt">>): void;
}

interface StartTaskInit {
  href?: string;
  kind?: TaskKind;
  /** Called when the user clicks Cancel. Should stop the work. */
  onCancel?: () => void;
  progress?: TaskProgress;
  subtitle?: string;
  title: string;
}

interface RunBackgroundFetchInit {
  href?: string;
  init?: RequestInit;
  kind?: TaskKind;
  /** Lets the caller post-process the response into a progress update or final message. */
  onResponse?: (res: Response) => Promise<{ message?: string } | undefined>;
  subtitle?: string;
  title: string;
  url: string;
}

interface TaskCenterApi {
  cancelTask(id: string): void;
  clearCompleted(): void;
  dismissTask(id: string): void;
  /**
   * Force an immediate re-fetch of /api/sync/status. Call this after any
   * user action that changes the scheduler (saving a new schedule in
   * Settings, or triggering a manual sync) so the countdown row updates
   * right away instead of waiting up to 60 s for the next background poll.
   * Safe to await or fire-and-forget — the provider swallows fetch errors
   * and keeps the last good status on failure.
   */
  refreshScheduler(): Promise<void>;
  /**
   * Convenience: fire a single `fetch` whose lifecycle is owned by the
   * context, so the request survives the caller component unmounting.
   */
  runBackgroundFetch(init: RunBackgroundFetchInit): TaskHandle;
  runningCount: number;
  /**
   * Latest known scheduler state (schedule, next run wall-clock, etc.).
   * `null` until the first poll succeeds — treat that as "unknown" in the UI
   * rather than "manual".
   */
  schedulerStatus: SchedulerStatus | null;
  startTask(init: StartTaskInit): TaskHandle;
  tasks: Task[];
}

const TaskCenterContext = createContext<TaskCenterApi | null>(null);

const MAX_RECENT = 20;
const AUTO_DISMISS_MS = 15_000;

// Internal: store cancel handlers separately from the rendered task state so
// we don't accidentally include non-serialisable values in the task list.
type CancelMap = Map<string, () => void>;

export function TaskCenterProvider({
  children,
  pollingEnabled = true,
  autoDismissEnabled = true,
  resumeCardsEnabled = true,
}: {
  children: ReactNode;
  /**
   * Round 3 wave G: when false the 4-second `/api/tasks/active` poll is
   * skipped — the provider still tracks manually-started tasks but won't
   * surface server-side resumed runs as TaskCenter rows. Default true.
   * Driven by `flag.taskcenter.polling`.
   */
  pollingEnabled?: boolean;
  /**
   * Round 3 wave I: when false a finished/cancelled row sticks around in
   * the dropdown forever (until the user explicitly dismisses it). Default
   * true. Driven by `flag.taskcenter.auto_dismiss`.
   */
  autoDismissEnabled?: boolean;
  /**
   * Round 3 wave I: when false the poll still happens (so the existing
   * scheduler row keeps refreshing) but no resume-after-restart cards are
   * minted. Default true. Driven by `flag.taskcenter.resume_cards`.
   */
  resumeCardsEnabled?: boolean;
}) {
  const t = useTranslations("task_center");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [schedulerStatus, setSchedulerStatus] =
    useState<SchedulerStatus | null>(null);
  const cancelHandlers = useRef<CancelMap>(new Map());
  const dismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const tasksRef = useRef<Task[]>([]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // `mounted` lets the async fetch below short-circuit state updates if
  // the provider unmounts mid-flight (React dev strict-mode + hot reload
  // routinely do this). Kept as a ref rather than a `cancelled` local so
  // the same guard works for both the periodic poll and the public
  // refreshScheduler() entry point below.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hoisted out of the poll effect so user-triggered refreshes (e.g.
  // Settings save) can reuse the same fetch + state-update path. Swallows
  // errors so a flaky network can't throw — callers don't need to handle
  // failure, we just keep the last good status.
  const refreshScheduler = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as SchedulerStatus;
      if (mountedRef.current) {
        setSchedulerStatus(body);
      }
    } catch (err) {
      // Network hiccups are expected (e.g. while the dev server reloads).
      // Keep the last good status rather than clobbering it.
      console.warn("[tasks] Scheduler status fetch failed:", err);
    }
  }, []);

  // Background poll for the sync scheduler so the nav dropdown can surface
  // an "upcoming sync" row with a live countdown. We poll on mount and every
  // SCHEDULER_POLL_MS thereafter; the row's countdown ticks off wall-clock
  // time between polls so we don't need a high-frequency server fetch. The
  // public refreshScheduler() above covers the "user just changed the
  // schedule" case where 60 s of staleness would be noticeable.
  useEffect(() => {
    refreshScheduler();
    const timer = setInterval(refreshScheduler, SCHEDULER_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshScheduler]);

  // Surface server-driven bulk runs (wayback / sync / policy) the user's
  // session didn't kick off. Filters to `initiator === 'resume'` so manual
  // runs don't get a duplicate card (the calling UI already owns those via
  // startTask). The actual poll callback is declared after startTask below.
  const serverTasksRef = useRef<
    Map<ServerJobKey, { handle: TaskHandle; runId: string }>
  >(new Map());
  const policyRunTasksRef = useRef<Map<string, TaskHandle>>(new Map());

  const scheduleAutoDismiss = useCallback(
    (id: string) => {
      // Wave I: when auto-dismiss is gated off, finished rows stay pinned
      // until the user dismisses them. Clear any existing timer first so a
      // mid-flight toggle from on→off cancels the pending removal.
      const existing = dismissTimers.current.get(id);
      if (existing) {
        clearTimeout(existing);
      }
      if (!autoDismissEnabled) {
        dismissTimers.current.delete(id);
        return;
      }
      const timer = setTimeout(() => {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        dismissTimers.current.delete(id);
      }, AUTO_DISMISS_MS);
      dismissTimers.current.set(id, timer);
    },
    [autoDismissEnabled]
  );

  const startTask = useCallback(
    (init: StartTaskInit): TaskHandle => {
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const task: Task = {
        id,
        title: init.title,
        subtitle: init.subtitle,
        kind: init.kind ?? "other",
        href: init.href,
        progress: init.progress,
        status: "running",
        startedAt: Date.now(),
      };

      if (init.onCancel) {
        cancelHandlers.current.set(id, init.onCancel);
      }

      setTasks((prev) => {
        const next = [task, ...prev];
        if (next.length > MAX_RECENT) {
          return next.slice(0, MAX_RECENT);
        }
        return next;
      });

      const update: TaskHandle["update"] = (patch) => {
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
        );
      };

      const setProgress: TaskHandle["setProgress"] = (
        current,
        total,
        label
      ) => {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, progress: { current, total, label } } : t
          )
        );
      };

      const complete: TaskHandle["complete"] = (status, message) => {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status,
                  endedAt: Date.now(),
                  message: message ?? t.message,
                }
              : t
          )
        );
        cancelHandlers.current.delete(id);
        // Successful and errored tasks now stick around in the "Recent" section
        // so the user can see what the system has been up to. The MAX_RECENT
        // cap in startTask() keeps the list from growing unbounded, and the
        // "Clear finished" button lets the user tidy up when they want to.
        // Only cancelled tasks still auto-dismiss — cancelling is explicitly
        // "I didn't want this; get it off my screen".
        if (status === "cancelled") {
          scheduleAutoDismiss(id);
        }
      };

      return { id, update, setProgress, complete };
    },
    [scheduleAutoDismiss]
  );

  const cancelTask = useCallback(
    (id: string) => {
      const handler = cancelHandlers.current.get(id);
      cancelHandlers.current.delete(id);
      try {
        handler?.();
      } catch (error) {
        /* Still mark cancelled below, but surface the handler's error in devtools. */
        console.warn(`[tasks] Cancel handler for ${id} threw:`, error);
      }
      setTasks((prev) =>
        prev.map((item) =>
          item.id === id && item.status === "running"
            ? {
                ...item,
                status: "cancelled",
                endedAt: Date.now(),
                message: t("msg_cancelled"),
              }
            : item
        )
      );
      scheduleAutoDismiss(id);
    },
    [scheduleAutoDismiss, t]
  );

  const dismissTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    const timer = dismissTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    dismissTimers.current.delete(id);
    cancelHandlers.current.delete(id);
  }, []);

  const clearCompleted = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === "running"));
  }, []);

  const runBackgroundFetch = useCallback(
    (init: RunBackgroundFetchInit): TaskHandle => {
      const controller = new AbortController();
      const handle = startTask({
        title: init.title,
        subtitle: init.subtitle,
        kind: init.kind ?? "other",
        href: init.href,
        onCancel: () => controller.abort(),
      });

      (async () => {
        try {
          const res = await fetch(init.url, {
            ...init.init,
            signal: controller.signal,
          });
          if (!res.ok) {
            let message = `Failed (${res.status})`;
            try {
              const body = await res.json();
              if (typeof body?.error === "string") {
                message = body.error;
              }
            } catch (error) {
              /* response body wasn't JSON — surface once in devtools */
              console.warn("[tasks] Non-JSON error body:", error);
            }
            handle.complete("error", message);
            return;
          }
          if (init.onResponse) {
            const outcome = await init.onResponse(res);
            handle.complete("done", outcome?.message);
          } else {
            handle.complete("done");
          }
        } catch (err) {
          // Abort comes through as DOMException name 'AbortError' — that's
          // already handled by cancelTask which sets status='cancelled'.
          if ((err as Error)?.name === "AbortError") {
            return;
          }
          console.error(
            `[tasks] Background fetch for "${init.title}" failed:`,
            err
          );
          handle.complete(
            "error",
            (err as Error)?.message ?? t("msg_unknown_error")
          );
        }
      })();

      return handle;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [startTask]
  );

  // Poll /api/tasks/active and surface any resumed bulk run as a TaskCenter
  // row. Only creates a card for `initiator === 'resume'` — manual runs are
  // owned by the calling UI (SettingsView) via its own startTask() handle,
  // so filtering prevents duplicate cards.
  const pollActiveTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/active", { cache: "no-store" });
      if (!(res.ok && mountedRef.current)) {
        return;
      }
      const body = (await res.json()) as ActiveTasksResponse;
      const jobs: [ServerJobKey, ActiveJobView][] = [
        ["wayback", body.wayback],
        ["sync", body.sync],
        ["policy", body.policy],
      ];
      for (const [jobKey, job] of jobs) {
        const existing = serverTasksRef.current.get(jobKey);

        // Nothing running or run blob already cleared → complete any
        // tracked task for this job and move on.
        if (!(job.running && job.runId)) {
          if (existing) {
            existing.handle.complete("done");
            serverTasksRef.current.delete(jobKey);
          }
          continue;
        }

        const hasLocalTask = tasksRef.current.some(
          (task) =>
            task.status === "running" && task.href === SERVER_JOB_HREF[jobKey]
        );

        // Show resumed jobs even after a reload. Also show manual policy
        // batches when there is no local SettingsView-owned task (e.g. the
        // user refreshed or opened a second tab mid-run). This keeps bulk
        // re-summarise visible without duplicating the task that launched it.
        const shouldSurface =
          (job.initiator === "resume" && resumeCardsEnabled) ||
          (jobKey === "policy" && job.initiator === "manual" && !hasLocalTask);
        if (!shouldSurface) {
          continue;
        }

        // Run boundary — a different runId means the previous one ended
        // and a new one started between polls. Close the old card first.
        if (existing && existing.runId !== job.runId) {
          existing.handle.complete("done");
          serverTasksRef.current.delete(jobKey);
        }

        const done = job.summary?.done ?? 0;
        const total = job.summary?.total ?? 0;
        const label = job.currentAppName ?? undefined;

        if (serverTasksRef.current.has(jobKey)) {
          const current = serverTasksRef.current.get(jobKey)!;
          current.handle.setProgress(done, total, label);
        } else {
          const handle = startTask({
            title: t(`kind_${jobKey}`),
            subtitle: t("subtitle_resumed"),
            kind: SERVER_JOB_KIND[jobKey],
            href: SERVER_JOB_HREF[jobKey],
            progress: { current: done, total, label },
          });
          serverTasksRef.current.set(jobKey, { handle, runId: job.runId });
        }
      }

      const activePolicyRuns = Array.isArray(body.policyRuns)
        ? body.policyRuns
        : [];
      const activePolicyIds = new Set(activePolicyRuns.map((run) => run.appId));
      for (const [appId, handle] of policyRunTasksRef.current.entries()) {
        if (!activePolicyIds.has(appId)) {
          handle.complete("done");
          policyRunTasksRef.current.delete(appId);
        }
      }

      for (const run of activePolicyRuns) {
        const href = `/apps/${run.appId}`;
        const localDuplicate = tasksRef.current.some(
          (task) =>
            task.status === "running" &&
            task.kind === "policy" &&
            task.href === href
        );
        if (localDuplicate && !policyRunTasksRef.current.has(run.appId)) {
          continue;
        }

        const subtitle = run.appName
          ? run.lastPhase
            ? `${run.appName} · ${run.lastPhaseNote || run.lastPhase}`.slice(
                0,
                120
              )
            : run.appName
          : run.lastPhaseNote || run.lastPhase || "Running";

        if (policyRunTasksRef.current.has(run.appId)) {
          policyRunTasksRef.current.get(run.appId)!.update({ subtitle });
        } else {
          const handle = startTask({
            title: t("kind_policy"),
            subtitle,
            kind: "policy",
            href,
          });
          policyRunTasksRef.current.set(run.appId, handle);
        }
      }
    } catch (err) {
      // Network blip — keep last known state. The next tick will recover.
      console.warn("[tasks] Active-tasks poll failed:", err);
    }
  }, [startTask, resumeCardsEnabled, t]);

  useEffect(() => {
    if (!pollingEnabled) {
      return;
    }
    pollActiveTasks();
    const timer = setInterval(pollActiveTasks, ACTIVE_TASKS_POLL_MS);
    return () => clearInterval(timer);
  }, [pollActiveTasks, pollingEnabled]);

  // On unmount, clear any pending timers. (Not normally hit since provider
  // lives for the entire session.)
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      timers.forEach((t) => {
        clearTimeout(t);
      });
      timers.clear();
    };
  }, []);

  const api = useMemo<TaskCenterApi>(
    () => ({
      tasks,
      runningCount: tasks.filter((t) => t.status === "running").length,
      schedulerStatus,
      refreshScheduler,
      startTask,
      cancelTask,
      dismissTask,
      clearCompleted,
      runBackgroundFetch,
    }),
    [
      tasks,
      schedulerStatus,
      refreshScheduler,
      startTask,
      cancelTask,
      dismissTask,
      clearCompleted,
      runBackgroundFetch,
    ]
  );

  return (
    <TaskCenterContext.Provider value={api}>
      {children}
    </TaskCenterContext.Provider>
  );
}

export function useTaskCenter(): TaskCenterApi {
  const ctx = useContext(TaskCenterContext);
  if (!ctx) {
    throw new Error("useTaskCenter must be used inside <TaskCenterProvider>.");
  }
  return ctx;
}

/**
 * Format a ms offset into a short, human-readable "in X" countdown. Kept
 * tight because the row only has room for one line next to the schedule
 * label ("Daily sync · in 3h 42m").
 */
function formatCountdown(msUntil: number): string {
  if (msUntil <= 0) {
    return "any moment now";
  }
  const totalSeconds = Math.floor(msUntil / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `in ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `in ${seconds}s`;
}

type SchedT = (key: string, values?: Record<string, string | number>) => string;
function scheduleLabel(
  t: SchedT,
  schedule: SchedulerStatus["schedule"]
): string {
  switch (schedule) {
    case "daily":
      return t("schedule_daily");
    case "weekly":
      return t("schedule_weekly");
    default:
      return t("schedule_default");
  }
}

/**
 * Nav-bar button + dropdown panel. Shows the running-task count as a pill,
 * and an expandable list of tasks with progress + cancel.
 */
export function TaskCenterTrigger() {
  // i18n — panel chrome (aria, title, clear-finished, empty state,
  // dismiss aria). Per-row task copy is composed dynamically and stays
  // English for now.
  const t = useTranslations("task_center");
  // Wave I: short-circuit when `flag.taskcenter.widget` resolves off.
  // The Nav already gates `flag.nav.task_center_trigger`; this is the
  // belt-and-braces gate on the widget itself so future surfaces that
  // mount it directly still respect the toggle.
  const widgetOn = useFlag("flag.taskcenter.widget") === "on";

  const {
    tasks,
    runningCount,
    schedulerStatus,
    cancelTask,
    dismissTask,
    clearCompleted,
  } = useTaskCenter();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // 1s ticker so the "in Xh Ym Zs" countdown re-renders smoothly while the
  // panel is open. We only run this while open to keep idle nav cheap.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const anyCompleted = tasks.some((t) => t.status !== "running");

  const hasUpcoming =
    !!schedulerStatus &&
    schedulerStatus.schedule !== "manual" &&
    typeof schedulerStatus.nextRun === "number";
  const upcomingCountdown =
    hasUpcoming && schedulerStatus
      ? formatCountdown((schedulerStatus.nextRun ?? 0) - nowTick)
      : null;

  /**
   * Navigate to the Sync Schedule section of Settings.
   *
   * Two code paths because Next.js `<Link>` uses `history.pushState` under
   * the hood, and pushState to the same pathname with only a hash change
   * does NOT fire `hashchange` — so the settings sidebar's hash-jump
   * effect never re-runs, and the browser never scrolls. We handle it
   * manually:
   *
   *   - Already on settings → scroll ourselves, quietly update the URL.
   *   - Elsewhere          → router.push(); the settings page mount path
   *                          will honour the hash on its own.
   */
  const goToSyncSchedule = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) {
        return;
      }
      e.preventDefault();
      setOpen(false);

      if (pathname === "/dashboard/settings") {
        const el = document.getElementById("sync-schedule");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          if (typeof window !== "undefined" && window.history) {
            window.history.replaceState(null, "", "#sync-schedule");
          }
        }
      } else {
        router.push("/dashboard/settings#sync-schedule");
      }
    },
    [pathname, router]
  );

  if (!widgetOn) {
    return null;
  }

  return (
    <div className="task-center" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label={
          runningCount > 0
            ? t("trigger_aria_running", { count: runningCount })
            : t("trigger_aria_idle")
        }
        className={`task-center-trigger ${runningCount > 0 ? "is-active" : ""} ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {runningCount > 0 ? (
          <span aria-hidden="true" className="task-center-spinner" />
        ) : (
          <svg
            aria-hidden="true"
            fill="none"
            height="18"
            viewBox="0 0 18 18"
            width="18"
          >
            <path
              d="M9 1.5V3.75M9 14.25V16.5M3.75 9H1.5M16.5 9H14.25M4.28 4.28L2.7 2.7M15.3 15.3L13.72 13.72M4.28 13.72L2.7 15.3M15.3 2.7L13.72 4.28"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.5"
            />
          </svg>
        )}
        {runningCount > 0 && (
          <span className="task-center-badge">{runningCount}</span>
        )}
      </button>

      {open && (
        <div
          aria-label={t("panel_aria")}
          className="task-center-panel"
          role="dialog"
        >
          <div className="task-center-panel-header">
            <div className="task-center-panel-title">{t("panel_title")}</div>
            {anyCompleted && (
              <button
                className="task-center-panel-clear"
                onClick={clearCompleted}
                type="button"
              >
                {t("clear_finished")}
              </button>
            )}
          </div>

          {hasUpcoming && schedulerStatus && (
            <div className="task-center-upcoming-wrap">
              <div className="task-center-section-label">
                {t("section_upcoming")}
              </div>
              <a
                className="task-center-upcoming"
                href="/dashboard/settings#sync-schedule"
                onClick={goToSyncSchedule}
              >
                <div aria-hidden="true" className="task-center-upcoming-icon">
                  <svg fill="none" height="16" viewBox="0 0 16 16" width="16">
                    <circle
                      cx="8"
                      cy="8"
                      r="6.25"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M8 4.5V8L10.25 9.75"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                    />
                  </svg>
                </div>
                <div className="task-center-upcoming-body">
                  <div className="task-center-upcoming-title">
                    {scheduleLabel(t, schedulerStatus.schedule)}
                  </div>
                  <div className="task-center-upcoming-sub">
                    {schedulerStatus.isRunning
                      ? t("row_running_now")
                      : schedulerStatus.isDue
                        ? t("row_due_running_soon")
                        : `Next run ${upcomingCountdown}`}
                  </div>
                </div>
                <div
                  aria-hidden="true"
                  className="task-center-upcoming-chevron"
                >
                  ›
                </div>
              </a>
            </div>
          )}

          {tasks.length === 0 ? (
            <div className="task-center-empty">
              <div className="task-center-empty-icon">✓</div>
              <div className="task-center-empty-title">{t("empty_title")}</div>
              <p className="task-center-empty-text">{t("empty_text")}</p>
            </div>
          ) : (
            (() => {
              const running = tasks.filter((t) => t.status === "running");
              const recent = tasks.filter((t) => t.status !== "running");
              return (
                <>
                  {running.length > 0 && (
                    <>
                      <div className="task-center-section-label">
                        {t("section_running")}
                      </div>
                      <ul className="task-center-list">
                        {running.map((task) => (
                          <TaskRow
                            key={task.id}
                            onCancel={() => cancelTask(task.id)}
                            onDismiss={() => dismissTask(task.id)}
                            onNavigate={() => setOpen(false)}
                            task={task}
                          />
                        ))}
                      </ul>
                    </>
                  )}
                  {recent.length > 0 && (
                    <>
                      <div className="task-center-section-label">
                        {t("section_recent")}
                      </div>
                      <ul className="task-center-list">
                        {recent.map((task) => (
                          <TaskRow
                            key={task.id}
                            onCancel={() => cancelTask(task.id)}
                            onDismiss={() => dismissTask(task.id)}
                            onNavigate={() => setOpen(false)}
                            task={task}
                          />
                        ))}
                      </ul>
                    </>
                  )}
                </>
              );
            })()
          )}

          {/* Diagnostics deep-link. The TaskCenter is already the
              "what's happening under the hood" surface (running jobs,
              upcoming sync, recent activity), so the live runtime
              metrics dashboard at /dashboard/diagnostics is a natural
              neighbour. Lives at the bottom of the panel as a compact
              link rather than a list row so it doesn't compete with
              actual tasks for attention. Hidden when no tasks are
              listed AND no upcoming sync is shown — that's the empty
              state where the panel is already minimal and doesn't
              need a debug entry-point. */}
          {(tasks.length > 0 || hasUpcoming) && (
            <div className="task-center-footer-link-wrap">
              <Link
                className="task-center-footer-link"
                href="/dashboard/diagnostics"
                onClick={() => setOpen(false)}
                title="Live runtime metrics: memory, event-loop lag, slow queries"
              >
                ⏱ Diagnostics
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  onCancel,
  onDismiss,
  onNavigate,
}: {
  task: Task;
  onCancel: () => void;
  onDismiss: () => void;
  onNavigate: () => void;
}) {
  // i18n — for the per-row dismiss aria-label.
  const t = useTranslations("task_center");
  const statusIcon =
    task.status === "running"
      ? "⏳"
      : task.status === "done"
        ? "✓"
        : task.status === "cancelled"
          ? "⊘"
          : "✕";

  const progressPct =
    task.progress && task.progress.total > 0
      ? Math.min(
          100,
          Math.round((task.progress.current / task.progress.total) * 100)
        )
      : null;

  return (
    <li className={`task-row task-row--${task.status}`}>
      <div aria-hidden="true" className="task-row-status">
        {task.status === "running" ? (
          <span className="task-row-spinner" />
        ) : (
          statusIcon
        )}
      </div>

      <div className="task-row-body">
        <div className="task-row-title-line">
          <span className="task-row-title">{task.title}</span>
          {task.subtitle && (
            <span className="task-row-subtitle">{task.subtitle}</span>
          )}
        </div>

        {task.progress && progressPct !== null ? (
          <div className="task-row-progress">
            <div className="task-row-progress-bar">
              <div
                className="task-row-progress-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="task-row-progress-label">
              {task.progress.label
                ? task.progress.label
                : `${task.progress.current} / ${task.progress.total}`}
            </span>
          </div>
        ) : task.message ? (
          <div className="task-row-message">{task.message}</div>
        ) : null}
      </div>

      <div className="task-row-actions">
        {task.href && task.status === "running" && (
          <Link
            className="task-row-btn task-row-btn--view"
            href={task.href}
            onClick={onNavigate}
          >
            View
          </Link>
        )}
        {task.status === "running" ? (
          <button
            className="task-row-btn task-row-btn--cancel"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        ) : (
          <button
            aria-label={t("dismiss_aria")}
            className="task-row-btn task-row-btn--dismiss"
            onClick={onDismiss}
            type="button"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  );
}
