export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '../../../../lib/db';
import { describeCurrentRun as describeWaybackRun } from '../../../../lib/wayback-bulk-runner';
import { describeCurrentSyncRun } from '../../../../lib/sync-bulk-runner';
import { describeCurrentPolicyRun } from '../../../../lib/policy-bulk-runner';

/**
 * Unified snapshot of every crash-safe bulk job currently in flight.
 *
 * Consumed by the TaskCenter poller on mount + every few seconds so the
 * "Background tasks" panel can rehydrate after a page refresh or after
 * an auto-resume kicked off by `instrumentation.ts`. Returns a small,
 * UI-shaped payload for each of the three jobs:
 *
 *   {
 *     wayback: { running, initiator, currentAppName, summary },
 *     sync:    { running, initiator, currentAppName, summary },
 *     policy:  { running, initiator, currentAppName, summary },
 *   }
 *
 * Each job-level object is always present (even when not running) so the
 * client can do a straight-line comparison against its own state and
 * decide whether to `startTask`, `update`, or `complete`.
 *
 * Design note — we keep this endpoint read-only and side-effect-free.
 * The corresponding per-job GETs (`/api/wayback/import-all`,
 * `/api/policy/sync-all`) are still the source of truth for their own
 * detailed UIs; this endpoint exists as a single poll for the
 * TaskCenter which would otherwise need three parallel fetches on every
 * refresh.
 */

interface ActiveJobView {
  running: boolean;
  mutexHeld: boolean;
  stale: boolean;
  status?: string;
  initiator: 'manual' | 'scheduled' | 'automatic' | 'resume' | null;
  currentAppName: string | null;
  /** Same shape as each runner's per-status counts. */
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    done: number;
    failed: number;
    remaining: number;
  } | null;
  /** Rolling totals when a state blob exists, otherwise null. */
  totals: unknown | null;
  /** Run UUID so clients can tell a fresh run apart from the previous one. */
  runId: string | null;
  startedAt: number | null;
  updatedAt: number | null;
}

interface ActivePolicyRunView {
  appId: string;
  appName: string | null;
  runStartedAt: number | null;
  updatedAt: number | null;
  lastPhase: string | null;
  lastPhaseNote: string | null;
}

function viewWayback(): ActiveJobView {
  const info = describeWaybackRun();
  return {
    running: info.running,
    mutexHeld: info.mutexHeld,
    stale: info.stale,
    status: info.status,
    initiator: info.state?.initiator ?? null,
    currentAppName: info.currentAppName,
    summary: info.summary,
    totals: info.state?.totals ?? null,
    runId: info.state?.runId ?? null,
    startedAt: info.state?.startedAt ?? null,
    updatedAt: info.state?.updatedAt ?? null,
  };
}

function viewSync(): ActiveJobView {
  const info = describeCurrentSyncRun();
  return {
    running: info.running,
    mutexHeld: info.mutexHeld,
    stale: info.stale,
    initiator: info.state?.initiator ?? null,
    currentAppName: info.currentAppName,
    summary: info.summary,
    totals: info.state?.totals ?? null,
    runId: info.state?.runId ?? null,
    startedAt: info.state?.startedAt ?? null,
    updatedAt: info.state?.updatedAt ?? null,
  };
}

function viewPolicy(): ActiveJobView {
  const info = describeCurrentPolicyRun();
  return {
    running: info.running,
    mutexHeld: info.mutexHeld,
    stale: info.stale,
    initiator: info.state?.initiator ?? null,
    currentAppName: info.currentAppName,
    summary: info.summary,
    totals: info.state?.totals ?? null,
    runId: info.state?.runId ?? null,
    startedAt: info.state?.startedAt ?? null,
    updatedAt: info.state?.updatedAt ?? null,
  };
}

function viewPolicyRuns(): ActivePolicyRunView[] {
  const rows = db
    .prepare(
      `SELECT p.app_id, p.run_started_at, p.updated_at, p.last_run_log, a.name AS app_name
         FROM privacy_policy_analyses p
         LEFT JOIN apps a ON a.id = p.app_id
        WHERE p.run_status = 'running'
        ORDER BY COALESCE(p.run_started_at, p.updated_at) ASC
        LIMIT 10`,
    )
    .all() as Array<{
      app_id: string;
      app_name: string | null;
      run_started_at: number | null;
      updated_at: number | null;
      last_run_log: string | null;
    }>;

  return rows.map(row => {
    let lastPhase: string | null = null;
    let lastPhaseNote: string | null = null;
    if (row.last_run_log) {
      try {
        const parsed = JSON.parse(row.last_run_log);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const tail = parsed[parsed.length - 1] as { phase?: unknown; note?: unknown } | undefined;
          lastPhase = typeof tail?.phase === 'string' ? tail.phase : null;
          lastPhaseNote = typeof tail?.note === 'string' ? tail.note : null;
        }
      } catch {
        // Corrupt run logs should not break the task center poll.
      }
    }
    return {
      appId: row.app_id,
      appName: row.app_name,
      runStartedAt: row.run_started_at ?? null,
      updatedAt: row.updated_at ?? null,
      lastPhase,
      lastPhaseNote,
    };
  });
}

export async function GET() {
  return NextResponse.json({
    wayback: viewWayback(),
    sync: viewSync(),
    policy: viewPolicy(),
    policyRuns: viewPolicyRuns(),
  });
}
