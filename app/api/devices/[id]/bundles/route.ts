/**
 * GET /api/devices/[id]/bundles → { bundleIds: string[] }
 *
 * Returns the bundle IDs of every app linked to a device. Drives the
 * "N apps already tracked from this device" accordion in the
 * OnboardWizard cfgutil panel so the user can collapse known apps and
 * focus on whatever's new.
 *
 * Read-only, same-origin only. Empty array when the device has no
 * linked apps (or doesn't exist — we don't 404 here because the
 * cfgutil flow may briefly hit the endpoint before the device row
 * lands).
 */

import { NextResponse } from "next/server";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    if (!id?.trim()) {
      return NextResponse.json({ bundleIds: [] });
    }
    // Join apps to filter NULL bundleIds out and dedupe on the way.
    const rows = db
      .prepare(`
        SELECT DISTINCT a.bundleId AS bundleId
        FROM app_devices ad
        JOIN apps a ON a.id = ad.app_id
        WHERE ad.device_id = ?
          AND a.bundleId IS NOT NULL
          AND a.bundleId != ''
      `)
      .all(id.trim()) as { bundleId: string }[];
    return NextResponse.json({ bundleIds: rows.map((r) => r.bundleId) });
  } catch (error) {
    console.error("[devices/[id]/bundles] failed:", error);
    return NextResponse.json({ bundleIds: [] });
  }
}
