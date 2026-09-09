export const dynamic = "force-dynamic";

import { type NextRequest, NextResponse } from "next/server";
import { getMostRecentImport } from "@/lib/audit-bundle-import";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";

const DEFAULT_WITHIN_MS = 24 * 60 * 60 * 1000;
const MAX_WITHIN_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * GET /api/import/audit-bundle/recent — the most recent audit-bundle
 * import inside a window (`?withinMs=`, default 24h), or `null`.
 *
 * Added for Rust-core Phase 0: backs the dashboard's provenance banner
 * ("imported from <friend> N hours ago"). The cutoff is computed HERE
 * from Date.now() on every call — the banner's 24h rule must hold even
 * for a tab that has been open for days, so the client never gets to
 * decide what "recent" means.
 */
export async function GET(request: NextRequest) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "audit-bundle.recent"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const raw = request.nextUrl.searchParams.get("withinMs");
  let withinMs = DEFAULT_WITHIN_MS;
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_WITHIN_MS) {
      return NextResponse.json(
        { error: `withinMs must be an integer in 1..${MAX_WITHIN_MS}` },
        { status: 400 }
      );
    }
    withinMs = parsed;
  }
  try {
    return NextResponse.json({ recent: getMostRecentImport(withinMs) });
  } catch (error) {
    console.warn("[audit-bundle/recent] failed:", error);
    return NextResponse.json({ recent: null });
  }
}
