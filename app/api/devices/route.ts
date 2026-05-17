/**
 * /api/devices — list + create.
 *
 *   GET  → { devices: Array<Device & { appCount: number }> }
 *   POST { name, ecid?, model?, iosVersion?, deviceClass? } → { device }
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import db from "@/lib/db";
import {
  createDevice,
  findOrCreateDeviceByEcid,
  getAllDevices,
  getDeviceAppCounts,
  getDeviceById,
} from "@/lib/devices";
import { getImportCountForDevice } from "@/lib/imports";
import { readBoundedJson, recordAudit, requestActorIp } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // `?ecid=<ecid>` — look up a single device by its Apple Configurator
    // identifier and return its prior-import history in the same call.
    // Used by the OnboardWizard cfgutil flow to decide whether to switch
    // into "implicit re-sync" mode when the user reconnects a device
    // they've imported from before. Use a plain `URL` parse so this
    // route works with either NextRequest or a vanilla Request (tests
    // pass the latter).
    const ecidParam = new URL(req.url).searchParams.get("ecid");
    if (typeof ecidParam === "string" && ecidParam.trim()) {
      const trimmed = ecidParam.trim();
      const row = db
        .prepare("SELECT id FROM devices WHERE ecid = ?")
        .get(trimmed) as { id: string } | undefined;
      if (!row) {
        return NextResponse.json({ device: null, importHistory: null });
      }
      const device = getDeviceById(row.id);
      const importHistory = getImportCountForDevice(row.id);
      return NextResponse.json({ device, importHistory });
    }

    const devices = getAllDevices();
    const counts = getDeviceAppCounts();
    return NextResponse.json({
      devices: devices.map((d) => ({ ...d, appCount: counts.get(d.id) ?? 0 })),
    });
  } catch (error) {
    console.error("[devices] GET failed:", error);
    return NextResponse.json({ devices: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = requireMutationGuard(req, {
    action: "devices.create",
    rateLimit: { keyPrefix: "devices.create", limit: 20, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
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
  const { name, ecid, model, iosVersion, deviceClass } = body as {
    name?: unknown;
    ecid?: unknown;
    model?: unknown;
    iosVersion?: unknown;
    deviceClass?: unknown;
  };
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const sanitizedEcid =
    typeof ecid === "string" && ecid.trim() ? ecid.trim() : null;
  const sanitizedModel =
    typeof model === "string" && model.trim() ? model.trim() : null;
  const sanitizedIosVersion =
    typeof iosVersion === "string" && iosVersion.trim()
      ? iosVersion.trim()
      : null;
  const sanitizedDeviceClass =
    typeof deviceClass === "string" && deviceClass.trim()
      ? deviceClass.trim()
      : null;

  try {
    const device = sanitizedEcid
      ? findOrCreateDeviceByEcid(sanitizedEcid, name.trim(), {
          model: sanitizedModel,
          iosVersion: sanitizedIosVersion,
          deviceClass: sanitizedDeviceClass,
        })
      : createDevice({
          name: name.trim(),
          ecid: null,
          model: sanitizedModel,
          iosVersion: sanitizedIosVersion,
          deviceClass: sanitizedDeviceClass,
        });
    recordAudit({
      action: "devices.create",
      actorIp: requestActorIp(req),
      userAgent: req.headers.get("user-agent"),
      detail: JSON.stringify({ id: device.id, ecid: device.ecid }),
      success: true,
    });
    return NextResponse.json({ device });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
