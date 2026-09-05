export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";
import { getTriageData, type TriageData } from "@/lib/triage";

/**
 * GET /api/triage — the dashboard's summary blob: counts, the reviewable /
 * higher-risk / stale lists, and the last week's activity.
 *
 * Added for Rust-core Phase 0: /dashboard called getTriageData() in its
 * server component; nothing else exposed it, and it cannot be rebuilt
 * from /api/apps (the reviewable list parses per-app changes_summary
 * against changes_acknowledged_at).
 *
 * ALWAYS 200. On an unready DB this returns the zero-app payload rather
 * than a 5xx, because the page treated "triage read failed" and "no apps"
 * as the SAME branch (bounce to onboarding). A 500 here would turn a
 * fresh install's first visit into a broken dashboard instead of the
 * welcome flow.
 */

const EMPTY: TriageData = {
  changesThisWeek: 0,
  higherRisk: [],
  highRiskCount: 0,
  lastSyncedAt: 0,
  moderateRiskCount: 0,
  quiet: true,
  recentActivity: [],
  reviewable: [],
  stale: [],
  staleCount: 0,
  totalApps: 0,
  totalCategories: 0,
};

export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "triage.read"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  try {
    return NextResponse.json(getTriageData());
  } catch (error) {
    console.warn("[triage] getTriageData failed:", error);
    return NextResponse.json(EMPTY);
  }
}
