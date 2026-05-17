import { NextResponse } from "next/server";
import { buildDeploymentSupportBundle } from "@/lib/deployment-diagnostics";

export const dynamic = "force-dynamic";

/**
 * Copy/paste-safe support bundle for local/LAN deployment troubleshooting.
 * Omits API keys, admin tokens, tracked app names, app ids, and full URLs.
 */
export async function GET(request: Request) {
  return NextResponse.json(buildDeploymentSupportBundle(request.headers), {
    headers: { "Cache-Control": "no-store" },
  });
}
