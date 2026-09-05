/**
 * /api/device-actions/backup — verify and record a completed cfgutil backup.
 *
 * The actual subprocess runs Tauri-side via `run_cfgutil_backup`. This
 * endpoint exists so the sidecar can independently canonicalise the path,
 * require a non-empty Manifest.db under Apple's MobileSync root, generate
 * an artifact-based completion timestamp, persist the stamp into `app_settings`,
 * and write an activity row. The uninstall gate revalidates the same
 * artifact every time it reads that stamp.
 *
 * Audience gate: present here as defence in depth, even though the
 * webview wizard already hides the entry points when audience !==
 * 'self'. A bundle-import flow could in theory craft a request from
 * an audience that shouldn't be able to record backups; we refuse
 * before writing any state.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  getLastBackup,
  normalizeEcid,
  recordBackup,
} from "@/lib/device-actions";
import { verifyBackupArtifact } from "@/lib/device-backup-verification";
import { getActiveFocus } from "@/lib/feature-flag-storage";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

interface Body {
  deviceName?: string | null;
  ecid?: string;
  /** Legacy client field. Accepted but ignored; the server owns the stamp. */
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
    !body?.ecid ||
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
  const verification = verifyBackupArtifact(body.path);
  if (!verification.ok) {
    return NextResponse.json(
      { error: "backup_not_verified", reason: verification.reason },
      { status: 422 }
    );
  }

  try {
    recordBackup({
      ecid: body.ecid,
      path: verification.path,
      finishedAt: Date.now(),
      deviceName: typeof body.deviceName === "string" ? body.deviceName : null,
    });
    return NextResponse.json({
      ok: true,
      lastBackup: getLastBackup(body.ecid),
    });
  } catch (e) {
    console.error("[/api/device-actions/backup POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to record backup" },
      { status: 500 }
    );
  }
}
