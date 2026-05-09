/**
 * /api/feature-flags/overrides/[key]
 *
 *   DELETE — clear a single flag's override row
 *
 * The POST/upsert path lives at the parent route (POST { key, value }).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { clearOverride } from '@/lib/feature-flag-storage';
import { HARD_DEFAULTS, type FlagKey } from '@/lib/feature-flag-rules';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ key: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { key } = await context.params;

  if (!(key in HARD_DEFAULTS)) {
    return NextResponse.json({ error: 'unknown flag key' }, { status: 400 });
  }

  try {
    clearOverride(key as FlagKey);
  } catch (e) {
    console.error('[/api/feature-flags/overrides/[key] DELETE] failed:', e);
    return NextResponse.json({ error: 'Failed to clear override' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, key });
}
