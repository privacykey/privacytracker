/**
 * /api/device-sync/commit — apply the user's diff selection.
 *
 *   POST { deviceId, addAppIds: string[], removeAppIds: string[] }
 *     → { added, removed, orphanedAndDeleted }
 *
 * Writes inside a single transaction (see `applyDeviceSyncDiff`). Records
 * the outcome in the audit log so the activity feed can render a
 * "Re-sync committed" row later.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { applyDeviceSyncDiff } from "@/lib/device-sync";
import { getDeviceById } from "@/lib/devices";
import { setSetting } from "@/lib/scheduler";
import { readBoundedJson, recordAudit, requestActorIp } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMutationGuard(req, {
    action: "device_sync.commit",
    rateLimit: { keyPrefix: "device_sync.commit", limit: 15, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await readBoundedJson<unknown>(req, 256 * 1024);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "expected object body" },
      { status: 400 }
    );
  }
  const { deviceId, addAppIds, removeAppIds, bundleIdMerges } = body as {
    deviceId?: unknown;
    addAppIds?: unknown;
    removeAppIds?: unknown;
    bundleIdMerges?: unknown;
  };
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    return NextResponse.json({ error: "deviceId required" }, { status: 400 });
  }
  if (!(Array.isArray(addAppIds) && Array.isArray(removeAppIds))) {
    return NextResponse.json(
      { error: "addAppIds and removeAppIds must be arrays" },
      { status: 400 }
    );
  }
  if (!getDeviceById(deviceId.trim())) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  const cleanAdds = (addAppIds as unknown[]).filter(
    (x): x is string => typeof x === "string" && x.length > 0
  );
  const cleanRemoves = (removeAppIds as unknown[]).filter(
    (x): x is string => typeof x === "string" && x.length > 0
  );
  // Bundle-ID merges: only pass through pairs the diff detected and
  // the client is forwarding back. Validated to a tight shape so a
  // crafted client can't ask us to merge arbitrary app rows.
  const cleanMerges = Array.isArray(bundleIdMerges)
    ? (bundleIdMerges as unknown[])
        .filter((m): m is { previousAppId: string; incomingAppId: string } => {
          if (!m || typeof m !== "object") {
            return false;
          }
          const x = m as Record<string, unknown>;
          return (
            typeof x.previousAppId === "string" &&
            x.previousAppId.length > 0 &&
            typeof x.incomingAppId === "string" &&
            x.incomingAppId.length > 0
          );
        })
        .map((m) => ({
          previousAppId: m.previousAppId,
          incomingAppId: m.incomingAppId,
        }))
    : [];

  try {
    const result = applyDeviceSyncDiff(deviceId.trim(), {
      addAppIds: cleanAdds,
      removeAppIds: cleanRemoves,
      bundleIdMerges: cleanMerges,
    });
    // Stamp the most-recent commit timestamp so the Tasks panel's
    // `resync_apps_from_device` chip auto-completes on first re-sync.
    setSetting("device_resync.last_committed_at", String(Date.now()));
    recordAudit({
      action: "device_sync.commit",
      actorIp: requestActorIp(req),
      userAgent: req.headers.get("user-agent"),
      detail: JSON.stringify({ deviceId, ...result }),
      success: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[device-sync/commit] failed:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
