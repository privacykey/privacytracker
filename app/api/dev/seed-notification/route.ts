/**
 * /api/dev/seed-notification — POST writes a single notification row
 * directly via `createNotification()`. Test affordance: the bell UI
 * exercises a multi-step flow (DB row → bell badge → dropdown → mark
 * read) that's tedious to trigger via the natural change-detection
 * path from a Playwright spec, since real change detection requires
 * an apps.apple.com round-trip the test client can't intercept.
 *
 * Same shape as `/api/dev/seed-sample-data`:
 *   - mutation-guarded (same-origin + rate limit + audit log)
 *   - synchronous DB write
 *   - returns the inserted row's logical fields so the caller can
 *     assert on them
 *
 * Body:
 *   { appId: string, appName: string, changes: ChangeEntry[] }
 *
 * `createNotification` no-ops when `changes.length === 0`, so the
 * caller must pass at least one entry. We surface that as a 400 to
 * keep the failure mode obvious in test logs.
 */

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import type { ChangeEntry } from "@/lib/changelog";
import { createNotification } from "@/lib/notifications";
import { readBoundedJson, recordAudit } from "@/lib/security";

export const dynamic = "force-dynamic";

interface SeedNotificationBody {
  appId?: unknown;
  appName?: unknown;
  changes?: unknown;
}

function isChangeEntry(value: unknown): value is ChangeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { description?: unknown }).description === "string"
  );
}

export async function POST(request: Request) {
  const guard = requireMutationGuard(request, {
    action: "dev.seed_notification",
    requireAdminToken: "configured",
    rateLimit: {
      keyPrefix: "dev.seed_notification",
      // E2E tests may seed multiple notifications across specs in a
      // single run, so be slightly more permissive than the apps
      // seeder. Still bounded so a same-origin bug can't loop.
      limit: 30,
      windowMs: 10 * 60_000,
      message:
        "Rate limit exceeded for dev notification seeding. Try again later.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: SeedNotificationBody;
  try {
    body = await readBoundedJson<SeedNotificationBody>(request, 16 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid JSON body" },
      { status: 400 }
    );
  }

  const appId = typeof body.appId === "string" ? body.appId.trim() : "";
  const appName = typeof body.appName === "string" ? body.appName.trim() : "";
  if (!(appId && appName)) {
    return NextResponse.json(
      { error: "Body must include non-empty `appId` and `appName` strings." },
      { status: 400 }
    );
  }

  const rawChanges = Array.isArray(body.changes) ? body.changes : [];
  const changes = rawChanges.filter(isChangeEntry);
  if (changes.length === 0) {
    return NextResponse.json(
      { error: "Body must include at least one ChangeEntry in `changes`." },
      { status: 400 }
    );
  }

  try {
    createNotification(appId, appName, changes);
  } catch (error) {
    console.error(
      "[/api/dev/seed-notification] createNotification failed:",
      error
    );
    recordAudit({
      action: "dev.seed_notification.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to write notification" },
      { status: 500 }
    );
  }

  recordAudit({
    action: "dev.seed_notification.success",
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
    detail: `appId=${appId} changes=${changes.length}`,
  });

  return NextResponse.json({ ok: true, appId, appName, changes });
}
