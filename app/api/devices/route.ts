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
  isDeviceOwnerAudience,
  setDeviceOwner,
} from "@/lib/devices";
import { getImportCountForDevice } from "@/lib/imports";
import { requestBodyErrorResponse } from "@/lib/request-body";
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
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }

    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "expected object body" },
      { status: 400 }
    );
  }
  const {
    name,
    ecid,
    model,
    iosVersion,
    deviceClass,
    ownerLabel,
    ownerAudience,
    permissionAcknowledged,
  } = body as {
    name?: unknown;
    ecid?: unknown;
    model?: unknown;
    iosVersion?: unknown;
    deviceClass?: unknown;
    ownerAudience?: unknown;
    ownerLabel?: unknown;
    permissionAcknowledged?: unknown;
  };
  // Ownership is optional at create time; the onboarding wizard sends it
  // from its "whose device is this?" step. Validated the same way PATCH
  // validates it, so the two paths cannot accept different shapes.
  const hasOwnership =
    Object.hasOwn(body, "ownerAudience") || Object.hasOwn(body, "ownerLabel");
  if (
    Object.hasOwn(body, "ownerLabel") &&
    !(ownerLabel === null || typeof ownerLabel === "string")
  ) {
    return NextResponse.json(
      { error: "ownerLabel must be a string or null" },
      { status: 400 }
    );
  }
  if (
    Object.hasOwn(body, "ownerAudience") &&
    !(ownerAudience === null || isDeviceOwnerAudience(ownerAudience))
  ) {
    return NextResponse.json(
      { error: "ownerAudience must be self, loved_one, guardian, or null" },
      { status: 400 }
    );
  }
  if (
    Object.hasOwn(body, "permissionAcknowledged") &&
    typeof permissionAcknowledged !== "boolean"
  ) {
    return NextResponse.json(
      { error: "permissionAcknowledged must be a boolean" },
      { status: 400 }
    );
  }
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
    // Applied AFTER find-or-create rather than passed into createDevice,
    // because a cfgutil ECID the install has seen before resolves to the
    // existing row — and the user's answer to "whose device is this?"
    // must land on that row too, not be silently dropped.
    if (hasOwnership || Object.hasOwn(body, "permissionAcknowledged")) {
      setDeviceOwner(device.id, {
        ...(Object.hasOwn(body, "ownerLabel")
          ? { label: (ownerLabel as string | null) ?? null }
          : {}),
        ...(Object.hasOwn(body, "ownerAudience")
          ? {
              audience: isDeviceOwnerAudience(ownerAudience)
                ? ownerAudience
                : null,
            }
          : {}),
        ...(typeof permissionAcknowledged === "boolean"
          ? { permissionAcknowledged }
          : {}),
      });
      // The attestation is the auditable part: who said they had
      // permission, for which device, and when.
      recordAudit({
        action:
          permissionAcknowledged === true
            ? "devices.permission_acknowledged"
            : "devices.set_owner",
        actorIp: requestActorIp(req),
        userAgent: req.headers.get("user-agent"),
        detail: JSON.stringify({
          id: device.id,
          ownerLabel,
          ownerAudience,
          permissionAcknowledged,
        }),
        success: true,
      });
    }
    return NextResponse.json({ device: getDeviceById(device.id) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
