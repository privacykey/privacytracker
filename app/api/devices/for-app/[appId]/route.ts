/**
 * GET /api/devices/for-app/[appId] → { devices: Device[] }
 *
 * Drives the App Detail "Tracked on" chip strip. Read-only, no auth
 * required beyond same-origin.
 */

import { NextResponse } from "next/server";
import { getDevicesForApp } from "@/lib/devices";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ appId: string }> }
) {
  try {
    const { appId } = await ctx.params;
    if (!appId?.trim()) {
      return NextResponse.json({ devices: [] }, { status: 400 });
    }
    const devices = getDevicesForApp(appId.trim());
    return NextResponse.json({ devices });
  } catch (error) {
    console.error("[devices/for-app] failed:", error);
    return NextResponse.json({ devices: [] }, { status: 500 });
  }
}
