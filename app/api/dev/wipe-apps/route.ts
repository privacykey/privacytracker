/**
 * /api/dev/wipe-apps — POST clears every app and rows hanging off them,
 * preserving user-level config (feature flags, app_settings, audit_log,
 * ai_debug_log) so devs can rebuild a test corpus.
 *
 * Distinct from /api/admin/start-over, which also truncates flags + settings.
 *
 * Children are listed explicitly (rather than relying on CASCADE) so tables
 * outside the cascade chain (manual_apps, imports, app_verdicts, …) are
 * cleared too and so the audit trail reports a real per-table count.
 */

import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { requireMutationGuard } from "@/lib/api-guards";
import db from "@/lib/db";
import { APP_DATA_TABLES_TO_TRUNCATE } from "@/lib/reset-tables";
import { recordAudit } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const guard = requireMutationGuard(request, {
    action: "dev.wipe_apps",
    requireAdminToken: "configured",
    rateLimit: {
      keyPrefix: "dev.wipe_apps",
      limit: 6,
      windowMs: 10 * 60_000,
      message: "Rate limit exceeded for dev wipe. Try again later.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let totalRemoved = 0;

  try {
    const wipe = db.transaction(() => {
      for (const table of APP_DATA_TABLES_TO_TRUNCATE) {
        try {
          const res = db.prepare(`DELETE FROM ${table}`).run();
          totalRemoved += res.changes;
        } catch (e) {
          // Older installs may not have every table — quiet skip on
          // "no such table"; any other SQLite error still logs with context.
          const msg = e instanceof Error ? e.message : String(e);
          if (/no such table/i.test(msg)) {
            console.warn(
              `[dev/wipe-apps] table not present in this DB, skipped: ${table}`
            );
          } else {
            console.warn(`[dev/wipe-apps] DELETE FROM ${table} skipped:`, e);
          }
        }
      }
    });
    wipe();
  } catch (e) {
    console.error("[/api/dev/wipe-apps] failed:", e);
    recordAudit({
      action: "dev.wipe_apps.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: "wipe-apps failed; database left untouched" },
      { status: 500 }
    );
  }

  // Log AFTER the wipe so the row isn't itself truncated.
  try {
    recordActivity({
      type: "reset",
      status: "ok",
      summary: `Dev wipe-apps — cleared ${totalRemoved} rows, preserved flags + settings`,
      detail: { mode: "dev-wipe-apps", rowsRemoved: totalRemoved },
      startedAt,
    });
  } catch (e) {
    console.warn("[/api/dev/wipe-apps] activity-log failed:", e);
  }
  recordAudit({
    action: "dev.wipe_apps.success",
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
    detail: `rowsRemoved=${totalRemoved}`,
  });

  return NextResponse.json({
    ok: true,
    rowsRemoved: totalRemoved,
    durationMs: Date.now() - startedAt,
  });
}
