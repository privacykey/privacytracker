export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import {
  COMPANION_MAX_DEVICES,
  ensureCompanionRegistry,
  getCompanionInstanceName,
  listCompanionDevices,
  setCompanionInstanceName,
} from "@/lib/companion";
import { COMPANION_CLAIM_WINDOW_MS } from "@/lib/companion-gate";
import { requestBodyErrorResponse } from "@/lib/request-body";
import { readBoundedJson } from "@/lib/security";

/**
 * GET /api/companion — Settings → Companion: the name phones show for this
 * instance and every pairing, with its state (`waiting` until the phone's
 * first request, `expired` if that never came within the claim window,
 * else `active`). Never returns a token: only hashes are stored.
 *
 * PUT /api/companion — `{ instanceName }`: rename the instance as phones
 * see it. Mirrored in core/src/server/companion.rs.
 */

function payload() {
  ensureCompanionRegistry();
  return {
    instanceName: getCompanionInstanceName(),
    devices: listCompanionDevices(),
    maxDevices: COMPANION_MAX_DEVICES,
    claimWindowMs: COMPANION_CLAIM_WINDOW_MS,
  };
}

export async function GET() {
  return NextResponse.json(payload());
}

export async function PUT(request: Request) {
  const guard = requireMutationGuard(request, {
    action: "companion.settings",
    rateLimit: {
      keyPrefix: "companion.settings",
      limit: 30,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 4 * 1024);
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }
    const message =
      error instanceof Error ? error.message : "Invalid JSON body";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (typeof body?.instanceName !== "string") {
    return NextResponse.json(
      { error: "instanceName must be a string" },
      { status: 400 }
    );
  }
  setCompanionInstanceName(body.instanceName);
  return NextResponse.json(payload());
}
