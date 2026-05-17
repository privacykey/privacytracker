/**
 * GET /api/devices/[id]/tracked-apps
 *   → { apps: Array<{ appId: string; name: string; bundleId: string | null }> }
 *
 * Returns the apps currently linked to a device, with enough metadata to
 * compute a diff client-side against an incoming cfgutil read. Powers
 * the step-2 upfront diff in the OnboardWizard's cfgutil re-sync flow.
 *
 * Read-only, same-origin only. Returns an empty list when the device
 * has no linked apps (or doesn't exist — we don't 404 here since the
 * wizard may hit this transiently before a fresh device row lands).
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
      return NextResponse.json({ apps: [] });
    }
    const rows = db
      .prepare(`
        SELECT a.id AS appId, a.name AS name, a.bundleId AS bundleId
        FROM app_devices ad
        JOIN apps a ON a.id = ad.app_id
        WHERE ad.device_id = ?
        ORDER BY a.name COLLATE NOCASE
      `)
      .all(id.trim()) as {
      appId: string;
      name: string;
      bundleId: string | null;
    }[];
    return NextResponse.json({ apps: rows });
  } catch (error) {
    console.error("[devices/[id]/tracked-apps] failed:", error);
    return NextResponse.json({ apps: [] });
  }
}
