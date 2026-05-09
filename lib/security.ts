/**
 * Central security utilities for the privacytracker.
 *
 * Scope: URL validation (SSRF), safe-fetch wrapper (size + time caps),
 * per-IP rate limiting, CSRF origin-check helper, audit logging, and a
 * shared-secret admin gate for destructive and externally reachable endpoints.
 *
 * Design notes:
 * - The app is a local-first, single-user, self-hosted tool (SQLite file,
 *   docker-compose bind mount). Rather than bolt on full authentication,
 *   we defend with (a) network binding to 127.0.0.1 by default, (b) a
 *   Origin/Referer CSRF check on mutating requests so malicious sites can't
 *   drive a user's browser against localhost:3000, and (c) an optional
 *   AUDITOR_ADMIN_TOKEN env var for guarded endpoints. If unset, the CSRF
 *   check alone is the gate for localhost binding, while LAN/domain hosts
 *   require the token before guarded API actions proceed.
 * - All outbound fetches that touch user-influenced URLs must go through
 *   `safeFetch` so response size and timeout are bounded and private IPs
 *   are rejected (defence against SSRF via DNS rebinding — see note below).
 */

import crypto from 'crypto';
import { promises as dns } from 'dns';
import db from './db';

// ─────────────────────────────────────────────
// URL validation
// ─────────────────────────────────────────────

export type UrlValidationError =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'private_host'
  | 'host_not_allowed'
  | 'too_long';

export interface UrlValidationResult {
  ok: boolean;
  error?: UrlValidationError;
  detail?: string;
  url?: URL;
}

/**
 * Hosts/IPs we NEVER let user-supplied URLs resolve to. Covers loopback,
 * link-local (including AWS/GCP/DO metadata), RFC-1918, CGNAT, unique-local
 * v6, multicast, and a few common docker-compose service names.
 *
 * Order matters: hostnames are normalised to lowercase and matched both
 * literally (exact equality) and via the private-IP checker below.
 */
const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Cloud metadata endpoints. These stay blocked even when a call site opts in
 * to `allowPrivateHosts` (see `validateExternalUrl`). The link-local 169.254/16
 * range is where AWS IMDS, GCP metadata, Azure IMDS, and DigitalOcean metadata
 * all live — reading from them leaks IAM credentials / user-data, which is the
 * single most valuable SSRF target on a cloud host. There is no legitimate
 * reason for the AI base URL (or any user-configured URL) to hit these.
 */
const METADATA_HOSTNAMES = new Set<string>([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase();
  if (METADATA_HOSTNAMES.has(h)) return true;
  // IPv4 literals: anything in 169.254.0.0/16 counts as metadata-adjacent
  // (IMDS lives at 169.254.169.254; ECS task metadata at 169.254.170.2).
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 169 && b === 254) return true;
  }
  // IPv6 metadata: AWS uses fd00:ec2::254 and GCP/Azure use fe80::a9fe:a9fe-ish
  // link-local. Blocking anything in fe80::/10 here is conservative but cheap.
  if (h.includes(':')) {
    const stripped = h.replace(/^\[|\]$/g, '');
    if (stripped.startsWith('fd00:ec2')) return true;
    if (/^fe[89ab]/.test(stripped)) return true;
  }
  return false;
}

export function isPrivateIpv4(hostname: string): boolean {
  // Plain dotted quad check; doesn't cover integer/octal/mixed forms which we
  // reject up front by requiring strict dotted-quad shape.
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some(o => o < 0 || o > 255)) return true; // reject malformed

  const [a, b] = octets;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (link-local incl. 169.254.169.254),
  // 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT), 224.0.0.0/4 (multicast)
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateIpv6(hostname: string): boolean {
  // Strip brackets Node may leave on URL.hostname for IPv6.
  const stripped = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!stripped.includes(':')) return false;
  if (stripped === '::' || stripped === '::1') return true;
  // fc00::/7 (unique-local), fe80::/10 (link-local), ff00::/8 (multicast),
  // ::ffff:0:0/96 (IPv4-mapped — let isPrivateIpv4 handle the mapped part).
  if (/^fc|^fd/.test(stripped)) return true;
  if (/^fe[89ab]/.test(stripped)) return true;
  if (/^ff/.test(stripped)) return true;
  if (stripped.startsWith('::ffff:')) {
    const mapped = stripped.slice('::ffff:'.length);
    return isPrivateIpv4(mapped);
  }
  return false;
}

/**
 * Validate a URL is safe to fetch from the server. Rejects non-http(s)
 * schemes, private/loopback hostnames, and (when strict=true) any literal IP.
 *
 * NOTE: This is a *syntactic* check on the URL the caller supplies. A
 * hostname that resolves to a private IP at lookup time (DNS rebinding) is
 * not blocked here — `safeFetch` does a resolving check when
 * `resolveAndCheck: true` is passed.
 *
 * `allowPrivateHosts` is an escape hatch for call sites where hitting a
 * loopback or RFC-1918 address is a legitimate use case — specifically, the
 * AI base URL, so users can point at Ollama on localhost or a self-hosted
 * inference server on their LAN. Even in this mode we still block cloud
 * metadata endpoints (169.254.0.0/16, GCP/AWS/Azure metadata hostnames),
 * because those are the high-value SSRF targets and have no legitimate
 * overlap with a user-configured AI endpoint.
 */
export function validateExternalUrl(
  raw: unknown,
  opts: { allowedHosts?: string[]; maxLength?: number; allowPrivateHosts?: boolean } = {},
): UrlValidationResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'invalid_url', detail: 'URL is empty or not a string' };
  }

  const maxLength = opts.maxLength ?? 2048;
  if (raw.length > maxLength) {
    return { ok: false, error: 'too_long', detail: `URL exceeds ${maxLength} chars` };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_url', detail: 'Not a parseable URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'unsupported_protocol',
      detail: `Only http(s) URLs are accepted (got ${parsed.protocol || 'unknown'})`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { ok: false, error: 'invalid_url', detail: 'URL has no hostname' };
  }

  // Metadata endpoints are always blocked — even for callers that opt in to
  // `allowPrivateHosts`. IMDS credential theft is the single worst SSRF
  // outcome on a cloud host, so we keep the gate closed unconditionally.
  if (isMetadataHost(host)) {
    return { ok: false, error: 'private_host', detail: `Metadata host ${host} is always blocked` };
  }

  if (!opts.allowPrivateHosts) {
    if (BLOCKED_HOSTNAMES.has(host)) {
      return { ok: false, error: 'private_host', detail: `Hostname ${host} is blocked` };
    }

    if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
      return { ok: false, error: 'private_host', detail: `Hostname ${host} is a private/loopback IP` };
    }
  }

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.some(pattern => hostMatches(host, pattern));
    if (!allowed) {
      return {
        ok: false,
        error: 'host_not_allowed',
        detail: `Hostname ${host} is not on the allowlist`,
      };
    }
  }

  return { ok: true, url: parsed };
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === p;
}

/**
 * Resolve a hostname to all of its A / AAAA records and confirm none of them
 * land in a private range. Used by `safeFetch({ resolveAndCheck: true })` to
 * close the DNS-rebinding gap that a syntactic URL check cannot catch.
 */
export async function hostResolvesToPublic(hostname: string): Promise<boolean> {
  // IP literals: we already validated upstream.
  const host = hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIpv4(host);
  if (host.includes(':')) return !isPrivateIpv6(host);

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return false;
    for (const record of records) {
      if (record.family === 4 && isPrivateIpv4(record.address)) return false;
      if (record.family === 6 && isPrivateIpv6(record.address)) return false;
    }
    return true;
  } catch {
    // DNS failure: surface upstream rather than silently allow.
    return false;
  }
}

// ─────────────────────────────────────────────
// safeFetch — bounded replacement for fetch()
// ─────────────────────────────────────────────

export interface SafeFetchOptions {
  allowedHosts?: string[];
  /** Max response body size in bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Timeout in ms. Default 15 000. */
  timeoutMs?: number;
  /** Strictly verify the hostname doesn't resolve to a private IP. */
  resolveAndCheck?: boolean;
  /** Headers to add. Note: fetch already supplies the defaults. */
  headers?: Record<string, string>;
  /** 'follow' (default) | 'error' | 'manual'. */
  redirect?: RequestRedirect;
  /** Hard cap on the number of redirects when redirect is 'follow'. */
  maxRedirects?: number;
  /**
   * Permit loopback / RFC-1918 hosts. Metadata endpoints remain blocked.
   * Only set this for calls that legitimately target a user's self-hosted
   * service (e.g. local Ollama for AI).
   */
  allowPrivateHosts?: boolean;
}

/**
 * Bounded server-side fetch. Rejects private/loopback targets, caps both
 * response bytes and wall time, and optionally resolves DNS to guard against
 * rebinding. Returns the Response plus the bounded body (read once; the body
 * stream is consumed by the time this resolves).
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<{ response: Response; body: Buffer; finalUrl: string }> {
  const validation = validateExternalUrl(rawUrl, {
    allowedHosts: options.allowedHosts,
    allowPrivateHosts: options.allowPrivateHosts,
  });
  if (!validation.ok || !validation.url) {
    throw new Error(`Blocked URL: ${validation.error ?? 'invalid_url'} — ${validation.detail ?? rawUrl}`);
  }

  const url = validation.url;

  // DNS-rebinding guard: skipped when the caller has opted into private hosts,
  // because the whole point of that mode is to allow private resolutions.
  if (options.resolveAndCheck && !options.allowPrivateHosts) {
    const ok = await hostResolvesToPublic(url.hostname);
    if (!ok) {
      throw new Error(`Blocked URL: host ${url.hostname} did not resolve to a public address`);
    }
  }

  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MiB
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const redirect: RequestRedirect = options.redirect ?? 'manual';

  let currentUrl = url.toString();
  let redirectsUsed = 0;

  // We follow redirects manually so we can re-validate every hop's hostname.
  // This defends against an initial allowlisted URL 302-ing to an internal IP.
  while (true) {
    const res = await fetch(currentUrl, {
      method: 'GET',
      headers: options.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (redirect === 'follow' && res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return readBounded(res, currentUrl, maxBytes);
      }
      redirectsUsed += 1;
      if (redirectsUsed > maxRedirects) {
        throw new Error(`safeFetch: too many redirects (${redirectsUsed})`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`safeFetch: invalid redirect target: ${location}`);
      }
      const nextValidation = validateExternalUrl(nextUrl, {
        allowedHosts: options.allowedHosts,
        allowPrivateHosts: options.allowPrivateHosts,
      });
      if (!nextValidation.ok) {
        throw new Error(
          `safeFetch: redirect rejected — ${nextValidation.error}: ${nextValidation.detail}`,
        );
      }
      if (options.resolveAndCheck && !options.allowPrivateHosts) {
        const ok = await hostResolvesToPublic(nextValidation.url!.hostname);
        if (!ok) throw new Error(`safeFetch: redirect host ${nextValidation.url!.hostname} is private`);
      }
      currentUrl = nextUrl;
      continue;
    }

    return readBounded(res, currentUrl, maxBytes);
  }
}

async function readBounded(
  res: Response,
  finalUrl: string,
  maxBytes: number,
): Promise<{ response: Response; body: Buffer; finalUrl: string }> {
  // Content-Length fast-path — lets us fail without actually reading a huge body.
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `safeFetch: declared content-length ${declared} exceeds cap ${maxBytes}`,
    );
  }

  if (!res.body) {
    return { response: res, body: Buffer.alloc(0), finalUrl };
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`safeFetch: response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return { response: res, body: Buffer.concat(chunks, total), finalUrl };
}

// ─────────────────────────────────────────────
// Rate limiting — sliding-window per key
// ─────────────────────────────────────────────

interface RateLimitBucket {
  timestamps: number[];
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export interface RateLimitOptions {
  /** Unique identifier for this limit (e.g. "scrape:1.2.3.4"). */
  key: string;
  /** Max events allowed in the window. */
  limit: number;
  /** Window size in ms. */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Per-key throttle on stderr-warn frequency. Without this, a tight
 * client loop tripping the limiter would log a warning per request
 * (potentially hundreds of times a second). We log at most once per
 * key per second — enough to surface the issue in the Tauri server
 * console without drowning out other diagnostics.
 */
const rateLimitLogMutedUntil = new Map<string, number>();
const RATE_LIMIT_LOG_COOLDOWN_MS = 1000;

export function checkRateLimit({ key, limit, windowMs }: RateLimitOptions): RateLimitVerdict {
  const now = Date.now();
  const cutoff = now - windowMs;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateLimitBuckets.set(key, bucket);
  }
  // Prune oldest outside window.
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
    bucket.timestamps.shift();
  }
  if (bucket.timestamps.length >= limit) {
    const retryAfterMs = bucket.timestamps[0] + windowMs - now;
    // Surface the deny as a server-log warning so when the Tauri
    // sidecar's queue drain (or any other internal call) gets bounced
    // off /api/scrape's per-IP throttle (limit=30/min) or
    // /api/search's (limit=60/min), the log shows it instead of
    // silently failing. Without this, a stuck drain looks identical
    // to "Apple is slow" — but the cause might be our own limiter.
    //
    // Throttled to one warn per key per second (see comment on
    // rateLimitLogMutedUntil) to avoid drowning out other logs in
    // a tight retry loop.
    const muteUntil = rateLimitLogMutedUntil.get(key) ?? 0;
    if (now >= muteUntil) {
      rateLimitLogMutedUntil.set(key, now + RATE_LIMIT_LOG_COOLDOWN_MS);
      console.warn(
        `[rate-limit] DENY ${key} — ${bucket.timestamps.length}/${limit} in ` +
        `${Math.round(windowMs / 1000)}s window; retry-after ${Math.round(retryAfterMs / 1000)}s. ` +
        'This is our INTERNAL limiter (lib/security.ts), not Apple\'s 429 cooldown.',
      );
    }
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  bucket.timestamps.push(now);

  // Opportunistically garbage-collect old empty buckets.
  if (rateLimitBuckets.size > 5000) {
    for (const [k, b] of rateLimitBuckets) {
      if (b.timestamps.length === 0) rateLimitBuckets.delete(k);
    }
  }

  return {
    allowed: true,
    remaining: limit - bucket.timestamps.length,
    retryAfterMs: 0,
  };
}

export function rateLimitKeyForRequest(request: Request, prefix: string): string {
  const xff = request.headers.get('x-forwarded-for');
  const direct = request.headers.get('x-real-ip');
  const ip = (xff?.split(',')[0].trim() || direct || 'unknown').toLowerCase();
  return `${prefix}:${ip}`;
}

// ─────────────────────────────────────────────
// CSRF / Origin check
// ─────────────────────────────────────────────

/**
 * Return true when a mutating request's Origin/Referer appears to come from
 * the same site it was served from. This blocks cross-site form submissions
 * and fetch() calls from a malicious webpage the user happens to visit while
 * the localhost app is running.
 *
 * - Same-origin fetches from the UI always include an Origin header.
 * - Server-to-server callers (curl, scripts) have no Origin and are only
 *   allowed through when they carry the admin token.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    // Match on host:port equality — http vs https is acceptable because this
    // runs behind a user-managed proxy.
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Admin-token gate: the user can set AUDITOR_ADMIN_TOKEN in the environment
 * to require a header on every guarded request. Localhost-only installs may
 * rely on same-origin checks; LAN/domain hosts require the shared-secret gate.
 */
export function adminTokenConfigured(): boolean {
  return !!process.env.AUDITOR_ADMIN_TOKEN;
}

function stripHostPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0] ?? trimmed;
}

export function requestLooksNonLocal(request: Request): boolean {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host');
  if (!host) return false;
  const h = stripHostPort(host);
  return !(
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

export function adminTokenRequiredForRequest(request: Request): boolean {
  return adminTokenConfigured() || requestLooksNonLocal(request);
}

export function requestHasValidAdminToken(request: Request): boolean {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!expected) return false;
  const provided = request.headers.get('x-auditor-admin-token');
  if (!provided) return false;
  // Constant-time compare to avoid timing side-channels.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────

/**
 * Persist a short-lived audit entry. Used from destructive routes (reset,
 * delete, settings-write) so a forensic trail survives even a full DB wipe
 * up to the next reset.
 */
export function recordAudit(event: {
  action: string;
  actorIp?: string | null;
  userAgent?: string | null;
  detail?: string | null;
  success: boolean;
}): void {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, created_at, action, actor_ip, user_agent, detail, success)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      Date.now(),
      event.action.slice(0, 120),
      (event.actorIp ?? '').slice(0, 64),
      (event.userAgent ?? '').slice(0, 256),
      (event.detail ?? '').slice(0, 1024),
      event.success ? 1 : 0,
    );
  } catch (error) {
    console.error('[audit] failed to record event', event.action, error);
  }
}

export function requestActorIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  const direct = request.headers.get('x-real-ip');
  return (xff?.split(',')[0].trim() || direct || 'unknown').toLowerCase();
}

// ─────────────────────────────────────────────
// JSON body size guard
// ─────────────────────────────────────────────

/**
 * Safely read the request body with a byte cap. Throws with a clear message
 * if the body is too large. Typical cap: 256 KiB — our API takes app-name
 * lists + short URLs; nothing legitimately larger than that.
 */
export async function readBoundedJson<T = unknown>(
  request: Request,
  maxBytes = 256 * 1024,
): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Request body too large (${declared} > ${maxBytes} bytes)`);
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`Request body too large (${buf.byteLength} > ${maxBytes} bytes)`);
  }
  if (buf.byteLength === 0) {
    throw new Error('Request body is empty');
  }
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/**
 * Variant for endpoints where an empty body is valid. The same byte cap is
 * enforced before parsing, but `''` / whitespace returns the supplied fallback.
 */
export async function readOptionalBoundedJson<T = unknown>(
  request: Request,
  maxBytes = 256 * 1024,
  fallback: T,
): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Request body too large (${declared} > ${maxBytes} bytes)`);
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`Request body too large (${buf.byteLength} > ${maxBytes} bytes)`);
  }
  const text = buf.toString('utf8');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

// ─────────────────────────────────────────────
// App Store URL allowlist + policy URL sanitiser
// ─────────────────────────────────────────────

const APP_STORE_HOSTS = ['apps.apple.com', 'itunes.apple.com'];

/**
 * Accept only canonical App Store URLs. Used by /api/scrape so a client can't
 * coax the server into fetching arbitrary origins. The path must carry an
 * `/id<digits>` segment — the thing the scraper extracts as the Apple track id.
 */
export function validateAppStoreUrl(raw: unknown): UrlValidationResult {
  const base = validateExternalUrl(raw, { allowedHosts: APP_STORE_HOSTS });
  if (!base.ok || !base.url) return base;
  if (!/\/id\d+(?:\/|$|\?)/i.test(base.url.pathname)) {
    return {
      ok: false,
      error: 'invalid_url',
      detail: 'App Store URL must contain an /id<digits> segment',
    };
  }
  return base;
}

/**
 * Sanitise a privacy-policy URL before persisting it or rendering it. Accepts
 * only http(s), caps length, and returns '' for anything unsafe so the UI
 * falls back to "no privacy-policy link available" rather than rendering a
 * javascript:/data:/file: URI.
 */
export function sanitizePolicyUrl(raw: unknown): string {
  const result = validateExternalUrl(raw, { maxLength: 2048 });
  if (!result.ok || !result.url) return '';
  return result.url.toString();
}
