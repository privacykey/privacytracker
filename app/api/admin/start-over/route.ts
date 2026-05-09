/**
 * /api/admin/start-over — POST wipes all user data, preserves schema.
 *
 * Distinct from `/api/admin/reset` (which deletes the DB file entirely).
 * Start Over keeps the schema + migration version intact and zeroes out:
 *
 *   - all tracked apps + privacy types/categories + snapshots + history
 *   - all annotations
 *   - all flag overrides + the active focus
 *   - all profiles (privacy + accessibility)
 *   - all AI config (provider, keys, timeouts, debug logs)
 *   - all notifications + activity rows
 *   - the welcomed_at timestamp
 *
 * On completion the user's next page load lands on /welcome (audience
 * unset → §4.10 hybrid-redirect kicks in).
 *
 * Implemented as a single transaction so a partial failure leaves the DB
 * in its pre-call state. Audit-logged via activity_log AFTER the wipe so
 * the row survives.
 */

import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { recordActivity } from '@/lib/activity';
import { requireMutationGuard } from '@/lib/api-guards';
import { START_OVER_TABLES_TO_TRUNCATE } from '@/lib/reset-tables';
import { recordAudit } from '@/lib/security';

export const dynamic = 'force-dynamic';

// app_settings keys that survive Start Over. Currently nothing — the user
// is starting completely fresh. If we ever need to keep e.g. a debug flag
// across resets, list it here.
const SETTINGS_KEYS_TO_PRESERVE: readonly string[] = [];

export async function POST(request: Request) {
  const startedAt = Date.now();
  const guard = requireMutationGuard(request, {
    action: 'admin.start_over',
    rateLimit: {
      keyPrefix: 'admin.start_over',
      limit: 3,
      windowMs: 10 * 60_000,
      message: 'Rate limit exceeded for Start Over. Try again later.',
    },
  });
  if (!guard.ok) return guard.response;

  try {
    const wipe = db.transaction(() => {
      // Truncate per-table data.
      for (const table of START_OVER_TABLES_TO_TRUNCATE) {
        try {
          db.prepare(`DELETE FROM ${table}`).run();
        } catch (e) {
          // Table may not exist on older installs — log and continue.
          console.warn(`[start-over] DELETE FROM ${table} skipped:`, e);
        }
      }

      // Wipe app_settings except any keys we want to preserve.
      if (SETTINGS_KEYS_TO_PRESERVE.length === 0) {
        db.prepare('DELETE FROM app_settings').run();
      } else {
        const placeholders = SETTINGS_KEYS_TO_PRESERVE.map(() => '?').join(', ');
        db.prepare(`DELETE FROM app_settings WHERE key NOT IN (${placeholders})`).run(
          ...SETTINGS_KEYS_TO_PRESERVE,
        );
      }
    });

    wipe();
  } catch (e) {
    console.error('[/api/admin/start-over] failed:', e);
    recordAudit({
      action: 'admin.start_over.failed',
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: 'Start Over failed; database left untouched' },
      { status: 500 },
    );
  }

  // Log the operation AFTER the wipe so the activity row is in the
  // freshly-empty log. Best-effort — don't fail the response if this
  // fails for some reason.
  try {
    recordActivity({
      type: 'reset',
      status: 'ok',
      summary: 'Started over — all user data wiped, schema preserved',
      detail: { mode: 'start-over' },
      startedAt,
    });
  } catch (e) {
    console.warn('[/api/admin/start-over] activity-log failed:', e);
  }
  recordAudit({
    action: 'admin.start_over.success',
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
  });

  return NextResponse.json({ ok: true, durationMs: Date.now() - startedAt });
}
