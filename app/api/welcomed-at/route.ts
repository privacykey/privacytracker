/**
 * /api/welcomed-at — POST sets the welcomed_at timestamp.
 *
 * Called when the onboarding wizard completes (user imports at least one app
 * or explicitly skips import). Used by the §4.10 hybrid-redirect logic to
 * stop sending users back to /welcome.
 *
 * v1 only writes; reads happen server-side via getWelcomedAt() in
 * lib/feature-flag-storage.ts.
 */

import { NextResponse } from "next/server";
import { setWelcomedAt } from "@/lib/feature-flag-storage";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    setWelcomedAt();
  } catch (e) {
    console.error("[/api/welcomed-at] write failed:", e);
    return NextResponse.json(
      { error: "Failed to mark onboarding complete" },
      { status: 500 }
    );
  }
  return NextResponse.json({ welcomedAt: Date.now() });
}
