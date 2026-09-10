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

import { safeFetch, validateExternalUrl } from "./security";

const WAYBACK_HOSTS = ["archive.org", "web.archive.org", "www.web.archive.org"];

const AVAILABILITY_MAX_BYTES = 64 * 1024;
const AVAILABILITY_TIMEOUT_MS = 8000;
const SAVE_NOW_TIMEOUT_MS = 25_000;
/**
 * The CDX index lists every capture of a URL in one response. Daily-collapsed
 * over five years of App Store captures is a few KB; the cap is generous so a
 * heavily-archived page never truncates mid-list.
 */
const CDX_MAX_BYTES = 1024 * 1024;
const CDX_TIMEOUT_MS = 20_000;
const CDX_ROW_LIMIT = 5000;

/**
 * archive.org answered but refused to serve — rate-limited (429) or a 5xx.
 * Distinct from "no capture" so callers can back off instead of treating a
 * throttled probe as an empty quarter. `retryAfterMs` mirrors the
 * `Retry-After` header when present.
 */
export class WaybackUnavailableError extends Error {
  readonly retryAfterMs: number | null;
  readonly status: number;

  constructor(status: number, retryAfterMs: number | null, endpoint: string) {
    const label =
      status === 429 ? "rate-limited" : `unavailable (HTTP ${status})`;
    const retry =
      retryAfterMs == null
        ? ""
        : ` — retry after ${Math.ceil(retryAfterMs / 1000)}s`;
    super(`archive.org ${label} for ${endpoint}${retry}`);
    this.name = "WaybackUnavailableError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isWaybackUnavailableError(
  error: unknown
): error is WaybackUnavailableError {
  return error instanceof WaybackUnavailableError;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return null;
}

/**
 * Throw for responses that mean "archive.org is refusing us right now".
 * Anything else (200, 404, 3xx that safeFetch already followed) is left to
 * the caller's parser, which returns null for payloads without a capture.
 */
function throwIfUnavailable(response: Response, endpoint: string): void {
  if (response.status === 429 || response.status >= 500) {
    throw new WaybackUnavailableError(
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      endpoint
    );
  }
}

export interface WaybackSnapshot {
  /** Archive capture timestamp in YYYYMMDDhhmmss form, if available. */
  timestamp?: string;
  /** Full URL to the archived page on web.archive.org. */
  url: string;
}

/**
 * Discriminated result for submitToWaybackSaveNow. Callers can check
 * `result.ok` for success or read `result.error` to surface a failure reason.
 */
export type WaybackSaveResult =
  | { ok: true; snapshot: WaybackSnapshot }
  | { ok: false; error: string };

interface WaybackRequestOptions {
  signal?: AbortSignal;
}

/**
 * Query the availability API for the latest snapshot of `targetUrl`. Returns
 * null when archive.org is unreachable, the JSON is malformed, or no
 * snapshot exists.
 */
export async function lookupLatestWaybackSnapshot(
  targetUrl: string,
  options: WaybackRequestOptions = {}
): Promise<WaybackSnapshot | null> {
  if (!targetUrl) {
    return null;
  }

  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;
  try {
    const { body } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: AVAILABILITY_MAX_BYTES,
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      signal: options.signal,
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": "privacytracker/1.0 (+privacy-history archiver)",
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }

    const closest = (
      parsed as {
        archived_snapshots?: {
          closest?: { url?: unknown; timestamp?: unknown; available?: unknown };
        };
      }
    )?.archived_snapshots?.closest;

    if (!closest) {
      return null;
    }
    if (closest.available === false) {
      return null;
    }
    if (typeof closest.url !== "string" || !closest.url.startsWith("http")) {
      return null;
    }

    return {
      url: closest.url,
      timestamp:
        typeof closest.timestamp === "string" ? closest.timestamp : undefined,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
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
  options: WaybackRequestOptions = {}
): Promise<WaybackSaveResult> {
  if (!targetUrl) {
    return { ok: false, error: "missing target url" };
  }

  // Save Page Now accepts the full URL with scheme. The earlier
  // `.replace(/^https?:\/\//, (m) => m)` was a no-op left over from a
  // half-finished refactor (the callback returned the matched protocol
  // unchanged) — dropping it.
  const endpoint = `https://web.archive.org/save/${targetUrl}`;

  try {
    const validation = validateExternalUrl(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
    });
    if (!validation.ok) {
      return {
        ok: false,
        error: `Save Page Now URL rejected: ${validation.detail ?? validation.error ?? "invalid URL"}`,
      };
    }

    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "manual",
      signal: withTimeoutSignal(SAVE_NOW_TIMEOUT_MS, options.signal),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "privacytracker/1.0 (+privacy-history archiver)",
      },
    });
    try {
      await response.body?.cancel();
    } catch {
      // The body is intentionally ignored. Save Page Now often redirects to a
      // full archived page; downloading that page only to learn its URL can
      // trip response-size caps for large App Store pages.
    }

    const snapshot =
      snapshotFromWaybackHeader(response.headers.get("location"), endpoint) ??
      snapshotFromWaybackHeader(
        response.headers.get("content-location"),
        endpoint
      );
    if (snapshot) {
      return { ok: true, snapshot };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      return {
        ok: false,
        error: retryAfter
          ? `Save Page Now rate-limited; retry after ${retryAfter}s`
          : "Save Page Now rate-limited",
      };
    }
    if (response.status >= 400) {
      return {
        ok: false,
        error: `Save Page Now returned HTTP ${response.status}`,
      };
    }

    // 200 with no snapshot URL: Apple served a 429/503 Wayback declined to
    // archive, or the job is still queueing.
    return {
      ok: false,
      error: `Save Page Now returned ${response.status} without a snapshot URL`,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    // Timeouts, DNS/TLS failures, or maxBytes cap all land here.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || "save now request failed" };
  }
}

function extractWaybackTimestamp(url: string): string | undefined {
  const match = url.match(/\/web\/(\d{4,14})(?:[a-z_]+)?\//i);
  return match?.[1];
}

function snapshotFromWaybackHeader(
  raw: string | null,
  baseUrl: string
): WaybackSnapshot | null {
  if (!raw) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return null;
  }

  const validation = validateExternalUrl(url.toString(), {
    allowedHosts: WAYBACK_HOSTS,
  });
  if (!(validation.ok && validation.url)) {
    return null;
  }

  const resolved = validation.url;
  const host = resolved.hostname.toLowerCase();
  if (host !== "web.archive.org" && host !== "www.web.archive.org") {
    return null;
  }
  if (!/^\/web\/\d{4,14}(?:[a-z_]+)?\//i.test(resolved.pathname)) {
    return null;
  }

  const snapshotUrl = resolved.toString();
  return {
    url: snapshotUrl,
    timestamp: extractWaybackTimestamp(snapshotUrl),
  };
}

/**
 * Variant of lookupLatestWaybackSnapshot that asks for the snapshot closest
 * to a specific target timestamp. Used by the historical-import flow.
 * No tolerance window — callers compare the returned timestamp themselves.
 */
export async function lookupWaybackSnapshotNear(
  targetUrl: string,
  targetDate: Date,
  options: WaybackRequestOptions = {}
): Promise<WaybackSnapshot | null> {
  if (!targetUrl) {
    return null;
  }

  const timestamp = formatWaybackTimestamp(targetDate);
  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}&timestamp=${timestamp}`;
  try {
    const { body, response } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: AVAILABILITY_MAX_BYTES,
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      signal: options.signal,
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": "privacytracker/1.0 (+privacy-history archiver)",
      },
    });
    // A throttled or failing archive must not masquerade as "no capture" —
    // the historical importer would otherwise record an empty quarter and
    // fire Save Page Now on the strength of a 429.
    throwIfUnavailable(response, "availability API");

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }

    const closest = (
      parsed as {
        archived_snapshots?: {
          closest?: { url?: unknown; timestamp?: unknown; available?: unknown };
        };
      }
    )?.archived_snapshots?.closest;

    if (!closest) {
      return null;
    }
    if (closest.available === false) {
      return null;
    }
    if (typeof closest.url !== "string" || !closest.url.startsWith("http")) {
      return null;
    }

    return {
      url: closest.url,
      timestamp:
        typeof closest.timestamp === "string" ? closest.timestamp : undefined,
    };
  } catch (error) {
    if (isAbortError(error) || isWaybackUnavailableError(error)) {
      throw error;
    }
    return null;
  }
}

/** One capture from the CDX index. */
export interface WaybackCapture {
  /** Epoch-ms of the capture, parsed from `timestamp`. */
  ms: number;
  /** Wayback `YYYYMMDDhhmmss` capture timestamp. */
  timestamp: string;
  /** Replay URL (`https://web.archive.org/web/<ts>/<original>`). */
  url: string;
}

/**
 * List every successful (HTTP 200) capture of `targetUrl` on or after
 * `from`, oldest first, one per day. One request replaces the up-to-seven
 * availability probes per target the importer used to issue, and lets the
 * caller pick the genuinely closest capture for each target locally.
 *
 * Returns `null` when the index is unreachable or its payload is not the
 * expected array-of-arrays — callers fall back to per-target availability
 * probes. Throws {@link WaybackUnavailableError} on 429 / 5xx so a
 * throttled archive is never mistaken for an unarchived page.
 */
export async function listWaybackCaptures(
  targetUrl: string,
  options: WaybackRequestOptions & { from?: Date } = {}
): Promise<WaybackCapture[] | null> {
  if (!targetUrl) {
    return null;
  }
  const params = new URLSearchParams({
    url: targetUrl,
    output: "json",
    fl: "timestamp,statuscode",
    filter: "statuscode:200",
    collapse: "timestamp:8",
    limit: String(CDX_ROW_LIMIT),
  });
  if (options.from) {
    params.set("from", formatWaybackTimestamp(options.from));
  }
  const endpoint = `https://web.archive.org/cdx/search/cdx?${params.toString()}`;
  try {
    const { body, response } = await safeFetch(endpoint, {
      allowedHosts: WAYBACK_HOSTS,
      maxBytes: CDX_MAX_BYTES,
      timeoutMs: CDX_TIMEOUT_MS,
      signal: options.signal,
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": "privacytracker/1.0 (+privacy-history archiver)",
      },
    });
    throwIfUnavailable(response, "CDX index");
    if (response.status !== 200) {
      return null;
    }

    const text = body.toString("utf8").trim();
    // An unarchived URL yields an empty body (not an empty array).
    if (text === "") {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) {
      return null;
    }

    const captures: WaybackCapture[] = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      if (!Array.isArray(row) || typeof row[0] !== "string") {
        continue;
      }
      const timestamp = row[0];
      // Header row (`["timestamp","statuscode"]`) and anything malformed.
      if (!/^\d{14}$/.test(timestamp) || seen.has(timestamp)) {
        continue;
      }
      const ms = parseWaybackTimestampMs(timestamp);
      if (ms == null) {
        continue;
      }
      seen.add(timestamp);
      captures.push({
        timestamp,
        ms,
        url: `https://web.archive.org/web/${timestamp}/${targetUrl}`,
      });
    }
    captures.sort((a, b) => a.ms - b.ms);
    return captures;
  } catch (error) {
    if (isAbortError(error) || isWaybackUnavailableError(error)) {
      throw error;
    }
    return null;
  }
}

function withTimeoutSignal(
  timeoutMs: number,
  signal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Convert a Date to YYYYMMDD (UTC) for the availability API. */
function formatWaybackTimestamp(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Parse a Wayback `YYYYMMDDhhmmss` (or any left-anchored prefix) into epoch-ms.
 * Returns null on malformed input. Short forms are padded to midday UTC so
 * the parse doesn't slide a day across timezones.
 */
export function parseWaybackTimestampMs(
  raw: string | undefined
): number | null {
  if (!raw) {
    return null;
  }
  const padded = `${raw}120000000000`.slice(0, 14);
  const match = padded.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(
    Number.parseInt(y, 10),
    Number.parseInt(mo, 10) - 1,
    Number.parseInt(d, 10),
    Number.parseInt(h, 10),
    Number.parseInt(mi, 10),
    Number.parseInt(s, 10)
  );
  return Number.isFinite(ms) ? ms : null;
}
