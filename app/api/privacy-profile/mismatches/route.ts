export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getMismatchedApps } from "@/lib/privacy-profile-server";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";

/**
 * GET /api/privacy-profile/mismatches — every tracked app that exceeds
 * the user's saved privacy profile, worst first.
 *
 * Added for Rust-core Phase 0: backs HomeView's "consider replacing"
 * section, which /dashboard used to fill from getMismatchedApps() in its
 * server component. Kept OUT of GET /api/privacy-profile on purpose —
 * that route is on several hot paths and this is a fleet-wide join over
 * privacy_categories × privacy_types.
 *
 * `{ apps: [] }` both when no profile is set and when the read fails —
 * the page swallowed the error to an empty list so a fresh install still
 * rendered its dashboard.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "privacy-profile.mismatches"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  try {
    return NextResponse.json({ apps: getMismatchedApps() });
  } catch (error) {
    console.warn("[privacy-profile/mismatches] failed:", error);
    return NextResponse.json({ apps: [] });
  }
}
