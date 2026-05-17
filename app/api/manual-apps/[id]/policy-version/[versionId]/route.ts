export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getManualAppPolicyVersion } from "../../../../../../lib/manual-app-history";
import { getManualApp } from "../../../../../../lib/manual-apps-server";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
} from "../../../../../../lib/security";

// Next 16 hands params as a Promise; the declared type must match exactly
// or Next's typed-routes generator fails the TS check.
interface Ctx {
  params: Promise<{ id: string; versionId: string }>;
}

/**
 * GET /api/manual-apps/[id]/policy-version/[versionId]
 *
 * Returns the stored source text for a single snapshot row, used by the
 * manual-app detail timeline to lazily render captured text. Mirrors
 * GET /api/policy/version/[id] for the standard-app side.
 */
export async function GET(request: Request, context: Ctx) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "manual-apps.read"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const params = await Promise.resolve(context.params);
  const manualAppId = (params?.id ?? "").toString();
  const versionId = (params?.versionId ?? "").toString();
  if (!(manualAppId && versionId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Guard against cross-app version id lookup — a fabricated versionId
  // shouldn't reveal that the id exists for some other app.
  if (!getManualApp(manualAppId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const version = getManualAppPolicyVersion(versionId);
  if (!version || version.manualAppId !== manualAppId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ version });
}
