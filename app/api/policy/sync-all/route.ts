export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  readBoundedJson,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
} from '../../../../lib/security';
import {
  runBulkPolicySync,
  canStartPolicyManualRun,
  buildInitialPolicyQueue,
  describeCurrentPolicyRun,
  type PolicyStreamWriter,
  type PolicyBulkPhase,
} from '../../../../lib/policy-bulk-runner';
import { zeroPolicyTotals } from '../../../../lib/policy-bulk-state';

/**
 * Bulk privacy-policy sync across every app that exposes a developer
 * privacy-policy link.
 *
 *   GET    /api/policy/sync-all
 *          Returns `describeCurrentPolicyRun()` output — used by
 *          SettingsView + TaskCenter to rehydrate the progress card on
 *          mount and poll while a run (including an auto-resumed one) is
 *          in flight.
 *
 *   POST   /api/policy/sync-all
 *          Body: { phase: 'fetch' | 'all', force?: boolean, stream?: boolean }
 *          Driven by the "Privacy Policies" section in Settings — two
 *          buttons (Re-scrape all / Summarise all) plus a Force re-scrape
 *          checkbox. With `stream: true` returns NDJSON per-app progress,
 *          otherwise a buffered summary.
 *
 * The heavy lifting — state persistence, mutex management, per-app
 * classification, activity + audit rows, resume-safe queue — lives in
 * `lib/policy-bulk-runner.ts`. This file is a thin HTTP glue layer:
 * rate-limit + 409-precheck + stream wiring on the way in, pass through
 * to the runner, wrap the result on the way out.
 *
 * 'summarise' on its own would skip the fetch and stall on whatever
 * stale source text happens to be cached, so only 'fetch' and 'all'
 * make sense in bulk. The single-app regenerate route still exposes
 * the full set.
 */
const VALID_PHASES: PolicyBulkPhase[] = ['fetch', 'all'];

/**
 * GET — live status of the bulk policy sync for SettingsView + TaskCenter.
 * Returns enough for the UI to render "<n>/<total> · <current app>" on
 * mount without waiting for the next `app-start` stream event.
 */
export async function GET() {
  const info = describeCurrentPolicyRun();
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
          phase: info.state.phase,
          force: info.state.force,
          currentAppId: info.state.currentAppId,
          totals: info.state.totals,
          // Omit the queue — it can be large; summary + currentAppName cover UI needs.
        }
      : null,
  });
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  // Rate-limit the endpoint itself — the inner loop is the real cost gate
  // (sequential, one app at a time) but we don't want 50 tabs hammering the
  // mutex check either.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'policy.sync-all'),
    limit: 4,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded for bulk policy sync. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let body: { phase?: unknown; force?: unknown; stream?: unknown } | null = null;
  try {
    body = await readBoundedJson<{ phase?: unknown; force?: unknown; stream?: unknown }>(
      request,
      2 * 1024,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request body' },
      { status: 400 },
    );
  }

  const rawPhase = typeof body?.phase === 'string' ? body.phase.trim() : 'fetch';
  const phase: PolicyBulkPhase = VALID_PHASES.includes(rawPhase as PolicyBulkPhase)
    ? (rawPhase as PolicyBulkPhase)
    : 'fetch';
  const force = body?.force === true;
  const wantStream = body?.stream === true;

  // Pre-flight: checks both the mutex and the persisted state blob — either
  // one being set means a previous/active run still owns the resource.
  const canStart = canStartPolicyManualRun();
  if (!canStart.ok) {
    return NextResponse.json(
      { error: 'A bulk policy sync is already running. Wait for it to finish before starting another.' },
      { status: 409 },
    );
  }

  // Build the queue up-front so we can early-return with a friendly empty
  // totals object when nothing is eligible, and so the audit row below can
  // cite the real app count.
  const { appCount } = buildInitialPolicyQueue();
  if (appCount === 0) {
    return NextResponse.json(
      {
        error: 'No apps have a developer privacy-policy link to sync.',
        totals: zeroPolicyTotals(),
        phase,
        force,
      },
      { status: 200 },
    );
  }

  recordAudit({
    action: 'policy.sync-all.start',
    actorIp,
    userAgent,
    success: true,
    detail: `phase=${phase} force=${force ? 1 : 0} apps=${appCount} stream=${wantStream ? 1 : 0}`,
  });

  if (wantStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer: PolicyStreamWriter = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
          } catch {
            /* client disconnected — ignore */
          }
        };

        try {
          await runBulkPolicySync({
            initiator: 'manual',
            phase,
            force,
            streamWriter: writer,
            actorIp,
            userAgent,
            streamRequested: true,
          });
        } catch {
          // runBulkPolicySync already emits a `type: 'error'` frame, an
          // audit row, and intentionally leaves state+mutex so startup can
          // resume. Nothing else to do here besides closing the stream.
        } finally {
          try {
            controller.close();
          } catch {
            /* ignore — already closed */
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

  // Buffered mode (no streaming) — intended for scripts / curl. Runner
  // leaves state+mutex in place if it throws so the next startup can resume.
  try {
    const result = await runBulkPolicySync({
      initiator: 'manual',
      phase,
      force,
      actorIp,
      userAgent,
      streamRequested: false,
    });
    return NextResponse.json({
      totals: result.totals,
      phase,
      force,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bulk policy sync failed';
    return NextResponse.json(
      { error: message, totals: zeroPolicyTotals(), phase, force },
      { status: 500 },
    );
  }
}
