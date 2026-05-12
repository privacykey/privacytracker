/**
 * /api/related-apps — fetches top apps in a given App Store category.
 *
 * Powers the Compare page's "Top in category" quick-pick beside Slot B.
 * The caller passes the source app's id (`?sourceAppId=<appId>`) and we:
 *
 *   1. Look the app up locally to grab its `genreId` + `priceAmount`.
 *      If the row predates the genre-column migration (or the iTunes
 *      lookup failed at scrape time), we hit `itunes.apple.com/lookup`
 *      ourselves to recover the values without writing back to the DB —
 *      this endpoint is read-only.
 *
 *   2. Pick the right Apple RSS feed: `topfreeapplications` when the
 *      source app is free (priceAmount ≤ 0), `toppaidapplications`
 *      otherwise. The price status is cached on the apps row so we
 *      don't pay another lookup.
 *
 *   3. Fetch the feed, filter the source app out of its own results,
 *      and surface the first 5 candidates in the same shape the
 *      slot-picker already understands (appleId, name, developer,
 *      iconUrl, url).
 *
 * Failure modes are deliberately soft — the UI shows a "no candidates"
 * state rather than blocking the user from picking another app.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import db from '../../../lib/db';
import { safeFetch } from '../../../lib/security';
import { getSetting } from '../../../lib/scheduler';

const APPLE_HOSTS = ['apps.apple.com', 'itunes.apple.com', 'rss.applemarketingtools.com'];
const DEFAULT_COUNTRY = 'us';

interface AppRow {
  id: string;
  name: string;
  genreId: number | null;
  genreName: string | null;
  priceAmount: number | null;
}

interface RelatedCandidate {
  appleId: string;
  name: string;
  developer: string;
  iconUrl: string;
  url: string;
}

type RelatedMode = 'top_in_category' | 'may_also_like';

function parseMode(raw: string | null): RelatedMode {
  return raw === 'may_also_like' ? 'may_also_like' : 'top_in_category';
}

/**
 * Strip the source app's name down to a single search keyword so iTunes
 * Search treats it like a category cue rather than a vendor-specific
 * lookup. "Notion: Notes, AI & Calendar" → "Notion", "Spark – Email by
 * Readdle" → "Spark", "iA Writer" → "iA Writer". We keep up to two
 * tokens because some apps actually do publish under two-word names
 * (e.g. "Apple Notes"), but anything beyond that is marketing fluff
 * and dilutes the result quality.
 */
function buildLikeKeyword(rawName: string): string {
  const stripped = rawName
    // Cut off everything after the first separator that introduces a
    // tagline ("App: tagline", "App – tagline", "App | tagline" etc).
    .split(/[:|–—-]/)[0]
    .trim()
    // Drop a trailing "App"/"by Vendor" suffix that would skew search
    // toward the literal vendor instead of similar apps.
    .replace(/\s+(?:app|by\s+.+?)$/i, '')
    .trim();
  const tokens = stripped.split(/\s+/).filter(Boolean).slice(0, 2);
  return tokens.join(' ');
}

/**
 * iTunes Search — used by the "you may also like" mode. iTunes returns
 * results ranked by Apple's relevance heuristic for the term, scoped to
 * software apps; we filter to the source app's primary genre + free/paid
 * tier (since users almost never want to swap a paid app for a free one
 * with the same name, and vice versa).
 *
 * Same failure handling as the chart feed — empty array on any
 * non-success path so the caller renders the empty state.
 */
async function fetchMayAlsoLike(opts: {
  country: string;
  free: boolean;
  genreId: number;
  keyword: string;
  excludeAppleId: string;
  limit: number;
}): Promise<RelatedCandidate[]> {
  const { country, free, genreId, keyword, excludeAppleId, limit } = opts;
  if (!keyword) return [];
  // entity=software keeps the result set to apps (vs in-app purchases or
  // podcasts). attribute=genreIndex doesn't exist on iTunes Search, so we
  // post-filter by primaryGenreId from each result. media=software is
  // implied but pinning it makes the API contract explicit.
  const url =
    `https://itunes.apple.com/search?` +
    `term=${encodeURIComponent(keyword)}` +
    `&country=${country}` +
    `&media=software` +
    `&entity=software` +
    `&limit=30`;
  try {
    const { response, body } = await safeFetch(url, {
      allowedHosts: APPLE_HOSTS,
      headers: { Accept: 'application/json' },
      timeoutMs: 8000,
      maxBytes: 2 * 1024 * 1024,
      redirect: 'follow',
    });
    if (!response.ok) return [];
    const parsed = JSON.parse(body.toString('utf8')) as {
      results?: Array<{
        trackId?: number;
        trackName?: string;
        artistName?: string;
        artworkUrl100?: string;
        artworkUrl60?: string;
        trackViewUrl?: string;
        primaryGenreId?: number;
        price?: number;
      }>;
    };
    const results = parsed.results ?? [];
    const out: RelatedCandidate[] = [];
    for (const r of results) {
      if (r.primaryGenreId !== genreId) continue;
      const resultFree = (r.price ?? 0) <= 0;
      if (resultFree !== free) continue;
      const appleId = r.trackId != null ? String(r.trackId) : '';
      if (!appleId || appleId === excludeAppleId) continue;
      const name = r.trackName?.trim();
      const developer = r.artistName?.trim() ?? '';
      const iconUrl = r.artworkUrl100 ?? r.artworkUrl60 ?? '';
      const trackUrl = r.trackViewUrl ?? '';
      if (!name || !trackUrl) continue;
      out.push({ appleId, name, developer, iconUrl, url: trackUrl });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    console.warn('[/api/related-apps] search fetch failed:', err);
    return [];
  }
}

function normaliseCountry(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(trimmed) ? trimmed : DEFAULT_COUNTRY;
}

/**
 * Best-effort iTunes lookup for an app's genre + price. We only call
 * this when the local row is missing one of those values; on
 * failure we return null and the UI falls through to its "no data"
 * state.
 */
async function lookupGenreAndPrice(
  appleId: string,
  country: string,
): Promise<{ genreId: number | null; genreName: string | null; priceAmount: number | null } | null> {
  if (!/^\d+$/.test(appleId)) return null;
  try {
    const { response, body } = await safeFetch(
      `https://itunes.apple.com/lookup?id=${appleId}&country=${country}`,
      {
        allowedHosts: APPLE_HOSTS,
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
        maxBytes: 1 * 1024 * 1024,
        redirect: 'follow',
      },
    );
    if (!response.ok) return null;
    const payload = JSON.parse(body.toString('utf8')) as {
      results?: Array<{
        primaryGenreId?: number;
        primaryGenreName?: string;
        price?: number;
      }>;
    };
    const entry = payload.results?.[0];
    if (!entry) return null;
    return {
      genreId: typeof entry.primaryGenreId === 'number' ? entry.primaryGenreId : null,
      genreName: typeof entry.primaryGenreName === 'string' ? entry.primaryGenreName : null,
      priceAmount: typeof entry.price === 'number' ? entry.price : null,
    };
  } catch {
    return null;
  }
}

/**
 * Hit Apple's marketing-tools RSS feed for the top free or top paid
 * apps in a country. The newer `rss.applemarketingtools.com` v2 API
 * doesn't filter by genre, so we pull the country-wide chart and
 * cross-reference each result's `primaryGenreId` via a follow-up
 * iTunes lookup (one batch call, all ids at once).
 *
 * Returns an empty array on any failure mode — the caller renders
 * the empty state.
 */
async function fetchTopInGenre(opts: {
  country: string;
  free: boolean;
  genreId: number;
  excludeAppleId: string;
  limit: number;
}): Promise<RelatedCandidate[]> {
  const { country, free, genreId, excludeAppleId, limit } = opts;

  // Apple's older `itunes.apple.com/.../rss/topfreeapplications/genre=…`
  // path still works and ALREADY filters by genre, so we hit that
  // directly — saves a round-trip and avoids batching ids through
  // /lookup. Pull 50 to give the genre filter room (the chart is
  // already country-wide; the genre filter narrows in-place).
  const feed = free ? 'topfreeapplications' : 'toppaidapplications';
  const url = `https://itunes.apple.com/${country}/rss/${feed}/limit=50/genre=${genreId}/json`;
  try {
    const { response, body } = await safeFetch(url, {
      allowedHosts: APPLE_HOSTS,
      headers: { Accept: 'application/json' },
      timeoutMs: 8000,
      maxBytes: 2 * 1024 * 1024,
      redirect: 'follow',
    });
    if (!response.ok) return [];
    const parsed = JSON.parse(body.toString('utf8')) as {
      feed?: {
        entry?: Array<{
          'im:name'?: { label?: string };
          'im:artist'?: { label?: string };
          'im:image'?: Array<{ label?: string }>;
          id?: { attributes?: { 'im:id'?: string } };
          link?: { attributes?: { href?: string } } | Array<{ attributes?: { href?: string } }>;
        }>;
      };
    };
    const entries = parsed.feed?.entry ?? [];
    const out: RelatedCandidate[] = [];
    for (const e of entries) {
      const appleId = e.id?.attributes?.['im:id'];
      if (!appleId || appleId === excludeAppleId) continue;
      const name = e['im:name']?.label?.trim();
      const developer = e['im:artist']?.label?.trim() ?? '';
      // iTunes RSS images are ordered small → large; pick the largest
      // (last) for crisper rendering at 28 px on retina displays.
      const images = Array.isArray(e['im:image']) ? e['im:image'] : [];
      const iconUrl = images[images.length - 1]?.label ?? '';
      // The first link entry on a feed row is the App Store URL.
      const linkRaw = Array.isArray(e.link) ? e.link[0] : e.link;
      const url = linkRaw?.attributes?.href ?? '';
      if (!name || !url) continue;
      out.push({ appleId, name, developer, iconUrl, url });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    console.warn('[/api/related-apps] feed fetch failed:', err);
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sourceAppId = searchParams.get('sourceAppId');
  const limitRaw = searchParams.get('limit');
  const limit = Math.min(
    Math.max(1, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 5),
    10,
  );
  const mode = parseMode(searchParams.get('mode'));

  if (!sourceAppId || !/^[A-Za-z0-9_-]+$/.test(sourceAppId)) {
    return NextResponse.json(
      { error: 'sourceAppId is required and must be a valid app id.' },
      { status: 400 },
    );
  }

  let row: AppRow | undefined;
  try {
    row = db
      .prepare(
        'SELECT id, name, genreId, genreName, priceAmount FROM apps WHERE id = ?',
      )
      .get(sourceAppId) as AppRow | undefined;
  } catch (e) {
    console.error('[/api/related-apps] DB read failed:', e);
    return NextResponse.json(
      { error: 'Could not read source app.' },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json(
      { error: 'Source app not found.' },
      { status: 404 },
    );
  }

  const country = normaliseCountry(getSetting('app_country', DEFAULT_COUNTRY));

  // Backfill missing genre/price by hitting iTunes lookup on demand.
  // We don't write back to the DB here — that's the scrape path's
  // job, and this endpoint is read-only (per /api/* convention for
  // GETs). The freshly-fetched values are used for the in-flight
  // request only.
  let genreId = row.genreId;
  let genreName = row.genreName;
  let priceAmount = row.priceAmount;
  if (genreId == null || priceAmount == null) {
    const lookup = await lookupGenreAndPrice(sourceAppId, country);
    if (lookup) {
      genreId = genreId ?? lookup.genreId;
      genreName = genreName ?? lookup.genreName;
      priceAmount = priceAmount ?? lookup.priceAmount;
    }
  }

  if (genreId == null) {
    return NextResponse.json({
      genreId: null,
      genreName: null,
      free: null,
      candidates: [] as RelatedCandidate[],
    });
  }

  const free = (priceAmount ?? 0) <= 0;
  const candidates = mode === 'may_also_like'
    ? await fetchMayAlsoLike({
        country,
        free,
        genreId,
        keyword: buildLikeKeyword(row.name),
        excludeAppleId: sourceAppId,
        limit,
      })
    : await fetchTopInGenre({
        country,
        free,
        genreId,
        excludeAppleId: sourceAppId,
        limit,
      });

  return NextResponse.json({
    mode,
    genreId,
    genreName,
    free,
    candidates,
  });
}
