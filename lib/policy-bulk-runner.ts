/**
 * Orchestrates a bulk privacy-policy sync across every app with a developer
 * privacy-policy link, persisting state to SQLite after each app so a
 * server crash mid-run can be resumed on the next startup.
 *
 * Called from two places:
 *   - `POST /api/policy/sync-all` (user-initiated, optionally streaming)
 *   - `instrumentation.ts` startup (auto-resume, always background/buffered)
 *
 * Design mirrors `lib/wayback-bulk-runner.ts` — the state module holds the
 * blob + mutex, the runner owns the loop and all activity/audit writes.
 * `syncPrivacyPolicyAnalysis` is safe to re-run because its text-hash
 * short-circuit skips the expensive AI call when the hash still matches,
 * and `bypassThrottle` / `forceResummarise` are preserved across resume so
 * cost profile stays stable.
 */

import crypto from 'crypto';
import db from './db';
import { recordActivity } from './activity';
import { recordAudit } from './security';
import {
  syncPrivacyPolicyAnalysis,
  type PolicyPhase,
  type PolicyPhaseStream,
} from './privacy-policy';
import type { PolicyRunPhase } from './policy-summary-meta';
import {
  readPolicyBulkState,
  writePolicyBulkState,
  clearPolicyBulkState,
  acquirePolicyBulkMutex,
  releasePolicyBulkMutex,
  isPolicyBulkMutexHeld,
  zeroPolicyTotals,
  summarisePolicyState,
  hasPolicyPendingWork,
  type PolicyBulkState,
  type PolicyBulkTotals,
  type PolicyQueueEntry,
  type PolicyAppOutcome,
} from './policy-bulk-state';

/** Row shape pulled from `apps` to seed the queue. */
export interface PolicyAppRow {
  id: string;
  name: string;
  developer: string | null;
  privacyPolicyUrl: string | null;
}

/** NDJSON writer; caller passes a real writer for streamed POSTs, nothing otherwise. */
export type PolicyStreamWriter = (obj: unknown) => void;

/**
 * The bulk endpoint only supports the two cost-sensible phases. 'summarise'
 * on its own would skip the fetch and stall on whatever stale source text
 * happened to be cached, so the single-app regenerate route is the only
 * place it's exposed.
 */
export type PolicyBulkPhase = Extract<PolicyPhase, 'fetch' | 'all'>;

export interface RunPolicyBulkOptions {
  initiator: 'manual' | 'automatic' | 'resume';
  phase: PolicyBulkPhase;
  /** Bypass the per-app scrape throttle for this batch. */
  force: boolean;
  /** NDJSON event sink. Omit for buffered / background runs. */
  streamWriter?: PolicyStreamWriter;
  actorIp?: string | null;
  userAgent?: string | null;
  streamRequested?: boolean;
  resumeState?: PolicyBulkState;
}

export interface RunPolicyBulkResult {
  totals: PolicyBulkTotals;
  durationMs: number;
}

/**
 * Classify a `syncPrivacyPolicyAnalysis` outcome into one of the four
 * bulk-totals buckets. Mirrors the logic the inlined route used before
 * the refactor so UI consumers see identical accounting.
 */
function classifyOutcome(
  analysisStatus: string | undefined,
  throttled: boolean,
): PolicyAppOutcome {
  if (throttled) return 'throttled';
  if (analysisStatus === 'ready' || analysisStatus === 'source_ready') {
    return 'succeeded';
  }
  return 'failed';
}

/**
 * Detect "throttle hit, returned prior state" by looking at the last
 * entry in the analysis's run log. Copied from the original route so
 * resumed and streamed runs classify the same way.
 */
function wasThrottled(lastRunLog: unknown): boolean {
  if (!Array.isArray(lastRunLog) || lastRunLog.length === 0) return false;
  const tail = lastRunLog[lastRunLog.length - 1] as { phase?: string } | undefined;
  return tail?.phase === 'throttled';
}

/**
 * Can a new manual run start right now? Returns `{ ok: true }` if neither
 * the mutex nor the state blob is claimed, otherwise `{ ok: false }` so
 * the POST handler can return a 409 response.
 */
export function canStartPolicyManualRun(): { ok: true } | { ok: false; reason: 'busy' } {
  if (isPolicyBulkMutexHeld() || readPolicyBulkState() !== null) {
    return { ok: false, reason: 'busy' };
  }
  return { ok: true };
}

/**
 * Query all eligible apps and turn them into a fresh pending queue. Used
 * when no resume state exists. Apps are sorted by name for a stable
 * ordering across runs and for a nicer UX ("A… B… C…").
 */
export function buildInitialPolicyQueue(): {
  queue: PolicyQueueEntry[];
  appCount: number;
} {
  const apps = db
    .prepare(
      `SELECT id, name, developer, privacyPolicyUrl
         FROM apps
        WHERE privacyPolicyUrl IS NOT NULL
          AND TRIM(privacyPolicyUrl) != ''
        ORDER BY name COLLATE NOCASE ASC`,
    )
    .all() as PolicyAppRow[];
  return {
    queue: apps
      .filter(app => app.privacyPolicyUrl) // defensive: SQL already excludes these
      .map<PolicyQueueEntry>(app => ({
        appId: app.id,
        appName: app.name,
        policyUrl: app.privacyPolicyUrl as string,
        status: 'pending',
      })),
    appCount: apps.length,
  };
}

/**
 * Fetch the full row for a queued app by id. Done at dequeue time rather
 * than cached in the queue blob so a mid-run DB rename or URL change
 * takes effect on the next tick without us persisting stale strings.
 */
function lookupPolicyAppRow(appId: string): PolicyAppRow | null {
  const row = db
    .prepare(`SELECT id, name, developer, privacyPolicyUrl FROM apps WHERE id = ?`)
    .get(appId) as PolicyAppRow | undefined;
  return row ?? null;
}

function bulkSummaryLine(phase: PolicyBulkPhase, totals: PolicyBulkTotals): string {
  const verb = phase === 'all' ? 'summarise' : 'scrape';
  const parts = [`${totals.succeeded} ok`];
  if (totals.failed) parts.push(`${totals.failed} failed`);
  if (totals.throttled) parts.push(`${totals.throttled} throttled`);
  if (totals.skipped) parts.push(`${totals.skipped} skipped`);
  return `Bulk policy ${verb}: ${parts.join(', ')}`;
}

/**
 * Main loop. Preconditions:
 *   - If `resumeState` is present, callers should have already acquired
 *     the mutex (or the runner will do so defensively).
 *   - If absent, the runner creates a fresh state blob.
 *
 * Callers are responsible for HTTP concerns (rate limits, body parsing).
 * This function only talks to the DB + activity log.
 */
export async function runBulkPolicySync(
  options: RunPolicyBulkOptions,
): Promise<RunPolicyBulkResult> {
  const writer: PolicyStreamWriter = options.streamWriter ?? (() => {});

  let state: PolicyBulkState;
  if (options.resumeState) {
    state = options.resumeState;
    // Flip any `in_progress` entries back to `pending` — those were the
    // app(s) mid-flight when the previous process died. We'll redo them.
    for (const entry of state.queue) {
      if (entry.status === 'in_progress') {
        entry.status = 'pending';
      }
    }
  } else {
    const { queue } = buildInitialPolicyQueue();
    state = {
      version: 1, // writePolicyBulkState overrides
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      initiator: options.initiator,
      updatedAt: Date.now(),
      phase: options.phase,
      force: options.force,
      currentAppId: null,
      queue,
      totals: zeroPolicyTotals(),
      streamRequested: options.streamRequested ?? false,
    };
  }

  // Defensive mutex acquire — POST handler takes it already, resume path
  // doesn't. A redundant set to 'true' is harmless.
  acquirePolicyBulkMutex();
  writePolicyBulkState(state);

  // 'all' implies force-resummarise; 'force' (bypass throttle) also implies
  // it because paying the bypass cost only makes sense to get fresh AI
  // output. Same logic the original route used.
  const forceResummarise = state.force || state.phase === 'all';
  const runStartedAt = Date.now();

  writer({
    type: 'batch-start',
    total: state.queue.length,
    phase: state.phase,
    force: state.force,
    startedAt: state.startedAt,
    initiator: state.initiator,
    runId: state.runId,
  });

  try {
    for (let i = 0; i < state.queue.length; i++) {
      const entry = state.queue[i];
      // Skip apps already completed in a prior life. `failed` is intentional
      // — a user can kick off a new run to retry them.
      if (entry.status === 'done' || entry.status === 'failed') continue;

      // Mark in-flight + persist BEFORE any work so a crash here is visible.
      entry.status = 'in_progress';
      entry.startedAt = Date.now();
      delete entry.finishedAt;
      delete entry.error;
      delete entry.outcome;
      delete entry.analysisStatus;
      state.currentAppId = entry.appId;
      state.totals.attempted++;
      writePolicyBulkState(state);

      writer({
        type: 'app-start',
        appId: entry.appId,
        name: entry.appName,
        index: i,
        total: state.queue.length,
      });

      // Refresh the app row — the user may have edited the URL / renamed
      // the app between queue build and dequeue.
      const app = lookupPolicyAppRow(entry.appId);
      if (!app || !app.privacyPolicyUrl) {
        const reason = !app
          ? 'App no longer exists.'
          : 'App no longer has a privacy policy URL.';
        entry.status = 'done'; // treat as completed-with-skip so we don't retry on resume
        entry.finishedAt = Date.now();
        entry.outcome = 'skipped';
        state.totals.skipped++;
        state.currentAppId = null;
        writePolicyBulkState(state);
        writer({
          type: 'app-done',
          appId: entry.appId,
          name: entry.appName,
          status: 'skipped',
          index: i,
          total: state.queue.length,
          note: reason,
        });
        continue;
      }

      const phaseStream: PolicyPhaseStream = {
        emit: (phaseEvent: PolicyRunPhase) =>
          writer({
            type: 'phase',
            appId: app.id,
            phase: phaseEvent,
          }),
      };

      try {
        const analysis = await syncPrivacyPolicyAnalysis(
          {
            appId: app.id,
            appName: app.name,
            developer: app.developer ?? undefined,
            policyUrl: app.privacyPolicyUrl,
          },
          {
            phase: state.phase,
            phaseStream,
            forceResummarise,
            bypassThrottle: state.force,
          },
        );
        const analysisStatus = analysis?.status ?? 'unknown';
        const throttled = analysis ? wasThrottled(analysis.lastRunLog) : false;
        const outcome = classifyOutcome(analysisStatus, throttled);

        entry.status = 'done';
        entry.finishedAt = Date.now();
        entry.outcome = outcome;
        entry.analysisStatus = analysisStatus;
        switch (outcome) {
          case 'succeeded':
            state.totals.succeeded++;
            break;
          case 'throttled':
            state.totals.throttled++;
            break;
          case 'failed':
            state.totals.failed++;
            break;
          case 'skipped':
            state.totals.skipped++;
            break;
        }
        state.currentAppId = null;
        writePolicyBulkState(state);

        writer({
          type: 'app-done',
          appId: app.id,
          name: app.name,
          status: analysisStatus,
          throttled,
          index: i,
          total: state.queue.length,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Bulk policy sync error';
        entry.status = 'failed';
        entry.finishedAt = Date.now();
        entry.error = message.slice(0, 200);
        entry.outcome = 'failed';
        state.totals.failed++;
        state.currentAppId = null;
        writePolicyBulkState(state);

        writer({
          type: 'app-done',
          appId: app.id,
          name: app.name,
          status: 'error',
          error: message,
          index: i,
          total: state.queue.length,
        });
      }
    }

    // Clean completion — write summary row + audit, clear state + mutex.
    const durationMs = Date.now() - runStartedAt;
    writer({
      type: 'summary',
      totals: state.totals,
      phase: state.phase,
      force: state.force,
      durationMs,
    });

    const summaryLine = bulkSummaryLine(state.phase, state.totals);
    const activitySummary =
      state.initiator === 'resume'
        ? `${summaryLine} (resumed after restart)`.slice(0, 200)
        : summaryLine.slice(0, 200);

    recordActivity({
      type: 'policy_summary',
      status: state.totals.failed > 0 ? 'partial' : 'ok',
      summary: activitySummary,
      detail: {
        mode: state.initiator === 'resume' ? 'bulk-resumed' : 'bulk',
        phase: state.phase,
        force: state.force,
        totals: state.totals,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action:
        state.initiator === 'resume'
          ? 'policy.sync-all.resumed.success'
          : 'policy.sync-all.success',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: true,
      detail:
        `phase=${state.phase} force=${state.force ? 1 : 0} ` +
        `attempted=${state.totals.attempted} ok=${state.totals.succeeded} ` +
        `fail=${state.totals.failed} throttled=${state.totals.throttled}`,
    });

    clearPolicyBulkState();
    releasePolicyBulkMutex();

    return { totals: state.totals, durationMs };
  } catch (error) {
    // Outer catch — loop itself blew up (DB I/O, OOM). Leave state + mutex
    // in place so `instrumentation.ts` can resume on the next boot.
    const message =
      error instanceof Error ? error.message : 'Bulk policy sync failed';
    writer({ type: 'error', error: message });
    recordActivity({
      type: 'policy_summary',
      status: 'error',
      summary: `Bulk policy sync aborted: ${message}`.slice(0, 200),
      detail: {
        mode: 'bulk',
        phase: state.phase,
        force: state.force,
        totals: state.totals,
        errorMessage: message,
        runId: state.runId,
      },
      startedAt: state.startedAt,
    });
    recordAudit({
      action: 'policy.sync-all.failed',
      actorIp: options.actorIp ?? null,
      userAgent: options.userAgent ?? null,
      success: false,
      detail: `phase=${state.phase} ${message.slice(0, 200)}`,
    });
    throw error;
  }
}

/**
 * Public summary of what `runBulkPolicySync` will find on disk. Used by
 * the GET handler + instrumentation startup check + unified tasks/active
 * endpoint. No side effects — safe to call anywhere.
 */
export function describeCurrentPolicyRun(): {
  running: boolean;
  mutexHeld: boolean;
  state: PolicyBulkState | null;
  summary: ReturnType<typeof summarisePolicyState> | null;
  currentAppName: string | null;
  stale: boolean;
} {
  const state = readPolicyBulkState();
  const mutexHeld = isPolicyBulkMutexHeld();
  const summary = state ? summarisePolicyState(state) : null;
  const currentAppName = state?.currentAppId
    ? state.queue.find(e => e.appId === state.currentAppId)?.appName ?? null
    : null;
  const stale = mutexHeld && !hasPolicyPendingWork(state);
  return {
    running: !!state || mutexHeld,
    mutexHeld,
    state,
    summary,
    currentAppName,
    stale,
  };
}
