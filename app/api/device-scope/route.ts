/**
 * /api/device-scope — read / save / reset the global device scope.
 *
 *   GET    → { scope, devices }
 *   PUT    body { scope } → { scope, devices } (reconciled before persisting)
 *   DELETE → resets to "all devices", returns { scope, devices }
 *
 * `devices` rides along on every response deliberately. The scope is
 * reconciled against the live device list (unknown ids dropped, a
 * fully-ticked subset collapsed to "all"), so handing the client a scope
 * without the list it was reconciled against invites the two drifting
 * apart — the picker would render checkboxes that disagree with what the
 * server just stored. One response, one consistent pair.
 *
 * Mutating handlers go through `requireMutationGuard`, matching
 * /api/dashboard/layout. Scope is a personal view preference, not a
 * privileged operation, so no admin gate — the rate limiter is there to
 * stop a runaway picker hammering SQLite.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import {
  getDeviceScope,
  resetDeviceScope,
  saveDeviceScope,
} from "@/lib/device-scope-server";
import { getAllDevices, getDeviceAppCounts } from "@/lib/devices";
import { requestBodyErrorResponse } from "@/lib/request-body";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

// Generous for a scope naming every device on a large family install
// (a UUID plus a comma is 37 bytes, so this holds ~100 devices).
const BODY_BYTES = 8 * 1024;

/** Minimal device rows for the picker: identity, iconography, ownership,
 *  and the app count each contributes. Everything else on `Device`
 *  (ecid, iOS version, timestamps) belongs to Settings → Devices. */
function pickerDevices() {
  try {
    const counts = getDeviceAppCounts();
    return getAllDevices().map((d) => ({
      appCount: counts.get(d.id) ?? 0,
      deviceClass: d.deviceClass,
      id: d.id,
      model: d.model,
      name: d.name,
      // Ownership drives the picker's grouping and the focus-switch
      // prompt. Both are null until the user states them in
      // Settings → Devices; nothing infers them.
      ownerAudience: d.ownerAudience,
      ownerLabel: d.ownerLabel,
    }));
  } catch (error) {
    console.warn("[device-scope] device list failed:", error);
    return [];
  }
}

export async function GET() {
  return NextResponse.json({
    scope: getDeviceScope(),
    devices: pickerDevices(),
  });
}

export async function PUT(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "device.scope.save",
    rateLimit: { keyPrefix: "device.scope.save", limit: 60, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, BODY_BYTES);
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Body must be an object" },
      { status: 400 }
    );
  }

  const raw = (body as { scope?: unknown }).scope;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json(
      { error: "Missing or invalid `scope` field" },
      { status: 400 }
    );
  }

  // Reconcile against the live device list before persisting — untrusted
  // input never lands in the DB raw.
  const scope = saveDeviceScope(raw);
  return NextResponse.json({ scope, devices: pickerDevices() });
}

export async function DELETE(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "device.scope.reset",
    rateLimit: { keyPrefix: "device.scope.reset", limit: 20, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json({
    scope: resetDeviceScope(),
    devices: pickerDevices(),
  });
}
