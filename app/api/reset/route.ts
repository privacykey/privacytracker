export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSetting } from "../../../lib/scheduler";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "../../../lib/security";
import { wipeAllUserData } from "../../../lib/wipe-all-data";

/**
 * Reset is "Delete everything" (lib/wipe-all-data.ts): every table of user
 * data, devices included, the settings, the automatic backup snapshots and
 * the backup signing key. `/api/admin/start-over` runs the same wipe; this
 * route keeps its own guard and limit because it is also the E2E suite's
 * per-spec reset. Irreversible and the most destructive action the app can
 * perform. Defence-in-depth:
 *   - The global proxy already enforces same-origin for mutating requests.
 *   - Require the admin token when configured or when reached via LAN/domain.
 *   - Record every attempt (success and failure) in the audit log.
 *   - Rate limit so a same-origin bug can't be trivially looped.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // The intent of this limiter is "stop a same-origin bug from being
  // trivially looped" (a runaway loop trips it instantly regardless of
  // the threshold) — not "approximate a human's reset cadence". The
  // primary guardrails are same-origin + the optional admin token; the
  // rate limit is defence-in-depth. The limit is sized for the E2E
  // suite, one server resetting before most specs: 30/10min was outgrown
  // once the suite reached about 33 resets a run, so 60 leaves room for
  // it to grow without weakening either primary guardrail. Keep
  // core/src/server/writes.rs in step.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "reset"),
    limit: 60,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) {
    recordAudit({
      action: "reset.rate_limited",
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${rate.retryAfterMs}`,
    });
    return NextResponse.json(
      { error: "Rate limit exceeded for reset. Try again later." },
      { status: 429 }
    );
  }

  if (
    adminTokenRequiredForRequest(request) &&
    !requestHasValidAdminToken(request)
  ) {
    recordAudit({
      action: "reset.unauthorised",
      actorIp,
      userAgent,
      success: false,
      detail: "admin token required but missing or invalid",
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  if (getSetting("sync_running", "false") === "true") {
    return NextResponse.json(
      { error: "A sync is currently running. Please wait until it finishes." },
      { status: 409 }
    );
  }

  try {
    // Everything goes, the audit trail included; the audit row below is
    // written after the wipe, so the log starts again with this reset.
    wipeAllUserData("reset", startedAt);
    recordAudit({
      action: "reset.success",
      actorIp,
      userAgent,
      success: true,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Reset API error", error);
    recordAudit({
      action: "reset.failed",
      actorIp,
      userAgent,
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to reset app data" },
      { status: 500 }
    );
  }
}
