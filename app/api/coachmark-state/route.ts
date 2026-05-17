import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { getSetting, setSetting } from "@/lib/scheduler";
import { readBoundedJson } from "@/lib/security";

/**
 * Coachmark-tour completion state, persisted in `app_settings` so the
 * Tauri desktop shell (different localhost port per launch, so different
 * localStorage origin) doesn't re-prompt on every launch. The component
 * still writes localStorage as a same-session cache; this endpoint is
 * the source of truth.
 *
 *   GET  → { completed: boolean }
 *   POST { completed: boolean } → echoes back the new state
 */
export const dynamic = "force-dynamic";

const KEY = "coachmark_tour_done";

function read(): { completed: boolean } {
  return { completed: getSetting(KEY, "false") === "true" };
}

export async function GET() {
  return NextResponse.json(read());
}

export async function POST(req: NextRequest) {
  const guard = requireMutationGuard(req, {
    action: "coachmark.write",
    rateLimit: { keyPrefix: "coachmark.write", limit: 30, windowMs: 60_000 },
    // Coachmark state is a low-stakes UI cosmetic; no admin token needed
    // beyond what same-origin CSRF gives us.
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown = null;
  try {
    body = await readBoundedJson<unknown>(req, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "expected object body" },
      { status: 400 }
    );
  }
  const next = (body as { completed?: unknown }).completed;
  if (typeof next !== "boolean") {
    return NextResponse.json(
      { error: "expected { completed: boolean }" },
      { status: 400 }
    );
  }
  setSetting(KEY, next ? "true" : "false");
  return NextResponse.json(read());
}
