export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  searchAppsByName,
  lookupAppsByBundleId,
  type SearchQuery,
} from '../../../lib/scraper';
import { sanitizeNamesList, sanitizeRowsList } from '../../../lib/app-import';
import { normalizeCountry } from '../../../lib/region';
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
} from '../../../lib/security';

// Local-first guardrails:
//   - Bounded body: imports can carry up to MAX_IMPORT_ROWS names, but nothing
//     should be megabytes large.
//   - Per-client rate limit: this endpoint fans out to iTunes Search; a stuck
//     UI loop should not get the user's local/LAN IP throttled by Apple.
const SEARCH_BODY_MAX_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'search'),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded for /api/search. Try again shortly.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) },
      },
    );
  }

  let body: {
    names?: unknown;
    rows?: unknown;
    bundleIds?: unknown;
    country?: unknown;
  };
  try {
    body = await readBoundedJson(request, SEARCH_BODY_MAX_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { names, rows, bundleIds, country } = body ?? {};
  const options = country !== undefined ? { country: normalizeCountry(country) } : {};

  try {
    // Bundle-ID lookup is preferred when present (it's more accurate
    // than name search, see lib/scraper.ts → "iTunes Lookup" section).
    // The cfgutil import path on Step 2 of the wizard sends bundleIds
    // because it has them; CSV / OCR / manual paths don't, so they
    // continue to send `names` or `rows`. We treat them as mutually
    // exclusive — if both are present, bundleIds wins because it's the
    // higher-fidelity signal.
    if (Array.isArray(bundleIds) && bundleIds.length > 0) {
      // Defensive: cap at 1000 inputs to mirror the search route's
      // body-size cap. Apple's lookup endpoint chunks internally at
      // 200/req anyway; the cap here just stops a runaway client from
      // queuing thousands of lookups in one POST.
      const ids = (bundleIds as unknown[])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map(v => v.trim())
        .slice(0, 1000);
      if (ids.length === 0) {
        return NextResponse.json({ results: [] });
      }
      const batch = await lookupAppsByBundleId(ids, options);
      // Mirror the searchAppsByName envelope so the client adapter
      // logic can flow through the same rate-limited handling.
      if (batch.rateLimited) {
        return NextResponse.json({
          results: batch.results,
          rateLimited: {
            retryAfterMs: batch.rateLimited.retryAfterMs,
            // Surface the un-processed bundle IDs (not search names)
            // so the client can re-issue the lookup after the cooldown.
            queuedBundleIds: batch.rateLimited.queued,
          },
        });
      }
      return NextResponse.json({ results: batch.results });
    }

    // Accept either `names: string[]` (legacy) or `rows: {name, developer?}[]`
    // (structured import). We prefer rows when both are provided — they carry
    // the optional developer hint that re-ranks iTunes candidates.
    let queries: SearchQuery[] = [];
    if (Array.isArray(rows) && rows.length > 0) {
      queries = sanitizeRowsList(rows);
    } else if (Array.isArray(names) && names.length > 0) {
      queries = sanitizeNamesList(names).map(name => ({ name }));
    } else {
      return NextResponse.json(
        { error: 'Invalid payload: expected `names`, `rows`, or `bundleIds` array' },
        { status: 400 },
      );
    }

    if (queries.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const batch = await searchAppsByName(queries, options);

    // If iTunes rate-limited us mid-batch, pass the full picture back so the
    // client can schedule a retry for the queued tail. `results` always
    // contains whatever we completed before the 429 fired.
    if (batch.rateLimited) {
      return NextResponse.json({
        results: batch.results,
        rateLimited: {
          retryAfterMs: batch.rateLimited.retryAfterMs,
          queued: batch.rateLimited.queued,
        },
      });
    }

    return NextResponse.json({ results: batch.results });
  } catch (error) {
    console.error('Search API error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
