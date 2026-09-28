export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { revokeCompanionPairing } from "@/lib/companion";
import { recordAudit } from "@/lib/security";

/**
 * DELETE /api/companion/pairings/[id] — end one phone's pairing. The row is
 * deleted and the gate stops accepting its token in the same instant.
 * Mirrored in core/src/server/companion.rs.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireMutationGuard(request, {
    action: "companion.revoke",
    rateLimit: {
      keyPrefix: "companion.revoke",
      limit: 30,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const label = id && id.length <= 64 ? revokeCompanionPairing(id) : null;
  if (label === null) {
    return NextResponse.json(
      { error: "No pairing with that id" },
      { status: 404 }
    );
  }
  recordAudit({
    action: "companion.revoked",
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    detail: JSON.stringify({ id, label }),
    success: true,
  });
  return NextResponse.json({ ok: true, id });
}
