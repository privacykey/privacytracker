import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { getSetting, setSetting } from "@/lib/scheduler";
import { readBoundedJson } from "@/lib/security";

/**
 * Floating dev-menu opt-in state, persisted in `app_settings` so it
 * survives Tauri sidecar restarts (the localhost port changes per launch
 * so localStorage scope changes too).
 *
 *   GET  → { enabled: boolean }
 *   POST { enabled: boolean } → echoes back the new state
 *
 * Persisted key: `dev_menu_enabled`. Matching localStorage key on the JS
 * side is `dev-menu-on`.
 */
export const dynamic = "force-dynamic";

const KEY = "dev_menu_enabled";

function read(): { enabled: boolean } {
  return { enabled: getSetting(KEY, "false") === "true" };
}

export async function GET() {
  return NextResponse.json(read());
}

export async function POST(req: NextRequest) {
  const guard = requireMutationGuard(req, {
    action: "dev_menu.write",
    rateLimit: { keyPrefix: "dev_menu.write", limit: 30, windowMs: 60_000 },
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
  const next = (body as { enabled?: unknown }).enabled;
  if (typeof next !== "boolean") {
    return NextResponse.json(
      { error: "expected { enabled: boolean }" },
      { status: 400 }
    );
  }
  setSetting(KEY, next ? "true" : "false");
  return NextResponse.json(read());
}
