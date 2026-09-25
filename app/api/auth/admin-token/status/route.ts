/**
 * GET /api/auth/admin-token/status
 *
 * UI helper — returns whether the admin token is configured server-side
 * and whether the current request carries a valid one (via the HttpOnly
 * cookie set by login, OR the legacy header). The Settings panel uses
 * this to render the "unlock" / "locked" pill since it cannot read the
 * HttpOnly cookie directly.
 *
 * Never returns the token itself. `unlocked` says whether a presented
 * token is right, so this public route counts wrong ones like every other
 * check (lib/admin-token-guard.ts), and a client past its budget is
 * answered 429 before its token is looked at.
 */
import { type NextRequest, NextResponse } from "next/server";
import {
  checkAdminTokenAttempt,
  TOO_MANY_FAILURES,
} from "@/lib/admin-token-guard";
import { adminTokenConfigured } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const check = checkAdminTokenAttempt(request.headers);
  if (check.outcome === "throttled") {
    return NextResponse.json(
      { error: TOO_MANY_FAILURES },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(check.retryAfterMs / 1000)),
        },
      }
    );
  }
  return NextResponse.json({
    configured: adminTokenConfigured(),
    unlocked: check.outcome === "valid",
  });
}
