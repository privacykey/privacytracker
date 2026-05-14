export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  IMPORT_ITEM_STATUSES,
  addImportItemsAsync,
  type ImportItemStatus,
} from '../../../../lib/imports';
import { readBoundedJson } from '../../../../lib/security';
import { requireMutationGuard } from '../../../../lib/api-guards';
import { withApiTiming } from '../../../../lib/api-timing';

// Per-import-batch cap. The 512 KiB body limit keeps individual rows
// small, but without an explicit length cap an attacker could submit
// 10000 minimal rows and drive a lot of SQLite write traffic. 5000 is
// well above any realistic onboarding flow (a Mac mini's `mobileapps`
// list maxes out around 1500–2000) yet far below "weaponisable".
const MAX_ITEMS_PER_REQUEST = 5000;

interface RawItem {
  query: unknown;
  editedQuery?: unknown;
  status: unknown;
  appId?: unknown;
  appName?: unknown;
  developer?: unknown;
  url?: unknown;
  iconUrl?: unknown;
  country?: unknown;
  scrapeError?: unknown;
  /**
   * Milliseconds from now until the next retry attempt — used when a
   * caller persists a `status='queued'` row because Apple rate-limited
   * the search and we want the server worker (or a later retry) to
   * honour the cooldown.
   */
  retryAfterMs?: unknown;
  /**
   * Absolute epoch-ms threshold for the next retry. Accepted as an
   * alternative to `retryAfterMs` for callers that already computed it.
   */
  nextAttemptAt?: unknown;
}

async function addImportItemsRoute(request: Request) {
  const guard = requireMutationGuard(request, {
    action: 'imports.items.add',
    rateLimit: { keyPrefix: 'imports.items.add', limit: 30, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 512 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      { status: 400 },
    );
  }

  try {
    const importId = typeof body?.importId === 'string' ? body.importId.trim() : '';
    if (!importId) {
      return NextResponse.json({ error: 'importId is required' }, { status: 400 });
    }

    const rawItems: RawItem[] = Array.isArray(body?.items) ? body.items : [];
    if (rawItems.length > MAX_ITEMS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many items in one request (${rawItems.length} > ${MAX_ITEMS_PER_REQUEST}). Split into multiple batches.` },
        { status: 413 },
      );
    }
    const cleaned = rawItems
      .map((item): Parameters<typeof addImportItemsAsync>[1][number] | null => {
        const query = typeof item?.query === 'string' ? item.query.trim() : '';
        const status = typeof item?.status === 'string' ? item.status : '';
        if (!query) return null;
        if (!IMPORT_ITEM_STATUSES.includes(status as ImportItemStatus)) return null;

        // Resolve the retry deadline from whichever field the caller sent.
        // Only honoured for the two retry-bearing statuses — anywhere else
        // `next_attempt_at` would be a meaningless number on a matched /
        // imported / etc. row.
        //
        //   'queued'         → scrape retry (server-side import-queue worker)
        //   'pending_search' → iTunes-search retry (client-side QueuedSearchProvider)
        let nextAttemptAt: number | null = null;
        if (status === 'queued' || status === 'pending_search') {
          if (typeof item?.nextAttemptAt === 'number' && item.nextAttemptAt > 0) {
            nextAttemptAt = item.nextAttemptAt;
          } else if (typeof item?.retryAfterMs === 'number' && item.retryAfterMs > 0) {
            nextAttemptAt = Date.now() + item.retryAfterMs;
          }
        }

        return {
          query,
          editedQuery:
            typeof item?.editedQuery === 'string' && item.editedQuery.trim().length > 0
              ? item.editedQuery.trim()
              : null,
          status: status as ImportItemStatus,
          appId: typeof item?.appId === 'string' ? item.appId : null,
          appName: typeof item?.appName === 'string' ? item.appName : null,
          developer: typeof item?.developer === 'string' ? item.developer : null,
          url: typeof item?.url === 'string' ? item.url : null,
          iconUrl: typeof item?.iconUrl === 'string' ? item.iconUrl : null,
          country: typeof item?.country === 'string' ? item.country : null,
          scrapeError: typeof item?.scrapeError === 'string' ? item.scrapeError : null,
          nextAttemptAt,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    if (cleaned.length === 0) {
      return NextResponse.json({ error: 'items must be a non-empty array' }, { status: 400 });
    }

    // Route through the worker-backed async variant so a 200-row
    // import doesn't block the Node sidecar's event loop. The Tauri
    // webview polls /api/tasks/active and /api/notifications during
    // an import; if those polls time out because writes are blocking,
    // the UI looks frozen even though the import is making progress.
    // See lib/db-worker-client.ts for the worker plumbing.
    const created = await addImportItemsAsync(importId, cleaned);
    return NextResponse.json({ items: created });
  } catch (error) {
    console.error('Add import items error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export const POST = withApiTiming('/api/imports/items', addImportItemsRoute);
