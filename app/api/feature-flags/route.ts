/**
 * /api/feature-flags — list every registered flag with its resolved value
 * + current override (if any). Drives the Dev Options panel.
 *
 *   GET  → { flags: [{ key, hardDefault, currentValue, override, surface }] }
 *
 * Mutations live at /api/feature-flags/overrides (one resource per key)
 * and /api/feature-flags/overrides (DELETE for bulk clear).
 */

import { NextResponse } from 'next/server';
import { HARD_DEFAULTS, type FlagKey, type FlagValue } from '@/lib/feature-flag-rules';
import { getResolverContextFromDb } from '@/lib/feature-flags-server';
import { resolveFlag } from '@/lib/feature-flags';
import { isWired } from '@/lib/feature-flag-wired';

export const dynamic = 'force-dynamic';

interface FlagRow {
  key: FlagKey;
  surface: string;
  hardDefault: FlagValue;
  currentValue: FlagValue;
  override: FlagValue | null;
  /** True when at least one component / route consumes this flag today. */
  wired: boolean;
}

export async function GET() {
  try {
    const ctx = getResolverContextFromDb();

    const rows: FlagRow[] = (Object.keys(HARD_DEFAULTS) as FlagKey[]).map((key) => {
      const surface = surfaceOf(key);
      const hardDefault = HARD_DEFAULTS[key];
      const override = ctx.overrides.get(key) ?? null;
      const currentValue = resolveFlag(key, ctx);
      return { key, surface, hardDefault, currentValue, override, wired: isWired(key) };
    });

    // Stable sort: surface alphabetical, then key alphabetical inside each surface.
    rows.sort((a, b) =>
      a.surface === b.surface ? a.key.localeCompare(b.key) : a.surface.localeCompare(b.surface),
    );

    return NextResponse.json({ flags: rows });
  } catch (e) {
    console.error('[/api/feature-flags GET] failed:', e);
    return NextResponse.json({ error: 'Failed to list flags' }, { status: 500 });
  }
}

/** Pull the surface prefix out of a flag key — second dotted segment. */
function surfaceOf(key: FlagKey): string {
  const parts = key.split('.');
  return parts.length >= 2 ? parts[1] : 'misc';
}
