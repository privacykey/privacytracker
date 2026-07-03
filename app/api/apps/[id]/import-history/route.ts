export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { recordActivity } from "../../../../../lib/activity";
import db from "../../../../../lib/db";
import {
  type ImportAppHistoryResult,
  importAppHistory,
  removeImportedHistory,
} from "../../../../../lib/historical-import";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
} from "../../../../../lib/security";

/**
 * Per-app historical import from the Wayback Machine.
 *
 *   POST   /api/apps/[id]/import-history
 *          Runs a quarterly backfill for a single app. Returns the
 *          per-target outcome list so the Settings UI can show exactly
 *          which quarters landed and which were skipped.
 *
 *   DELETE /api/apps/[id]/import-history
 *          Removes every wayback-sourced snapshot for the app. Used by
 *          the per-app "Remove imported history" action so users can
 *          undo the import if the reconstructed timeline looks wrong.
 *
 * Both paths record a row in `activity_log` so the Developer Options
 * screen shows the run with its outcome. POST uses `wayback_import` as
 * the activity type; DELETE reuses the same type with a `removed=true`
 * marker in the detail blob so the activity filter still captures both.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Rate-limit per actor + app — a runaway script or accidental double-click
  // shouldn't hammer archive.org. 3/min is plenty for a manual button.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, `wayback.import.${id}`),
    limit: 3,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Import throttled — wait before retrying." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  const app = db
    .prepare("SELECT id, url, name FROM apps WHERE id = ?")
    .get(id) as { id: string; url: string; name: string } | undefined;
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }
  if (!app.url) {
    return NextResponse.json(
      { error: "App has no App Store URL to import history from." },
      { status: 422 }
    );
  }

  // Optional denser cadence. Body `{ intervalMonths: 1..6 }` overrides the
  // default quarterly reconstruction (1 = monthly). Anything missing or out
  // of range falls back to the default — the button has no body at all.
  let intervalMonths: number | undefined;
  const body = (await request.json().catch(() => null)) as {
    intervalMonths?: unknown;
  } | null;
  const rawInterval = body?.intervalMonths;
  if (
    typeof rawInterval === "number" &&
    Number.isFinite(rawInterval) &&
    rawInterval >= 1 &&
    rawInterval <= 6
  ) {
    intervalMonths = Math.floor(rawInterval);
  }

  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");
  const startedAt = Date.now();

  recordAudit({
    action: "wayback.import.app.start",
    actorIp,
    userAgent,
    success: true,
    detail: `app=${id}`,
  });

  let result: ImportAppHistoryResult;
  try {
    result = await importAppHistory(
      app,
      intervalMonths ? { intervalMonths } : {}
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    recordAudit({
      action: "wayback.import.app.failed",
      actorIp,
      userAgent,
      success: false,
      detail: `app=${id} ${message.slice(0, 200)}`,
    });
    recordActivity({
      type: "wayback_import",
      status: "error",
      appId: id,
      appName: app.name,
      summary: `Wayback import failed: ${message}`.slice(0, 200),
      detail: { mode: "app", errorMessage: message },
      startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const status = pickActivityStatus(result);
  recordActivity({
    type: "wayback_import",
    status,
    appId: id,
    appName: app.name,
    summary: buildSummaryLine(app.name, result),
    detail: { mode: "app", result },
    startedAt,
  });

  recordAudit({
    action: "wayback.import.app.success",
    actorIp,
    userAgent,
    success: true,
    detail:
      `app=${id} imported=${result.imported} unchanged=${result.unchanged} ` +
      `skipped=${result.skipped} failed=${result.failed}`,
  });

  return NextResponse.json({ result });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const app = db.prepare("SELECT id, name FROM apps WHERE id = ?").get(id) as
    | { id: string; name: string }
    | undefined;
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");
  const startedAt = Date.now();
  const deleted = removeImportedHistory(id);

  recordAudit({
    action: "wayback.import.app.remove",
    actorIp,
    userAgent,
    success: true,
    detail: `app=${id} deleted=${deleted}`,
  });

  recordActivity({
    type: "wayback_import",
    status: "ok",
    appId: id,
    appName: app.name,
    summary: `Removed ${deleted} imported history row${deleted === 1 ? "" : "s"}`,
    detail: { mode: "app", removed: true, deleted },
    startedAt,
  });

  return NextResponse.json({ deleted });
}

/**
 * Derive the activity-log status from the per-target outcomes.
 *   - any `imported` / `unchanged` with zero failures → ok
 *   - nothing imported but some targets skipped cleanly → ok (no-op run)
 *   - any failure with at least one success → partial
 *   - all failures / no success → error
 */
function pickActivityStatus(result: ImportAppHistoryResult) {
  if (result.failed === 0) {
    return "ok" as const;
  }
  const anySuccess = result.imported > 0 || result.unchanged > 0;
  return anySuccess ? ("partial" as const) : ("error" as const);
}

function buildSummaryLine(
  appName: string,
  result: ImportAppHistoryResult
): string {
  const parts: string[] = [];
  if (result.imported) {
    parts.push(`${result.imported} imported`);
  }
  if (result.unchanged) {
    parts.push(`${result.unchanged} no-op`);
  }
  if (result.skipped) {
    parts.push(`${result.skipped} skipped`);
  }
  if (result.failed) {
    parts.push(`${result.failed} failed`);
  }
  if (result.snapshotsRequested) {
    parts.push(
      `${result.snapshotsRequested} snapshot${result.snapshotsRequested === 1 ? "" : "s"} requested`
    );
  }
  const tail = parts.length ? parts.join(", ") : "nothing to do";
  return `Wayback import for ${appName}: ${tail}`.slice(0, 200);
}
