export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getStats } from "../../../lib/stats";

/**
 * GET /api/stats — the Statistics page's summary blob (totals, severity
 * spread, category leaders, recent changes, staleness).
 *
 * Added for Rust-core Phase 0: `/dashboard/stats` used to call
 * `getStats()` in its server component. The heavier visualisation
 * queries already had their own routes (`/matrix`, `/radar`,
 * `/timeline`) — this is the summary half, kept as its own endpoint for
 * the same reason: the page can load the cheap cards immediately and
 * let each chart panel fetch its own data.
 */
export async function GET() {
  try {
    return NextResponse.json(getStats());
  } catch (error) {
    console.error("/api/stats error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
