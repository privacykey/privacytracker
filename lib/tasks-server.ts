/**
 * Server-side helpers for the user-tasks feature. Reads + writes hit
 * `app_settings` (one JSON blob — `user_tasks_state`) plus the existing
 * data the per-task `completionCheck` predicates derive from.
 *
 * Mirrors the split in `feature-flag-rules.ts` (pure) vs
 * `feature-flag-storage.ts` (DB), so client code can import `lib/tasks`
 * without pulling `better-sqlite3` into its bundle.
 */

import db from "./db";
import { getActiveFocus, getActiveFocusWorkflow } from "./feature-flag-storage";
import { getPrivacyProfile } from "./privacy-profile-server";
import { getSetting, setSetting } from "./scheduler";
import {
  getOptInCandidates,
  type OptInCandidate,
  type ResolvedTask,
  resolveTasks,
  TASK_DEFS,
  type TaskCompletionContext,
  type UserTaskId,
} from "./tasks";

const STORAGE_KEY = "user_tasks_state";
const TASK_IDS = new Set<UserTaskId>(TASK_DEFS.map((d) => d.id));

export interface UserTasksStateBlob {
  tasks: Partial<
    Record<
      UserTaskId,
      {
        started_at?: number;
        dismissed_at?: number;
        opted_in_at?: number;
      }
    >
  >;
  version: 1;
}

const EMPTY_BLOB: UserTasksStateBlob = { version: 1, tasks: {} };

/**
 * Parse the JSON blob from `app_settings`. Returns the empty blob on any
 * shape mismatch — corruption is logged but doesn't propagate to callers.
 * Mirrors the parse-or-empty pattern used by `getPreviewState` in
 * `feature-flag-storage.ts`.
 */
export function getUserTasksState(): UserTasksStateBlob {
  const raw = getSetting(STORAGE_KEY, "");
  if (!raw) {
    return EMPTY_BLOB;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return EMPTY_BLOB;
    }
    const obj = parsed as { version?: unknown; tasks?: unknown };
    if (obj.version !== 1) {
      return EMPTY_BLOB;
    }
    if (!obj.tasks || typeof obj.tasks !== "object") {
      return EMPTY_BLOB;
    }
    // Sanitize: drop unknown task ids and non-numeric timestamps.
    const cleanTasks: UserTasksStateBlob["tasks"] = {};
    for (const [id, entry] of Object.entries(
      obj.tasks as Record<string, unknown>
    )) {
      if (!TASK_IDS.has(id as UserTaskId)) {
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as {
        started_at?: unknown;
        dismissed_at?: unknown;
        opted_in_at?: unknown;
      };
      const cleaned: {
        started_at?: number;
        dismissed_at?: number;
        opted_in_at?: number;
      } = {};
      if (typeof e.started_at === "number" && Number.isFinite(e.started_at)) {
        cleaned.started_at = e.started_at;
      }
      if (
        typeof e.dismissed_at === "number" &&
        Number.isFinite(e.dismissed_at)
      ) {
        cleaned.dismissed_at = e.dismissed_at;
      }
      if (typeof e.opted_in_at === "number" && Number.isFinite(e.opted_in_at)) {
        cleaned.opted_in_at = e.opted_in_at;
      }
      cleanTasks[id as UserTaskId] = cleaned;
    }
    return { version: 1, tasks: cleanTasks };
  } catch (error) {
    console.warn("[tasks-server] user_tasks_state corrupt, resetting:", error);
    return EMPTY_BLOB;
  }
}

export function setUserTasksState(next: UserTasksStateBlob): void {
  setSetting(STORAGE_KEY, JSON.stringify(next));
}

/**
 * Build the completion context in one DB pass. Per-task `completionCheck`
 * predicates are pure over this snapshot — no I/O inside the predicates.
 */
export function buildTaskCompletionContext(
  focus = getActiveFocus()
): TaskCompletionContext {
  const workflow = getActiveFocusWorkflow(focus);
  const hasProfile = (() => {
    try {
      const p = getPrivacyProfile();
      if (!p) {
        return false;
      }
      return Object.values(p).some((v) => typeof v === "string");
    } catch {
      return false;
    }
  })();

  // Combined query: any user-set verdict counts toward `verdictCount`;
  // verdicts specifically marked `uninstall` count toward
  // `uninstallVerdictCount`. One DB round-trip for both.
  const { verdictCount, uninstallVerdictCount } = (() => {
    try {
      const row = db
        .prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN verdict = 'uninstall' THEN 1 ELSE 0 END) AS uninstall
          FROM app_verdicts
          WHERE source = 'user'
        `)
        .get() as { total?: number; uninstall?: number } | undefined;
      return {
        verdictCount: row?.total ?? 0,
        uninstallVerdictCount: row?.uninstall ?? 0,
      };
    } catch {
      return { verdictCount: 0, uninstallVerdictCount: 0 };
    }
  })();

  const syncScheduleRaw = getSetting("sync_schedule", "");
  const syncSchedule = syncScheduleRaw === "" ? null : syncScheduleRaw;

  // Has any device with at least one app linked? Cheap existence check.
  const hasDeviceWithApps = (() => {
    try {
      const row = db.prepare("SELECT 1 FROM app_devices LIMIT 1").get();
      return Boolean(row);
    } catch {
      return false;
    }
  })();
  const lastResyncAt = numericSetting("device_resync.last_committed_at") ?? 0;

  return {
    focus,
    workflow,
    hasPrivacyProfile: hasProfile,
    anyAppDetailVisitedAt: numericSetting("task_visit.app_detail_at"),
    auditBundleLastExportedAt: numericSetting("audit_bundle_last_exported_at"),
    privacyMapVisitedAt: numericSetting("task_visit.privacy_map_at"),
    compareVisitedAt: numericSetting("task_visit.compare_at"),
    verdictCount,
    uninstallVerdictCount,
    backgroundWizardCompletedAt: numericSetting(
      "background_wizard_completed_at"
    ),
    syncSchedule,
    hasDeviceWithApps,
    lastResyncAt,
  };
}

function numericSetting(key: string): number | null {
  const raw = getSetting(key, "");
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Full resolve: figure out which tasks apply to this focus + their state.
 * Server callers should pass `isDesktop: false` so the Tauri-only task is
 * filtered out — the client provider re-resolves with the real flag.
 */
export function resolveAllTasks(
  focus = getActiveFocus(),
  isDesktop = false
): ResolvedTask[] {
  const ctx = buildTaskCompletionContext(focus);
  const blob = getUserTasksState();
  return resolveTasks(focus, ctx, blob, { isDesktop });
}

/** Companion to `resolveAllTasks` — what opt-in chips should the panel
 *  surface? Computed against the same focus + blob to stay consistent. */
export function resolveOptInCandidates(
  focus = getActiveFocus(),
  isDesktop = false
): OptInCandidate[] {
  const ctx = buildTaskCompletionContext(focus);
  const blob = getUserTasksState();
  return getOptInCandidates(focus, ctx, blob, { isDesktop });
}

function mutateBlob(
  mutator: (blob: UserTasksStateBlob) => UserTasksStateBlob
): void {
  const current = getUserTasksState();
  setUserTasksState(mutator(current));
}

export function startTask(id: UserTaskId): void {
  if (!TASK_IDS.has(id)) {
    return;
  }
  mutateBlob((blob) => {
    const existing = blob.tasks[id] ?? {};
    return {
      version: 1,
      tasks: {
        ...blob.tasks,
        [id]: { ...existing, started_at: Date.now() },
      },
    };
  });
}

export function dismissTask(id: UserTaskId): void {
  if (!TASK_IDS.has(id)) {
    return;
  }
  mutateBlob((blob) => {
    const existing = blob.tasks[id] ?? {};
    return {
      version: 1,
      tasks: {
        ...blob.tasks,
        [id]: { ...existing, dismissed_at: Date.now() },
      },
    };
  });
}

export function resetTask(id: UserTaskId): void {
  if (!TASK_IDS.has(id)) {
    return;
  }
  mutateBlob((blob) => {
    const next = { ...blob.tasks };
    delete next[id];
    return { version: 1, tasks: next };
  });
}

/** Add an opt-in task to the user's panel. No-op if the task isn't
 *  `optInOnly` (we don't gate non-opt-in tasks behind this) or if it
 *  was already opted in. */
export function optInTask(id: UserTaskId): void {
  if (!TASK_IDS.has(id)) {
    return;
  }
  const def = TASK_DEFS.find((d) => d.id === id);
  if (!def?.optInOnly) {
    return;
  }
  mutateBlob((blob) => {
    const existing = blob.tasks[id] ?? {};
    if (existing.opted_in_at) {
      return blob;
    }
    return {
      version: 1,
      tasks: {
        ...blob.tasks,
        [id]: { ...existing, opted_in_at: Date.now() },
      },
    };
  });
}

/** Wipes the entire blob — powers the "Show all tasks again" reset. */
export function clearAllTasks(): void {
  setUserTasksState(EMPTY_BLOB);
}
