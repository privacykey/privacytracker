export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  clearAiDebugLog,
  listAiDebugLog,
} from "../../../../lib/privacy-policy";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "../../../../lib/security";

// Returns the rolling window of captured AI prompt/response pairs — used by
// Settings → Developer Options. The log already lives inside a locked-down
// table (rolling cap, server-only); this endpoint is gated the same way as
// the settings write endpoint so it doesn't leak prompts in a multi-admin
// deployment.

function requireAdminIfConfigured(request: Request): NextResponse | null {
  if (
    adminTokenRequiredForRequest(request) &&
    !requestHasValidAdminToken(request)
  ) {
    recordAudit({
      action: "ai_debug_log.unauthorised",
      actorIp: requestActorIp(request),
      userAgent: request.headers.get("user-agent"),
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }
  return null;
}

export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "ai_debug_log.read"),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const guard = requireAdminIfConfigured(request);
  if (guard) {
    return guard;
  }

  return NextResponse.json({ rows: listAiDebugLog() });
}

export async function DELETE(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "ai_debug_log.clear"),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const guard = requireAdminIfConfigured(request);
  if (guard) {
    return guard;
  }

  clearAiDebugLog();
  recordAudit({
    action: "ai_debug_log.cleared",
    actorIp: requestActorIp(request),
    userAgent: request.headers.get("user-agent"),
    success: true,
  });
  return NextResponse.json({ success: true });
}
