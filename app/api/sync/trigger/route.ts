export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireMutationGuard } from "../../../../lib/api-guards";
import { runScheduledSync } from "../../../../lib/scheduler";
import { recordAudit } from "../../../../lib/security";

export async function POST(request: Request) {
  const guard = requireMutationGuard(request, {
    action: "sync.trigger",
    requireAdminToken: false,
    rateLimit: {
      keyPrefix: "sync.trigger",
      limit: 10,
      windowMs: 10 * 60_000,
      message: "Rate limit exceeded for manual sync. Try again later.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const result = await runScheduledSync({ manual: true });
    recordAudit({
      action: "sync.trigger.success",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: true,
      detail: `synced=${result.synced ?? 0} changes=${result.changes ?? 0} skipped=${result.skipped ? "true" : "false"}`,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("Manual sync trigger failed:", e);
    recordAudit({
      action: "sync.trigger.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: String(e?.message ?? e),
    });
    return NextResponse.json(
      { error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
