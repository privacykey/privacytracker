/**
 * /api/feature-flags/overrides — write/clear flag overrides.
 *
 *   POST   { key, value }              — set or upsert a single override
 *   POST   { flags: [{ key, override }] }
 *                                      — bulk import: WIPE every existing
 *                                        non-quarantined override and replay
 *                                        only the rows whose `override` is
 *                                        non-null. Mirrors the shape produced
 *                                        by the panel's "Export current flag
 *                                        state as JSON" download so a round-
 *                                        trip just works. Unknown keys are
 *                                        skipped (counted in the response).
 *   DELETE                             — clear ALL non-quarantined overrides
 *   DELETE ?surface=<prefix>           — clear overrides for one surface (e.g. ?surface=dashboard)
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  setOverride as storeOverride,
  clearAllOverrides,
  clearSurfaceOverrides,
} from '@/lib/feature-flag-storage';
import { HARD_DEFAULTS, type FlagKey, type FlagValue } from '@/lib/feature-flag-rules';
import { readBoundedJson } from '@/lib/security';

export const dynamic = 'force-dynamic';

const VALID_VALUES: readonly FlagValue[] = ['on', 'off', 'collapsed'];

interface PostBody {
  key?: string;
  value?: string;
  /**
   * Bulk-import payload. When present, the server wipes every existing
   * override (using the same code path as DELETE without a surface) and
   * then replays each row whose `override` is non-null. This is the path
   * the Dev Options "Import flag state" button hits — the export blob's
   * top-level shape is `{ flags: [...] }`, where each row carries an
   * `override` of `'on' | 'off' | 'collapsed' | null`.
   */
  flags?: Array<{
    key?: unknown;
    override?: unknown;
  }>;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = await readBoundedJson<PostBody>(request, 64 * 1024);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Bulk import path. We treat the presence of an array `flags` as the
  // signal to use the wipe-then-replay flow rather than a single-key
  // upsert, so callers don't need a separate URL.
  if (Array.isArray(body.flags)) {
    let applied = 0;
    let skipped = 0;
    const skippedKeys: string[] = [];
    try {
      // Wipe first so any flag the user is dropping (`override === null`
      // in the imported file) really goes back to its computed default.
      // `clearAllOverrides` only touches non-quarantined rows so the
      // quarantine table is preserved — same guarantee the standalone
      // DELETE handler gives.
      clearAllOverrides();

      for (const row of body.flags) {
        if (!row || typeof row !== 'object') { skipped++; continue; }
        const key = row.key;
        const override = row.override;

        // Only persist rows whose `override` is one of the valid string
        // values. `null` (cleared) and unknown / malformed entries fall
        // through to the post-wipe default state.
        if (typeof key !== 'string' || !(key in HARD_DEFAULTS)) {
          skipped++;
          if (typeof key === 'string') skippedKeys.push(key);
          continue;
        }
        if (override === null || override === undefined) {
          // Imported file says "no override" — already covered by the wipe.
          continue;
        }
        if (typeof override !== 'string' || !VALID_VALUES.includes(override as FlagValue)) {
          skipped++;
          continue;
        }
        storeOverride(key as FlagKey, override as FlagValue);
        applied++;
      }
    } catch (e) {
      console.error('[/api/feature-flags/overrides POST bulk] failed:', e);
      return NextResponse.json({ error: 'Failed to import overrides' }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      applied,
      skipped,
      // Truncate so a malformed file with thousands of unknown keys
      // doesn't bloat the response. Callers get the count + a sample.
      skippedKeys: skippedKeys.slice(0, 20),
    });
  }

  if (!body.key || typeof body.key !== 'string' || !(body.key in HARD_DEFAULTS)) {
    return NextResponse.json({ error: 'unknown flag key' }, { status: 400 });
  }
  if (!body.value || !VALID_VALUES.includes(body.value as FlagValue)) {
    return NextResponse.json(
      { error: `value must be one of: ${VALID_VALUES.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    storeOverride(body.key as FlagKey, body.value as FlagValue);
  } catch (e) {
    console.error('[/api/feature-flags/overrides POST] failed:', e);
    return NextResponse.json({ error: 'Failed to set override' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, key: body.key, value: body.value });
}

export async function DELETE(request: NextRequest) {
  const surface = request.nextUrl.searchParams.get('surface');

  try {
    if (surface) {
      clearSurfaceOverrides(surface);
    } else {
      clearAllOverrides();
    }
  } catch (e) {
    console.error('[/api/feature-flags/overrides DELETE] failed:', e);
    return NextResponse.json({ error: 'Failed to clear overrides' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scope: surface ?? 'all' });
}
