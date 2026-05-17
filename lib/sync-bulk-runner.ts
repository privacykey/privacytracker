/**
 * Orchestrates a bulk App Store label sync across every app, persisting
 * state to SQLite after each app so a server crash mid-run can be resumed
 * on the next startup.
 *
 * Called from three places:
 *   - `POST /api/sync/trigger` (user pressed "Sync now")
 *   - `instrumentation.ts` 30-minute ticker (scheduled)
 *   - `instrumentation.ts` startup (auto-resume of a crashed run)
 *
 * Design mirrors `lib/wayback-bulk-runner.ts` and
 * `lib/policy-bulk-runner.ts` — the state module holds the blob + mutex,
 * the runner owns the loop and all activity writes. `fetchAndParseApp`
 * is safe to re-run because its write path is a single `db.transaction`
 * that wipes + rewrites the app's privacy rows, and the snapshot/diff
 * chain dedupes on identical JSON.
 *
 * Apple's 429 handling is different from policy's internal throttle.
 * When Apple rate-limits, it stays rate-limited for every URL from the
 * same client for a while, so continuing the loop just wastes requests
 * and extends the cooldown. The runner bails out of the loop on the
 * first 429, marks the remaining pending apps as `rate_limited` in
 * totals, and **still clears state + mutex cleanly** — the next
 * scheduled tick (30 mins away) picks up fresh. This is deliberately
 * different from a process-kill: 429 is an expected, recoverable
 * condition, not a crash.
 */

import crypto from "node:crypto";
import { recordActivity } from "./activity";
import db from "./db";
import { schedulePostAppUpdatePolicyFetch } from "./post-app-update-policy-fetch";
import {
  acquireSyncBulkMutex,
  clearSyncBulkState,
  hasSyncPendingWork,
  isSyncBulkMutexHeld,
  readSyncBulkState,
  releaseSyncBulkMutex,
  type SyncBulkState,
  type SyncBulkTotals,
  type SyncQueueEntry,
  summariseSyncState,
  writeSyncBulkState,
  zeroSyncTotals,
} from "./sync-bulk-state";

/** Row shape pulled from `apps` to seed the queue. */
export interface SyncAppRow {
  id: string;
  name: string;
  url: string;
}

export interface RunSyncBulkOptions {
  initiator: "manual" | "scheduled" | "resume";
  resumeState?: SyncBulkState;
}

/** Return shape kept compatible with the pre-refactor `runScheduledSync`. */
export interface RunSyncBulkResult {
  changes: number;
  durationMs?: number;
  /** Extended: how many apps Apple rate-limited us on this run. */
  rateLimited?: number;
  skipped?: boolean;
  synced: number;
}

/**
 * Can a new manual run start right now? Returns `{ ok: true }` if neither
 * the mutex nor the state blob is claimed. Callers of `runScheduledSync`
 * historically returned `{ skipped: true }` in the busy case so the
 * runner does the same for back-compat.
 */
export function canStartSyncManualRun():
  | { ok: true }
  | { ok: false; reason: "busy" } {
  if (isSyncBulkMutexHeld() || readSyncBulkState() !== null) {
    return { ok: false, reason: "busy" };
  }
  return { ok: true };
}

/**
 * Query all apps and turn them into a fresh pending queue. Used when no
 * resume state exists. Ordered by name for a stable ordering across runs.
 */
export function buildInitialSyncQueue(): {
  queue: SyncQueueEntry[];
  appCount: number;
} {
  const apps = db
    .prepare(
      `SELECT id, name, url
         FROM apps
        WHERE url IS NOT NULL
          AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as SyncAppRow[];
  return {
    queue: apps
      .filter((app) => app.url) // defensive: SQL already excludes these
      .map<SyncQueueEntry>((app) => ({
        appId: app.id,
        appName: app.name,
        url: app.url,
        status: "pending",
      })),
    appCount: apps.length,
  };
}

/**
 * Fetch the current URL for a queued app — done at dequeue time rather
 * than cached in the queue so a mid-run DB rename / URL change takes
 * effect on the next tick without us persisting stale strings.
 */
function lookupSyncAppRow(appId: string): SyncAppRow | null {
  const row = db
    .prepare("SELECT id, name, url FROM apps WHERE id = ?")
    .get(appId) as SyncAppRow | undefined;
  return row ?? null;
}

function bulkSummaryLine(totals: SyncBulkTotals): string {
  const parts = [`${totals.succeeded}/${totals.attempted} synced`];
  parts.push(`${totals.changes} change${totals.changes === 1 ? "" : "s"}`);
  if (totals.failed) {
    parts.push(`${totals.failed} error${totals.failed === 1 ? "" : "s"}`);
  }
  if (totals.rateLimited) {
    parts.push(`${totals.rateLimited} rate-limited`);
  }
  if (totals.skipped) {
    parts.push(`${totals.skipped} skipped`);
  }
  return parts.join(", ");
}

function activityTypeFor(
  initiator: "manual" | "scheduled" | "resume"
): "manual_sync" | "scheduled_sync" {
  // Resume is re-finishing whatever the original initiator started — we
  // don't know which one. Treating it as 'scheduled_sync' keeps the
  // activity timeline readable (users rarely kick off manual syncs, so
  // resumes are more likely to be continuations of scheduled work).
  return initiator === "manual" ? "manual_sync" : "scheduled_sync";
}

/**
 * Main loop. Preconditions:
 *   - If `resumeState` is present, callers should have already acquired
 *     the mutex (or the runner will do so defensively).
 *   - If absent, the runner creates a fresh state blob.
 */
export async function runBulkSync(
  options: RunSyncBulkOptions
): Promise<RunSyncBulkResult> {
  let state: SyncBulkState;
  if (options.resumeState) {
    state = options.resumeState;
    // Flip any `in_progress` entries back to `pending` — those were the
    // app(s) mid-flight when the previous process died. We'll redo them.
    for (const entry of state.queue) {
      if (entry.status === "in_progress") {
        entry.status = "pending";
      }
    }
  } else {
    const { queue } = buildInitialSyncQueue();
    state = {
      version: 1, // writeSyncBulkState overrides
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      initiator: options.initiator,
      updatedAt: Date.now(),
      currentAppId: null,
      queue,
      totals: zeroSyncTotals(),
    };
  }

  // Defensive mutex acquire — the policy/wayback routes already hold it
  // by this point, resume path doesn't. A redundant set is harmless.
  acquireSyncBulkMutex();
  writeSyncBulkState(state);

  // Empty queue — record a clean no-op row and return early. Preserves the
  // pre-refactor behaviour where `runScheduledSync` wrote a "No apps to sync"
  // activity row rather than silently succeeding.
  if (state.queue.length === 0) {
    recordActivity({
      type: activityTypeFor(state.initiator),
      status: "ok",
      summary: "No apps to sync",
      detail: { appCount: 0 },
      startedAt: state.startedAt,
    });
    clearSyncBulkState();
    releaseSyncBulkMutex();
    return { synced: 0, changes: 0 };
  }

  const runStartedAt = Date.now();

  // Lazy-load to match the pre-refactor dynamic import — avoids a cycle
  // between scheduler.ts (which imports activity) and scraper.ts (which
  // also imports activity indirectly via db).
  const { fetchAndParseApp, AppleRateLimitError } = await import("./scraper");
  const trigger: "manual" | "scheduled" =
    state.initiator === "manual" ? "manual" : "scheduled";

  let rateLimited = false;

  try {
    for (let i = 0; i < state.queue.length; i++) {
      const entry = state.queue[i];
      // Skip apps already completed in a prior life. `failed` is intentional
      // — a user can kick off a new run to retry them.
      if (entry.status === "done" || entry.status === "failed") {
        continue;
      }

      // Mark in-flight + persist BEFORE any work so a crash here is visible.
      entry.status = "in_progress";
      entry.startedAt = Date.now();
      entry.finishedAt = undefined;
      entry.error = undefined;
      entry.outcome = undefined;
      entry.changesDetected = undefined;
      state.currentAppId = entry.appId;
      state.totals.attempted++;
      writeSyncBulkState(state);

      // Refresh the app row — the user may have deleted the app or edited
      // the URL between queue build and dequeue.
      const app = lookupSyncAppRow(entry.appId);
      if (!app?.url) {
        const reason = app
          ? "App no longer has a URL."
          : "App no longer exists.";
        entry.status = "done"; // treat as completed-with-skip so we don't retry on resume
        entry.finishedAt = Date.now();
        entry.outcome = "skipped";
        entry.error = reason;
        state.totals.skipped++;
        state.totals.attempted--; // this one didn't actually fire a scrape
        state.currentAppId = null;
        writeSyncBulkState(state);
        continue;
      }

      try {
        // Scheduled / manual syncs always use resync=true and keep policy
        // fetching out of the scrape loop. A fetch-only policy pass is
        // scheduled after the bulk App Store labels finish.
        const result = await fetchAndParseApp(app.url, true, false, trigger);
        const changesDetected =
          result && typeof result === "object" && "changesDetected" in result
            ? !!(result as { changesDetected?: boolean }).changesDetected
            : false;

        entry.status = "done";
        entry.finishedAt = Date.now();
        entry.outcome = changesDetected ? "changed" : "succeeded";
        entry.changesDetected = changesDetected;
        state.totals.succeeded++;
        if (changesDetected) {
          state.totals.changes++;
        }
        state.currentAppId = null;
        writeSyncBulkState(state);
      } catch (error) {
        const isRateLimit =
          !!error &&
          typeof error === "object" &&
          (error instanceof AppleRateLimitError ||
            (error as { rateLimited?: unknown }).rateLimited === true);

        if (isRateLimit) {
          // Apple 429s are client-wide — every remaining URL is guaranteed
          // to 429 too. Mark this one and all pending peers as rate_limited
          // in totals, then bail out. The next scheduled tick will retry
          // from scratch; crash-safe resume doesn't apply because we're
          // about to clear state cleanly.
          entry.status = "failed";
          entry.finishedAt = Date.now();
          entry.outcome = "rate_limited";
          entry.error =
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Apple rate-limited";
          state.totals.rateLimited++;
          state.totals.attempted--; // 429 isn't a real attempt
          state.currentAppId = null;
          writeSyncBulkState(state);

          // Count remaining pending apps as rate-limited in totals (they
          // didn't run this round, but the user should see they were
          // waiting on Apple not on us).
          for (let j = i + 1; j < state.queue.length; j++) {
            const peer = state.queue[j];
            if (peer.status === "pending") {
              state.totals.rateLimited++;
            }
          }
          rateLimited = true;
          break;
        }

        const message = error instanceof Error ? error.message : "Sync error";
        entry.status = "failed";
        entry.finishedAt = Date.now();
        entry.error = message.slice(0, 200);
        entry.outcome = "failed";
        state.totals.failed++;
        state.currentAppId = null;
        writeSyncBulkState(state);
      }
    }

    // Clean completion (or rate-limit exit) — write summary row, clear state.
    const durationMs = Date.now() - runStartedAt;
    const status = state.totals.failed > 0 || rateLimited ? "partial" : "ok";

    const baseSummary = bulkSummaryLine(state.totals);
    const activitySummary = (
      state.initiator === "resume"
        ? `${baseSummary} (resumed after restart)`
        : baseSummary
    ).slice(0, 200);

    // Only bump last_auto_sync on a real completion — rate-limit exits don't
    // count because we haven't actually covered every app.
    if (!rateLimited) {
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
      ).run("last_auto_sync", Date.now().toString());
    }

    recordActivity({
      type: activityTypeFor(state.initiator),
      status,
      summary: activitySummary,
      detail: {
        mode: state.initiator === "resume" ? "bulk-resumed" : "bulk",
        totals: state.totals,
        runId: state.runId,
        rateLimited,
      },
      startedAt: state.startedAt,
    });

    clearSyncBulkState();
    releaseSyncBulkMutex();

    if (state.totals.succeeded > 0) {
      schedulePostAppUpdatePolicyFetch("sync");
    }

    return {
      synced: state.totals.succeeded,
      changes: state.totals.changes,
      rateLimited: state.totals.rateLimited,
      durationMs,
    };
  } catch (error) {
    // Outer catch — loop itself blew up (DB I/O, OOM). Leave state + mutex
    // in place so `instrumentation.ts` can resume on the next boot.
    const message = error instanceof Error ? error.message : "Bulk sync failed";
    recordActivity({
      type: activityTypeFor(state.initiator),
      status: "error",
      summary:
        `${state.initiator === "manual" ? "Manual" : "Scheduled"} sync failed: ${message}`.slice(
          0,
          200
        ),
      detail: {
        mode: "bulk",
        totals: state.totals,
        errorMessage: message,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    throw error;
  }
}

/**
 * Public summary of what `runBulkSync` will find on disk. Used by the
 * scheduler's status endpoint + instrumentation startup check + unified
 * `/api/tasks/active`. No side effects — safe to call anywhere.
 */
export function describeCurrentSyncRun(): {
  running: boolean;
  mutexHeld: boolean;
  state: SyncBulkState | null;
  summary: ReturnType<typeof summariseSyncState> | null;
  currentAppName: string | null;
  stale: boolean;
} {
  const state = readSyncBulkState();
  const mutexHeld = isSyncBulkMutexHeld();
  const summary = state ? summariseSyncState(state) : null;
  const currentAppName = state?.currentAppId
    ? (state.queue.find((e) => e.appId === state.currentAppId)?.appName ?? null)
    : null;
  const stale = mutexHeld && !hasSyncPendingWork(state);
  return {
    running: !!state || mutexHeld,
    mutexHeld,
    state,
    summary,
    currentAppName,
    stale,
  };
}
