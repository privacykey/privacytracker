export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSinceInstallDiff } from "../../../../../lib/changelog";
import db from "../../../../../lib/db";

/**
 * GET /api/apps/[id]/since-install
 *
 * Cumulative privacy-label diff from the install-era baseline snapshot
 * (the newest snapshot at-or-before `apps.firstSeen`) to the latest
 * snapshot. Powers the "Since you added this app" card on the History tab.
 *
 * Returns `{ sinceInstall: null }` when the app exists but has no usable
 * snapshot yet, so the client can simply render nothing.
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

  return NextResponse.json({
    appId: id,
    sinceInstall: getSinceInstallDiff(id),
  });
}
