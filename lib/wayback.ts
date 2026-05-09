/**
 * Internet Archive integration for privacy-policy persistence.
 *
 * - `lookupLatestWaybackSnapshot` queries archive.org's availability API
 *   for the most recent capture of a URL.
 * - `submitToWaybackSaveNow` triggers a fresh Save Page Now capture and
 *   returns the snapshot URL.
 *
 * Both fail gracefully — an unreachable archive.org must never break the
 * scrape.
 */

import { safeFetch } from './security';

const WAYBACK_HOSTS = ['archive.org', 'web.archive.org'];

const AVAILABILITY_MAX_BYTES = 64 * 1024;
const SAVE_NOW_MAX_BYTES = 256 * 1024;

const AVAILABILITY_TIMEOUT_MS = 8_000;
const SAVE_NOW_TIMEOUT_MS = 25_000;

export interface WaybackSnapshot {
  /** Full URL to the archived page on web.archive.org. */
  url: string;
  /** Archive capture timestamp in YYYYMMDDhhmmss form, if available. */
  timestamp?: string;
}

/**
 * Discriminated result for submitToWaybackSaveNow. Callers can check
 * `result.ok` for success or read `result.error` to surface a failure reason.
 */
export type WaybackSaveResult =
  | { ok: true; snapshot: WaybackSnapshot }
  | { ok: false; error: string };

/**
 * Query the availability API for the latest snapshot of `targetUrl`. Returns
 * null when archive.org is unreachable, the JSON is malformed, or no
 * snapshot exists.
 */
export async function lookupLatestWaybackSnapshot(
  targetUrl: string,
): Promise<WaybackSnapshot | null> {
  if (!targetUrl) return null;

  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;
  try {
    const { body } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: AVAILABILITY_MAX_BYTES,
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'privacytracker/1.0 (+privacy-history archiver)',
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }

    const closest = (parsed as {
      archived_snapshots?: { closest?: { url?: unknown; timestamp?: unknown; available?: unknown } };
    })?.archived_snapshots?.closest;

    if (!closest) return null;
    if (closest.available === false) return null;
    if (typeof closest.url !== 'string' || !closest.url.startsWith('http')) {
      return null;
    }

    return {
      url: closest.url,
      timestamp: typeof closest.timestamp === 'string' ? closest.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Trigger a fresh Save Page Now capture. Returns the final snapshot URL
 * (after redirect) or the in-flight URL from `Content-Location` when the
 * save is still in progress.
 */
export async function submitToWaybackSaveNow(
  targetUrl: string,
): Promise<WaybackSaveResult> {
  if (!targetUrl) return { ok: false, error: 'missing target url' };

  const endpoint = `https://web.archive.org/save/${targetUrl.replace(/^https?:\/\//, (m) => m)}`;

  try {
    const { response, finalUrl } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: SAVE_NOW_MAX_BYTES,
      timeoutMs: SAVE_NOW_TIMEOUT_MS,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'privacytracker/1.0 (+privacy-history archiver)',
      },
    });

    // Prefer the post-redirect URL, then Content-Location, else error.
    if (finalUrl && /^https:\/\/(www\.)?web\.archive\.org\/web\//.test(finalUrl)) {
      return {
        ok: true,
        snapshot: { url: finalUrl, timestamp: extractWaybackTimestamp(finalUrl) },
      };
    }

    const contentLocation = response.headers.get('content-location');
    if (contentLocation && contentLocation.startsWith('/web/')) {
      const built = `https://web.archive.org${contentLocation}`;
      return {
        ok: true,
        snapshot: { url: built, timestamp: extractWaybackTimestamp(built) },
      };
    }

    // 200 with no snapshot URL: Apple served a 429/503 Wayback declined to
    // archive, or the job is still queueing.
    return {
      ok: false,
      error: `Save Page Now returned ${response.status} without a snapshot URL`,
    };
  } catch (error) {
    // Timeouts, DNS/TLS failures, or maxBytes cap all land here.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || 'save now request failed' };
  }
}

function extractWaybackTimestamp(url: string): string | undefined {
  const match = url.match(/\/web\/(\d{4,14})\//);
  return match?.[1];
}

/**
 * Variant of lookupLatestWaybackSnapshot that asks for the snapshot closest
 * to a specific target timestamp. Used by the historical-import flow.
 * No tolerance window — callers compare the returned timestamp themselves.
 */
export async function lookupWaybackSnapshotNear(
  targetUrl: string,
  targetDate: Date,
): Promise<WaybackSnapshot | null> {
  if (!targetUrl) return null;

  const timestamp = formatWaybackTimestamp(targetDate);
  const endpoint =
    `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}&timestamp=${timestamp}`;
  try {
    const { body } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: AVAILABILITY_MAX_BYTES,
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'privacytracker/1.0 (+privacy-history archiver)',
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }

    const closest = (parsed as {
      archived_snapshots?: { closest?: { url?: unknown; timestamp?: unknown; available?: unknown } };
    })?.archived_snapshots?.closest;

    if (!closest) return null;
    if (closest.available === false) return null;
    if (typeof closest.url !== 'string' || !closest.url.startsWith('http')) {
      return null;
    }

    return {
      url: closest.url,
      timestamp: typeof closest.timestamp === 'string' ? closest.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

/** Convert a Date to YYYYMMDD (UTC) for the availability API. */
function formatWaybackTimestamp(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Parse a Wayback `YYYYMMDDhhmmss` (or any left-anchored prefix) into epoch-ms.
 * Returns null on malformed input. Short forms are padded to midday UTC so
 * the parse doesn't slide a day across timezones.
 */
export function parseWaybackTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const padded = (raw + '120000000000').slice(0, 14);
  const match = padded.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    parseInt(s, 10),
  );
  return Number.isFinite(ms) ? ms : null;
}
