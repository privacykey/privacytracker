export const dynamic = "force-dynamic";
// 24 h — matches the hit-side TTL below so Next won't re-invoke us if a
// cached response is still good. We still set explicit Cache-Control on
// the Response so browsers and any upstream CDN cache it too.
export const revalidate = 86_400;

import { NextResponse } from "next/server";
import { safeFetch, validateExternalUrl } from "../../../lib/security";

/**
 * GET /api/favicon?host=<hostname>
 *
 * Server-side favicon proxy. Fetches `https://HOST/favicon.ico` (or the icon
 * declared by `<link rel="icon">` on the site's HTML root) through safeFetch
 * so the request is SSRF-bounded and size-capped. Returns the image bytes
 * with the upstream Content-Type, or a 404 with an empty body if the site
 * does not expose a reachable favicon.
 *
 * We keep this behind an origin of our own (rather than pointing <img> at
 * the remote favicon directly) for three reasons:
 *   1. Privacy — the user's browser never pings third-party hosts just
 *      because a Manual Apps page is open. This app is a privacy auditor;
 *      leaking referrer to every source-URL host would be embarrassing.
 *   2. Reliability — many favicons 404 or lock behind hot-linking rules.
 *      We do the HTML fallback path server-side so the client stays simple.
 *   3. Caching — an in-memory TTL keeps repeat lookups ~O(ms), and long
 *      browser-side Cache-Control means a given manual-apps page only
 *      triggers one round-trip per host per day.
 *
 * Cache policy:
 *   - Hits: 24 h TTL, served with `Cache-Control: public, max-age=86400`.
 *   - Misses: 1 h TTL, served as `404` with a short max-age so broken hosts
 *     don't hammer us every render.
 */

interface CacheEntry {
  body: Buffer | null;
  contentType: string;
  expiresAt: number;
  kind: "hit" | "miss";
}

const CACHE = new Map<string, CacheEntry>();
const HIT_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 60 * 60_000;

// Sane upper bound on favicon size. Most favicons are <10 KiB; anything
// bigger is almost certainly the wrong asset (a hero image, PDF, etc.).
const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

// Outbound timeout — favicons are usually served fast; if a host is slow
// we'd rather render a fallback glyph than block the Manual Apps page.
const FETCH_TIMEOUT_MS = 4000;

// Prune the cache if it gets unreasonably large. Simple LRU-ish behaviour:
// drop the oldest entry when we're over the cap.
const CACHE_CAP = 512;

function rememberHit(
  host: string,
  body: Buffer,
  contentType: string
): CacheEntry {
  const entry: CacheEntry = {
    expiresAt: Date.now() + HIT_TTL_MS,
    kind: "hit",
    body,
    contentType,
  };
  CACHE.set(host, entry);
  enforceCap();
  return entry;
}

function rememberMiss(host: string): CacheEntry {
  const entry: CacheEntry = {
    expiresAt: Date.now() + MISS_TTL_MS,
    kind: "miss",
    body: null,
    contentType: "",
  };
  CACHE.set(host, entry);
  enforceCap();
  return entry;
}

function enforceCap(): void {
  if (CACHE.size <= CACHE_CAP) {
    return;
  }
  // Drop oldest half so we don't thrash on every insert once full.
  const drop = Math.ceil(CACHE.size / 2);
  let i = 0;
  for (const key of CACHE.keys()) {
    CACHE.delete(key);
    i += 1;
    if (i >= drop) {
      break;
    }
  }
}

function lookup(host: string): CacheEntry | null {
  const entry = CACHE.get(host);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    CACHE.delete(host);
    return null;
  }
  return entry;
}

/**
 * Normalise the `host` query param. The route accepts either a bare
 * hostname ("example.com") or a full URL; we strip everything except the
 * host and reject anything that looks like a private address via
 * `validateExternalUrl`.
 */
function resolveHost(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  // If the caller passed a full URL, parse it and extract `.host` (includes
  // port when non-standard). Otherwise wrap the bare host in https:// so
  // validateExternalUrl has something to work with.
  let probeUrl: string;
  if (trimmed.includes("://")) {
    probeUrl = trimmed;
  } else if (trimmed.startsWith("//")) {
    probeUrl = `https:${trimmed}`;
  } else {
    probeUrl = `https://${trimmed}`;
  }

  const verdict = validateExternalUrl(probeUrl, { maxLength: 2048 });
  if (!(verdict.ok && verdict.url)) {
    return null;
  }
  if (verdict.url.protocol !== "https:" && verdict.url.protocol !== "http:") {
    return null;
  }
  return verdict.url.host;
}

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const REL_ATTR_RE = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Scan an HTML root document for an icon declaration. Returns the resolved
 * absolute URL of the best candidate, or null if none found. We do this
 * without a full HTML parser because we only need `<link rel="icon">` and
 * friends — a regex scan is fine for that.
 */
function extractIconFromHtml(html: string, baseUrl: string): string | null {
  // Preferred rel values, in order of preference. "icon" beats
  // "shortcut icon" (most sites declare both), which beats apple-touch-icon
  // (larger / PNG — still usable).
  const preference: Record<string, number> = {
    icon: 3,
    "shortcut icon": 2,
    "apple-touch-icon": 1,
    "apple-touch-icon-precomposed": 1,
  };

  let best: { score: number; href: string } | null = null;

  const matches = html.match(LINK_TAG_RE);
  if (!matches) {
    return null;
  }
  for (const tag of matches) {
    const relMatch = tag.match(REL_ATTR_RE);
    const hrefMatch = tag.match(HREF_ATTR_RE);
    if (!(relMatch && hrefMatch)) {
      continue;
    }
    const rel = (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? "")
      .trim()
      .toLowerCase();
    const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
    if (!(rel && href)) {
      continue;
    }
    const score = preference[rel] ?? 0;
    if (score === 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { score, href };
    }
  }

  if (!best) {
    return null;
  }
  try {
    return new URL(best.href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch the site root and try to extract the icon URL. Returns null on
 * failure — we fall back to /favicon.ico in that case.
 */
async function discoverIconUrl(host: string): Promise<string | null> {
  const rootUrl = `https://${host}/`;
  try {
    const { body, response, finalUrl } = await safeFetch(rootUrl, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_HTML_BYTES,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 privacytracker-favicon/1.0" },
    });
    if (!response.ok) {
      return null;
    }
    const text = body.toString("utf8");
    return extractIconFromHtml(text, finalUrl);
  } catch {
    return null;
  }
}

/**
 * Fetch an icon URL and return the bytes + content type, or null on
 * failure. Validates the Content-Type looks image-ish so we don't serve a
 * 200-OK HTML "nope" page as an image.
 */
async function fetchIconBytes(
  iconUrl: string
): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const { body, response } = await safeFetch(iconUrl, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_FAVICON_BYTES,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 privacytracker-favicon/1.0" },
    });
    if (!response.ok || body.byteLength === 0) {
      return null;
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    // Accept anything that claims to be an image, or the common "icon" MIME.
    const isImage =
      contentType.startsWith("image/") ||
      contentType === "application/ico" ||
      contentType === "application/x-ico";
    // Some servers return the correct bytes with a bogus or empty
    // Content-Type. As a last-resort check, accept anything that looks
    // binary (first byte is non-ASCII) to avoid 404-ing on those hosts.
    const looksBinary = body.byteLength > 0 && body[0] > 0x7f;
    if (!(isImage || looksBinary)) {
      return null;
    }
    // Fall back to image/x-icon when the upstream type is missing/bogus —
    // `/favicon.ico` is the conventional path and .ico is the classic MIME.
    const safeContentType =
      contentType && isImage ? contentType : "image/x-icon";
    return { body, contentType: safeContentType };
  } catch {
    return null;
  }
}

function hitResponse(entry: CacheEntry): NextResponse {
  // NextResponse's constructor types (in the DOM lib shipped with TS 6) don't
  // accept Node Buffer or typed-array views whose .buffer is ArrayBufferLike.
  // We copy the bytes into a fresh ArrayBuffer so the resulting Uint8Array is
  // unambiguously a BlobPart under the stricter typings.
  const contentType = entry.contentType || "image/x-icon";
  let payload: Blob;
  if (entry.body && entry.body.byteLength > 0) {
    const bytes = new Uint8Array(entry.body.byteLength);
    bytes.set(entry.body);
    payload = new Blob([bytes], { type: contentType });
  } else {
    payload = new Blob([], { type: contentType });
  }
  return new NextResponse(payload, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Favicon-Cache": "HIT",
    },
  });
}

function missResponse(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "X-Favicon-Cache": "MISS",
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const host = resolveHost(url.searchParams.get("host"));
  if (!host) {
    return new NextResponse(null, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const cached = lookup(host);
  if (cached) {
    return cached.kind === "hit" ? hitResponse(cached) : missResponse();
  }

  // Strategy: try /favicon.ico first (cheapest, most sites have one), then
  // fall back to the site root HTML parse. The other order would work too,
  // but this way a healthy site gets answered with a single round-trip.
  const directUrl = `https://${host}/favicon.ico`;
  let icon = await fetchIconBytes(directUrl);

  if (!icon) {
    const discovered = await discoverIconUrl(host);
    if (discovered) {
      icon = await fetchIconBytes(discovered);
    }
  }

  if (!icon) {
    rememberMiss(host);
    return missResponse();
  }

  const entry = rememberHit(host, icon.body, icon.contentType);
  return hitResponse(entry);
}
