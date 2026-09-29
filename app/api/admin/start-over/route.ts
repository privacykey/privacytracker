/**
 * /api/admin/start-over — POST runs "Delete everything"
 * (lib/wipe-all-data.ts), the one full wipe Settings offers.
 *
 * `/api/reset` runs the same wipe behind a different guard (it doubles as
 * the E2E suite's per-spec reset). Both remove:
 *
 *   - all tracked and manual apps, with their labels, snapshots, history,
 *     policy summaries, notes, verdicts and shortlist entries
 *   - all devices and their app links (names, ECIDs, owners, attestations)
 *   - imports, notifications, the activity log, the audit log, the AI
 *     debug log and every flag override
 *   - every setting (focus, profiles, AI config, schedule, welcomed_at)
 *     except the flag-migration marker and the runtime marker
 *   - the automatic backup snapshots and the backup signing key
 *
 * The schema stays. On completion the next page load lands on /welcome
 * (audience unset → §4.10 hybrid-redirect kicks in).
 *
 * The database part is one transaction, so a failure leaves it in its
 * pre-call state and no file is touched. The activity and audit rows are
 * written after the wipe, so they survive it.
 */

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { getSetting } from "@/lib/scheduler";
import { recordAudit } from "@/lib/security";
import { wipeAllUserData } from "@/lib/wipe-all-data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const guard = requireMutationGuard(request, {
    action: "admin.start_over",
    rateLimit: {
      keyPrefix: "admin.start_over",
      limit: 3,
      windowMs: 10 * 60_000,
      message: "Rate limit exceeded for Start Over. Try again later.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // Same refusal as /api/reset: a sync that is still writing would put
  // apps back into the emptied database.
  if (getSetting("sync_running", "false") === "true") {
    return NextResponse.json(
      { error: "A sync is currently running. Please wait until it finishes." },
      { status: 409 }
    );
  }

  try {
    wipeAllUserData("start-over", startedAt);
  } catch (e) {
    console.error("[/api/admin/start-over] failed:", e);
    recordAudit({
      action: "admin.start_over.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: "Start Over failed; database left untouched" },
      { status: 500 }
    );
  }

  recordAudit({
    action: "admin.start_over.success",
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
  });

  return NextResponse.json({ ok: true, durationMs: Date.now() - startedAt });
}
