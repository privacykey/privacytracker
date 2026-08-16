export const dynamic = "force-dynamic";

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { setSettingIfUnset } from "@/lib/scheduler";
import { readBoundedJson } from "@/lib/security";

/**
 * POST /api/user-tasks/visit — body `{ surface: "privacy_map" | "compare" |
 * "app_detail" }`.
 *
 * Records the first-visit marker that `lib/tasks-server.ts` reads when
 * deciding whether the matching checklist task is complete
 * (`task_visit.<surface>_at`).
 *
 * Added for Rust-core Phase 0. The Privacy Map, Compare and App Detail
 * pages each stamped this themselves via `setSettingIfUnset` during
 * their server render; as client shells they can't, and dropping the
 * write would quietly stop those checklist items from ever completing.
 *
 * `setSettingIfUnset` keeps the original semantics exactly: the FIRST
 * visit wins and every later call is a no-op, so this stays safe to fire
 * on every mount.
 */

const SURFACES = new Set(["privacy_map", "compare", "app_detail"]);

export async function POST(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "user-tasks.visit",
    rateLimit: { keyPrefix: "user-tasks.visit", limit: 60, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: { surface?: unknown };
  try {
    body = await readBoundedJson<{ surface?: unknown }>(request, 1024);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const surface = body?.surface;
  if (typeof surface !== "string" || !SURFACES.has(surface)) {
    return NextResponse.json(
      { error: `surface must be one of: ${[...SURFACES].join(", ")}` },
      { status: 400 }
    );
  }

  try {
    setSettingIfUnset(`task_visit.${surface}_at`, String(Date.now()));
  } catch (error) {
    // The page must never break because a completion marker failed —
    // same tolerance the server pages applied.
    console.warn("[user-tasks/visit] marker write failed:", error);
  }

  return NextResponse.json({ ok: true, surface });
}
