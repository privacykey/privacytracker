export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRadarData } from "../../../../lib/stats-views";

/**
 * GET /api/stats/radar?apps=<id>,<id>,...
 *
 * When `apps` is omitted the helper returns the six most recently synced
 * apps with populated summaries — that's the default the Stats page picks
 * up. The compare view passes explicit IDs for its two slots.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("apps");
  const appIds = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  // Guardrail: the SQL uses a parameterised IN() and nothing trusts the ID
  // strings, but we still cap the list so a caller can't pass 10k IDs and
  // build a giant placeholder string.
  if (appIds && appIds.length > 20) {
    return NextResponse.json(
      { error: "Too many app IDs (max 20)" },
      { status: 400 }
    );
  }

  try {
    const data = getRadarData(appIds);
    return NextResponse.json(data);
  } catch (error) {
    console.error("/api/stats/radar error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
