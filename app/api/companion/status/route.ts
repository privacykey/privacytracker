export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  ensureCompanionRegistry,
  getCompanionInstanceName,
} from "@/lib/companion";
import {
  COMPANION_HEADER,
  COMPANION_REFUSALS,
  COMPANION_SCOPE_READ,
  lookupCompanionToken,
} from "@/lib/companion-gate";
import { countApps } from "@/lib/scraper";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";
import pkg from "../../../../package.json";

/**
 * GET /api/companion/status — the one route only a companion token can
 * call. The phone asks it first after scanning a pairing code and whenever
 * it checks the instance is reachable: it proves the token works and says
 * how many apps the instance tracks, which the phone's onboarding uses to
 * send the user back to import apps before it will finish pairing.
 *
 * proxy.ts has already validated the token and recorded its use by the
 * time this runs; a request without the header (an admin session, a
 * script) is refused here. Mirrored in core/src/server/companion.rs.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "companion.status"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const token = request.headers.get(COMPANION_HEADER);
  if (token === null) {
    return NextResponse.json(
      {
        error:
          "This route answers the companion app only. Pair a phone in Settings → Companion.",
      },
      { status: 401 }
    );
  }
  ensureCompanionRegistry();
  const entry = lookupCompanionToken(token);
  if (!entry) {
    return NextResponse.json(
      { error: COMPANION_REFUSALS.invalid.error },
      { status: COMPANION_REFUSALS.invalid.status }
    );
  }
  return NextResponse.json({
    instanceName: getCompanionInstanceName(),
    appCount: countApps(),
    version: pkg.version,
    scope: COMPANION_SCOPE_READ,
    device: { id: entry.id, label: entry.label },
  });
}
