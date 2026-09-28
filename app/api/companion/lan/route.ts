export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";

/**
 * GET/PUT /api/companion/lan — "Allow phone connections": the desktop app's
 * second listener, bound to the local network with a self-signed TLS
 * certificate whose fingerprint rides in the pairing code, serving only the
 * companion routes. It exists in the Rust core only
 * (core/src/server/companion_lan.rs), and only when the core runs inside the
 * desktop app: a Docker install is reached at its own address instead.
 *
 * This Node route answers for the rollback builds so Settings can tell the
 * feature is not here, rather than fetch a 404.
 */

const UNSUPPORTED = {
  supported: false,
  enabled: false,
  running: false,
  port: null,
  addresses: [] as string[],
  fingerprint: null,
  error: null,
};

export async function GET() {
  return NextResponse.json(UNSUPPORTED);
}

export async function PUT(request: Request) {
  const guard = requireMutationGuard(request, {
    action: "companion.lan",
    rateLimit: {
      keyPrefix: "companion.lan",
      limit: 10,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }
  return NextResponse.json(
    {
      error:
        "Phone connections over Wi-Fi are part of the desktop app's built-in server only.",
    },
    { status: 409 }
  );
}
