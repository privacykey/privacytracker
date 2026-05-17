export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  isManualAppSource,
  MANUAL_APP_SOURCE_META,
  MANUAL_APP_SOURCES,
  type ManualAppInput,
} from "../../../lib/manual-apps";
import {
  createManualApp,
  listManualApps,
} from "../../../lib/manual-apps-server";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from "../../../lib/security";

/**
 * List every manual app the user has tracked and return the source-type
 * metadata alongside, so the UI can render labels/icons without hard-coding
 * anything client-side. Kept unauthenticated (reads are safe) but still
 * rate limited so a same-origin loop can't hammer SQLite.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "manual-apps.list"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  return NextResponse.json({
    apps: listManualApps(),
    sources: MANUAL_APP_SOURCES.map((value) => ({
      ...MANUAL_APP_SOURCE_META[value],
    })),
  });
}

/**
 * Create a new manual app. Body shape mirrors `ManualAppInput`:
 *   { name, source, developer?, privacyPolicyUrl?, sourceUrl?, notes? }
 *
 * `createManualApp` throws on validation failures (missing name, bad source,
 * non-http(s) URL) — we translate those into a 400 so the UI can surface the
 * message inline without a full page reload.
 */
export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

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
      action: "manual-apps.create.unauthorised",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    // 8 KB is plenty — the heaviest field is `notes` and we don't want to
    // let someone stash a novel in the DB either.
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid body" },
      { status: 400 }
    );
  }

  if (!isManualAppSource(body.source)) {
    return NextResponse.json(
      { error: `source must be one of: ${MANUAL_APP_SOURCES.join(", ")}` },
      { status: 400 }
    );
  }

  const input: ManualAppInput = {
    name: typeof body.name === "string" ? body.name : "",
    source: body.source,
    developer: typeof body.developer === "string" ? body.developer : null,
    privacyPolicyUrl:
      typeof body.privacyPolicyUrl === "string" ? body.privacyPolicyUrl : null,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  };

  try {
    const created = createManualApp(input);
    recordAudit({
      action: "manual-apps.create.success",
      actorIp,
      userAgent,
      success: true,
      detail: `id=${created.id} source=${created.source}`,
    });
    return NextResponse.json({ app: created }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create manual app";
    recordAudit({
      action: "manual-apps.create.failed",
      actorIp,
      userAgent,
      success: false,
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
