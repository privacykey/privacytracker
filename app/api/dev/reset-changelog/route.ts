/**
 * /api/dev/reset-changelog — POST clears the change-history tables but
 * keeps every tracked app intact. Useful for testing the "first sync /
 * baseline" path without re-onboarding apps from scratch.
 *
 * What gets cleared:
 *   - privacy_snapshots          (the per-sync snapshot rows)
 *   - change_review_actions      (per-change ack/snooze/dismiss state)
 *   - apps.changeCount           (reset to 0)
 *   - apps.changes_acknowledged_at (reset to 0)
 *   - apps.changes_snoozed_until (reset to 0)
 *
 * What's preserved:
 *   - apps themselves
 *   - privacy_types + privacy_categories (the current-state snapshot)
 *   - accessibility_features
 *   - notifications (we leave these — the bell history is separate)
 *
 * After this runs, the next sync of any app produces a clean baseline
 * snapshot with no diff (because there's no previous snapshot to diff
 * against).
 */

import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { recordActivity } from '@/lib/activity';
import { requireMutationGuard } from '@/lib/api-guards';
import { recordAudit } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const startedAt = Date.now();
  const guard = requireMutationGuard(request, {
    action: 'dev.reset_changelog',
    rateLimit: {
      keyPrefix: 'dev.reset_changelog',
      limit: 6,
      windowMs: 10 * 60_000,
      message: 'Rate limit exceeded for dev changelog reset. Try again later.',
    },
  });
  if (!guard.ok) return guard.response;

  let snapshotsRemoved = 0;
  let reviewActionsRemoved = 0;
  let appsTouched = 0;

  try {
    const wipe = db.transaction(() => {
      const a = db.prepare('DELETE FROM privacy_snapshots').run();
      snapshotsRemoved = a.changes;

      try {
        const b = db.prepare('DELETE FROM change_review_actions').run();
        reviewActionsRemoved = b.changes;
      } catch (e) {
        // Older installs may not have this table — non-fatal.
        console.warn('[dev/reset-changelog] change_review_actions skipped:', e);
      }

      const c = db
        .prepare(
          `UPDATE apps
             SET changeCount = 0,
                 changes_acknowledged_at = 0,
                 changes_snoozed_until = 0`,
        )
        .run();
      appsTouched = c.changes;
    });
    wipe();
  } catch (e) {
    console.error('[/api/dev/reset-changelog] failed:', e);
    recordAudit({
      action: 'dev.reset_changelog.failed',
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: 'reset-changelog failed; database left untouched' },
      { status: 500 },
    );
  }

  try {
    recordActivity({
      type: 'reset',
      status: 'ok',
      summary: `Dev reset-changelog — cleared ${snapshotsRemoved} snapshots`,
      detail: {
        mode: 'dev-reset-changelog',
        snapshotsRemoved,
        reviewActionsRemoved,
        appsTouched,
      },
      startedAt,
    });
  } catch (e) {
    console.warn('[/api/dev/reset-changelog] activity-log failed:', e);
  }
  recordAudit({
    action: 'dev.reset_changelog.success',
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
    detail: `snapshotsRemoved=${snapshotsRemoved} appsTouched=${appsTouched}`,
  });

  return NextResponse.json({
    ok: true,
    snapshotsRemoved,
    reviewActionsRemoved,
    appsTouched,
    durationMs: Date.now() - startedAt,
  });
}
