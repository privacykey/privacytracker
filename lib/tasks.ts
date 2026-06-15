/**
 * User-facing task list — pure data + helpers (no DB access).
 *
 * Drives the inline "Tasks" panel at the top of the dashboard and the
 * persistent nav icon. Mirrors the shape of `TOUR_STEPS` in
 * `feature-flag-rules.ts`: each task has a stable id, an `includedWhen`
 * predicate keyed on the active focus, and a pure `completionCheck` over
 * a pre-built snapshot. Completion is **always derived** — there is no
 * `completed_at` field. That way clearing the underlying state (e.g.
 * resetting the privacy profile) un-completes the task automatically.
 *
 * Server reads + writes live in `lib/tasks-server.ts`; this module is
 * import-safe from client code (no `better-sqlite3`).
 */

import type {
  Audience,
  FocusState,
  Modifier,
  PrimaryGoal,
} from "./feature-flag-rules";
import type { FocusWorkflow } from "./focus-workflow";

export type UserTaskId =
  | "view_privacy_map"
  | "open_any_app_detail"
  | "create_privacy_profile"
  | "review_mismatches"
  | "compare_two_apps"
  | "setup_background_mode"
  | "remove_apps_from_phone"
  | "resync_apps_from_device"
  | "export_audit_bundle";

/** Frozen snapshot fed to every `completionCheck`. Built once per resolve. */
export interface TaskCompletionContext {
  anyAppDetailVisitedAt: number | null;
  auditBundleLastExportedAt: number | null;
  backgroundWizardCompletedAt: number | null;
  compareVisitedAt: number | null;
  focus: FocusState;
  /** True when at least one device exists with at least one app linked.
   *  Drives inclusion of the `resync_apps_from_device` opt-in task —
   *  we don't surface "re-sync from your device" if the user has never
   *  done an import that landed in any device's app list. */
  hasDeviceWithApps: boolean;
  hasPrivacyProfile: boolean;
  /** Epoch ms of the most-recent re-sync commit for any device, or 0.
   *  Lets `resync_apps_from_device` auto-complete once the user has
   *  done at least one re-sync — they've discovered the feature. */
  lastResyncAt: number;
  privacyMapVisitedAt: number | null;
  /** Current value of `sync_schedule` in `app_settings`. Used by
   *  `setup_background_mode` to also count "switched away from manual
   *  sync" as a form of "tracking in the background." */
  syncSchedule: string | null;
  uninstallVerdictCount: number;
  verdictCount: number;
  workflow: FocusWorkflow;
}

export interface UserTaskDef {
  /** Pure function over a pre-built snapshot. Never trusts a client-set
   *  marker — completion is derived from observable state. */
  completionCheck: (ctx: TaskCompletionContext) => boolean;
  /** i18n key root — copy lives at `tasks.<i18nKey>.{title,body}`. */
  i18nKey: string;
  id: UserTaskId;
  /** Server-safe inclusion predicate. `env.isDesktop` is supplied by the
   *  caller — the server resolver passes `false`; the client provider
   *  refines after its own `isDesktop()` check. */
  includedWhen: (
    focus: FocusState,
    env: { isDesktop: boolean },
    ctx: TaskCompletionContext
  ) => boolean;
  /** When `true`, the task is hidden from the panel until the user
   *  explicitly opts in via the chip tray (writes `opted_in_at` to the
   *  blob). When `false` / undefined, the task is governed only by
   *  `includedWhen`. Surfaces as a chip in the "Add a task" tray while
   *  the user hasn't opted in. */
  optInOnly?: boolean;
  /** Soft-gate tasks. Clicking with an unmet prereq opens the gate modal. */
  prerequisites: UserTaskId[];
  /** Navigation target. Component appends `?from=tasks` so destination
   *  surfaces can show a "back to tasks" affordance later if desired. */
  route: string;
}

const has = (focus: FocusState, goal: PrimaryGoal | Modifier) =>
  focus.goals.has(goal);

/**
 * Six initial tasks. Order here is the order they render. `includedWhen`
 * predicates compose against the focus; e.g. the desktop-only background-
 * mode task only surfaces when `env.isDesktop` is true.
 */
export const TASK_DEFS: UserTaskDef[] = [
  {
    id: "view_privacy_map",
    route: "/dashboard/privacy",
    prerequisites: [],
    i18nKey: "view_privacy_map",
    includedWhen: () => true,
    completionCheck: (ctx) => ctx.privacyMapVisitedAt != null,
  },
  {
    id: "open_any_app_detail",
    route: "/dashboard/apps",
    prerequisites: [],
    i18nKey: "open_any_app_detail",
    includedWhen: () => true,
    completionCheck: (ctx) => ctx.anyAppDetailVisitedAt != null,
  },
  {
    id: "create_privacy_profile",
    // Recommender flavour is achieved by audience-aware i18n copy; the
    // route is the same setup screen.
    route: "/onboard/profile",
    prerequisites: [],
    i18nKey: "create_privacy_profile",
    includedWhen: () => true,
    completionCheck: (ctx) => ctx.hasPrivacyProfile,
  },
  {
    id: "review_mismatches",
    route: "/dashboard/review-recommendations",
    prerequisites: ["create_privacy_profile"],
    i18nKey: "review_mismatches",
    includedWhen: (focus) => has(focus, "cleanup") || has(focus, "minimal"),
    completionCheck: (ctx) => ctx.verdictCount >= 1,
  },
  {
    id: "compare_two_apps",
    route: "/dashboard/compare",
    prerequisites: [],
    i18nKey: "compare_two_apps",
    includedWhen: (focus) => has(focus, "monitor") || has(focus, "cleanup"),
    completionCheck: (ctx) => ctx.compareVisitedAt != null,
  },
  {
    id: "setup_background_mode",
    // Universal route — works on web (configures auto-sync) and on desktop
    // (the Background Mode wizard callout is already on this page).
    route: "/dashboard/settings#sync",
    prerequisites: [],
    i18nKey: "setup_background_mode",
    includedWhen: () => true,
    optInOnly: true,
    // Two ways to satisfy this: completed the Tauri Background Mode wizard,
    // or simply picked any non-manual sync schedule. Both signal "I want
    // tracking to happen in the background."
    completionCheck: (ctx) =>
      ctx.backgroundWizardCompletedAt != null ||
      (ctx.syncSchedule != null && ctx.syncSchedule !== "manual"),
  },
  {
    id: "remove_apps_from_phone",
    // The review wizard is where verdicts get set — that's the "I plan
    // to remove this" surface. The Tauri cfgutil flow downstream of
    // that handles the actual on-device uninstall.
    route: "/dashboard/review-recommendations",
    prerequisites: ["create_privacy_profile"],
    i18nKey: "remove_apps_from_phone",
    includedWhen: () => true,
    optInOnly: true,
    completionCheck: (ctx) => ctx.uninstallVerdictCount >= 1,
  },
  {
    id: "resync_apps_from_device",
    // Settings → Devices is the central spot — each device has its own
    // "Re-sync" button there. Routing the user to /dashboard/settings/devices
    // lets them pick the device they want to re-sync.
    route: "/dashboard/settings/devices",
    prerequisites: [],
    i18nKey: "resync_apps_from_device",
    // Only relevant when the user has at least one device with apps —
    // re-sync needs something to diff against.
    includedWhen: (_focus, _env) => true,
    optInOnly: true,
    // Auto-complete once the user has done a re-sync at least once.
    completionCheck: (ctx) => ctx.lastResyncAt > 0,
  },
  {
    id: "export_audit_bundle",
    route: "/dashboard/settings#export-data",
    prerequisites: [],
    i18nKey: "export_audit_bundle",
    includedWhen: (_focus, _env, ctx) => ctx.workflow === "other_handoff",
    optInOnly: true,
    completionCheck: (ctx) => ctx.auditBundleLastExportedAt != null,
  },
];

export type ResolvedTaskState =
  | "ready"
  | "in_progress"
  | "completed"
  | "blocked"
  | "dismissed";

/** A def plus everything the UI needs to render it. */
export interface ResolvedTask {
  /** Audience copy depends on the focus; the resolver passes it through
   *  so the client doesn't have to re-import the focus store. */
  audience: Audience;
  dismissedAt: number | null;
  i18nKey: string;
  id: UserTaskId;
  /** Epoch ms — set when the user added the task via the chip tray.
   *  null for tasks that don't have `optInOnly`. */
  optedInAt: number | null;
  prerequisites: UserTaskId[];
  route: string;
  /** Epoch ms; surfaces in tooltips and feeds the 14-day staleness check. */
  startedAt: number | null;
  state: ResolvedTaskState;
}

/** Subset of a TaskDef needed to render an opt-in chip. The full def
 *  isn't exposed because predicates aren't serialisable. */
export interface OptInCandidate {
  i18nKey: string;
  id: UserTaskId;
}

/** Audit a single task against a snapshot + per-task user state. Pure.
 *  The user-state shape mirrors the JSON blob persisted in `app_settings`
 *  (snake_case), so callers can pass `blob.tasks[id]` straight through. */
export function resolveTaskState(
  def: UserTaskDef,
  ctx: TaskCompletionContext,
  userState: { started_at?: number; dismissed_at?: number } | undefined,
  allTasks: { id: UserTaskId; isCompleted: boolean }[],
  /** Now-ish, injectable for tests. */
  now: number = Date.now()
): ResolvedTaskState {
  if (def.completionCheck(ctx)) {
    return "completed";
  }
  if (userState?.dismissed_at) {
    return "dismissed";
  }

  const blockedBy = def.prerequisites.find((prereqId) => {
    const prereq = allTasks.find((t) => t.id === prereqId);
    return prereq && !prereq.isCompleted;
  });
  if (blockedBy) {
    return "blocked";
  }

  if (userState?.started_at) {
    // Auto-reset abandoned tasks. 14 days mirrors the "did the user
    // actually pursue this?" question — no completion, no recent touch,
    // back to 'ready' so the panel doesn't permanently show a stale
    // in-progress marker.
    const STALE_MS = 14 * 24 * 60 * 60 * 1000;
    if (now - userState.started_at < STALE_MS) {
      return "in_progress";
    }
  }
  return "ready";
}

/**
 * Filter + resolve every task for a given focus. Server-side callers pass
 * `isDesktop: false` (and the client provider re-resolves with the real
 * runtime flag). Returns the tasks in TASK_DEFS order.
 *
 * `optInOnly` tasks are filtered out unless the user has opted in via the
 * chip tray. Completed prerequisites still come from the full resolved
 * pool, not just the opt-in subset — so a prereq task that's not visible
 * but is completed still unblocks its dependants.
 */
export function resolveTasks(
  focus: FocusState,
  ctx: TaskCompletionContext,
  blob: {
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
  },
  env: { isDesktop: boolean },
  now: number = Date.now()
): ResolvedTask[] {
  // Visible = passes includedWhen AND (not optInOnly OR opted in).
  const visibleDefs = TASK_DEFS.filter((d) => {
    if (!d.includedWhen(focus, env, ctx)) {
      return false;
    }
    if (d.optInOnly && !blob.tasks[d.id]?.opted_in_at) {
      return false;
    }
    return true;
  });

  // Completion is derived for EVERY def in TASK_DEFS so prerequisite
  // checks work even when the prereq isn't currently visible (e.g. user
  // already has a profile — `create_privacy_profile` task auto-completes
  // and unblocks `remove_apps_from_phone` even before they opt in).
  const completionMap = new Map<UserTaskId, boolean>();
  for (const d of TASK_DEFS) {
    completionMap.set(d.id, d.completionCheck(ctx));
  }

  return visibleDefs.map((def) => {
    const userState = blob.tasks[def.id];
    const state = resolveTaskState(
      def,
      ctx,
      userState,
      TASK_DEFS.map((d) => ({
        id: d.id,
        isCompleted: completionMap.get(d.id) ?? false,
      })),
      now
    );
    return {
      id: def.id,
      route: def.route,
      prerequisites: def.prerequisites,
      i18nKey: def.i18nKey,
      state,
      startedAt: userState?.started_at ?? null,
      dismissedAt: userState?.dismissed_at ?? null,
      optedInAt: userState?.opted_in_at ?? null,
      audience: focus.audience,
    };
  });
}

/**
 * Task ids that are eligible to surface as chips in the "Add a task"
 * tray: `optInOnly` AND `includedWhen` passes AND not already opted in
 * AND not already completed via derived state.
 */
export function getOptInCandidates(
  focus: FocusState,
  ctx: TaskCompletionContext,
  blob: {
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
  },
  env: { isDesktop: boolean }
): OptInCandidate[] {
  return TASK_DEFS.filter((d) => {
    if (!d.optInOnly) {
      return false;
    }
    if (!d.includedWhen(focus, env, ctx)) {
      return false;
    }
    if (blob.tasks[d.id]?.opted_in_at) {
      return false;
    }
    // Don't offer to opt into a task you're already done with — that's
    // confusing UX. Derived-completion still applies.
    if (d.completionCheck(ctx)) {
      return false;
    }
    return true;
  }).map((d) => ({ id: d.id, i18nKey: d.i18nKey }));
}

/** True when every visible task is `completed` or `dismissed`. Drives the
 *  collapsed-chip state on the dashboard. */
export function isAllSettled(tasks: ResolvedTask[]): boolean {
  if (tasks.length === 0) {
    return true;
  }
  return tasks.every((t) => t.state === "completed" || t.state === "dismissed");
}
