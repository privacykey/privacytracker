/**
 * SQLite health endpoint.
 *
 *   GET                       — cheap PRAGMA snapshot (page_count, freelist,
 *                               journal mode, busy_timeout, etc.). Polled by
 *                               the diagnostics page every ~10s.
 *   POST { runIntegrityCheck } — opt-in full-page integrity scan (slow on
 *                               large DBs). Admin-token gated.
 *
 * The PRAGMA reads are O(1) so polling them costs nothing; the
 * integrity-check is gated behind an explicit flag because it walks
 * every page.
 */

import { NextResponse } from "next/server";
import { runIntegrityCheck, snapshotDatabaseHealth } from "@/lib/db-health";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(snapshotDatabaseHealth());
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // Tight rate limit — integrity_check can lock the DB for seconds on a
  // large file. Once a minute is plenty; the user can poll the GET to
  // see the cached result while waiting.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "diagnostics.database.check"),
    limit: 4,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429 }
    );
  }

  if (
    adminTokenRequiredForRequest(request) &&
    !requestHasValidAdminToken(request)
  ) {
    recordAudit({
      action: "diagnostics.database.check.unauthorised",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  let body: { runIntegrityCheck?: unknown };
  try {
    body = await readBoundedJson<{ runIntegrityCheck?: unknown }>(
      request,
      1024
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid body" },
      { status: 400 }
    );
  }
  if (body.runIntegrityCheck !== true) {
    return NextResponse.json(
      { error: 'pass `{ "runIntegrityCheck": true }` to run the check' },
      { status: 400 }
    );
  }

  const result = runIntegrityCheck();
  recordAudit({
    action: "diagnostics.database.check.complete",
    actorIp,
    userAgent,
    success: result.status === "ok",
    detail: `status=${result.status} duration=${result.durationMs}ms`,
  });
  return NextResponse.json({ ...snapshotDatabaseHealth(), justRan: result });
}
