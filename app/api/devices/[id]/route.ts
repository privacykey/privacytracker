/**
 * /api/devices/[id] — rename, merge, or delete.
 *
 *   PATCH { name?, mergeIntoDeviceId? } → { device | merged: true }
 *   DELETE                              → { orphanedAndDeleted }
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { deleteDevice, getDeviceById, renameDevice } from "@/lib/devices";
import { getImportCountForDevice } from "@/lib/imports";
import { readBoundedJson, recordAudit, requestActorIp } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * GET /api/devices/[id] → { device, importHistory }
 *
 * The device row plus its prior-import summary (count + last completed
 * timestamp). Drives the "Previously imported · N times" badge that
 * appears on the OnboardWizard's cfgutil panel when the connected
 * device matches an existing devices row.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const device = getDeviceById(id);
    if (!device) {
      return NextResponse.json({ error: "device not found" }, { status: 404 });
    }
    const importHistory = getImportCountForDevice(id);
    return NextResponse.json({ device, importHistory });
  } catch (error) {
    console.error("[devices/[id]] GET failed:", error);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = requireMutationGuard(req, {
    action: "devices.update",
    rateLimit: { keyPrefix: "devices.update", limit: 30, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await ctx.params;
  if (!getDeviceById(id)) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
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
  const { name, mergeIntoDeviceId } = body as {
    name?: unknown;
    mergeIntoDeviceId?: unknown;
  };

  try {
    if (typeof mergeIntoDeviceId === "string" && mergeIntoDeviceId.trim()) {
      // Merge → delete the source, repoint its links to the target.
      const result = deleteDevice(id, {
        reassignToDeviceId: mergeIntoDeviceId.trim(),
      });
      recordAudit({
        action: "devices.merge",
        actorIp: requestActorIp(req),
        userAgent: req.headers.get("user-agent"),
        detail: JSON.stringify({ sourceId: id, targetId: mergeIntoDeviceId }),
        success: true,
      });
      return NextResponse.json({ merged: true, ...result });
    }

    if (typeof name === "string" && name.trim()) {
      renameDevice(id, name.trim());
      recordAudit({
        action: "devices.rename",
        actorIp: requestActorIp(req),
        userAgent: req.headers.get("user-agent"),
        detail: JSON.stringify({ id, name: name.trim() }),
        success: true,
      });
      return NextResponse.json({ device: getDeviceById(id) });
    }

    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = requireMutationGuard(req, {
    action: "devices.delete",
    rateLimit: { keyPrefix: "devices.delete", limit: 15, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await ctx.params;
  if (!getDeviceById(id)) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  try {
    const result = deleteDevice(id);
    recordAudit({
      action: "devices.delete",
      actorIp: requestActorIp(req),
      userAgent: req.headers.get("user-agent"),
      detail: JSON.stringify({
        id,
        orphanedAndDeleted: result.orphanedAndDeleted,
      }),
      success: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
