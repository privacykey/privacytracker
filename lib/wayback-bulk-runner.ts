/**
 * Orchestrates a bulk Wayback import across every app, persisting state to
 * SQLite after each app so a server crash mid-run can be resumed on the
 * next startup.
 *
 * Called from two places:
 *   - `POST /api/wayback/import-all` (user-initiated, optionally streaming)
 *   - `instrumentation.ts` startup (auto-resume, always background / buffered)
 *
 * The runner owns both the durable state blob (`wayback_bulk_state`) and
 * the cross-request mutex (`wayback_import_running`):
 *
 *   - Entry: seeds or reuses state, acquires mutex, emits `batch-start`.
 *   - Each app boundary: marks in_progress → runs `importAppHistory` →
 *     marks done/failed, writes per-app activity row, rewrites state blob.
 *   - Clean completion: writes summary activity + audit, clears state +
 *     mutex, emits `summary`.
 *   - Exception escape: state + mutex are intentionally left in place so
 *     the next server startup can resume.
 *
 * Resume granularity is at the app boundary. If we died processing
 * Instagram, the resumed run re-starts Instagram from scratch —
 * `importAppHistory` is safe to re-run because its per-target dedup
 * (`alreadyCovered` + `existing.some(row => row.wayback_snapshot_url === url)`)
 * prevents duplicate snapshot rows, and Save-Page-Now is idempotent on
 * Wayback's side.
 */

import crypto from 'crypto';
import db from './db';
import { recordActivity } from './activity';
import { recordAudit } from './security';
import {
  importAppHistory,
  type ImportAppHistoryResult,
  type ImportProgressEvent,
} from './historical-import';
import { isAbortError } from './wayback';
import {
  readBulkState,
  writeBulkState,
  clearBulkState,
  acquireBulkMutex,
  releaseBulkMutex,
  isBulkMutexHeld,
  zeroTotals,
  summariseState,
  hasPendingWork,
  type WaybackBulkState,
  type WaybackBulkTotals,
  type QueueEntry,
} from './wayback-bulk-state';

/** Shape of the rows we pull from `apps` to seed the queue. */
export interface AppRow {
  id: string;
  url: string;
  name: string;
}

/**
 * Writer for streaming NDJSON events. The POST handler passes a real writer
 * backed by a `ReadableStream` controller; buffered callers (the resume
 * path) pass nothing and events are dropped.
 */
export type StreamWriter = (obj: unknown) => void;

export interface RunBulkOptions {
  /**
   * What initiated the run. 'manual' = POST from the UI, 'resume' = server
   * restart with leftover state. Drives the activity-log copy and the
   * `bulk-resumed` detail tag.
   */
  initiator: 'manual' | 'resume';
  /** NDJSON event sink. Omit for buffered / background runs. */
  streamWriter?: StreamWriter;
  /** Actor IP for audit-log rows. Null for server-driven resumes. */
  actorIp?: string | null;
  /** User-Agent for audit-log rows. Null for server-driven resumes. */
  userAgent?: string | null;
  /** Whether the original caller requested `?stream=1`. Informational. */
  streamRequested?: boolean;
  /**
   * Pre-loaded state from a previous run. When provided, the runner skips
   * queue initialisation and continues from the leftover queue.
   */
  resumeState?: WaybackBulkState;
}

export interface RunBulkResult {
  totals: WaybackBulkTotals;
  durationMs: number;
}

const activeRunAbortControllers = new Map<string, AbortController>();

export function requestActiveBulkWaybackCancel(runId?: string | null): boolean {
  if (runId) {
    const controller = activeRunAbortControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  let aborted = false;
  for (const controller of activeRunAbortControllers.values()) {
    controller.abort();
    aborted = true;
  }
  return aborted;
}

/**
 * Check whether a new manual run can be started. Returns `{ ok: true }` if
 * no other run is active, otherwise `{ ok: false, reason: 'busy' }` so the
 * POST handler can map to a 409 response.
 */
export function canStartManualRun(): { ok: true } | { ok: false; reason: 'busy' } {
  if (isBulkMutexHeld() || readBulkState() !== null) {
    return { ok: false, reason: 'busy' };
  }
  return { ok: true };
}

/**
 * Query all apps eligible for Wayback import and turn them into a fresh
 * pending queue. Used when no resume state exists.
 */
export function buildInitialQueue(): { queue: QueueEntry[]; appCount: number } {
  const apps = db
    .prepare(
      `SELECT id, url, name
         FROM apps
        WHERE url IS NOT NULL AND TRIM(url) != ''
        ORDER BY name COLLATE NOCASE ASC`,
    )
    .all() as AppRow[];
  return {
    queue: apps.map<QueueEntry>(app => ({
      appId: app.id,
      appName: app.name,
      status: 'pending',
    })),
    appCount: apps.length,
  };
}

/**
 * Main loop. Preconditions:
 *   - If `resumeState` is present, callers should have already acquired
 *     the mutex (or the runner will do so defensively).
 *   - If absent, the runner creates a fresh state blob.
 *
 * Callers are responsible for any HTTP-level concerns (rate limiting,
 * request parsing). This function only talks to the DB + activity log.
 */
export async function runBulkWaybackImport(
  options: RunBulkOptions,
): Promise<RunBulkResult> {
  const writer: StreamWriter = options.streamWriter ?? (() => {});

  // Seed (or reuse) state. For a fresh run, we write it immediately so a
  // crash during the first app still leaves enough breadcrumbs to resume.
  let state: WaybackBulkState;
  if (options.resumeState) {
    state = options.resumeState;
    // Mark every `in_progress` back to `pending` — those are apps that
    // were mid-flight when the process died. We'll redo them from scratch.
    for (const entry of state.queue) {
      if (entry.status === 'in_progress') {
        entry.status = 'pending';
      }
    }
  } else {
    const { queue } = buildInitialQueue();
    state = {
      version: 1, // writeBulkState overrides, but keeps the type happy
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      initiator: options.initiator,
      updatedAt: Date.now(),
      currentAppId: null,
      status: 'running',
      queue,
      totals: zeroTotals(),
      streamRequested: options.streamRequested ?? false,
    };
  }

  // Defensively (re)acquire the mutex. The POST handler will have already
  // taken it, but the resume path doesn't, and a redundant set to 'true'
  // is harmless.
  state.status = 'running';
  delete state.pausedAt;
  delete state.pauseRequestedAt;
  delete state.cancelRequestedAt;
  acquireBulkMutex();
  writeBulkState(state);
  const abortController = new AbortController();
  activeRunAbortControllers.set(state.runId, abortController);

  const runStartedAt = Date.now();

  writer({
    type: 'batch-start',
    total: state.queue.length,
    startedAt: state.startedAt,
    initiator: state.initiator,
    runId: state.runId,
  });

  try {
    for (let i = 0; i < state.queue.length; i++) {
      const entry = state.queue[i];
      // Skip apps already completed in a previous life. `failed` entries
      // from a prior crash are NOT retried automatically — users can
      // kick off a new run to retry.
      if (entry.status === 'done' || entry.status === 'failed') continue;

      const preAppControl = finishIfControlRequested(state, writer, runStartedAt, options);
      if (preAppControl) return preAppControl;

      // Mark in-flight + persist before any work so a crash here is visible.
      entry.status = 'in_progress';
      entry.startedAt = Date.now();
      delete entry.finishedAt;
      delete entry.error;
      state.currentAppId = entry.appId;
      state.totals.appsAttempted++;
      writeBulkState(state);

      writer({
        type: 'app-start',
        appId: entry.appId,
        name: entry.appName,
        index: i,
        total: state.queue.length,
      });

      const app = lookupAppRow(entry.appId);
      // App may have been deleted between the original queue build and
      // now. Mark failed and move on rather than crashing the whole run.
      if (!app || !app.url) {
        const missingMsg = 'App no longer has a URL — may have been deleted.';
        entry.status = 'failed';
        entry.finishedAt = Date.now();
        entry.error = missingMsg;
        state.totals.failed++;
        state.currentAppId = null;
        writeBulkState(state);
        writer({
          type: 'app-done',
          appId: entry.appId,
          name: entry.appName,
          index: i,
          total: state.queue.length,
          error: missingMsg,
        });
        continue;
      }

      try {
        const result = await importAppHistory(app, {
          signal: abortController.signal,
          onProgress: (event: ImportProgressEvent) =>
            writer({ type: 'target', ...event }),
        });
        accumulateTotals(state.totals, result);
        entry.status = 'done';
        entry.finishedAt = Date.now();
        entry.imported = result.imported;
        entry.unchanged = result.unchanged;
        entry.skipped = result.skipped;
        entry.failed = result.failed;
        entry.snapshotsRequested = result.snapshotsRequested ?? 0;
        state.currentAppId = null;
        writeBulkState(state);

        recordActivity({
          type: 'wayback_import',
          status: pickAppActivityStatus(result),
          appId: app.id,
          appName: app.name,
          summary: buildAppSummary(app.name, result),
          detail: {
            mode: 'bulk-app',
            result,
            resumedRun: state.initiator === 'resume',
          },
          startedAt: entry.startedAt ?? Date.now(),
        });

        writer({
          type: 'app-done',
          appId: entry.appId,
          name: entry.appName,
          index: i,
          total: state.queue.length,
          result,
        });
      } catch (error) {
        if (isAbortError(error)) {
          state.currentAppId = null;
          const cancelled = finishIfControlRequested(state, writer, runStartedAt, options);
          if (cancelled) return cancelled;
          throw error;
        }
        const message =
          error instanceof Error ? error.message : 'import failed';
        entry.status = 'failed';
        entry.finishedAt = Date.now();
        entry.error = message.slice(0, 200);
        state.totals.failed++;
        state.currentAppId = null;
        writeBulkState(state);

        recordActivity({
          type: 'wayback_import',
          status: 'error',
          appId: app.id,
          appName: app.name,
          summary: `Wayback import failed for ${app.name}: ${message}`.slice(0, 200),
          detail: {
            mode: 'bulk-app',
            errorMessage: message,
            resumedRun: state.initiator === 'resume',
          },
          startedAt: entry.startedAt ?? Date.now(),
        });

        writer({
          type: 'app-done',
          appId: entry.appId,
          name: entry.appName,
          index: i,
          total: state.queue.length,
          error: message,
        });
      }

      const postAppControl = finishIfControlRequested(state, writer, runStartedAt, options);
      if (postAppControl) return postAppControl;
    }

    // Clean completion. Write the summary row, clear state + mutex.
    const durationMs = Date.now() - runStartedAt;
    writer({ type: 'summary', totals: state.totals, durationMs });

    recordActivity({
      type: 'wayback_import',
      status: state.totals.failed > 0 ? 'partial' : 'ok',
      summary: buildBulkSummary(state.totals, state.initiator, state.queue.length),
      detail: {
        mode: state.initiator === 'resume' ? 'bulk-resumed' : 'bulk',
        totals: state.totals,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action:
        state.initiator === 'resume'
          ? 'wayback.import.bulk.resumed.success'
          : 'wayback.import.bulk.success',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: true,
      detail:
        `apps=${state.queue.length} imported=${state.totals.imported} ` +
        `unchanged=${state.totals.unchanged} skipped=${state.totals.skipped} ` +
        `failed=${state.totals.failed}`,
    });

    clearBulkState();
    releaseBulkMutex();

    return { totals: state.totals, durationMs };
  } catch (error) {
    // Outer catch — this fires if the loop itself crashes (DB I/O error,
    // OOM, etc.), not for per-app failures which are handled inline above.
    // We INTENTIONALLY leave state + mutex in place so `instrumentation.ts`
    // can pick up on the next startup.
    const message = error instanceof Error ? error.message : 'Bulk import failed';
    writer({ type: 'error', error: message });
    recordActivity({
      type: 'wayback_import',
      status: 'error',
      summary: `Bulk Wayback import aborted: ${message}`.slice(0, 200),
      detail: {
        mode: 'bulk',
        errorMessage: message,
        totals: state.totals,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action: 'wayback.import.bulk.failed',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: false,
      detail: message.slice(0, 200),
    });
    throw error;
  } finally {
    if (activeRunAbortControllers.get(state.runId) === abortController) {
      activeRunAbortControllers.delete(state.runId);
    }
  }
}

function syncControlStatusFromDisk(state: WaybackBulkState): void {
  const persisted = readBulkState();
  if (!persisted || persisted.runId !== state.runId) return;
  if (persisted.status === 'pause_requested' || persisted.status === 'cancel_requested') {
    state.status = persisted.status;
    state.pauseRequestedAt = persisted.pauseRequestedAt;
    state.cancelRequestedAt = persisted.cancelRequestedAt;
  }
}

function finishIfControlRequested(
  state: WaybackBulkState,
  writer: StreamWriter,
  runStartedAt: number,
  options: RunBulkOptions,
): RunBulkResult | null {
  syncControlStatusFromDisk(state);

  if (state.status === 'pause_requested') {
    const durationMs = Date.now() - runStartedAt;
    state.status = 'paused';
    state.pausedAt = Date.now();
    state.currentAppId = null;
    writeBulkState(state);
    releaseBulkMutex();

    const summary = summariseState(state);
    const message =
      `Wayback import paused — ${summary.remaining} of ${summary.total} app${
        summary.total === 1 ? '' : 's'
      } remaining`;

    writer({
      type: 'paused',
      totals: state.totals,
      durationMs,
      summary,
    });
    recordActivity({
      type: 'wayback_import',
      status: 'cancelled',
      summary: message,
      detail: {
        mode: 'bulk-paused',
        totals: state.totals,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action: 'wayback.import.bulk.paused',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: true,
      detail: `remaining=${summary.remaining} total=${summary.total}`,
    });
    return { totals: state.totals, durationMs };
  }

  if (state.status === 'cancel_requested') {
    const durationMs = Date.now() - runStartedAt;
    const summary = summariseState(state);
    const message =
      `Wayback import cancelled — ${summary.remaining} of ${summary.total} app${
        summary.total === 1 ? '' : 's'
      } not processed`;

    writer({
      type: 'cancelled',
      totals: state.totals,
      durationMs,
      summary,
    });
    recordActivity({
      type: 'wayback_import',
      status: 'cancelled',
      summary: message,
      detail: {
        mode: 'bulk',
        cancelled: true,
        totals: state.totals,
        runId: state.runId,
        remaining: summary.remaining,
        total: summary.total,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action: 'wayback.import.bulk.cancelled',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: true,
      detail: `remaining=${summary.remaining} total=${summary.total}`,
    });
    clearBulkState();
    releaseBulkMutex();
    return { totals: state.totals, durationMs };
  }

  return null;
}

function lookupAppRow(appId: string): AppRow | null {
  const row = db
    .prepare(`SELECT id, url, name FROM apps WHERE id = ?`)
    .get(appId) as AppRow | undefined;
  if (!row) return null;
  return row;
}

function accumulateTotals(
  totals: WaybackBulkTotals,
  result: ImportAppHistoryResult,
): void {
  totals.targetsAttempted += result.attempted;
  totals.imported += result.imported;
  totals.unchanged += result.unchanged;
  totals.skipped += result.skipped;
  totals.failed += result.failed;
  totals.snapshotsRequested += result.snapshotsRequested ?? 0;
  if (result.imported > 0) totals.appsWithImports++;
}

function buildBulkSummary(
  totals: WaybackBulkTotals,
  initiator: 'manual' | 'resume',
  queueLength: number,
): string {
  const parts: string[] = [];
  parts.push(`${totals.imported} imported`);
  if (totals.unchanged) parts.push(`${totals.unchanged} no-op`);
  if (totals.skipped) parts.push(`${totals.skipped} skipped`);
  if (totals.failed) parts.push(`${totals.failed} failed`);
  if (totals.snapshotsRequested) {
    parts.push(
      `${totals.snapshotsRequested} snapshot${
        totals.snapshotsRequested === 1 ? '' : 's'
      } requested`,
    );
  }
  const prefix = initiator === 'resume' ? 'Wayback import (resumed)' : 'Wayback import';
  return `${prefix} across ${queueLength} apps: ${parts.join(', ')}`.slice(0, 200);
}

function pickAppActivityStatus(result: ImportAppHistoryResult) {
  if (result.failed === 0) return 'ok' as const;
  const anySuccess = result.imported > 0 || result.unchanged > 0;
  return anySuccess ? ('partial' as const) : ('error' as const);
}

function buildAppSummary(appName: string, result: ImportAppHistoryResult): string {
  const parts: string[] = [];
  if (result.imported) parts.push(`${result.imported} imported`);
  if (result.unchanged) parts.push(`${result.unchanged} no-op`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  if (result.failed) parts.push(`${result.failed} failed`);
  if (result.snapshotsRequested) {
    parts.push(
      `${result.snapshotsRequested} snapshot${
        result.snapshotsRequested === 1 ? '' : 's'
      } requested`,
    );
  }
  const tail = parts.length ? parts.join(', ') : 'nothing to do';
  return `Wayback import for ${appName}: ${tail}`.slice(0, 200);
}

/**
 * Public summary of what runBulkWaybackImport will find on disk. Used by
 * the GET handler + instrumentation startup check. Always safe to call
 * from anywhere — no side effects.
 */
export function describeCurrentRun(): {
  running: boolean;
  mutexHeld: boolean;
  status: WaybackBulkState['status'] | 'idle' | 'stale';
  state: WaybackBulkState | null;
  summary: ReturnType<typeof summariseState> | null;
  currentAppName: string | null;
  stale: boolean;
} {
  const state = readBulkState();
  const mutexHeld = isBulkMutexHeld();
  const summary = state ? summariseState(state) : null;
  const currentAppName = state?.currentAppId
    ? state.queue.find(e => e.appId === state.currentAppId)?.appName ?? null
    : null;
  // "Stale" = mutex is still held but either the state is gone or has no
  // work left. Startup will clear this to unblock future manual runs.
  const stale = mutexHeld && !hasPendingWork(state);
  const status = stale ? 'stale' : state?.status ?? (mutexHeld ? 'running' : 'idle');
  return {
    running: mutexHeld && !stale && status !== 'paused',
    mutexHeld,
    status,
    state,
    summary,
    currentAppName,
    stale,
  };
}
