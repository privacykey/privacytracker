/**
 * /api/verdicts/bulk
 *
 *   POST { appIds: string[], verdict: 'safe'|'replace'|'uninstall', rationale?: string }
 *     → { count, verdicts: AppVerdict[] }
 *
 * Single transaction + single activity-log row, used by AppGrid Select
 * mode to mark many apps at once. Per-app verdict_set rows are
 * intentionally suppressed in the bulk helper; the bulk_verdict_set
 * summary row is the audit trail.
 *
 * Hard limit: 500 apps per request — defence against runaway clients
 * and DB lock contention. The UI confirms above 10, so this is just
 * a backstop.
 */

import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/security";
import { isValidVerdict, setVerdicts, type VerdictValue } from "@/lib/verdicts";

export const dynamic = "force-dynamic";

const MAX_BULK = 500;

interface PostBody {
  appIds?: unknown;
  rationale?: string | null;
  verdict?: VerdictValue;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = await readBoundedJson<PostBody>(request, 64 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.appIds) || body.appIds.length === 0) {
    return NextResponse.json(
      { error: "appIds must be a non-empty array" },
      { status: 400 }
    );
  }
  if (body.appIds.length > MAX_BULK) {
    return NextResponse.json(
      { error: `appIds exceeds bulk cap of ${MAX_BULK}` },
      { status: 400 }
    );
  }
  if (
    !body.appIds.every(
      (id): id is string => typeof id === "string" && id.length > 0
    )
  ) {
    return NextResponse.json(
      { error: "every appId must be a non-empty string" },
      { status: 400 }
    );
  }
  if (!isValidVerdict(body.verdict)) {
    return NextResponse.json(
      { error: "verdict must be one of: safe, replace, uninstall" },
      { status: 400 }
    );
  }
  if (
    body.rationale !== undefined &&
    body.rationale !== null &&
    typeof body.rationale !== "string"
  ) {
    return NextResponse.json(
      { error: "rationale must be a string or null" },
      { status: 400 }
    );
  }

  try {
    const verdicts = setVerdicts(body.appIds, body.verdict, {
      rationale: body.rationale ?? null,
    });
    try {
      revalidatePath("/dashboard", "layout");
    } catch (e) {
      console.warn("[/api/verdicts/bulk] revalidatePath failed:", e);
    }
    return NextResponse.json(
      { count: verdicts.length, verdicts },
      { status: 201 }
    );
  } catch (e) {
    console.error("[/api/verdicts/bulk POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to bulk-set verdicts" },
      { status: 500 }
    );
  }
}
