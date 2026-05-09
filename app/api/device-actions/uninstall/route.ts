/**
 * /api/device-actions/uninstall — record an attempted (or successful)
 * cfgutil uninstall.
 *
 * Like the backup route, the actual subprocess runs Tauri-side via
 * `run_cfgutil_remove_app`. This endpoint:
 *
 *   1. Re-runs the gate check server-side (audience + flag + backup
 *      freshness) so a malicious page can't bypass the webview's
 *      gating by hand-crafting an invoke. Returns 403 with a
 *      structured `{ reason }` body when refused so the wizard can
 *      render the right copy.
 *   2. Writes a `cfgutil_uninstall` activity row regardless of
 *      success — failures are as important to log as successes.
 *
 * The endpoint is GET-able too: `GET /api/device-actions/uninstall?ecid=…`
 * returns the gate result without committing anything. The wizard
 * uses this to decide whether to render the uninstall buttons at all.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { checkUninstallGate, recordUninstall } from '@/lib/device-actions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ecid = request.nextUrl.searchParams.get('ecid');
  if (!ecid) {
    return NextResponse.json({ error: 'ecid is required' }, { status: 400 });
  }
  return NextResponse.json(checkUninstallGate(ecid));
}

interface Body {
  ecid?: string;
  bundleId?: string;
  appId?: string | null;
  appName?: string | null;
  ok?: boolean;
  error?: string | null;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.ecid || typeof body.ecid !== 'string') {
    return NextResponse.json({ error: 'ecid is required' }, { status: 400 });
  }
  if (!body.bundleId || typeof body.bundleId !== 'string') {
    return NextResponse.json({ error: 'bundleId is required' }, { status: 400 });
  }
  if (typeof body.ok !== 'boolean') {
    return NextResponse.json({ error: 'ok is required' }, { status: 400 });
  }

  // Server-side gate. Even though the webview will have already
  // checked, repeat the check before writing any audit row so a
  // direct API hit can't bypass the protections.
  const gate = checkUninstallGate(body.ecid);
  if (!gate.allowed) {
    return NextResponse.json({ error: 'gate_denied', gate }, { status: 403 });
  }

  try {
    recordUninstall({
      ecid: body.ecid,
      bundleId: body.bundleId,
      appId: body.appId ?? null,
      appName: body.appName ?? null,
      ok: body.ok,
      error: body.error ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[/api/device-actions/uninstall POST] failed:', e);
    return NextResponse.json({ error: 'Failed to record uninstall' }, { status: 500 });
  }
}
