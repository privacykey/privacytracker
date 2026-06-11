/**
 * Server health-check endpoint.
 *
 *   GET  — the last persisted HealthCheckResult (or { neverRun: true } until
 *          the 24h ticker has fired once). Cheap; no DB scan.
 *   POST — run a health check on demand. Admin-token gated + rate-limited
 *          because it performs (non-destructive) heals and can run the
 *          opt-in integrity scan.
 *
 * The 24h scheduled run lives in `instrumentation.ts`; this route is the
 * read surface + manual trigger. See `lib/health-check.ts`.
 */

import { NextResponse } from "next/server";
import { readLastHealthCheck, runHealthCheck } from "@/lib/health-check";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "@/lib/security";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readLastHealthCheck() ?? { neverRun: true });
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // Tight rate limit — a manual run does heals + an optional integrity scan.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "diagnostics.health.run"),
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
      action: "diagnostics.health.run.unauthorised",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  const result = runHealthCheck({ trigger: "manual" });
  recordAudit({
    action: "diagnostics.health.run.complete",
    actorIp,
    userAgent,
    success: result.status !== "error",
    detail: `status=${result.status} heals=${result.heals.length} warnings=${result.checks.warnings.length}`,
  });
  return NextResponse.json(result);
}
