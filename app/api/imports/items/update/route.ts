export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  IMPORT_ITEM_STATUSES,
  updateImportItem,
  type ImportItemStatus,
} from '../../../../../lib/imports';
import { readBoundedJson } from '../../../../../lib/security';
import { withApiTiming } from '../../../../../lib/api-timing';

async function updateImportItemRoute(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 32 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      { status: 400 },
    );
  }

  try {
    const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
    }

    const patch: Parameters<typeof updateImportItem>[1] = {};

    if (typeof body?.query === 'string' && body.query.trim().length > 0) {
      patch.query = body.query.trim();
    }
    if (typeof body?.editedQuery === 'string') {
      patch.editedQuery = body.editedQuery.trim() || null;
    }
    if (typeof body?.status === 'string') {
      if (!IMPORT_ITEM_STATUSES.includes(body.status as ImportItemStatus)) {
        return NextResponse.json({ error: `invalid status: ${body.status}` }, { status: 400 });
      }
      patch.status = body.status as ImportItemStatus;
    }
    if ('appId' in body) patch.appId = typeof body.appId === 'string' ? body.appId : null;
    if ('appName' in body) patch.appName = typeof body.appName === 'string' ? body.appName : null;
    if ('developer' in body) patch.developer = typeof body.developer === 'string' ? body.developer : null;
    if ('url' in body) patch.url = typeof body.url === 'string' ? body.url : null;
    if ('iconUrl' in body) patch.iconUrl = typeof body.iconUrl === 'string' ? body.iconUrl : null;
    if ('country' in body) patch.country = typeof body.country === 'string' ? body.country : null;
    if ('scrapeError' in body) {
      patch.scrapeError = typeof body.scrapeError === 'string' ? body.scrapeError : null;
    }
    // `retryAfterMs` is the client's request to enqueue with a specific
    // backoff window. Only honoured when the caller is also flipping status
    // to 'queued' — otherwise it'd be ambiguous what next_attempt_at means.
    if (typeof body?.retryAfterMs === 'number'
        && body.retryAfterMs > 0
        && patch.status === 'queued') {
      patch.nextAttemptAt = Date.now() + body.retryAfterMs;
    }

    const updated = updateImportItem(itemId, patch);
    if (!updated) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    return NextResponse.json({ item: updated });
  } catch (error) {
    console.error('Update import item error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export const POST = withApiTiming('/api/imports/items/update', updateImportItemRoute);
