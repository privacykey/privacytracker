import { NextRequest, NextResponse } from 'next/server';
import { checkForUpdate, getCachedUpdateStatus } from '@/lib/update-check';

/**
 * GET /api/update-status
 *
 * Default behaviour: cheap synchronous read of the cached status. The
 * cache is refreshed in the background by the 24h ticker in
 * `instrumentation.ts`, so most polls never hit the network.
 *
 * Query params:
 *   - `?refresh=1` — force a live check (subject to a 5-min throttle).
 *     Used by the manual "Check now" button in Settings.
 *
 * Response shape mirrors `UpdateStatus` from lib/update-check.ts plus a
 * `meta` object describing this particular request (refreshed?, error?).
 *
 * `force-dynamic` because we read mutable settings on every call — same
 * pattern as /api/sync/status, /api/notifications, etc.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const force = url.searchParams.get('refresh') === '1';

  if (force) {
    const result = await checkForUpdate({ force: true });
    return NextResponse.json({
      ...result.status,
      meta: {
        refreshed: result.performed,
        skipReason: result.skipReason ?? null,
        error: result.error ?? null,
      },
    });
  }

  const status = getCachedUpdateStatus();
  return NextResponse.json({
    ...status,
    meta: {
      refreshed: false,
      skipReason: 'cache_only',
      error: status.lastError,
    },
  });
}
