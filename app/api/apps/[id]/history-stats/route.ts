export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import db from "../../../../../lib/db";
import {
  computeCategoryTrend,
  computeQuarterlyChanges,
} from "../../../../../lib/historical-import";

/**
 * GET /api/apps/[id]/history-stats
 *
 * Returns the aggregates that feed the widgets under the per-app changelog:
 *   - `quarterly`:      array of { label, startMs, endMs, changeEvents,
 *                                  changeEntries } for the sparkline.
 *   - `categoryTrend`:  added/removed totals + the same quarterly buckets
 *                       with per-quarter added/removed counts.
 *
 * Both series share the same bucket boundaries (calendar quarters anchored
 * to `APP_STORE_HISTORICAL_FLOOR`, Q1 2021) so the UI can index into them
 * in lockstep without re-computing alignment. Only privacy-label entries
 * count — policy, accessibility and age-rating events share the snapshot
 * table but are not label changes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const exists = db.prepare("SELECT 1 FROM apps WHERE id = ?").get(id);
  if (!exists) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const categoryTrend = computeCategoryTrend(id);
  const quarterly = computeQuarterlyChanges(id);

  return NextResponse.json({
    appId: id,
    categoryTrend,
    quarterly,
  });
}
