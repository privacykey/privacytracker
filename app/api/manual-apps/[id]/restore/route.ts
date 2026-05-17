/**
 * POST /api/manual-apps/[id]/restore
 *
 * Re-creates a manual app row that was just deleted, using the original
 * id. Drives the Cmd-Z undo path on `ManualAppsView`: the client snapshots
 * the full {@link ManualApp} before calling DELETE and posts it back here
 * on undo so the row's id, first_seen, and any user-typed metadata stay
 * intact.
 *
 * Body shape (everything required except the nullable text fields):
 *   { name, source, developer?, privacyPolicyUrl?, sourceUrl?, notes?,
 *     firstSeen, updatedAt }
 *
 * The url-path id and the body's id MUST match — keeps the route safely
 * scoped to the resource the client says it's restoring.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  isManualAppSource,
  MANUAL_APP_SOURCES,
  type ManualApp,
} from "../../../../../lib/manual-apps";
import { restoreManualApp } from "../../../../../lib/manual-apps-server";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "../../../../../lib/security";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: Ctx) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // Same write rate-limit bucket as the create route so a malicious
  // restore-spam can't escape the manual-apps.write quota.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "manual-apps.write"),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (
    adminTokenRequiredForRequest(request) &&
    !requestHasValidAdminToken(request)
  ) {
    recordAudit({
      action: "manual-apps.restore.unauthorised",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  const params = await Promise.resolve(context.params);
  const urlId = (params?.id ?? "").toString();
  if (!urlId || urlId.length > 128) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid body" },
      { status: 400 }
    );
  }

  // The id in the URL and the id in the snapshot must agree. Without
  // this check, a malicious client could submit a snapshot for a
  // different deleted row and silently restore it under a different id.
  const bodyId = typeof body.id === "string" ? body.id : "";
  if (bodyId !== urlId) {
    return NextResponse.json(
      { error: "Body id must match the URL id" },
      { status: 400 }
    );
  }

  if (!isManualAppSource(body.source)) {
    return NextResponse.json(
      { error: `source must be one of: ${MANUAL_APP_SOURCES.join(", ")}` },
      { status: 400 }
    );
  }

  const snapshot: ManualApp = {
    id: bodyId,
    name: typeof body.name === "string" ? body.name : "",
    source: body.source,
    developer: typeof body.developer === "string" ? body.developer : null,
    privacyPolicyUrl:
      typeof body.privacyPolicyUrl === "string" ? body.privacyPolicyUrl : null,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
    notes: typeof body.notes === "string" ? body.notes : null,
    firstSeen: Number(body.firstSeen),
    updatedAt: Number(body.updatedAt),
  };

  const restored = restoreManualApp(snapshot);
  if (!restored) {
    // Idempotent: most likely the user double-pressed Cmd+Z, or another
    // tab beat us to the restore. Tell the client the row exists so its
    // undo stack drops the op without an error toast.
    recordAudit({
      action: "manual-apps.restore.skipped",
      actorIp,
      userAgent,
      success: true,
      detail: `id=${urlId}`,
    });
    return NextResponse.json(
      { error: "Already exists or could not be restored" },
      { status: 409 }
    );
  }

  recordAudit({
    action: "manual-apps.restore.success",
    actorIp,
    userAgent,
    success: true,
    detail: `id=${restored.id} source=${restored.source}`,
  });
  return NextResponse.json({ app: restored }, { status: 201 });
}
