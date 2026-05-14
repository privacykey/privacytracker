/**
 * /api/dashboard/layout/preset — apply a named preset.
 *
 *   POST body { preset: 'default' | 'minimal' | 'caretaker' | 'watchdog' | 'at_a_glance' }
 *        → { layout, matchedPreset }
 *
 * `applyDashboardPreset` goes through `saveDashboardLayoutWithLog`, so a
 * preset apply records a `dashboard_layout_applied` activity row when
 * the change crosses a preset boundary (i.e. always, since the result
 * is a named preset). Idempotent re-applies of the active preset are a
 * no-op for the activity feed.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { applyDashboardPreset } from '@/lib/dashboard-layout-server';
import {
  DASHBOARD_PRESET_KEYS,
  matchDashboardPreset,
  type DashboardPresetKey,
} from '@/lib/dashboard-layout';
import { readBoundedJson } from '@/lib/security';
import { requireMutationGuard } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

const BODY_BYTES = 1 * 1024;

function isPresetKey(value: unknown): value is DashboardPresetKey {
  return (
    typeof value === 'string' &&
    (DASHBOARD_PRESET_KEYS as readonly string[]).includes(value)
  );
}

export async function POST(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: 'dashboard.layout.preset',
    rateLimit: {
      keyPrefix: 'dashboard.layout.preset',
      limit: 30,
      windowMs: 60_000,
    },
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

  const preset = (body as { preset?: unknown }).preset;
  if (!isPresetKey(preset)) {
    return NextResponse.json(
      {
        error: `\`preset\` must be one of: ${DASHBOARD_PRESET_KEYS.join(', ')}`,
      },
      { status: 400 },
    );
  }

  const layout = applyDashboardPreset(preset);
  return NextResponse.json({
    layout,
    matchedPreset: matchDashboardPreset(layout),
  });
}
