export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getImportQueueStatus, forceImportQueueRun } from '../../../../lib/import-queue';

/**
 * GET  /api/imports/queue — poll endpoint used by the Task Center provider
 *                          and Import History to render "X queued" + ETA.
 * POST /api/imports/queue — force an immediate drain + clear global pause.
 *                          Bound to the "Retry queue now" button.
 */
export async function GET() {
  return NextResponse.json(getImportQueueStatus());
}

export async function POST() {
  try {
    const result = await forceImportQueueRun();
    return NextResponse.json({ ...result, status: getImportQueueStatus() });
  } catch (error) {
    console.error('Force import-queue run failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
