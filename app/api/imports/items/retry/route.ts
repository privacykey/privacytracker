export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  getImportItemById,
  recordItemSuccess,
  recordItemError,
  recordItemRetry,
  completeImportIfSettled,
} from '../../../../../lib/imports';
import { fetchAndParseApp, AppleRateLimitError } from '../../../../../lib/scraper';
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
} from '../../../../../lib/security';

/**
 * Retry a single import item.
 *
 * Distinct from `POST /api/imports/queue` which kicks the GLOBAL drain
 * (every queued row across every import). The per-item Retry button on
 * Import History → expanded row used to call the global drain too,
 * which meant clicking "Retry" on one queued row started ALL queued rows
 * draining — confusing if the user just wanted to see whether one
 * specific row would scrape successfully.
 *
 * This endpoint scrapes exactly one row and returns the resulting
 * status. It still respects Apple's rate-limit framework (the central
 * cooldown in lib/rate-limit.ts), so a 429 here surfaces in the same
 * banner the global drain uses — but the retry only consumes one
 * request worth of Apple's budget.
 *
 * Body: { itemId: string }
 *
 * Response (success):
 *   { item: ImportItemRow, status: 'imported' | 'error' | 'queued' }
 * Response (rate-limited):
 *   { item: ImportItemRow, status: 'queued', rateLimited: { retryAfterMs } }
 */
export async function POST(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'imports-retry-item'),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded for /api/imports/items/retry. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let body: { itemId?: unknown };
  try {
    body = await readBoundedJson(request, 4 * 1024);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
  if (!itemId) {
    return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
  }

  const item = getImportItemById(itemId);
  if (!item) {
    return NextResponse.json({ error: `Unknown import item ${itemId}` }, { status: 404 });
  }
  if (!item.url) {
    // Defensive: a queued row without a URL is unfetchable. Flip it to
    // error so the row stops re-claiming on every queue tick.
    console.warn(`[ImportRetryItem] item ${itemId} has no URL — flipping to error`);
    const errored = recordItemError(item.id, 'Queued item has no URL to scrape');
    completeImportIfSettled(item.importId);
    return NextResponse.json({ item: errored, status: 'error' });
  }

  console.info(`[ImportRetryItem] retry start — item ${itemId} → ${item.url}`);
  const startedAt = Date.now();

  try {
    const result = await fetchAndParseApp(item.url, false, false, 'import');
    if (result && typeof result === 'object' && 'id' in result && 'name' in result) {
      const updated = recordItemSuccess(item.id, {
        id: String(result.id),
        name: String(result.name),
        developer: item.developer,
        url: item.url,
        iconUrl: item.iconUrl,
      });
      completeImportIfSettled(item.importId);
      console.info(
        `[ImportRetryItem] retry ok — item ${itemId} → "${String(result.name)}" in ${Date.now() - startedAt}ms`,
      );
      return NextResponse.json({ item: updated, status: 'imported' });
    }
    console.warn(`[ImportRetryItem] retry error — item ${itemId} got unexpected scraper shape:`, result);
    const errored = recordItemError(item.id, 'Scraper returned an unexpected shape');
    completeImportIfSettled(item.importId);
    return NextResponse.json({ item: errored, status: 'error' });
  } catch (err) {
    if (err instanceof AppleRateLimitError) {
      // Apple 429 — keep this row queued, set its next_attempt_at, and
      // surface the cooldown to the client so it can show a countdown.
      // The global pause fence is set by the scraper's recordRateLimit
      // call (see lib/scraper.ts), so the user's banner picks it up via
      // the existing /api/rate-limit/status poll.
      const retryAfterMs = err.retryAfterMs;
      const updated = recordItemRetry(item.id, {
        retryAfterMs,
        scrapeError: 'Apple rate-limited the queue; will retry later',
      });
      console.warn(
        `[ImportRetryItem] retry rate-limit — item ${itemId} got Apple 429; ` +
        `next attempt in ${Math.round(retryAfterMs / 1000)}s`,
      );
      return NextResponse.json({
        item: updated,
        status: 'queued',
        rateLimited: { retryAfterMs },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ImportRetryItem] retry error — item ${itemId}: ${message}`);
    const errored = recordItemError(item.id, message);
    completeImportIfSettled(item.importId);
    return NextResponse.json({ item: errored, status: 'error' });
  }
}
