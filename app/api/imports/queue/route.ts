export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getImportQueueStatus, forceImportQueueRun } from '../../../../lib/import-queue';
import { withApiTiming } from '../../../../lib/api-timing';

/**
 * GET  /api/imports/queue — poll endpoint used by the Task Center provider
 *                          and Import History to render "X queued" + ETA.
 * POST /api/imports/queue — force an immediate drain + clear global pause.
 *                          Bound to the "Retry queue now" button.
 *
 * Both handlers are wrapped with `withApiTiming` so slow ticks land in the
 * diagnostics ring — this is the most useful route to track during an
 * import hang.
 */
export const GET = withApiTiming('/api/imports/queue', async () => {
  return NextResponse.json(getImportQueueStatus());
});

export const POST = withApiTiming('/api/imports/queue', async () => {
  try {
    const result = await forceImportQueueRun();
    return NextResponse.json({ ...result, status: getImportQueueStatus() });
  } catch (error) {
    console.error('Force import-queue run failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});
