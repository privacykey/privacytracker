export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import db from "../../../lib/db";
import { getSetting } from "../../../lib/scheduler";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "../../../lib/security";

/**
 * Reset wipes the entire DB. This is irreversible and the most destructive
 * action the app can perform. Defence-in-depth:
 *   - The global proxy already enforces same-origin for mutating requests.
 *   - Require the admin token when configured or when reached via LAN/domain.
 *   - Record every attempt (success and failure) in the audit log.
 *   - Rate limit so a same-origin bug can't be trivially looped.
 */
export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // The intent of this limiter is "stop a same-origin bug from being
  // trivially looped" (a runaway loop trips it instantly regardless of
  // the threshold) — not "approximate a human's reset cadence". The
  // primary guardrails are same-origin + the optional admin token; the
  // rate limit is defence-in-depth. 30/10min leaves headroom for the
  // E2E suite (5+ specs reset between runs) without weakening either
  // primary guardrail.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "reset"),
    limit: 30,
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

  const resetAll = db.transaction(() => {
    db.prepare("DELETE FROM notifications").run();
    // Clear the import history too — `imports` cascades into `import_items`
    // via FK, but we DELETE both explicitly so the behaviour is obvious to
    // anyone reading this list. Reset is a clean-slate operation; leaving
    // stale history rows around would show phantom "Removed" entries for
    // apps that no longer exist in the fresh DB.
    db.prepare("DELETE FROM import_items").run();
    db.prepare("DELETE FROM imports").run();
    // Manual apps are user-authored and independent of the scraped apps, but
    // they're still privacy state — clean-slate means we drop these too.
    db.prepare("DELETE FROM manual_apps").run();
    db.prepare("DELETE FROM privacy_data_types").run();
    db.prepare("DELETE FROM privacy_categories").run();
    db.prepare("DELETE FROM privacy_purposes").run();
    db.prepare("DELETE FROM privacy_snapshots").run();
    db.prepare("DELETE FROM privacy_types").run();
    db.prepare("DELETE FROM apps").run();
    db.prepare("DELETE FROM app_settings").run();
    // NB: intentionally NOT deleting audit_log — we want the trail to survive.
  });

  try {
    resetAll();
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
