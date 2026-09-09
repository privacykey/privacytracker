export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getChangelogPage } from "../../../../../lib/changelog";
import db from "../../../../../lib/db";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/apps/[id]/changelog?before=<epoch-ms>&limit=<1..200>
 *
 * Older pages of the History tab. The detail payload ships only the newest
 * page (`getChangelogPage`); the timeline asks here for rows strictly older
 * than the oldest one it holds. Same row shape as `detail.changelog`, plus
 * `hasMore` so the client knows whether to keep offering "Show older".
 */
export async function GET(
  request: Request,
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

  const { searchParams } = new URL(request.url);
  const rawBefore = searchParams.get("before");
  const rawLimit = searchParams.get("limit");

  let beforeMs: number | undefined;
  if (rawBefore !== null) {
    const parsed = Number(rawBefore);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return NextResponse.json(
        { error: "`before` must be a non-negative epoch-ms number" },
        { status: 400 }
      );
    }
    beforeMs = parsed;
  }

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json(
        { error: `\`limit\` must be an integer between 1 and ${MAX_LIMIT}` },
        { status: 400 }
      );
    }
    limit = parsed;
  }

  const page = getChangelogPage(id, limit, { beforeMs });
  return NextResponse.json({ appId: id, ...page });
}
