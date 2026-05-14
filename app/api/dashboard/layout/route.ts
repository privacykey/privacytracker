/**
 * /api/dashboard/layout — read / save / reset the user's dashboard layout.
 *
 *   GET    → { layout, matchedPreset: DashboardPresetKey | null }
 *   PUT    body { layout } → { layout, matchedPreset } (validated + reconciled)
 *   DELETE → resets to the `default` preset, returns { layout, matchedPreset }
 *
 * All mutating handlers go through `requireMutationGuard` — same pattern
 * the feature-flags override route uses. Body cap is generous (8 KiB) so a
 * 16-card layout fits trivially with headroom for future additions.
 *
 * `saveDashboardLayoutWithLog` in lib/dashboard-layout-server.ts records
 * a `dashboard_layout_applied` activity row whenever the change crosses
 * a named-preset boundary. Custom-to-custom edits (single-row tweaks
 * inside a non-preset state) intentionally don't fire — the editor saves
 * on every keystroke and we don't want the activity log to spam every
 * reorder.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  readDashboardLayoutWithMatch,
  resetDashboardLayout,
  saveDashboardLayoutWithLog,
} from '@/lib/dashboard-layout-server';
import {
  matchDashboardPreset,
  reconcileLayout,
} from '@/lib/dashboard-layout';
import { readBoundedJson } from '@/lib/security';
import { requireMutationGuard } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

const BODY_BYTES = 8 * 1024;

export async function GET() {
  return NextResponse.json(readDashboardLayoutWithMatch());
}

export async function PUT(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: 'dashboard.layout.save',
    rateLimit: {
      keyPrefix: 'dashboard.layout.save',
      limit: 60,
      windowMs: 60_000,
    },
    // Layout edits are a personal preference, not a privileged operation
    // — same rationale as the privacy-profile save (no admin gate). The
    // rate limiter still protects the DB from a runaway editor.
    requireAdminToken: false,
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, BODY_BYTES);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const raw = (body as { layout?: unknown }).layout;
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json(
      { error: 'Missing or invalid `layout` field' },
      { status: 400 },
    );
  }

  // Reconcile to drop unknown ids, slot any missing canonical cards
  // next to their neighbour, and dedupe. The reconciled layout is what
  // we persist — untrusted input never lands in the DB raw.
  const reconciled = reconcileLayout(raw);
  saveDashboardLayoutWithLog(reconciled);

  return NextResponse.json({
    layout: reconciled,
    matchedPreset: matchDashboardPreset(reconciled),
  });
}

export async function DELETE(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: 'dashboard.layout.reset',
    rateLimit: {
      keyPrefix: 'dashboard.layout.reset',
      limit: 20,
      windowMs: 60_000,
    },
    requireAdminToken: false,
  });
  if (!guard.ok) return guard.response;

  const next = resetDashboardLayout();
  return NextResponse.json({
    layout: next,
    matchedPreset: matchDashboardPreset(next),
  });
}
