/**
 * /api/dev/sync-stop — POST releases the sync mutex + clears the bulk
 * state so the runner exits at its next safe boundary.
 *
 * Cooperative cancel only: the in-flight scrape for the current app
 * finishes (Apple is already mid-request), then the runner sees the
 * cleared mutex and bails out at the per-app loop boundary. This is the
 * same code path the bulk runner uses on graceful completion, so the
 * activity log stays clean and no resume row is created.
 *
 * Dev-menu surface; not exposed in user-facing UI.
 */

import { NextResponse } from 'next/server';
import { requireMutationGuard } from '@/lib/api-guards';
import { clearSyncBulkState, releaseSyncBulkMutex } from '@/lib/sync-bulk-state';
import { recordAudit } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const guard = requireMutationGuard(request, {
    action: 'dev.sync_stop',
    rateLimit: {
      keyPrefix: 'dev.sync_stop',
      limit: 10,
      windowMs: 10 * 60_000,
      message: 'Rate limit exceeded for sync stop. Try again later.',
    },
  });
  if (!guard.ok) return guard.response;

  try {
    clearSyncBulkState();
    releaseSyncBulkMutex();
  } catch (e) {
    console.error('[/api/dev/sync-stop] failed:', e);
    recordAudit({
      action: 'dev.sync_stop.failed',
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: 'Failed to release sync mutex' },
      { status: 500 },
    );
  }
  recordAudit({
    action: 'dev.sync_stop.success',
    actorIp: guard.actorIp,
    userAgent: guard.userAgent,
    success: true,
  });
  return NextResponse.json({ ok: true });
}
