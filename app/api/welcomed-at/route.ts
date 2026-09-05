/**
 * /api/welcomed-at — POST sets the welcomed_at timestamp.
 *
 * Called when the onboarding wizard completes (user imports at least one
 * app or explicitly skips import). Used by the §4.10 hybrid-redirect logic
 * to stop sending users back to /welcome.
 *
 * Body (optional): `{ ifUnset?: boolean }`. With `ifUnset: true` the write
 * is first-write-wins (setSettingIfUnset) — the dashboard shell fires
 * this on every mount for the lazy "user has apps but never hit the
 * wizard's completion call" case, exactly where the server page used to
 * do `if (getWelcomedAt() === null) setWelcomedAt()`. Without the flag
 * the write stays unconditional for the wizard's own call. Firing the
 * unconditional form from a mount effect would re-stamp the original
 * onboarding-completion time on every visit.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { setWelcomedAt } from "@/lib/feature-flag-storage";
import { setSettingIfUnset } from "@/lib/scheduler";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "welcomed-at.set",
    rateLimit: { keyPrefix: "welcomed-at.set", limit: 60, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  // The wizard posts with no body; tolerate empty/absent JSON.
  let ifUnset = false;
  try {
    const body = await readBoundedJson<{ ifUnset?: unknown }>(request, 1024);
    ifUnset = body?.ifUnset === true;
  } catch {
    ifUnset = false;
  }

  const now = Date.now();
  try {
    if (ifUnset) {
      setSettingIfUnset("welcomed_at", String(now));
    } else {
      setWelcomedAt(now);
    }
  } catch (e) {
    console.error("[/api/welcomed-at] write failed:", e);
    return NextResponse.json(
      { error: "Failed to mark onboarding complete" },
      { status: 500 }
    );
  }
  return NextResponse.json({ welcomedAt: now, ifUnset });
}
