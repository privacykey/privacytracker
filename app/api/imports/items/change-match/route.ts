export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  getImportItemById,
  replaceImportItemMatch,
} from '../../../../../lib/imports';
import { fetchAndParseApp } from '../../../../../lib/scraper';
import db from '../../../../../lib/db';
import { readBoundedJson } from '../../../../../lib/security';

/**
 * Rewire a single import item to point at a different App Store listing.
 *
 * Body: `{ itemId, url, editedQuery? }`. Scrapes the new URL before touching
 * the item so a scrape failure leaves the history record unchanged. The
 * previous app is garbage-collected if no other import row references it.
 * Sets status to `imported` even if previously `removed` — this is the
 * explicit re-add pathway and should only be POSTed on deliberate user action.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 16 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      { status: 400 },
    );
  }

  try {
    const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    const editedQuery =
      typeof body?.editedQuery === 'string' && body.editedQuery.trim().length > 0
        ? body.editedQuery.trim()
        : null;

    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'url must be a valid http(s) URL' }, { status: 400 });
    }

    const existing = getImportItemById(itemId);
    if (!existing) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    let scraped;
    try {
      // Skip policy summarization — the background summarize step handles it.
      scraped = await fetchAndParseApp(
        url,
        /* resync */ false,
        /* summarizePolicies */ false,
        /* trigger */ 'import',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: `Failed to scrape replacement app: ${message}` },
        { status: 502 },
      );
    }

    // Scrape result lacks `developer`; pull from the freshly-written apps row.
    const appRow = db
      .prepare('SELECT developer, url, iconUrl FROM apps WHERE id = ?')
      .get(scraped.id) as
      | { developer: string | null; url: string | null; iconUrl: string | null }
      | undefined;

    const { item, previousAppRemoved } = replaceImportItemMatch(itemId, {
      id: scraped.id,
      name: scraped.name,
      developer: appRow?.developer ?? null,
      url: appRow?.url ?? url,
      // Reading iconUrl back from the apps table keeps Import History
      // showing the new match's artwork rather than the previous one.
      iconUrl: appRow?.iconUrl ?? null,
    });

    // Refresh `edited_query` so the row label matches the new match.
    // Honours an explicit caller-provided `editedQuery` verbatim;
    // otherwise overwrites with `scraped.name`. The original `query`
    // column is never rewritten, preserving the "originally: …" sub-line.
    const nextEditedQuery = editedQuery ?? scraped.name;
    if (item && nextEditedQuery) {
      db.prepare('UPDATE import_items SET edited_query = ? WHERE id = ?').run(
        nextEditedQuery,
        itemId,
      );
    }

    return NextResponse.json({
      item: getImportItemById(itemId) ?? item,
      previousAppRemoved,
    });
  } catch (error) {
    console.error('Change import-item match error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
