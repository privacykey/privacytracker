/**
 * /api/activity/queue-session
 *
 *   POST { totals, preflight } → 204
 *
 * Records a `queue_session_completed` activity row at the end of a
 * review-queue session. Used by the ReviewQueue client component as
 * fire-and-forget — no client-visible failure path. The activity feed
 * + Dev Options accordion read these rows.
 */

import { type NextRequest, NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

interface Totals {
  decided?: number;
  notesAdded?: number;
  replace?: number;
  safe?: number;
  uninstall?: number;
}

interface Preflight {
  scope?: string;
  sort?: string;
  split?: number | null;
}

interface Body {
  preflight?: Preflight;
  totals?: Totals;
}

const VALID_SCOPES = new Set(["undecided", "all", "mismatch", "changed"]);
const VALID_SORTS = new Set([
  "mismatch_severity",
  "risk",
  "alphabetical",
  "random",
]);
const VALID_SPLITS = new Set([10, 25, 50, null]);

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = await readBoundedJson<Body>(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const totals = body.totals ?? {};
  const decided = Number(totals.decided ?? 0);
  const safe = Number(totals.safe ?? 0);
  const replace = Number(totals.replace ?? 0);
  const uninstall = Number(totals.uninstall ?? 0);
  const notesAdded = Number(totals.notesAdded ?? 0);

  const preflight = body.preflight ?? {};
  const scope = VALID_SCOPES.has(preflight.scope as string)
    ? preflight.scope
    : "unknown";
  const sort = VALID_SORTS.has(preflight.sort as string)
    ? preflight.sort
    : "unknown";
  const split = VALID_SPLITS.has(preflight.split as number | null)
    ? preflight.split
    : "unknown";

  // Drop the row entirely when nothing happened — avoids feed noise from
  // users opening + closing the preflight without deciding anything.
  if (decided === 0) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    recordActivity({
      type: "queue_session_completed",
      status: "ok",
      summary: `Queue session: ${decided} decided · ${safe} safe · ${replace} replace · ${uninstall} uninstall`,
      detail: {
        decided,
        safe,
        replace,
        uninstall,
        notesAdded,
        preflight: { scope, sort, split },
      },
      startedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[/api/activity/queue-session] recordActivity failed:", e);
  }
  return new NextResponse(null, { status: 204 });
}
