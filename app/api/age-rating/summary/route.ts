export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  countAppsAboveAgeBand,
  getChildAgeBand,
} from "@/lib/age-rating-server";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";

/**
 * GET /api/age-rating/summary — `{ band, count }`: the guardian's stored
 * child age band (validated, null when unset) and how many tracked apps
 * are rated above it.
 *
 * Added for Rust-core Phase 0: backs the dashboard's age-rating callout.
 * One call replaces getChildAgeBand() + countAppsAboveAgeBand(), keeping
 * the isValidAgeBand normalisation server-side. The count is a scan over
 * every app with a rating, so callers gate this on the callout flag the
 * way the page did — don't fetch it unconditionally on every load.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "age-rating.summary"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  try {
    const band = getChildAgeBand();
    return NextResponse.json({
      band,
      count: band ? countAppsAboveAgeBand(band) : 0,
    });
  } catch (error) {
    console.warn("[age-rating/summary] failed:", error);
    return NextResponse.json({ band: null, count: 0 });
  }
}
