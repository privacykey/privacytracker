export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  removeImportedHistory,
} from '../../../../lib/historical-import';
import { recordActivity } from '../../../../lib/activity';
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
} from '../../../../lib/security';
import {
  runBulkWaybackImport,
  canStartManualRun,
  buildInitialQueue,
  describeCurrentRun,
  type StreamWriter,
} from '../../../../lib/wayback-bulk-runner';
import { zeroTotals } from '../../../../lib/wayback-bulk-state';

/**
 * Bulk historical import across every app with an App Store URL.
 *
 *   GET    /api/wayback/import-all
 *          Returns `describeCurrentRun()` output — used by SettingsView to
 *          rehydrate the "N of M · AppName" progress card on mount and to
 *          poll while a run (including an auto-resumed one) is in flight.
 *
 *   POST   /api/wayback/import-all[?stream=1]
 *          Runs the bulk loop sequentially over every app. With `?stream=1`
 *          returns NDJSON so the Settings UI can render a running progress
 *          tally; otherwise returns a buffered summary at the end.
 *
 *   DELETE /api/wayback/import-all
 *          Wipes every wayback-sourced row across the database. Used by
 *          the Settings "Remove all imported history" action.
 *
 * The heavy lifting — state persistence, mutex management, activity/audit
 * rows, resume-safe queue — lives in `lib/wayback-bulk-runner.ts`. This
 * file is now a thin HTTP glue layer: rate-limit + 409-precheck + stream
 * wiring on the way in, pass through to the runner, wrap the result on the
 * way out.
 */

/**
 * GET — live status of the bulk Wayback import for SettingsView's poller.
 * The mutex alone isn't enough because the UI also wants the per-app
 * progress so it can show "3/12 · Netflix" immediately on navigation
 * rather than waiting for the next `app-start` event to land (which only
 * flows through the active stream, not out-of-band).
 */
export async function GET() {
  const info = describeCurrentRun();
  return NextResponse.json({
    running: info.running,
    mutexHeld: info.mutexHeld,
    stale: info.stale,
    currentAppName: info.currentAppName,
    summary: info.summary,
    state: info.state
      ? {
          runId: info.state.runId,
          startedAt: info.state.startedAt,
          updatedAt: info.state.updatedAt,
          initiator: info.state.initiator,
          currentAppId: info.state.currentAppId,
          totals: info.state.totals,
          // Don't echo the whole queue — it can be large and the UI only
          // needs counts + the current app. summariseState() gives that.
        }
      : null,
  });
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');
  const url = new URL(request.url);
  const wantStream = url.searchParams.get('stream') === '1' || url.searchParams.get('stream') === 'true';

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'wayback.import-all'),
    limit: 2,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Bulk import throttled — wait before retrying.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  // Pre-flight: can this user start a manual run right now? `canStartManualRun`
  // checks both the mutex and the persisted state blob — either one being set
  // means a previous/active run still owns the resource, so we return 409
  // rather than stepping on its state.
  const canStart = canStartManualRun();
  if (!canStart.ok) {
    return NextResponse.json(
      { error: 'A Wayback import is already running. Wait for it to finish before starting another.' },
      { status: 409 },
    );
  }

  // Build the queue up-front so we can early-return with a friendly empty
  // totals object when nothing is eligible, and so the audit row below can
  // cite the real app count.
  const { appCount } = buildInitialQueue();
  if (appCount === 0) {
    return NextResponse.json(
      {
        error: 'No apps to import history for.',
        totals: zeroTotals(),
      },
      { status: 200 },
    );
  }

  recordAudit({
    action: 'wayback.import.bulk.start',
    actorIp,
    userAgent,
    success: true,
    detail: `apps=${appCount} stream=${wantStream ? 1 : 0}`,
  });

  if (wantStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer: StreamWriter = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
          } catch {
            /* client disconnected — ignore */
          }
        };

        try {
          await runBulkWaybackImport({
            initiator: 'manual',
            streamWriter: writer,
            actorIp,
            userAgent,
            streamRequested: true,
          });
        } catch {
          // runBulkWaybackImport already emits a `type: 'error'` frame, an
          // audit row, and intentionally leaves state+mutex so startup can
          // resume. Nothing else to do here besides closing the stream.
        } finally {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
      },
    });
  }

  // Buffered mode (no streaming) — just await the runner and return its
  // summary. If the runner throws (outer catch), state+mutex are left in
  // place on purpose so the next startup can resume.
  try {
    const result = await runBulkWaybackImport({
      initiator: 'manual',
      actorIp,
      userAgent,
      streamRequested: false,
    });
    return NextResponse.json({
      totals: result.totals,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bulk import failed';
    return NextResponse.json(
      { error: message, totals: zeroTotals() },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');
  const startedAt = Date.now();
  const deleted = removeImportedHistory();

  recordAudit({
    action: 'wayback.import.bulk.remove',
    actorIp,
    userAgent,
    success: true,
    detail: `deleted=${deleted}`,
  });
  recordActivity({
    type: 'wayback_import',
    status: 'ok',
    summary: `Removed ${deleted} imported history row${deleted === 1 ? '' : 's'}`,
    detail: { mode: 'bulk', removed: true, deleted },
    startedAt,
  });
  return NextResponse.json({ deleted });
}
