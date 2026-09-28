export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import {
  COMPANION_LABEL_DEFAULT,
  COMPANION_MAX_DEVICES,
  cleanLabel,
  countCompanionDevices,
  createCompanionPairing,
} from "@/lib/companion";
import { requestBodyErrorResponse } from "@/lib/request-body";
import { readOptionalBoundedJson, recordAudit } from "@/lib/security";

/**
 * POST /api/companion/pairings — `{ label? }`: mint one read-only companion
 * token for a phone. The reply is the only time the token exists in
 * plaintext; Settings turns it into the pairing QR code and forgets it.
 * An unused token stops working after the claim window
 * (lib/companion-gate.ts). Mirrored in core/src/server/companion.rs.
 */
export async function POST(request: Request) {
  const guard = requireMutationGuard(request, {
    action: "companion.pair",
    rateLimit: {
      keyPrefix: "companion.pair",
      limit: 10,
      windowMs: 60_000,
      message: "Too many pairing codes. Try again in a minute.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: Record<string, unknown>;
  try {
    body = await readOptionalBoundedJson<Record<string, unknown>>(
      request,
      4 * 1024,
      {}
    );
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }
    const message =
      error instanceof Error ? error.message : "Invalid JSON body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (countCompanionDevices() >= COMPANION_MAX_DEVICES) {
    return NextResponse.json(
      {
        error: `${COMPANION_MAX_DEVICES} phones are paired already. Remove one in Settings → Companion first.`,
      },
      { status: 409 }
    );
  }

  const label = cleanLabel(body?.label, COMPANION_LABEL_DEFAULT);
  const created = createCompanionPairing(label);
  recordAudit({
    action: "companion.paired",
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    detail: JSON.stringify({ id: created.device.id, label }),
    success: true,
  });
  return NextResponse.json(
    { device: created.device, token: created.token },
    { status: 201 }
  );
}
