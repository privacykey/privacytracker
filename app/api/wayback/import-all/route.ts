export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { recordActivity } from "../../../../lib/activity";
import { removeImportedHistory } from "../../../../lib/historical-import";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
} from "../../../../lib/security";
import {
  buildInitialQueue,
  canStartManualRun,
  describeCurrentRun,
  requestActiveBulkWaybackCancel,
  runBulkWaybackImport,
  type StreamWriter,
} from "../../../../lib/wayback-bulk-runner";
import {
  clearBulkState,
  hasPendingWork,
  isBulkMutexHeld,
  readBulkState,
  releaseBulkMutex,
  summariseState,
  writeBulkState,
  zeroTotals,
} from "../../../../lib/wayback-bulk-state";

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
 *          `?force=1` discards a paused/stale queue before starting fresh.
 *
 *   PATCH  /api/wayback/import-all
 *          Body `{ action: "pause" | "resume" | "cancel" }` controls a
 *          persisted queue. Pause/cancel are cooperative at app boundaries.
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
    status: info.status,
    stale: info.stale,
    currentAppName: info.currentAppName,
    summary: info.summary,
    state: info.state
      ? {
          runId: info.state.runId,
          startedAt: info.state.startedAt,
          updatedAt: info.state.updatedAt,
          initiator: info.state.initiator,
          status: info.state.status,
          pausedAt: info.state.pausedAt ?? null,
          pauseRequestedAt: info.state.pauseRequestedAt ?? null,
          cancelRequestedAt: info.state.cancelRequestedAt ?? null,
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
  const userAgent = request.headers.get("user-agent");
  const url = new URL(request.url);
  const wantStream =
    url.searchParams.get("stream") === "1" ||
    url.searchParams.get("stream") === "true";
  const force =
    url.searchParams.get("force") === "1" ||
    url.searchParams.get("force") === "true";

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "wayback.import-all"),
    limit: 2,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Bulk import throttled — wait before retrying." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  if (force) {
    const existing = describeCurrentRun();
    if (existing.mutexHeld && !existing.stale) {
      return NextResponse.json(
        {
          error:
            "A Wayback import is already running. Pause or cancel it before forcing a fresh import.",
        },
        { status: 409 }
      );
    }
    if (existing.state || existing.mutexHeld) {
      clearBulkState();
      releaseBulkMutex();
      recordAudit({
        action: "wayback.import.bulk.force_restart",
        actorIp,
        userAgent,
        success: true,
        detail: existing.state
          ? `discardedRunId=${existing.state.runId}`
          : "discarded stale mutex",
      });
      recordActivity({
        type: "wayback_import",
        status: "cancelled",
        summary:
          "Discarded paused Wayback import queue before starting a fresh import",
        detail: {
          mode: "bulk-force-restart",
          discardedRunId: existing.state?.runId ?? null,
        },
        startedAt: Date.now(),
      });
    }
  }

  // Pre-flight: can this user start a manual run right now? `canStartManualRun`
  // checks both the mutex and the persisted state blob — either one being set
  // means a previous/active run still owns the resource, so we return 409
  // rather than stepping on its state.
  const canStart = canStartManualRun();
  if (!canStart.ok) {
    return NextResponse.json(
      {
        error:
          "A Wayback import is already running. Wait for it to finish before starting another.",
      },
      { status: 409 }
    );
  }

  // Build the queue up-front so we can early-return with a friendly empty
  // totals object when nothing is eligible, and so the audit row below can
  // cite the real app count.
  const { appCount } = buildInitialQueue();
  if (appCount === 0) {
    return NextResponse.json(
      {
        error: "No apps to import history for.",
        totals: zeroTotals(),
      },
      { status: 200 }
    );
  }

  recordAudit({
    action: "wayback.import.bulk.start",
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
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
          } catch {
            /* client disconnected — ignore */
          }
        };

        try {
          await runBulkWaybackImport({
            initiator: "manual",
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
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
      },
    });
  }

  // Buffered mode (no streaming) — just await the runner and return its
  // summary. If the runner throws (outer catch), state+mutex are left in
  // place on purpose so the next startup can resume.
  try {
    const result = await runBulkWaybackImport({
      initiator: "manual",
      actorIp,
      userAgent,
      streamRequested: false,
    });
    return NextResponse.json({
      totals: result.totals,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Bulk import failed";
    return NextResponse.json(
      { error: message, totals: zeroTotals() },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "wayback.import-all.control"),
    limit: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "Wayback import controls are throttled — wait before retrying.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
  } | null;
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "pause") {
    const state = readBulkState();
    if (!state) {
      return NextResponse.json(
        { error: "No Wayback import queue is available to pause." },
        { status: 404 }
      );
    }
    if (state.status === "paused") {
      return NextResponse.json({
        ok: true,
        status: "paused",
        summary: summariseState(state),
      });
    }

    const next = {
      ...state,
      status: isBulkMutexHeld()
        ? ("pause_requested" as const)
        : ("paused" as const),
      pauseRequestedAt: Date.now(),
      pausedAt: isBulkMutexHeld() ? state.pausedAt : Date.now(),
      currentAppId: isBulkMutexHeld() ? state.currentAppId : null,
    };
    writeBulkState(next);
    if (!isBulkMutexHeld()) {
      releaseBulkMutex();
    }
    recordAudit({
      action: "wayback.import.bulk.pause_requested",
      actorIp,
      userAgent,
      success: true,
      detail: `runId=${state.runId}`,
    });
    return NextResponse.json({
      ok: true,
      status: next.status,
      summary: summariseState(next),
    });
  }

  if (action === "cancel") {
    const state = readBulkState();
    const mutexHeld = isBulkMutexHeld();
    if (!(state || mutexHeld)) {
      return NextResponse.json({ ok: true, status: "idle" });
    }
    if (state && mutexHeld) {
      const next = {
        ...state,
        status: "cancel_requested" as const,
        cancelRequestedAt: Date.now(),
      };
      writeBulkState(next);
      const aborted = requestActiveBulkWaybackCancel(state.runId);
      recordAudit({
        action: "wayback.import.bulk.cancel_requested",
        actorIp,
        userAgent,
        success: true,
        detail: `runId=${state.runId} aborted=${aborted ? 1 : 0}`,
      });
      return NextResponse.json({
        ok: true,
        status: "cancel_requested",
        aborted,
        summary: summariseState(next),
      });
    }

    const summary = state ? summariseState(state) : null;
    const startedAt = Date.now();
    clearBulkState();
    releaseBulkMutex();
    recordAudit({
      action: "wayback.import.bulk.cancelled",
      actorIp,
      userAgent,
      success: true,
      detail: state ? `runId=${state.runId}` : "stale mutex",
    });
    recordActivity({
      type: "wayback_import",
      status: "cancelled",
      summary: state
        ? `Cancelled Wayback import queue — ${summary?.remaining ?? 0} app${summary?.remaining === 1 ? "" : "s"} not processed`
        : "Cleared stale Wayback import lock",
      detail: {
        mode: "bulk",
        cancelled: true,
        runId: state?.runId ?? null,
        remaining: summary?.remaining ?? 0,
        total: summary?.total ?? 0,
      },
      startedAt,
    });
    return NextResponse.json({ ok: true, status: "cancelled", summary });
  }

  if (action === "resume") {
    const state = readBulkState();
    if (!(state && hasPendingWork(state))) {
      return NextResponse.json(
        { error: "No paused Wayback import queue is available to resume." },
        { status: 404 }
      );
    }
    if (state.status === "cancel_requested") {
      return NextResponse.json(
        { error: "This Wayback import is already cancelling." },
        { status: 409 }
      );
    }
    if (isBulkMutexHeld()) {
      return NextResponse.json(
        { error: "A Wayback import is already running." },
        { status: 409 }
      );
    }

    const resumeState = {
      ...state,
      status: "running" as const,
      pausedAt: undefined,
      pauseRequestedAt: undefined,
      cancelRequestedAt: undefined,
    };
    writeBulkState(resumeState);
    runBulkWaybackImport({
      initiator: "manual",
      actorIp,
      userAgent,
      streamRequested: false,
      resumeState,
    }).catch((error) => {
      console.error("[WaybackResume] Manual resume failed:", error);
    });
    recordAudit({
      action: "wayback.import.bulk.resume_requested",
      actorIp,
      userAgent,
      success: true,
      detail: `runId=${state.runId}`,
    });
    return NextResponse.json({
      ok: true,
      status: "running",
      summary: summariseState(resumeState),
    });
  }

  return NextResponse.json(
    { error: "Unknown Wayback control action." },
    { status: 400 }
  );
}

export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");
  const startedAt = Date.now();
  const deleted = removeImportedHistory();

  recordAudit({
    action: "wayback.import.bulk.remove",
    actorIp,
    userAgent,
    success: true,
    detail: `deleted=${deleted}`,
  });
  recordActivity({
    type: "wayback_import",
    status: "ok",
    summary: `Removed ${deleted} imported history row${deleted === 1 ? "" : "s"}`,
    detail: { mode: "bulk", removed: true, deleted },
    startedAt,
  });
  return NextResponse.json({ deleted });
}
