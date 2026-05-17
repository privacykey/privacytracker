export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import db from "../../../lib/db";

/**
 * Liveness probe for Docker / uptime checks. Intentionally does NOT touch
 * `/api/apps` — that route reveals what the user is tracking and we don't
 * want a liveness check to be an oracle for that. A tiny DB ping confirms
 * the process is healthy end-to-end.
 */
export async function GET() {
  try {
    const row = db.prepare("SELECT 1 as ok").get() as
      | { ok: number }
      | undefined;
    if (!row || row.ok !== 1) {
      return NextResponse.json({ status: "degraded" }, { status: 503 });
    }
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("[health] DB ping failed", error);
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
