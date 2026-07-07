/**
 * /api/device-actions/backup — record a completed cfgutil backup.
 *
 * The actual subprocess runs Tauri-side via `run_cfgutil_backup`. This
 * endpoint exists so the webview can persist the outcome (timestamp +
 * path) into the SQLite-backed `app_settings` table and write an
 * activity row. The freshness gate that protects the uninstall path
 * reads from the same key.
 *
 * Audience gate: present here as defence in depth, even though the
 * webview wizard already hides the entry points when audience !==
 * 'self'. A bundle-import flow could in theory craft a request from
 * an audience that shouldn't be able to record backups; we refuse
 * before writing any state.
 */

import { type NextRequest, NextResponse } from "next/server";
import { normalizeEcid, recordBackup } from "@/lib/device-actions";
import { getActiveFocus } from "@/lib/feature-flag-storage";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

interface Body {
  deviceName?: string | null;
  ecid?: string;
  finishedAt?: number;
  path?: string;
}

export async function POST(request: NextRequest) {
  const focus = getActiveFocus();
  if (focus.audience !== "self") {
    return NextResponse.json(
      { error: "Backups can only be recorded under audience=self." },
      { status: 403 }
    );
  }

  let body: Body;
  try {
    body = await readBoundedJson<Body>(request, 8 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.ecid ||
    typeof body.ecid !== "string" ||
    !normalizeEcid(body.ecid)
  ) {
    return NextResponse.json(
      { error: "a valid ecid is required" },
      { status: 400 }
    );
  }
  if (!body.path || typeof body.path !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (
    typeof body.finishedAt !== "number" ||
    !Number.isFinite(body.finishedAt)
  ) {
    return NextResponse.json(
      { error: "finishedAt is required" },
      { status: 400 }
    );
  }

  try {
    recordBackup({
      ecid: body.ecid,
      path: body.path,
      finishedAt: body.finishedAt,
      deviceName: body.deviceName ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/device-actions/backup POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to record backup" },
      { status: 500 }
    );
  }
}
