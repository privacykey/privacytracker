import db from './db';
import crypto from 'crypto';
import {
  beginScrape,
  endScrape,
  markScrapePhase,
  newScrapeId,
} from './scrape-activity';
import {
  buildSnapshot,
  diffSnapshots,
  getLatestSnapshot,
  type PrivacyTypeSnapshot,
  type ChangeEntry,
  type SyncTrigger,
} from './changelog';
import {
  computeNotBefore,
  createParserFallthroughNotification,
  createProfileMismatchNotification,
  createVersionUpdateNotification,
} from './notifications';
import {
  type AccessibilityFeatureRecord,
  buildAccessibilitySnapshot,
  diffAccessibility,
  extractAccessibilityFeatures,
} from './accessibility';
import {
  getPrivacyProfile,
} from './privacy-profile-server';
import {
  computeProfileMismatch,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
  type AppProfileFootprint,
  type ProfileTier,
} from './privacy-profile';
import { getPolicyAnalysis, syncPrivacyPolicyAnalysis } from './privacy-policy';
import { DEFAULT_COUNTRY, normalizeCountry } from './region';
import { getSetting } from './scheduler';
import { safeFetch, sanitizePolicyUrl, validateAppStoreUrl } from './security';
import { recordActivity } from './activity';
import { runBulkWrite } from './db-worker-client';
import type { DbWorkerStatement } from './db-worker-types';
import {
  acquireRateLimitToken,
  getRemainingCooldownMs,
  recordRateLimit,
} from './rate-limit';

// Apple hosts we will fetch from. Anything else is rejected up front so that
// `fetchAndParseApp` can't be talked into hitting an internal URL via a rogue
// redirect or a malformed App Store URL.
const APPLE_HOSTS = ['apps.apple.com', 'itunes.apple.com'];
// Apple pages are on the order of ~500 KB; give ourselves headroom but don't
// stream arbitrary binary content.
const APP_STORE_MAX_BYTES = 4 * 1024 * 1024;

// Apple App Store pages (apps.apple.com/../idN) trip the same rolling-minute
// rate limit as iTunes Search. Start with a generous cooldown so the queue
// worker doesn't immediately re-trip the ban.
const APP_STORE_RATE_LIMIT_COOLDOWN_MS = 70_000;
// Cap the Retry-After header we're willing to honour. If Apple tells us to
// wait an hour we'd rather retry on our own 10-minute schedule than stall
// the queue worker forever.
const APP_STORE_RATE_LIMIT_MAX_MS = 10 * 60 * 1000;

/**
 * Thrown by `fetchAndParseApp` when Apple's HTML endpoint returns HTTP 429.
 * The enqueue path in `scrapeInitialUrls` catches this so we can persist the
 * `retryAfterMs` on the queued row rather than flipping it straight to
 * `'error'`.
 */
export class AppleRateLimitError extends Error {
  readonly rateLimited = true as const;
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `Apple App Store rate-limited (HTTP 429); retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'AppleRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

function isAppleRateLimitError(value: unknown): value is AppleRateLimitError {
  return !!value && typeof value === 'object' && (value as { rateLimited?: unknown }).rateLimited === true;
}

/**
 * Parse a Retry-After header that we've already confirmed is non-null. Apple
 * usually sends seconds but the spec also allows an HTTP date; handle both.
 * Returns null if the value is unparseable or implausibly large.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number.parseInt(header, 10);
  if (Number.isFinite(secs) && secs > 0) {
    const ms = secs * 1000;
    return ms < APP_STORE_RATE_LIMIT_MAX_MS ? ms : APP_STORE_RATE_LIMIT_MAX_MS;
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate) && asDate > Date.now()) {
    return Math.min(asDate - Date.now(), APP_STORE_RATE_LIMIT_MAX_MS);
  }
  return null;
}

// ─────────────────────────────────────────────
// iTunes Search
// ─────────────────────────────────────────────

export interface AppCandidate {
  appleId: string;
  name: string;
  developer: string;
  iconUrl: string;
  url: string;
  bundleId: string;
  searchQuery: string;
}

export interface SearchResult {
  query: string;
  candidates: AppCandidate[];
}

export interface SearchOptions {
  /** ISO 3166-1 alpha-2 storefront; falls back to the saved `app_country`
   *  setting, then to 'us'. Lets one iTunes Search cover region-specific
   *  listings (e.g. AU-only banking apps). */
  country?: string;
}

export interface SearchQuery {
  name: string;
  /** Optional developer / seller hint, used to re-rank candidates. */
  developer?: string;
}

/**
 * Batch response for `searchAppsByName`. Callers should use the structured
 * result when they care about rate limiting: `rateLimited` is present when
 * iTunes responded 429 mid-batch. `queued` contains the queries we didn't
 * get a chance to run, so the caller can retry them after `retryAfterMs`.
 */
export interface SearchBatch {
  results: SearchResult[];
  rateLimited?: {
    retryAfterMs: number;
    queued: SearchQuery[];
  };
}

/**
 * iTunes Search enforces an undocumented ~20 req/min limit per client. When
 * we trip it we need to wait at least one rolling minute before the next
 * attempt. We bias a little higher (70s) so a retry doesn't immediately
 * trip the same limit when Apple's rolling window counts are conservative.
 */
const ITUNES_RATE_LIMIT_COOLDOWN_MS = 70_000;

const ITUNES_RETRY_DELAY_MS = 1200;

/**
 * Typed sentinel returned by `runItunesSearch` when iTunes responds 429. We
 * plumb this up through `searchAppsByName` so the caller can surface the
 * queued-retry UX rather than treating it like a generic search failure.
 */
interface ItunesRateLimitSignal {
  rateLimited: true;
  retryAfterMs: number;
}

type ItunesSearchOutcome =
  | AppCandidate[]
  | null
  | ItunesRateLimitSignal;

function isRateLimitSignal(value: ItunesSearchOutcome): value is ItunesRateLimitSignal {
  return !!value && typeof value === 'object' && !Array.isArray(value) && value.rateLimited === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Score how well a candidate's developer string matches the hint. Higher is
 * better, 0 means no signal. The scoring rewards exact matches and common
 * substring overlap so "Meta" matches "Meta Platforms, Inc." and
 * "Apple Inc." matches "Apple".
 */
function scoreDeveloperMatch(candidateDev: string | undefined, hint: string): number {
  if (!candidateDev || !hint) return 0;
  const a = candidateDev.toLowerCase();
  const b = hint.toLowerCase();
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 50;

  // Token overlap: "Meta Platforms, Inc." vs "Meta Platforms" → strong match.
  const aTokens = new Set(a.split(/\W+/).filter(Boolean));
  const bTokens = new Set(b.split(/\W+/).filter(Boolean));
  let overlap = 0;
  bTokens.forEach(t => { if (aTokens.has(t)) overlap += 1; });
  if (overlap === 0) return 0;
  return Math.min(40, overlap * 12);
}

async function runItunesSearch(
  name: string,
  country: string,
): Promise<ItunesSearchOutcome> {
  // Hard-cooldown short-circuit: if we already know iTunes is throttling
  // us, don't waste a request that's guaranteed to 429. Return the
  // rate-limit signal directly so the caller can surface the live
  // countdown without burning more of Apple's window. The remaining ms
  // is what the banner displays; it stays accurate because every reader
  // computes `resumeAt - Date.now()`.
  const cooldownMs = getRemainingCooldownMs('search');
  if (cooldownMs > 0) {
    return { rateLimited: true, retryAfterMs: cooldownMs };
  }

  // Soft pacer: token bucket reserves a slot before we issue. Sleeps
  // briefly if we're at the burst ceiling — this is the proactive
  // throttle that keeps us under Apple's rolling-minute limit even
  // when bulk runners + interactive search both fire concurrently.
  await acquireRateLimitToken('search');

  const apiUrl =
    `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=software&country=${country}&limit=5`;

  // iTunes Search through safeFetch so (a) a malicious redirect can't
  // pivot us onto an internal host and (b) the response size is capped.
  const { response: res, body: bodyBuf } = await safeFetch(apiUrl, {
    allowedHosts: APPLE_HOSTS,
    headers: { Accept: 'application/json' },
    timeoutMs: 8000,
    maxBytes: 1 * 1024 * 1024,
    redirect: 'follow',
  });

  // iTunes Search caps at ~20 requests per minute per client. When that
  // window trips it returns 429 with (sometimes) a Retry-After hint. We
  // honour the hint when it looks sane and fall back to a 70s cooldown
  // otherwise — rolling-minute limits need a full minute of idle time to
  // fully recover.
  if (res.status === 429) {
    const retryAfterHeader = res.headers.get('retry-after');
    const parsed = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : NaN;
    const retryAfterMs = Number.isFinite(parsed) && parsed > 0 && parsed < 600_000
      ? parsed
      : ITUNES_RATE_LIMIT_COOLDOWN_MS;
    console.warn(
      `iTunes search rate-limited (HTTP 429) on "${name}"; cooling down ${Math.round(retryAfterMs / 1000)}s before retry`,
    );
    // Record the cooldown centrally so every other request (and every
    // UI surface) sees the same expiry window. Without this the next
    // call would re-issue the search and re-trip the ban; with it,
    // the next call hits the short-circuit at the top of this fn.
    recordRateLimit(
      'search',
      retryAfterMs,
      `HTTP 429 from iTunes Search at ${new Date().toISOString()}${retryAfterHeader ? ` (Retry-After: ${retryAfterHeader})` : ''}`,
    );
    return { rateLimited: true, retryAfterMs };
  }

  if (!res.ok) {
    console.warn(
      `iTunes search returned HTTP ${res.status} for "${name}" (country=${country})`,
    );
    return null;
  }

  let data: any;
  try {
    data = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    console.warn(`iTunes search returned non-JSON body for "${name}"`);
    return null;
  }
  return (data.results || []).map((r: any) => ({
    appleId: String(r.trackId),
    name: r.trackName,
    developer: r.artistName,
    iconUrl: r.artworkUrl100?.replace('100x100bb', '200x200bb') ?? '',
    url: r.trackViewUrl?.split('?')[0] ?? '',
    bundleId: r.bundleId,
    searchQuery: name,
  })) as AppCandidate[];
}

/**
 * Look up a batch of names on iTunes Search. Returns a structured batch so
 * callers can distinguish three outcomes:
 *
 *   • Full batch — `rateLimited` absent, `results.length === queries.length`.
 *   • Partial batch — `rateLimited` set, `queued` holds the unprocessed tail.
 *   • Legacy array shape — see `searchAppsByNameLegacy` below for the old
 *     callers that only care about `SearchResult[]`.
 *
 * We stop on the first 429 rather than spacing requests out, because iTunes
 * Search counts requests in a rolling minute and continuing to push into a
 * tripped limit just extends the ban. The caller (typically the wizard)
 * schedules a resume after `retryAfterMs`.
 */
export async function searchAppsByName(
  input: Array<string | SearchQuery>,
  options: SearchOptions = {},
): Promise<SearchBatch> {
  const results: SearchResult[] = [];

  // Resolve once so every name in the batch hits the same storefront.
  const country = normalizeCountry(
    options.country ?? getSetting('app_country', DEFAULT_COUNTRY),
  );

  const queries: SearchQuery[] = input
    .map(raw => (typeof raw === 'string' ? { name: raw } : raw))
    .filter(q => q && typeof q.name === 'string' && q.name.trim().length > 0)
    .map(q => ({
      name: q.name.trim(),
      developer: q.developer?.trim() || undefined,
    }));

  for (let i = 0; i < queries.length; i += 1) {
    const { name, developer } = queries[i];
    try {
      let outcome = await runItunesSearch(name, country);

      // 429 on the very first call — nothing in this batch is safe to run.
      // Queue *everything* from this index on and let the caller retry.
      if (isRateLimitSignal(outcome)) {
        return {
          results,
          rateLimited: {
            retryAfterMs: outcome.retryAfterMs,
            queued: queries.slice(i),
          },
        };
      }

      // If the first attempt returned zero candidates, retry once after a
      // short delay — iTunes Search occasionally soft-throttles a burst and
      // a single follow-up almost always succeeds. The retry itself can hit
      // 429, in which case we also queue the tail.
      if (outcome !== null && outcome.length === 0) {
        console.warn(
          `iTunes search returned 0 results for "${name}" (country=${country}); retrying in ${ITUNES_RETRY_DELAY_MS}ms`,
        );
        await sleep(ITUNES_RETRY_DELAY_MS);
        const retry = await runItunesSearch(name, country);
        if (isRateLimitSignal(retry)) {
          return {
            results,
            rateLimited: {
              retryAfterMs: retry.retryAfterMs,
              queued: queries.slice(i),
            },
          };
        }
        if (retry && Array.isArray(retry) && retry.length > 0) outcome = retry;
      }

      if (outcome === null) {
        results.push({ query: name, candidates: [] });
        continue;
      }

      let candidates = outcome as AppCandidate[];

      // Apply the developer hint (from a Configurator CSV, for instance) to
      // re-rank. Ties fall back to the original iTunes ranking so we don't
      // accidentally demote Apple's best guess.
      if (developer && candidates.length > 1) {
        const scored = candidates.map((cand, idx) => ({
          cand,
          idx,
          score: scoreDeveloperMatch(cand.developer, developer),
        }));
        scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
        candidates = scored.map(s => s.cand);
      }

      if (candidates.length === 0) {
        console.warn(
          `iTunes search found no match for "${name}" (country=${country}) after retry`,
        );
      }

      results.push({ query: name, candidates });
    } catch (e) {
      console.error('iTunes search failed for', name, e);
      results.push({ query: name, candidates: [] });
    }
  }

  return { results };
}

// ─────────────────────────────────────────────
// iTunes Lookup (by bundle ID)
// ─────────────────────────────────────────────
//
// Apple exposes a sibling endpoint to `search` called `lookup` that
// resolves bundle IDs (and a handful of other primary keys: trackId,
// appleId, isbn, amgArtistId, etc.) to canonical App Store records.
// It accepts a comma-separated list of IDs and returns one record per
// successful match, in `data.results`. The same `country=` storefront
// param applies, the same rate-limit window applies (we treat lookup
// and search as a single 'search' rate-limit category in
// lib/rate-limit.ts because they share Apple's rolling-minute counter).
//
// Why lookup beats search for cfgutil imports:
//   1. Bundle IDs are unique per App Store record. No name collisions
//      (Calculator/Notes/Camera ambiguity), no need for a developer
//      hint, no manual disambiguation in Step 3.
//   2. Lookup accepts up to ~200 IDs per request — what would have
//      been 214 search calls becomes 1-2 lookup calls, which is
//      effectively free against Apple's rate limit.
//   3. Survives renames. If "Twitter" gets renamed to "X", a name
//      search still returns "X" (Apple updates the trackName), but a
//      bundle-ID lookup is also stable AND skips the wonder of "is
//      this the right app?" entirely.
//
// Misses (no record returned for a given bundle ID) are normal — they
// happen for: ancient apps Apple has fully delisted, regionally-
// blocked apps in storefronts other than the one we're querying,
// sideloaded enterprise distributions (custom B2B apps with bundle
// IDs that never appeared on the public store), and TestFlight builds
// whose bundle IDs differ from the production app. The wizard falls
// back to name search for those, which has a chance of recovering them
// (especially in the "wrong storefront" case, where a country=AU
// search picks up the AU listing that lookup didn't see because we
// queried country=US first).

/**
 * Apple's lookup endpoint caps the IDs-per-request at a documented 200.
 * We split larger inputs into chunks of this size and stitch the
 * responses together. The cap is high enough that most cfgutil imports
 * fit in a single request.
 */
const ITUNES_LOOKUP_BATCH_SIZE = 200;

/**
 * Result for one input bundleId. `match` is `null` when Apple returned
 * no record for that ID (delisted / sideloaded / wrong storefront /
 * never published). Callers should fall back to name search for
 * unmatched entries rather than dropping them.
 */
export interface BundleIdLookupResult {
  bundleId: string;
  match: AppCandidate | null;
}

export interface BundleIdLookupBatch {
  results: BundleIdLookupResult[];
  /**
   * Mirrors `SearchBatch.rateLimited`. When iTunes 429s mid-batch, we
   * stop and surface the unprocessed tail of bundle IDs so the caller
   * can resume after the cooldown elapses.
   */
  rateLimited?: {
    retryAfterMs: number;
    queued: string[];
  };
}

/**
 * Look up a list of bundle IDs against iTunes' `lookup?bundleId=…`
 * endpoint. See the section header above for the design rationale —
 * the short version is "this is the canonical, no-fuzzy-matching path
 * for cfgutil imports, where we already have the bundle ID in hand".
 *
 * Behaviour mirrors `searchAppsByName`:
 *   • Hard-cooldown short-circuit (returns early with `rateLimited`).
 *   • Soft pacer (acquireRateLimitToken before each request).
 *   • On 429, records the cooldown centrally and bails with the
 *     unprocessed tail in `queued` so the caller can resume.
 *   • Empty input is a no-op.
 *
 * Inputs that aren't valid Apple bundle IDs (empty string, whitespace,
 * obvious garbage) are filtered out up front. We don't try to validate
 * the ID format strictly — Apple is the authority on what's valid; we
 * just defend against trivially-broken input.
 */
export async function lookupAppsByBundleId(
  bundleIds: string[],
  options: SearchOptions = {},
): Promise<BundleIdLookupBatch> {
  // Normalize + dedupe the input. Lookup is idempotent (same ID twice
  // returns the same record both times) but the dedupe avoids wasting
  // request bytes and makes the result map straightforward.
  const cleaned = Array.from(
    new Set(
      bundleIds
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(id => id.length > 0),
    ),
  );

  if (cleaned.length === 0) return { results: [] };

  const country = normalizeCountry(
    options.country ?? getSetting('app_country', DEFAULT_COUNTRY),
  );

  const results: BundleIdLookupResult[] = [];
  // Split the input into 200-ID chunks. Most cfgutil imports fit in
  // one chunk; the loop just future-proofs against unusually large
  // libraries.
  for (let i = 0; i < cleaned.length; i += ITUNES_LOOKUP_BATCH_SIZE) {
    const chunk = cleaned.slice(i, i + ITUNES_LOOKUP_BATCH_SIZE);

    // Hard-cooldown short-circuit: if iTunes is currently throttling
    // us (a 429 already landed somewhere else), don't make a request
    // we know will bounce. Surface the remaining cooldown to the
    // caller and queue the full remaining tail (this chunk + every
    // chunk after it).
    const cooldownMs = getRemainingCooldownMs('search');
    if (cooldownMs > 0) {
      return {
        results,
        rateLimited: {
          retryAfterMs: cooldownMs,
          queued: cleaned.slice(i),
        },
      };
    }

    // Soft pacer: reserve a token from the shared search bucket so
    // bulk lookups + interactive search both stay under Apple's
    // rolling-minute ceiling.
    await acquireRateLimitToken('search');

    const url =
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(chunk.join(','))}`
      + `&country=${country}&limit=${ITUNES_LOOKUP_BATCH_SIZE}`;

    try {
      const { response: res, body: bodyBuf } = await safeFetch(url, {
        allowedHosts: APPLE_HOSTS,
        headers: { Accept: 'application/json' },
        timeoutMs: 12_000,
        // Lookup with 200 IDs comes back larger than a search response;
        // bump the cap to 4MB to be safe (search caps at 1MB).
        maxBytes: 4 * 1024 * 1024,
        redirect: 'follow',
      });

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const parsed = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : NaN;
        const retryAfterMs = Number.isFinite(parsed) && parsed > 0 && parsed < 600_000
          ? parsed
          : ITUNES_RATE_LIMIT_COOLDOWN_MS;
        console.warn(
          `iTunes lookup rate-limited (HTTP 429); cooling down ${Math.round(retryAfterMs / 1000)}s before retry`,
        );
        recordRateLimit(
          'search',
          retryAfterMs,
          `HTTP 429 from iTunes Lookup at ${new Date().toISOString()}${retryAfterHeader ? ` (Retry-After: ${retryAfterHeader})` : ''}`,
        );
        return {
          results,
          rateLimited: {
            retryAfterMs,
            queued: cleaned.slice(i),
          },
        };
      }

      if (!res.ok) {
        // Non-429 error — log and skip this chunk. The IDs in this
        // chunk all surface as `null` matches; the caller will fall
        // back to name search for them.
        console.warn(`iTunes lookup returned HTTP ${res.status} for chunk of ${chunk.length} bundle IDs`);
        for (const id of chunk) results.push({ bundleId: id, match: null });
        continue;
      }

      let data: any;
      try {
        data = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        console.warn('iTunes lookup returned non-JSON body');
        for (const id of chunk) results.push({ bundleId: id, match: null });
        continue;
      }

      // Index Apple's response by bundle ID so we can map each input ID
      // to its match (if any). Apple returns matches in `data.results`
      // but doesn't preserve input ordering when bundleIDs are
      // comma-separated, so we have to look each one up by hand. A
      // bundle ID that wasn't found just won't appear in `results`.
      const byBundle = new Map<string, AppCandidate>();
      for (const r of (data.results || []) as any[]) {
        const bundle = typeof r.bundleId === 'string' ? r.bundleId : null;
        if (!bundle) continue;
        byBundle.set(bundle, {
          appleId: String(r.trackId),
          name: r.trackName,
          developer: r.artistName,
          iconUrl: r.artworkUrl100?.replace('100x100bb', '200x200bb') ?? '',
          url: r.trackViewUrl?.split('?')[0] ?? '',
          bundleId: bundle,
          // We use the bundle ID as the search-query identifier so the
          // wizard can key its results map by either name OR bundle ID
          // when stitching this back into the existing AppCandidate
          // pipeline. The wizard's adapter decides which to use.
          searchQuery: bundle,
        });
      }

      for (const id of chunk) {
        results.push({ bundleId: id, match: byBundle.get(id) ?? null });
      }
    } catch (e) {
      console.error('iTunes lookup failed for chunk', e);
      for (const id of chunk) results.push({ bundleId: id, match: null });
    }
  }

  return { results };
}

// ─────────────────────────────────────────────
// Scraping
// ─────────────────────────────────────────────

/**
 * Result of a single `scrapeInitialUrls` iteration. Callers can distinguish
 * three terminal shapes:
 *
 *   • status: 'success'      — scrape landed, row is live in `apps`.
 *   • status: 'rate_limited' — Apple 429'd us; caller should enqueue with
 *                              the supplied `retryAfterMs` backoff.
 *   • status: 'error'        — anything else (network, 4xx that isn't 429,
 *                              malformed HTML). Caller should mark the row
 *                              as errored.
 */
export type ScrapeResult =
  | { url?: string; id: string; name: string; status: 'success'; isNew: boolean; changesDetected: boolean; changeCount: number }
  | { url: string; status: 'rate_limited'; retryAfterMs: number; error: string }
  | { url: string; status: 'error'; error: string };

export async function scrapeInitialUrls(
  urls: string[],
  resync = false,
  summarizePolicies = false,
  options: { stopOnRateLimit?: boolean; trigger?: SyncTrigger } = {},
): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  // Default trigger matches the historical meaning of resync vs fresh scrape.
  // Call sites that know better (the scheduler, the onboarding flow, the
  // import queue) can override explicitly via options.trigger.
  const trigger: SyncTrigger = options.trigger ?? (resync ? 'manual' : 'import');
  for (const url of urls) {
    try {
      const result = await fetchAndParseApp(url, resync, summarizePolicies, trigger);
      results.push(result as ScrapeResult);
    } catch (e: any) {
      if (isAppleRateLimitError(e)) {
        // Apple cooldowns persist across URLs from the same client, so every
        // remaining URL is guaranteed to 429 too. Bail out immediately and
        // let the caller enqueue the tail — that matches the iTunes-search
        // queued-retry flow above and avoids extending the ban.
        const retryAfterMs = e.retryAfterMs;
        results.push({ url, status: 'rate_limited', retryAfterMs, error: e.message });
        if (options.stopOnRateLimit !== false) {
          // Mark every remaining URL as queued-for-retry so the caller has a
          // complete map of what needs to be picked up later.
          const remaining = urls.slice(urls.indexOf(url) + 1);
          for (const tailUrl of remaining) {
            results.push({
              url: tailUrl,
              status: 'rate_limited',
              retryAfterMs,
              error: 'Queued behind an earlier rate-limited request',
            });
          }
          return results;
        }
        continue;
      }
      console.error('Failed to scrape:', url, e);
      results.push({ url, status: 'error', error: String(e?.message ?? e) });
    }
  }
  return results;
}

export async function fetchAndParseApp(
  url: string,
  resync = false,
  summarizePolicies = false,
  trigger: SyncTrigger = resync ? 'manual' : 'import',
) {
  // Defence-in-depth: even though the API routes validate the URL, the
  // scraper is also called from instrumentation (background sync) and from
  // test code. Re-validate here so every entry point is covered.
  const verdict = validateAppStoreUrl(url);
  if (!verdict.ok || !verdict.url) {
    throw new Error(
      `Refusing to scrape untrusted URL: ${verdict.error ?? 'invalid_url'} (${verdict.detail ?? url})`,
    );
  }

  // ── Activity log boundary ──
  // Record one row per scrape/resync so the Developer Options activity log
  // and the Task Center "Recent" section can show what's been happening.
  // We wrap the body in a try so any thrown error still produces a row
  // before propagating to the caller.
  const __activityStart = Date.now();
  const __activityType = resync ? 'resync' : 'scrape';
  // Live diagnostics handle — visible on the Diagnostics page while the
  // scrape is still running. The phase marks below sit at the four
  // boundaries that account for most of a scrape's wall-clock cost:
  // Apple HTML fetch, HTML/JSON parse, DB commit, optional policy fetch.
  const __scrapeId = newScrapeId();
  let __scrapeAppName: string | undefined;
  let __scrapeOutcome: 'success' | 'error' | 'rate_limited' = 'error';
  let __scrapeError: string | undefined;
  beginScrape(__scrapeId, verdict.url.toString(), resync);
  try {

  // Hard-cooldown short-circuit. If a previous request already triggered
  // a 429/403 that hasn't expired, throw the typed rate-limit error
  // immediately rather than make Apple re-issue it. The error carries
  // the *remaining* cooldown so callers see a single consistent
  // resumeAt timestamp regardless of which request first observed it.
  const scrapeCooldownMs = getRemainingCooldownMs('scrape');
  if (scrapeCooldownMs > 0) {
    console.info(
      `[scrape] short-circuit (cooldown active) — ${verdict.url.toString()} ` +
      `would be a no-op for ${Math.round(scrapeCooldownMs / 1000)}s`,
    );
    throw new AppleRateLimitError(scrapeCooldownMs);
  }

  // Soft pacer: bigger bucket than search (App Store HTML accepts a
  // higher per-minute rate), still keeps a small bulk sync from
  // tripping the ban out of the gate.
  await acquireRateLimitToken('scrape');

  const { response: req, body: htmlBuf } = await safeFetch(verdict.url.toString(), {
    allowedHosts: APPLE_HOSTS,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 15_000,
    maxBytes: APP_STORE_MAX_BYTES,
    redirect: 'follow',
  });

  // Apple's product-page endpoint rate-limits the same way iTunes Search
  // does. Surface this as a typed error so the queue worker can back off
  // rather than flipping the row to a terminal 'error' state.
  //
  // Apple uses 429 for explicit rate-limiting, but in practice IP-based
  // soft throttling arrives as 403 (with no Retry-After) — same effect,
  // different status. Treating 403 as a rate-limit lets the queue worker
  // and the onboard wizard's pause-on-rate-limit modal fire consistently
  // instead of flipping rows to a terminal 'error' state that never
  // recovers. See the fetchDiagnostics comment in the catch block below
  // for the historical context on why 403 is a rate signal here.
  if (req.status === 429 || req.status === 403) {
    const retryAfter = parseRetryAfterMs(req.headers.get('retry-after'));
    const retryAfterMs = retryAfter ?? APP_STORE_RATE_LIMIT_COOLDOWN_MS;
    console.warn(
      `App Store rate-limited (HTTP ${req.status}) for ${verdict.url.toString()}; retry after ${Math.round(retryAfterMs / 1000)}s`,
    );
    // Centrally record so the next request (regardless of caller) and
    // every UI surface sees the same cooldown window.
    recordRateLimit(
      'scrape',
      retryAfterMs,
      `HTTP ${req.status} from App Store HTML at ${new Date().toISOString()}${retryAfter ? ' (Retry-After honoured)' : ''}`,
    );
    throw new AppleRateLimitError(retryAfterMs);
  }

  if (!req.ok) throw new Error(`HTTP ${req.status} fetching App Store page`);
  const html = htmlBuf.toString('utf8');
  markScrapePhase(__scrapeId, 'apple_fetched');

  // ── Name ──
  let name = 'Unknown App';
  const nameMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (nameMatch) name = nameMatch[1].replace(/ on the App Store$/i, '').trim();

  // ── Icon ──
  let iconUrl = '';
  const iconMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (iconMatch) iconUrl = iconMatch[1];

  // ── Apple ID ──
  let appleId: string = crypto.randomUUID();
  const idMatch = url.match(/\/id([0-9]+)/i);
  if (idMatch) appleId = idMatch[1];

  // ── Developer ──
  let developer = '';
  const devMatch = html.match(/"author"\s*:\s*\{\s*"@type"[^}]*"name"\s*:\s*"([^"]+)"/);
  if (devMatch) developer = devMatch[1];

  // ── Privacy Policy URL ──
  let privacyPolicyUrl = '';
  
  // 1. Target by ARIA label (most specific)
  // Supports both ' (straight) and ’ (curly) apostrophes
  const ariaMatch = html.match(/<a\s+[^>]*?aria-label="Developer[’']s Privacy Policy"[^]*?href="([^"]+)"/i) 
                 || html.match(/<a\s+[^]*?href="([^"]+)"[^]*?aria-label="Developer[’']s Privacy Policy"/i);
  
  if (ariaMatch) {
    privacyPolicyUrl = ariaMatch[1];
  } else {
    // 2. Target within notPurchasedLinks section with a more precise bound match
    const sectionMatch = html.match(/id="notPurchasedLinks"[\s\S]*?<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*Privacy Policy\s*<\/a>/i);
    if (sectionMatch) {
      privacyPolicyUrl = sectionMatch[1];
    } else {
      // 3. Last resort fallback (global search for Privacy Policy text link)
      const finalMatch = html.match(/<a\s+[^>]*?href="([^"]+)"[^>]*?>\s*Privacy Policy\s*<\/a>/i);
      if (finalMatch) privacyPolicyUrl = finalMatch[1];
    }
  }

  // Scrub the scraped privacy-policy URL BEFORE it's persisted. If Apple's
  // page ever serves a javascript:/data:/file: URI (or a link to an internal
  // IP), sanitizePolicyUrl drops it on the floor rather than letting it
  // flow through to the UI, where a target="_blank" <a href> would execute
  // the scheme when clicked.
  privacyPolicyUrl = sanitizePolicyUrl(privacyPolicyUrl);

  // ── Privacy JSON ──
  const jsonMatch = html.match(/<script\b[^>]*\bid\s*=\s*(["'])serialized-server-data\1[^>]*>([\s\S]*?)<\/script>/i);
  if (!jsonMatch) throw new Error('No serialized-server-data script found in App Store page');

  let data: any;
  try {
    const raw = JSON.parse(jsonMatch[2]);
    // Apple now wraps the payload: { data: [...], userTokenHash: ... }
    // Fall back gracefully if it's still a plain array
    data = Array.isArray(raw) ? raw : (raw.data ?? []);
  } catch {
    throw new Error('Failed to parse serialized-server-data JSON');
  }

  // ── Name — prefer clean JSON title over og:title ──
  // data[0].data.title is just "Instagram"; og:title is "Instagram App - App Store"
  const jsonTitle: string | undefined = data[0]?.data?.title;
  if (jsonTitle) {
    name = jsonTitle.trim();
  } else if (name !== 'Unknown App') {
    // Strip trailing " App - App Store" or " - App Store" from og:title
    name = name
      .replace(/\s+App\s*[-–]\s*App Store.*/i, '')
      .replace(/\s*[-–]\s*App Store.*/i, '')
      .replace(/\s+on the App Store.*/i, '')
      .trim();
  }

  // ── Privacy details presence (3-state flag) ──
  // Apple shows a dedicated "No Details Provided" shelf/disclaimer when the
  // developer hasn't filled in privacy labels yet. Detect that explicitly so
  // the UI can show the standard Apple copy instead of a generic empty state.
  const hasPrivacyDetails = detectPrivacyDetailsFlag(html, data);

  // ── In-app purchases flag (3-state, like hasPrivacyDetails) ──
  // Detector tries the structured page-data paths first and falls back to
  // a conservative HTML scan. NULL = couldn't decide; saveToDb treats that
  // as "leave whatever was already there" so a transient parser miss
  // doesn't clear a known-true value from a previous sync.
  const hasIap = detectIapFlag(html, data);

  // ── Version + price metadata from iTunes Lookup (best-effort, non-fatal) ──
  const versionInfo = await fetchVersionInfo(appleId);

  // Capture snapshot BEFORE overwriting. Also pull the previous version
  // metadata so a resync that lands a new Apple version can both (a) stamp
  // the old version onto the outgoing snapshot row for accurate history and
  // (b) trigger a version-update notification separately from any label
  // diff that came with the release.
  const existingApp = db
    .prepare('SELECT id, currentVersion, versionUpdatedAt FROM apps WHERE id = ?')
    .get(appleId) as
    | { id: string; currentVersion: string | null; versionUpdatedAt: number | null }
    | undefined;
  let previousSnapshot: PrivacyTypeSnapshot[] | null = null;
  if (existingApp) {
    previousSnapshot = getLatestSnapshot(appleId) ?? buildSnapshot(appleId);
  }
  // Accessibility features live in their own table but changes flow through
  // the same changes_summary array as privacy-label diffs (tagged
  // category:'accessibility'). Capture the pre-scrape DB state BEFORE
  // saveToDb wipes + re-inserts, mirroring the privacy snapshot pattern.
  const previousAccessibility: AccessibilityFeatureRecord[] = existingApp
    ? buildAccessibilitySnapshot(appleId)
    : [];
  const previousVersion = existingApp?.currentVersion ?? null;
  const previousVersionUpdatedAt = existingApp?.versionUpdatedAt ?? null;
  const writePlan = prepareScrapeWritePlan(data, html);
  const newSnapshot = writePlan.snapshot;
  __scrapeAppName = name;
  markScrapePhase(__scrapeId, 'parsed');

  // ── Parser-fallthrough alert ────────────────────────────────────
  // Three states for `hasPrivacyDetails`:
  //   1   — Apple shows shelf items (parser succeeded)
  //   0   — Apple shows the "No Details Provided" copy (developer
  //         legitimately hasn't filed labels — not a parser failure)
  //   null — neither; the parser couldn't decide. Combined with an
  //         empty snapshot, that's the canonical signal that Apple's
  //         HTML structure has drifted past every shelf-fallback
  //         we know how to walk.
  // We deliberately skip this when the page has no labels for a
  // legitimate reason: a brand-new app that hasn't yet declared
  // privacy details produces snapshot.length === 0 AND
  // hasPrivacyDetails === 0, and we don't want to spam the bell on
  // those. The cooldown inside createParserFallthroughNotification
  // also collapses bulk-sync waves into a single visible alert per
  // 24 hours, so this is safe to call on every scrape.
  if (hasPrivacyDetails === null && newSnapshot.length === 0) {
    try {
      createParserFallthroughNotification({
        appName: name,
        appsAffected: 1,
      });
    } catch (error) {
      // Notifications are best-effort. A failure here mustn't take down
      // the scrape itself — the rest of the pipeline (snapshot, version,
      // accessibility) is still valuable even if the alert can't land.
      console.warn('[scraper] parser-fallthrough notification failed:', error);
    }
  }

  // Capture the privacy-profile mismatch BEFORE the write so we can detect
  // *newly* mismatching categories after the scrape. Doing this up-front (off
  // the old footprint) ensures the diff ignores pre-existing mismatches — we
  // only want the bell to fire for changes that just landed. When no profile
  // is set, `profileMismatchBefore` stays empty and the post-scrape branch
  // short-circuits without work.
  const privacyProfile = getPrivacyProfile();
  const profileMismatchBefore = privacyProfile
    ? existingApp
      ? computeProfileMismatch(privacyProfile, snapshotToFootprint(previousSnapshot ?? []))
      : null
    : null;

  const privacyChanges = previousSnapshot ? diffSnapshots(previousSnapshot, newSnapshot) : [];
  // Accessibility diff uses the parsed shelf directly. If parsing was
  // inconclusive (`null`), the commit leaves the old rows untouched, so the
  // effective post-scrape state is just the previous snapshot.
  const newAccessibility = writePlan.accessibilityFeatures ?? previousAccessibility;
  const accessibilityChanges = existingApp
    ? diffAccessibility(previousAccessibility, newAccessibility)
    : [];
  const changes = [...privacyChanges, ...accessibilityChanges];

  await commitScrapedAppToDb({
    appleId,
    name,
    url,
    iconUrl,
    developer,
    privacyPolicyUrl,
    isNew: !existingApp,
    hasPrivacyDetails,
    versionInfo,
    hasIap,
    writePlan,
    changes,
    trigger,
    activityType: __activityType,
    activityStartedAt: __activityStart,
  });
  markScrapePhase(__scrapeId, 'committed');

  // Version-update notification. Only fires when:
  //   - The app already existed (first-ever scrapes don't count as an update).
  //   - The version string actually moved (not just a non-null → null blip).
  //   - The user hasn't disabled the versionUpdates notification type.
  // Debounced per-app inside `createVersionUpdateNotification` so a bulk
  // resync running through many apps in sequence doesn't spam the bell.
  if (
    existingApp &&
    versionInfo.currentVersion &&
    previousVersion &&
    versionInfo.currentVersion !== previousVersion
  ) {
    try {
      createVersionUpdateNotification({
        appId: appleId,
        appName: name,
        previousVersion,
        currentVersion: versionInfo.currentVersion,
        previousVersionUpdatedAt,
        currentVersionUpdatedAt: versionInfo.versionUpdatedAt,
      });
    } catch (error) {
      console.warn('[scraper] version-update notification failed:', error);
    }
  }

  // Privacy-profile delta: fire a bell notification when a fresh scrape
  // introduces NEW mismatched categories against the user's profile. We
  // specifically diff category-by-category so an app that's been over the
  // limit since its first import doesn't keep re-alerting, while a resync
  // that adds (say) "Location → tracking" to a previously-fine app does.
  // Silently skipped when no profile is set (profileMismatchBefore === null
  // && we don't re-fetch) so the bell stays quiet for those users.
  if (privacyProfile) {
    try {
      const profileMismatchAfter = computeProfileMismatch(
        privacyProfile,
        snapshotToFootprint(newSnapshot),
      );
      if (profileMismatchAfter.count > 0) {
        const knownCategories = new Set(
          (profileMismatchBefore?.mismatches ?? []).map(m => m.category),
        );
        const newMismatches = profileMismatchAfter.mismatches.filter(
          m => !knownCategories.has(m.category),
        );
        if (newMismatches.length > 0) {
          createProfileMismatchNotification({
            appId: appleId,
            appName: name,
            newMismatches,
            isNew: !existingApp,
          });
        }
      }
    } catch (error) {
      // A profile-notification failure must never take down a scrape —
      // the user cares about the actual privacy-label data landing first.
      console.warn('[scraper] profile-mismatch notify failed for', name, error);
    }
  }

  // Optional policy analysis now runs strictly after the App Store label
  // scrape has committed its app rows, snapshot, notification, and activity.
  // Import/sync callers pass false and use the dedicated policy step/runner
  // instead, so a slow developer policy page can't hold the app import open.
  if (summarizePolicies) {
    try {
      await syncPrivacyPolicyAnalysis({
        appId: appleId,
        appName: name,
        developer,
        policyUrl: privacyPolicyUrl,
      });
    } catch (error) {
      console.error('Privacy policy analysis failed for', name, error);
    }
    markScrapePhase(__scrapeId, 'policy_done');
  }

  __scrapeOutcome = 'success';
  return {
    id: appleId,
    name,
    status: 'success',
    isNew: !existingApp,
    changesDetected: changes.length > 0,
    changeCount: changes.length,
  };
  } catch (error) {
    // Surface the failure in the activity log then rethrow so existing
    // callers (scrapeInitialUrls, import-queue, onboarding wizard) still
    // see the same error they always have. We also attach a small
    // structured "fetchDiagnostics" block when the error message carries
    // an HTTP status or well-known network signature, so the activity log
    // UI can render a troubleshoot panel with actionable hints rather
    // than just the raw "Fetch failed: HTTP 403" string.
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown error');
    const httpMatch = message.match(/HTTP\s+(\d{3})/i);
    const fetchDiagnostics: Record<string, unknown> = { requestedUrl: url };
    if (httpMatch) {
      const status = parseInt(httpMatch[1], 10);
      fetchDiagnostics.httpStatus = status;
      const hints: string[] = [];
      if (status === 403) {
        hints.push('Apple\'s App Store HTML endpoint refused the request.');
        hints.push('This is often a transient rate-limit — retry in a few minutes before assuming the scraper is broken.');
      } else if (status === 404) {
        hints.push('The App Store URL returned Not Found. The app may have been removed from the store.');
      } else if (status === 429) {
        hints.push('Apple is rate-limiting us. Stagger re-syncs with a longer delay, or wait a few minutes and retry.');
      } else if (status >= 500) {
        hints.push('App Store is returning an upstream error. Usually transient.');
      }
      if (hints.length > 0) fetchDiagnostics.troubleshoot = hints;
    } else if (/timeout|aborted|ETIMEDOUT/i.test(message)) {
      fetchDiagnostics.networkHint = 'timeout';
      fetchDiagnostics.troubleshoot = ['Request timed out. Retry later; the App Store HTML endpoint occasionally hangs.'];
    } else if (/ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(message)) {
      fetchDiagnostics.networkHint = 'network';
      fetchDiagnostics.troubleshoot = ['Network error reaching apps.apple.com. Check the container has outbound internet access.'];
    }
    recordActivity({
      type: __activityType,
      status: 'error',
      appId: null,
      appName: null,
      summary: message.slice(0, 200),
      detail: { url, errorMessage: message, fetchDiagnostics },
      startedAt: __activityStart,
    });
    // A typed AppleRateLimitError lands here too; we want it categorised
    // separately so the diagnostics panel can show "1 rate-limited" vs
    // "1 error" rather than collapsing them together.
    __scrapeOutcome = isAppleRateLimitError(error) ? 'rate_limited' : 'error';
    __scrapeError = message.slice(0, 200);
    throw error;
  } finally {
    endScrape(__scrapeId, __scrapeOutcome, {
      appName: __scrapeAppName,
      error: __scrapeError,
    });
  }
}

interface VersionInfo {
  currentVersion: string | null;
  versionUpdatedAt: number | null;
  whatsNew: string | null;
  /**
   * Phase 2: pricing snapshot from the iTunes Lookup payload. All three
   * are populated together (or all-null if the lookup failed). The
   * `formattedPrice` field on the Apple side is already locale-aware —
   * we render it as-is rather than reformatting client-side, so the
   * chip on the card matches what users see on the App Store listing.
   */
  priceAmount: number | null;
  priceCurrency: string | null;
  priceFormatted: string | null;
  /**
   * Apple App Store genre / category. `genreId` is the numeric id Apple
   * uses in its category-chart RSS feeds (`/genre/<id>`); `genreName` is
   * the human label ("Social Networking", "Productivity") rendered in
   * the Compare page's "Top in {category}" toggle. Both populated
   * together from the iTunes Lookup payload's `primaryGenreId` /
   * `primaryGenreName` — null on lookup failure.
   */
  genreId: number | null;
  genreName: string | null;
}

/**
 * Hit the iTunes Lookup endpoint for version + pricing metadata.
 * Best-effort: a failure here must not block the scrape (the HTML
 * parse is the source of truth for privacy data; version + price info
 * is a nice-to-have on top). The IAP boolean comes from the App Store
 * HTML parse, NOT this endpoint — Apple's Lookup API doesn't expose
 * an IAP flag.
 */
async function fetchVersionInfo(appleId: string): Promise<VersionInfo> {
  const empty: VersionInfo = {
    currentVersion: null,
    versionUpdatedAt: null,
    whatsNew: null,
    priceAmount: null,
    priceCurrency: null,
    priceFormatted: null,
    genreId: null,
    genreName: null,
  };
  if (!/^\d+$/.test(appleId)) return empty;

  const country = normalizeCountry(getSetting('app_country', DEFAULT_COUNTRY));
  try {
    const { response: res, body: bodyBuf } = await safeFetch(
      `https://itunes.apple.com/lookup?id=${appleId}&country=${country}`,
      {
        allowedHosts: APPLE_HOSTS,
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
        maxBytes: 1 * 1024 * 1024,
        redirect: 'follow',
      },
    );
    if (!res.ok) return empty;
    let payload: any;
    try {
      payload = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      return empty;
    }
    const entry = payload?.results?.[0];
    if (!entry) return empty;

    const currentVersion = typeof entry.version === 'string' && entry.version.trim()
      ? entry.version.trim()
      : null;

    let versionUpdatedAt: number | null = null;
    if (typeof entry.currentVersionReleaseDate === 'string') {
      const parsed = Date.parse(entry.currentVersionReleaseDate);
      if (!Number.isNaN(parsed)) versionUpdatedAt = parsed;
    }

    const whatsNew = typeof entry.releaseNotes === 'string' && entry.releaseNotes.trim()
      ? entry.releaseNotes.trim()
      : null;

    // Pricing — Apple returns numeric `price`, ISO `currency`, and the
    // localised display string `formattedPrice`. The numeric `price` is
    // 0 for free apps; we keep that as 0 (not null) so a downstream
    // sort-by-price doesn't lump "free" in with "unknown". Currency +
    // formattedPrice can still be present on free rows ("Free", "USD")
    // — Apple includes them anyway.
    const priceAmount = typeof entry.price === 'number' && Number.isFinite(entry.price)
      ? entry.price
      : null;
    const priceCurrency = typeof entry.currency === 'string' && entry.currency.trim()
      ? entry.currency.trim()
      : null;
    const priceFormatted = typeof entry.formattedPrice === 'string' && entry.formattedPrice.trim()
      ? entry.formattedPrice.trim()
      : null;

    // Genre / category. iTunes Lookup returns `primaryGenreId` (numeric)
    // and `primaryGenreName` (human label). The numeric id is what we
    // need for the App Store category-chart RSS lookup; the name is
    // what we render in the Compare page's "Top in {Productivity}"
    // toggle label.
    const genreId =
      typeof entry.primaryGenreId === 'number' && Number.isFinite(entry.primaryGenreId)
        ? entry.primaryGenreId
        : null;
    const genreName =
      typeof entry.primaryGenreName === 'string' && entry.primaryGenreName.trim()
        ? entry.primaryGenreName.trim()
        : null;

    return {
      currentVersion,
      versionUpdatedAt,
      whatsNew,
      priceAmount,
      priceCurrency,
      priceFormatted,
      genreId,
      genreName,
    };
  } catch (error) {
    console.error('iTunes lookup failed for', appleId, error);
    return empty;
  }
}

/**
 * Detect whether the App Store listing advertises in-app purchases.
 *
 * Apple surfaces IAP through a few different shapes depending on the
 * page-data revision:
 *
 *   - `shelfMapping.inAppPurchases.items[]` — the canonical product-page
 *     shelf with each IAP item listed (price + name).
 *   - `shelfMapping.information.items[].title === 'In-App Purchases'` —
 *     the boolean appears as a row in the "Information" shelf when the
 *     store doesn't expose a dedicated IAP shelf.
 *   - `additionalAttributes.attributes[].attributeKey === 'in-app-purchases'`
 *     — older serialised shape.
 *
 * The HTML fallback (regex against the literal "In-App Purchases" copy)
 * is intentionally conservative — Apple uses the same string in some
 * marketing copy, so we only trust it when the structured paths above
 * don't decide. The whole detector is best-effort: returning null
 * leaves the existing DB value untouched on the next sync, so a
 * temporary parser miss doesn't flip a known-true row to "unknown".
 *
 * Returns:
 *   1   — page advertises in-app purchases
 *   0   — page parsed and no IAP signal found
 *   null — couldn't decide; leave the previous value in place
 */
function detectIapFlag(html: string, rawData: any): number | null {
  try {
    const root = rawData?.[0]?.data;
    if (!root) return null;

    // Path 1 — dedicated inAppPurchases shelf.
    const iapShelf = root.shelfMapping?.inAppPurchases;
    if (iapShelf) {
      const items = iapShelf.items;
      if (Array.isArray(items)) {
        return items.length > 0 ? 1 : 0;
      }
    }

    // Path 2 — information shelf carrying the "In-App Purchases" row.
    const infoItems: unknown = root.shelfMapping?.information?.items;
    if (Array.isArray(infoItems)) {
      for (const item of infoItems as Array<Record<string, unknown>>) {
        const title = typeof item?.title === 'string' ? item.title : '';
        if (/^in[-‑ ]?app\s+purchases$/i.test(title)) return 1;
      }
    }

    // Path 3 — older `additionalAttributes` schema with attributeKey rows.
    const attrs: unknown = root.additionalAttributes?.attributes;
    if (Array.isArray(attrs)) {
      for (const a of attrs as Array<Record<string, unknown>>) {
        const key = typeof a?.attributeKey === 'string' ? a.attributeKey : '';
        if (/^in[-_‑]?app[-_‑]?purchases$/i.test(key)) {
          // Some payloads carry the boolean here; fall back to "1" if
          // the key is present at all (the row only shows up when IAP
          // is offered).
          if (typeof a.value === 'boolean') return a.value ? 1 : 0;
          return 1;
        }
      }
    }

    // Path 4 — last-resort HTML scan for the literal "Offers In-App
    // Purchases" / "In-App Purchases" badge text. Looks for the badge
    // shape specifically (sentence-case, immediately under the title)
    // rather than any mention, so prose like "We disclose in-app
    // purchases in our policy" doesn't trip the detector.
    if (/Offers\s+In[-‑ ]?App\s+Purchases/i.test(html)) return 1;

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns:
 *   1  — developer has declared privacy labels (shelf items present)
 *   0  — developer explicitly hasn't provided any (Apple "No Details Provided" copy)
 *   null — unknown / parser couldn't decide
 */
function detectPrivacyDetailsFlag(html: string, rawData: any): number | null {
  try {
    const shelfMap = rawData?.[0]?.data?.shelfMapping;

    const hasItems =
      !!shelfMap?.privacyTypes?.items?.length ||
      !!shelfMap?.privacyHeader?.seeAllAction?.pageData?.shelves?.some(
        (s: any) => s?.contentType === 'privacyType' && s?.items?.length,
      );

    if (hasItems) return 1;

    // Apple's disclaimer copy: "The developer will be required to provide
    // privacy details when they submit their next app update." + the header
    // phrase "No Details Provided" (sometimes rendered as "No details provided").
    const hasNoDetailsCopy =
      /No\s+Details\s+Provided/i.test(html) ||
      /required\s+to\s+provide\s+privacy\s+details\s+when\s+they\s+submit/i.test(html);

    if (hasNoDetailsCopy) return 0;

    return null;
  } catch {
    return null;
  }
}

interface ParsedPrivacyCategory {
  identifier: string;
  title: string;
}

interface ParsedPrivacyItem {
  identifier: string;
  title: string;
  detail: string;
  categories: ParsedPrivacyCategory[];
}

interface ScrapeWritePlan {
  privacyItems: ParsedPrivacyItem[];
  accessibilityFeatures: AccessibilityFeatureRecord[] | null;
  hasAccessibilityLabels: number | null;
  snapshot: PrivacyTypeSnapshot[];
}

interface CommitScrapedAppInput {
  appleId: string;
  name: string;
  url: string;
  iconUrl: string;
  developer: string;
  privacyPolicyUrl: string;
  isNew: boolean;
  hasPrivacyDetails: number | null;
  versionInfo: VersionInfo;
  hasIap: number | null;
  writePlan: ScrapeWritePlan;
  changes: ChangeEntry[];
  trigger: SyncTrigger;
  activityType: 'scrape' | 'resync';
  activityStartedAt: number;
}

/**
 * Extract `privacyTypes` items from Apple's older Ember/FastBoot shoebox
 * cache embedded in the HTML. Used as a fallback when the modern
 * `<script id="serialized-server-data">` blob doesn't contain shelf
 * data — historically true for every capture between Jan 2021 and the
 * Nov 2025 web App Store redesign.
 *
 * Wayback investigation (see SECURITY.md / wiki Wayback notes) confirmed
 * the historical schema:
 *
 *   <script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">
 *     {".v1.catalog.us.apps.<id>...": "<json-string>", ...}
 *   </script>
 *
 * After unwrapping the inner string, the path to privacy data is:
 *
 *   d[0].attributes.privacy.privacyTypes[]
 *     ├── identifier        ── DATA_USED_TO_TRACK_YOU / DATA_LINKED_TO_YOU / …
 *     ├── privacyType       ── localised display label (rename: title)
 *     ├── description
 *     └── dataCategories[]
 *           ├── identifier  ── PURCHASES / IDENTIFIERS / LOCATION / …
 *           └── dataCategory ── localised display label (rename: title)
 *
 * The `identifier` enums are byte-identical to the modern format, so
 * downstream snapshot diffing, severity styling, and change detection
 * all work without further translation. The only two renames the
 * normaliser cares about (`title` is what
 * {@link normalizePrivacyItems} expects on each item / category) are
 * applied here so the rest of the pipeline stays single-shape.
 *
 * Returns an empty array on any failure path. The caller falls through
 * to the parser-fallthrough notification just like it does for the
 * modern path's empty case.
 */
export function extractFromShoebox(html: string): any[] {
  try {
    // Match every fastboot shoebox script. Apple writes the privacy data
    // into `shoebox-media-api-cache-apps` on the apps page, but the
    // exact id has shifted over Apple's design refreshes (e.g.
    // `shoebox-uts-api-cache-apps` showed up briefly in 2023). Pulling
    // every shoebox and walking each one for the marker path is more
    // robust than hard-coding the id and missing a window.
    const SHOEBOX_RE = /<script[^>]*\btype="fastboot\/shoebox"[^>]*\bid="(shoebox-[^"]*)"[^>]*>([\s\S]*?)<\/script>/gi;
    const candidates: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = SHOEBOX_RE.exec(html)) !== null) {
      // Only consider shoeboxes whose id mentions "media-api" or "apps"
      // — the localizer / language-code / global-elements shoeboxes
      // never carry app data and are noise to walk.
      const id = match[1];
      if (!/media-api|apps/i.test(id)) continue;
      candidates.push(match[2]);
    }
    if (candidates.length === 0) return [];

    // Decode HTML entities. The shoebox body is HTML-escaped JSON
    // (Ember writes `&quot;` for the JSON string delimiters etc.) so
    // a naive JSON.parse on the raw match would fail.
    const decode = (s: string): string => s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    for (const body of candidates) {
      let outer: Record<string, unknown>;
      try {
        outer = JSON.parse(decode(body)) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Shoebox values are JSON-encoded strings keyed by Apple API
      // request URLs. Decode each, then probe `d[0].attributes.privacy
      // .privacyTypes` — that's the historical schema.
      for (const value of Object.values(outer)) {
        let entry: any = value;
        if (typeof entry === 'string') {
          try { entry = JSON.parse(entry); }
          catch { continue; }
        }
        const d = entry?.d;
        if (!Array.isArray(d) || d.length === 0) continue;
        const attrs = d[0]?.attributes;
        const privacyTypes = attrs?.privacy?.privacyTypes;
        if (!Array.isArray(privacyTypes) || privacyTypes.length === 0) continue;

        // Field-rename to the modern shape so `normalizePrivacyItems`
        // can consume the result without a second normaliser. The
        // identifier enums are unchanged so downstream stays single-
        // schema.
        return privacyTypes
          .filter((t: any) => t && typeof t.identifier === 'string')
          .map((t: any) => ({
            identifier: t.identifier,
            // Historical field is `privacyType` (e.g. "Data Linked to
            // You"); the modern parser keys off `title`.
            title: typeof t.privacyType === 'string' ? t.privacyType
                 : typeof t.title === 'string' ? t.title
                 : t.identifier,
            categories: Array.isArray(t.dataCategories)
              ? t.dataCategories
                  .filter((c: any) => c && typeof c.identifier === 'string')
                  .map((c: any) => ({
                    identifier: c.identifier,
                    title: typeof c.dataCategory === 'string' ? c.dataCategory
                         : typeof c.title === 'string' ? c.title
                         : c.identifier,
                  }))
              : [],
          }));
      }
    }
  } catch (error) {
    console.warn('[scraper] shoebox privacy extract failed:', error);
  }
  return [];
}

function prepareScrapeWritePlan(rawData: any, html?: string): ScrapeWritePlan {
  // ── Extract accessibility nutrition labels ──
  // Defensive: any parse/shape error is captured and defaulted to NULL so a
  // partial Apple response still lets privacy-label persistence succeed. A
  // null here means "we couldn't decide" (hasAccessibilityLabels = NULL) so
  // the UI renders nothing rather than falsely claiming "no accessibility".
  let accessibilityFeatures: AccessibilityFeatureRecord[] | null = null;
  try {
    accessibilityFeatures = extractAccessibilityFeatures(rawData);
  } catch (e) {
    console.error('Could not extract accessibility data from raw JSON', e);
    accessibilityFeatures = null;
  }
  const hasAccessibilityLabels: number | null =
    accessibilityFeatures === null
      ? null
      : accessibilityFeatures.length > 0
        ? 1
        : 0;

  // ── Extract privacy types from product-page shelf (flat categories) ──
  let privacyItems: any[] = [];
  try {
    const shelfMap = rawData[0]?.data?.shelfMapping;

    // Prefer the product-page privacyTypes shelf (flat: type → categories[])
    if (shelfMap?.privacyTypes?.items?.length) {
      privacyItems = shelfMap.privacyTypes.items;
    }

    // Fallback: detail shelves from privacyHeader (may have nested purposes)
    // We flatten them to extract just the unique categories per type.
    if (!privacyItems.length) {
      const via_header = shelfMap?.privacyHeader?.seeAllAction?.pageData?.shelves;
      if (via_header?.length) {
        for (const shelf of via_header) {
          if (shelf.contentType !== 'privacyType') continue;
          for (const item of (shelf.items ?? [])) {
            // If the item has direct categories, use them
            if (item.categories?.length) {
              privacyItems.push(item);
            }
            // If it uses the nested purposes → categories structure, flatten it
            else if (item.purposes?.length) {
              const catMap = new Map<string, any>();
              for (const p of item.purposes) {
                for (const c of (p.categories ?? [])) {
                  if (!catMap.has(c.identifier)) {
                    catMap.set(c.identifier, { identifier: c.identifier, title: c.title });
                  }
                }
              }
              privacyItems.push({
                ...item,
                categories: [...catMap.values()],
                purposes: [], // clear nested structure
              });
            }
          }
        }
      }
    }

    // Fallback: generic pageData
    if (!privacyItems.length) {
      const pageData = rawData[0]?.data?.pageData;
      if (pageData?.shelves?.length) {
        for (const shelf of pageData.shelves) {
          if (shelf.contentType === 'privacyType') {
            privacyItems.push(...(shelf.items ?? []));
          }
        }
      }
    }

    // Fallback: legacy Ember/FastBoot shoebox cache. Used by
    // `apps.apple.com` from Jan 2021 through the Nov 2025 redesign,
    // which means every Wayback capture in that window depends on this
    // path to extract privacy data — the modern `serialized-server-data`
    // blob simply didn't exist yet. See {@link extractFromShoebox} for
    // the schema and field-rename details. Caller passes `html` only
    // for paths that have it; old call sites stay backwards-compatible
    // with the implicit-undefined behaviour (skip the fallback when
    // there's nothing to scan).
    if (!privacyItems.length && html) {
      privacyItems = extractFromShoebox(html);
    }
  } catch (e) {
    console.error('Could not extract privacy data from raw JSON', e);
  }

  const parsedPrivacyItems = normalizePrivacyItems(privacyItems);
  return {
    privacyItems: parsedPrivacyItems,
    accessibilityFeatures,
    hasAccessibilityLabels,
    snapshot: parsedPrivacyItems.map((item) => ({
      identifier: item.identifier,
      title: item.title,
      categories: item.categories.map((category) => ({
        identifier: category.identifier,
        title: category.title,
      })),
    })),
  };
}

function normalizePrivacyItems(items: any[]): ParsedPrivacyItem[] {
  const out: ParsedPrivacyItem[] = [];
  for (const item of items) {
    if (!item || typeof item.identifier !== 'string' || typeof item.title !== 'string') {
      continue;
    }
    const categories = new Map<string, ParsedPrivacyCategory>();
    for (const cat of item.categories ?? []) {
      if (!cat || typeof cat.identifier !== 'string' || typeof cat.title !== 'string') {
        continue;
      }
      if (!categories.has(cat.identifier)) {
        categories.set(cat.identifier, {
          identifier: cat.identifier,
          title: cat.title,
        });
      }
    }
    out.push({
      identifier: item.identifier,
      title: item.title,
      detail: typeof item.detail === 'string' ? item.detail : '',
      categories: [...categories.values()],
    });
  }
  return out;
}

function snapshotToFootprint(snapshot: PrivacyTypeSnapshot[]): AppProfileFootprint {
  const worst: Record<string, Exclude<ProfileTier, 'not_collected'>> = {};
  for (const type of snapshot) {
    const tier = TYPE_IDENTIFIER_TO_TIER[type.identifier];
    if (!tier || tier === 'not_collected') continue;
    for (const category of type.categories) {
      const existing = worst[category.identifier];
      if (!existing || TIER_RANK[tier] > TIER_RANK[existing]) {
        worst[category.identifier] = tier as Exclude<ProfileTier, 'not_collected'>;
      }
    }
  }
  return { worstByCategory: worst };
}

function pushScrapedAppStatements(
  statements: DbWorkerStatement[],
  input: CommitScrapedAppInput,
  now: number,
): void {
  const {
    appleId: appId,
    name,
    url,
    iconUrl,
    developer,
    privacyPolicyUrl,
    isNew,
    hasPrivacyDetails,
    versionInfo,
    hasIap,
    writePlan,
  } = input;

  // Wipe existing privacy tree (will re-insert fresh). The worker connection
  // has foreign_keys=ON, so categories cascade from privacy_types.
  statements.push({
    sql: 'DELETE FROM privacy_types WHERE app_id = ?',
    params: [appId],
  });

  if (isNew) {
    statements.push({
      sql: `
        INSERT INTO apps (
          id, name, url, iconUrl, developer, privacyPolicyUrl, bundleId,
          firstSeen, lastSynced, changeCount,
          currentVersion, versionUpdatedAt, whatsNew, hasPrivacyDetails,
          hasAccessibilityLabels,
          priceAmount, priceCurrency, priceFormatted, hasIap,
          genreId, genreName
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      params: [
        appId, name, url, iconUrl, developer, privacyPolicyUrl,
        now, now,
        versionInfo.currentVersion,
        versionInfo.versionUpdatedAt,
        versionInfo.whatsNew,
        hasPrivacyDetails,
        writePlan.hasAccessibilityLabels,
        versionInfo.priceAmount,
        versionInfo.priceCurrency,
        versionInfo.priceFormatted,
        hasIap,
        versionInfo.genreId,
        versionInfo.genreName,
      ],
    });
  } else {
    // COALESCE guards parser misses from clearing previously-good metadata.
    statements.push({
      sql: `
        UPDATE apps
           SET name = ?, url = ?, iconUrl = ?, developer = ?, privacyPolicyUrl = ?,
               lastSynced = ?,
               currentVersion = COALESCE(?, currentVersion),
               versionUpdatedAt = COALESCE(?, versionUpdatedAt),
               whatsNew = COALESCE(?, whatsNew),
               hasPrivacyDetails = ?,
               hasAccessibilityLabels = COALESCE(?, hasAccessibilityLabels),
               priceAmount = COALESCE(?, priceAmount),
               priceCurrency = COALESCE(?, priceCurrency),
               priceFormatted = COALESCE(?, priceFormatted),
               hasIap = COALESCE(?, hasIap),
               genreId = COALESCE(?, genreId),
               genreName = COALESCE(?, genreName)
         WHERE id = ?
      `,
      params: [
        name, url, iconUrl, developer, privacyPolicyUrl,
        now,
        versionInfo.currentVersion,
        versionInfo.versionUpdatedAt,
        versionInfo.whatsNew,
        hasPrivacyDetails,
        writePlan.hasAccessibilityLabels,
        versionInfo.priceAmount,
        versionInfo.priceCurrency,
        versionInfo.priceFormatted,
        hasIap,
        versionInfo.genreId,
        versionInfo.genreName,
        appId,
      ],
    });
  }

  for (const item of writePlan.privacyItems) {
    const typeId = `${appId}_${item.identifier}`;
    statements.push({
      sql: `
        INSERT INTO privacy_types (id, app_id, identifier, title, detail)
        VALUES (?, ?, ?, ?, ?)
      `,
      params: [typeId, appId, item.identifier, item.title, item.detail],
    });

    // Flat categories directly on the privacy type.
    for (const cat of item.categories) {
      const catId = `${typeId}_${cat.identifier}`;
      statements.push({
        sql: `
          INSERT OR IGNORE INTO privacy_categories (id, type_id, identifier, title)
          VALUES (?, ?, ?, ?)
        `,
        params: [catId, typeId, cat.identifier, cat.title],
      });
    }
  }

  // Accessibility features — same wipe+reinsert pattern as privacy_types.
  // Only touch the table when the parser decided something (null = leave
  // alone so a transient Apple parse glitch doesn't silently delete a
  // previously-captured feature set).
  if (writePlan.accessibilityFeatures !== null) {
    statements.push({
      sql: 'DELETE FROM accessibility_features WHERE app_id = ?',
      params: [appId],
    });
    for (const f of writePlan.accessibilityFeatures) {
      statements.push({
        sql: 'INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template) VALUES (?, ?, ?, ?, ?, ?)',
        params: [
          `${appId}_${f.identifier}`,
          appId,
          f.identifier,
          f.title,
          f.description,
          f.iconTemplate,
        ],
      });
    }
  }
}

async function commitScrapedAppToDb(input: CommitScrapedAppInput): Promise<void> {
  const now = Date.now();
  const statements: DbWorkerStatement[] = [];
  pushScrapedAppStatements(statements, input, now);

  const snapshotId = crypto.randomUUID();
  const hasChanges = input.changes.length > 0;
  statements.push({
    sql: `
      INSERT INTO privacy_snapshots
        (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
         source, wayback_snapshot_url, triggered_by,
         app_version, app_version_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)
    `,
    params: [
      snapshotId,
      input.appleId,
      now,
      JSON.stringify(input.writePlan.snapshot),
      hasChanges ? 1 : 0,
      JSON.stringify(input.changes),
      input.trigger,
      input.versionInfo.currentVersion,
      input.versionInfo.versionUpdatedAt,
    ],
  });

  if (hasChanges) {
    statements.push({
      sql: 'UPDATE apps SET changeCount = changeCount + 1 WHERE id = ?',
      params: [input.appleId],
    });
    statements.push({
      sql: `
        INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, not_before)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `,
      params: [
        crypto.randomUUID(),
        input.appleId,
        input.name,
        JSON.stringify(input.changes),
        now,
        computeNotBefore(new Date(now)),
      ],
    });
  }

  const activityEndedAt = Date.now();
  const durationMs = Math.max(0, activityEndedAt - input.activityStartedAt);
  statements.push({
    sql: `
      INSERT INTO activity_log
        (id, type, status, app_id, app_name, summary, detail,
         started_at, ended_at, duration_ms)
      VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?)
    `,
    params: [
      crypto.randomUUID(),
      input.activityType,
      input.appleId,
      input.name,
      hasChanges
        ? `${input.changes.length} change${input.changes.length === 1 ? '' : 's'} detected`
        : input.isNew
          ? 'New app added'
          : 'No changes',
      JSON.stringify({
        changeCount: input.changes.length,
        isNew: input.isNew,
        hasPrivacyDetails: input.hasPrivacyDetails,
      }),
      input.activityStartedAt,
      activityEndedAt,
      durationMs,
    ],
  });
  statements.push({
    sql: `
      DELETE FROM activity_log
       WHERE id IN (
         SELECT id FROM activity_log
          ORDER BY started_at DESC
          LIMIT -1 OFFSET 2000
       )
    `,
    params: [],
  });

  await runBulkWrite(statements, { chunkSize: Math.max(1, statements.length) });
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

export function getAllApps() {
  return db.prepare(`
    WITH privacy_counts AS (
      SELECT
        t.app_id,
        COUNT(c.id) AS categoryCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_USED_TO_TRACK_YOU' THEN 1 ELSE 0 END) AS trackCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS linkedCount,
        SUM(CASE WHEN c.id IS NOT NULL AND t.identifier = 'DATA_NOT_LINKED_TO_YOU' THEN 1 ELSE 0 END) AS unlinkedCount
      FROM privacy_types t
      LEFT JOIN privacy_categories c ON c.type_id = t.id
      GROUP BY t.app_id
    ),
    sync_counts AS (
      SELECT app_id, COUNT(*) AS syncCount
      FROM privacy_snapshots
      GROUP BY app_id
    ),
    accessibility_counts AS (
      SELECT app_id, COUNT(*) AS accessibilityCount
      FROM accessibility_features
      GROUP BY app_id
    )
    SELECT a.*,
      COALESCE(pc.categoryCount, 0) AS categoryCount,
      COALESCE(pc.trackCount, 0) AS trackCount,
      COALESCE(pc.linkedCount, 0) AS linkedCount,
      COALESCE(pc.unlinkedCount, 0) AS unlinkedCount,
      COALESCE(sc.syncCount, 0) AS syncCount,
      COALESCE(ac.accessibilityCount, 0) AS accessibilityCount
    FROM apps a
    LEFT JOIN privacy_counts pc ON pc.app_id = a.id
    LEFT JOIN sync_counts sc ON sc.app_id = a.id
    LEFT JOIN accessibility_counts ac ON ac.app_id = a.id
    ORDER BY a.name ASC
  `).all();
}

/**
 * Per-app breakdown of which change categories are currently pending
 * acknowledgement on the Apps grid. The pulsing dot on each card used to
 * be one colour regardless of *what* changed, which made an
 * accessibility-label update look like a privacy regression. Splitting
 * this out lets the grid render a blue dot for accessibility, orange for
 * privacy labels/policies, and both side-by-side when a single app has a
 * mixed bundle.
 *
 * Aggregates across *all* pending snapshots (anything since
 * `changes_acknowledged_at`), not just the most recent one, so a card
 * that went "privacy change" → "accessibility change" across two scrapes
 * shows both dots until the user acks.
 *
 * Returns a bare object (not a Map) so it can be serialised and passed
 * through server → client boundaries unchanged. Apps with no pending
 * changes are simply omitted from the result.
 */
export function getPendingChangeCategoriesByApp(): Record<
  string,
  { privacy: boolean; accessibility: boolean; policy: boolean }
> {
  const rows = db
    .prepare(
      `SELECT ps.app_id, ps.changes_summary
         FROM privacy_snapshots ps
         JOIN apps a ON a.id = ps.app_id
        WHERE ps.changes_detected = 1
          AND ps.scraped_at > COALESCE(a.changes_acknowledged_at, 0)`,
    )
    .all() as Array<{ app_id: string; changes_summary: string | null }>;

  const out: Record<
    string,
    { privacy: boolean; accessibility: boolean; policy: boolean }
  > = {};
  for (const row of rows) {
    const bucket = (out[row.app_id] ??= {
      privacy: false,
      accessibility: false,
      policy: false,
    });
    if (!row.changes_summary) {
      // Defensive fallback — a pending snapshot with no summary is almost
      // certainly a privacy-label change from an older writer that
      // stored the blob differently; treat it as privacy so we don't
      // accidentally demote it to a blue accessibility dot.
      bucket.privacy = true;
      continue;
    }
    try {
      const entries = JSON.parse(row.changes_summary) as Array<{
        category?: string;
      }>;
      for (const entry of entries) {
        const cat = entry.category ?? 'privacy-label';
        if (cat === 'accessibility') bucket.accessibility = true;
        else if (cat === 'privacy-policy') bucket.policy = true;
        else if (cat === 'privacy-label') bucket.privacy = true;
        // wayback-attempt rows are skipped here — they shouldn't land in
        // pending bundles (saveSnapshot uses skipChangeCountBump for
        // wayback) but the guard keeps the set honest if some new path
        // ever bumps changeCount via wayback.
      }
    } catch {
      bucket.privacy = true;
    }
  }
  return out;
}

export function getAppWithPrivacy(appId: string) {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId) as any;
  if (!app) return null;

  const types = db.prepare('SELECT * FROM privacy_types WHERE app_id = ?').all(appId) as any[];
  for (const t of types) {
    t.categories = db.prepare(
      'SELECT * FROM privacy_categories WHERE type_id = ?'
    ).all(t.id) as any[];
  }

  app.privacyTypes = types;
  app.policyAnalysis = getPolicyAnalysis(appId);
  // Attach accessibility nutrition labels. Empty array is meaningful:
  // combined with hasAccessibilityLabels=0 it means "developer has not
  // declared any"; combined with hasAccessibilityLabels=null it means
  // "we haven't been able to scrape this app yet".
  app.accessibilityFeatures = db
    .prepare(
      'SELECT identifier, title, description, icon_template AS iconTemplate FROM accessibility_features WHERE app_id = ? ORDER BY identifier',
    )
    .all(appId);
  return app;
}

/**
 * Returns data pivoted by privacy type → category, each category listing
 * every app that has it. Ordered by severity (most serious first).
 */
export function getGroupedPrivacyView() {
  const apps = db.prepare('SELECT id, name, iconUrl, developer FROM apps').all() as any[];
  const appMap = new Map<string, any>(apps.map(a => [a.id, a]));

  const rows = db.prepare(`
    SELECT
      pt.identifier  AS typeId,
      pt.title       AS typeTitle,
      pt.detail      AS typeDetail,
      pc.identifier  AS categoryId,
      pc.title       AS categoryTitle,
      pt.app_id
    FROM privacy_types pt
    JOIN privacy_categories pc ON pc.type_id = pt.id
  `).all() as any[];

  const severityOrder: Record<string, number> = {
    DATA_USED_TO_TRACK_YOU: 0,
    DATA_LINKED_TO_YOU: 1,
    DATA_NOT_LINKED_TO_YOU: 2,
  };

  // Category risk weight — red > orange > blue > neutral (matches CATEGORY_META.color).
  // Used to break ties when multiple categories have similar app counts within a severity.
  const categoryRiskWeight: Record<string, number> = {
    SENSITIVE_INFO: 5,
    LOCATION: 5,
    HEALTH_AND_FITNESS: 5,
    IDENTIFIERS: 5,
    FINANCIAL_INFO: 4,
    USER_CONTENT: 4,
    BROWSING_HISTORY: 4,
    SEARCH_HISTORY: 4,
    USAGE_DATA: 4,
    CONTACT_INFO: 3,
    CONTACTS: 3,
    PURCHASES: 3,
    DIAGNOSTICS: 1,
    OTHER: 1,
  };

  const grouped: Record<string, any> = {};

  for (const row of rows) {
    if (!grouped[row.typeId]) {
      grouped[row.typeId] = {
        identifier: row.typeId,
        title: row.typeTitle,
        detail: row.typeDetail,
        categories: {} as Record<string, any>,
      };
    }

    if (!grouped[row.typeId].categories[row.categoryId]) {
      grouped[row.typeId].categories[row.categoryId] = {
        identifier: row.categoryId,
        title: row.categoryTitle,
        appIds: new Set<string>(),
      };
    }

    grouped[row.typeId].categories[row.categoryId].appIds.add(row.app_id);
  }

  return Object.values(grouped)
    .map((group: any) => ({
      ...group,
      categories: Object.values(group.categories)
        .map((c: any) => ({
          identifier: c.identifier,
          title: c.title,
          riskWeight: categoryRiskWeight[c.identifier] ?? 2,
          apps: [...c.appIds]
            .map((id: string) => appMap.get(id))
            .filter(Boolean),
        }))
        .sort((a: any, b: any) => {
          // Primary: by intrinsic category risk (Sensitive/Location/Identifiers first).
          const weightDiff = (b.riskWeight ?? 0) - (a.riskWeight ?? 0);
          if (weightDiff !== 0) return weightDiff;
          // Secondary: by how many apps use it.
          return b.apps.length - a.apps.length;
        }),
    }))
    .sort((a: any, b: any) => (severityOrder[a.identifier] ?? 99) - (severityOrder[b.identifier] ?? 99));
}
