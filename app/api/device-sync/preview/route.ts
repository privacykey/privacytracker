/**
 * /api/device-sync/preview — compute the diff between a device's current
 * tracked app set and an incoming import list.
 *
 *   POST { deviceId, currentImport: ImportedAppRef[] } → DeviceSyncDiff
 *
 * Pure read; doesn't write anything. The commit step lives at
 * /api/device-sync/commit.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import db from "@/lib/db";
import { computeDeviceSyncDiff, type ImportedAppRef } from "@/lib/device-sync";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // The preview is a no-side-effect read, but we still rate-limit it
  // because callers feed it an arbitrarily-long array of app refs and we
  // don't want a misbehaving client to spam the diff path.
  const guard = requireMutationGuard(req, {
    action: "device_sync.preview",
    rateLimit: {
      keyPrefix: "device_sync.preview",
      limit: 30,
      windowMs: 60_000,
    },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await readBoundedJson<unknown>(req, 512 * 1024);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "expected object body" },
      { status: 400 }
    );
  }
  const { deviceId, currentImport } = body as {
    deviceId?: unknown;
    currentImport?: unknown;
  };
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    return NextResponse.json({ error: "deviceId required" }, { status: 400 });
  }
  if (!Array.isArray(currentImport)) {
    return NextResponse.json(
      { error: "currentImport must be an array" },
      { status: 400 }
    );
  }
  // Cap the list to prevent DoS via huge payloads.
  if (currentImport.length > 2000) {
    return NextResponse.json(
      { error: "too many apps in currentImport" },
      { status: 400 }
    );
  }
  // Sanitize each entry — we only require appId + name.
  const sanitized: ImportedAppRef[] = [];
  for (const entry of currentImport) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.appId !== "string" || !e.appId.trim()) {
      continue;
    }
    sanitized.push({
      appId: e.appId.trim(),
      name: typeof e.name === "string" ? e.name : "",
      developer: typeof e.developer === "string" ? e.developer : null,
      url: typeof e.url === "string" ? e.url : null,
      iconUrl: typeof e.iconUrl === "string" ? e.iconUrl : null,
      bundleId: typeof e.bundleId === "string" ? e.bundleId : null,
    });
  }

  // Enrich any rows the client didn't send a bundleId for. The diff's
  // bundle-ID overlap detection (which catches the
  // legacy-import-rename artifact — see DiffBundleIdMerge) only fires
  // when the incoming side has a bundleId, so we backfill from the
  // server-side apps table here. Single bulk query so a 500-app
  // import doesn't become 500 round-trips.
  const idsMissingBundle = sanitized
    .filter((r) => !r.bundleId)
    .map((r) => r.appId);
  if (idsMissingBundle.length > 0) {
    const placeholders = idsMissingBundle.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, bundleId FROM apps WHERE id IN (${placeholders})`)
      .all(...idsMissingBundle) as { id: string; bundleId: string | null }[];
    const lookup = new Map<string, string | null>(
      rows.map((r) => [r.id, r.bundleId])
    );
    for (const ref of sanitized) {
      if (ref.bundleId) {
        continue;
      }
      const found = lookup.get(ref.appId);
      if (found) {
        ref.bundleId = found;
      }
    }
  }

  try {
    const diff = computeDeviceSyncDiff(deviceId.trim(), sanitized);
    return NextResponse.json({ diff });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("unknown deviceId")) {
      return NextResponse.json({ error: "device not found" }, { status: 404 });
    }
    console.error("[device-sync/preview] failed:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
