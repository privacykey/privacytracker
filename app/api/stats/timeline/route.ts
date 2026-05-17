export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getTimelineData,
  type TimelineBucket,
} from "../../../../lib/stats-views";

/**
 * GET /api/stats/timeline?from=<ms>&to=<ms>&bucket=day|week|month&appId=<id>
 *
 * All params optional. Defaults to the last 90 days ending at "now".
 * Bucket auto-chosen from window length unless forced via ?bucket=. `appId`
 * scopes the aggregate to a single app (used by the app detail Change
 * History strip — same endpoint as the site-wide Change Timeline).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = Date.now();

  const parseTs = (v: string | null, fallback: number) => {
    if (!v) {
      return fallback;
    }
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const from = parseTs(url.searchParams.get("from"), now - 90 * 86_400_000);
  const to = parseTs(url.searchParams.get("to"), now);
  if (from > to) {
    return NextResponse.json({ error: "from must be <= to" }, { status: 400 });
  }

  const bucketRaw = url.searchParams.get("bucket");
  const bucket: TimelineBucket | undefined =
    bucketRaw === "day" || bucketRaw === "week" || bucketRaw === "month"
      ? bucketRaw
      : undefined;

  // Only forward `appId` when it looks like a numeric Apple track id —
  // stops query-value injection without rejecting requests that omit it.
  const appIdRaw = url.searchParams.get("appId");
  const appId = appIdRaw && /^\d+$/.test(appIdRaw) ? appIdRaw : undefined;

  try {
    const data = getTimelineData(from, to, bucket, appId);
    return NextResponse.json(data);
  } catch (error) {
    console.error("/api/stats/timeline error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
