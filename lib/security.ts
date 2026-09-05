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

import crypto from "node:crypto";
import { promises as dns } from "node:dns";
import db from "./db";
import { clientIpFromHeaders, isNetworkExposed } from "./deployment-trust";
import {
  isMetadataHost,
  isPrivateIpv4,
  isPrivateIpv6,
} from "./network-address";
import { outboundDispatcher } from "./outbound-dispatcher";

// ─────────────────────────────────────────────
// URL validation
// ─────────────────────────────────────────────

export type UrlValidationError =
  | "invalid_url"
  | "unsupported_protocol"
  | "private_host"
  | "host_not_allowed"
  | "too_long";

export interface UrlValidationResult {
  detail?: string;
  error?: UrlValidationError;
  ok: boolean;
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
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

/**
 * Cloud metadata endpoints. These stay blocked even when a call site opts in
 * to `allowPrivateHosts` (see `validateExternalUrl`). The link-local 169.254/16
 * range is where AWS IMDS, GCP metadata, Azure IMDS, and DigitalOcean metadata
 * all live — reading from them leaks IAM credentials / user-data, which is the
 * single most valuable SSRF target on a cloud host. There is no legitimate
 * reason for the AI base URL (or any user-configured URL) to hit these.
 */
export { isPrivateIpv4, isPrivateIpv6 } from "./network-address";

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
  opts: {
    allowedHosts?: string[];
    maxLength?: number;
    allowPrivateHosts?: boolean;
  } = {}
): UrlValidationResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      error: "invalid_url",
      detail: "URL is empty or not a string",
    };
  }

  const maxLength = opts.maxLength ?? 2048;
  if (raw.length > maxLength) {
    return {
      ok: false,
      error: "too_long",
      detail: `URL exceeds ${maxLength} chars`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url", detail: "Not a parseable URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "unsupported_protocol",
      detail: `Only http(s) URLs are accepted (got ${parsed.protocol || "unknown"})`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: "invalid_url",
      detail: "URL credentials are not supported",
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) {
    return { ok: false, error: "invalid_url", detail: "URL has no hostname" };
  }

  // Metadata endpoints are always blocked — even for callers that opt in to
  // `allowPrivateHosts`. IMDS credential theft is the single worst SSRF
  // outcome on a cloud host, so we keep the gate closed unconditionally.
  if (isMetadataHost(host)) {
    return {
      ok: false,
      error: "private_host",
      detail: `Metadata host ${host} is always blocked`,
    };
  }

  if (!opts.allowPrivateHosts) {
    if (BLOCKED_HOSTNAMES.has(host)) {
      return {
        ok: false,
        error: "private_host",
        detail: `Hostname ${host} is blocked`,
      };
    }

    if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
      return {
        ok: false,
        error: "private_host",
        detail: `Hostname ${host} is a private/loopback IP`,
      };
    }
  }

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.some((pattern) =>
      hostMatches(host, pattern)
    );
    if (!allowed) {
      return {
        ok: false,
        error: "host_not_allowed",
        detail: `Hostname ${host} is not on the allowlist`,
      };
    }
  }

  return { ok: true, url: parsed };
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
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
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return !isPrivateIpv4(host);
  }
  if (host.includes(":")) {
    return !isPrivateIpv6(host);
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      return false;
    }
    for (const record of records) {
      if (record.family === 4 && isPrivateIpv4(record.address)) {
        return false;
      }
      if (record.family === 6 && isPrivateIpv6(record.address)) {
        return false;
      }
    }
    return true;
  } catch {
    // DNS failure: surface upstream rather than silently allow.
    return false;
  }
}

/**
 * Resolve a hostname and report whether ANY of its A / AAAA records lands on a
 * cloud-metadata endpoint (169.254.0.0/16, fd00:ec2::/…, fe80::/10, or the
 * named metadata hosts). Used by `safeFetch` to keep the metadata gate closed
 * even in `allowPrivateHosts` mode, where the public-resolve check is skipped:
 * a hostname that DNS-rebinds to 169.254.169.254 is the one private target we
 * refuse regardless of the allow-private opt-in.
 */
export async function hostResolvesToMetadata(
  hostname: string
): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IP literals (and the named metadata hostnames) are decided synchronously.
  if (isMetadataHost(host)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return false;
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.some((record) => isMetadataHost(record.address));
  } catch {
    // DNS failure: not provably metadata. The subsequent fetch will surface
    // the resolution error; we don't mislabel an outage as an attack.
    return false;
  }
}

/**
 * Shared resolve-time gate for `safeFetch`. Public-only callers must resolve
 * to a public address; private-allowed callers (Ollama/LAN) skip that but are
 * still blocked from any hostname that resolves to a cloud-metadata IP.
 * Throws with a descriptive message when the resolved target is disallowed.
 */
async function assertResolvedHostAllowed(
  hostname: string,
  allowPrivateHosts: boolean | undefined
): Promise<void> {
  if (allowPrivateHosts) {
    if (await hostResolvesToMetadata(hostname)) {
      throw new Error(
        `Blocked URL: host ${hostname} resolves to a cloud-metadata endpoint`
      );
    }
    return;
  }
  if (!(await hostResolvesToPublic(hostname))) {
    throw new Error(
      `Blocked URL: host ${hostname} did not resolve to a public address`
    );
  }
}

function defaultResolveAndCheck(): boolean {
  return !(
    process.env.NEXT_PHASE === "phase-test" &&
    process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS === "1"
  );
}

// ─────────────────────────────────────────────
// safeFetch — bounded replacement for fetch()
// ─────────────────────────────────────────────

export interface SafeFetchOptions {
  allowedHosts?: string[];
  /**
   * Permit loopback / RFC-1918 hosts. Metadata endpoints remain blocked.
   * Only set this for calls that legitimately target a user's self-hosted
   * service (e.g. local Ollama for AI).
   *
   * NOTE: even in this mode a hostname that *resolves* to a cloud-metadata
   * IP (169.254.0.0/16 et al) is still rejected — see the metadata-resolve
   * check below. allowPrivateHosts opens loopback/LAN, never IMDS.
   */
  allowPrivateHosts?: boolean;
  /**
   * Request body for non-GET methods. Only ever sent on the initial
   * request: webhook callers pair this with `redirect: 'manual'`, so the
   * body is never replayed to a redirect target. Don't combine a one-shot
   * (stream) body with `redirect: 'follow'`.
   */
  body?: BodyInit;
  /** Headers to add. Note: fetch already supplies the defaults. */
  headers?: Record<string, string>;
  /** Max response body size in bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Hard cap on the number of redirects when redirect is 'follow'. */
  maxRedirects?: number;
  /**
   * Max URL length in characters. Default 2048 — covers every UI-driven
   * scrape we do but isn't enough for the iTunes bulk-lookup endpoint
   * where 200 comma-joined bundle IDs blow past it. Callers that need
   * a longer cap pass it through explicitly.
   */
  maxUrlLength?: number;
  /** HTTP method. Default 'GET'. Webhook delivery passes 'POST'. */
  method?: string;
  /** 'follow' (default) | 'error' | 'manual'. */
  redirect?: RequestRedirect;
  /** Force real DNS checks in tests. Production checks cannot be disabled. */
  resolveAndCheck?: boolean;
  /** Optional caller-controlled abort signal, composed with the timeout. */
  signal?: AbortSignal;
  /** Timeout in ms. Default 15 000. */
  timeoutMs?: number;
}

/**
 * Bounded server-side fetch. Rejects private/loopback targets, caps both
 * response bytes and wall time, and optionally resolves DNS to guard against
 * rebinding. Returns the Response plus the bounded body (read once; the body
 * stream is consumed by the time this resolves).
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<{ response: Response; body: Buffer; finalUrl: string }> {
  const validation = validateExternalUrl(rawUrl, {
    allowedHosts: options.allowedHosts,
    allowPrivateHosts: options.allowPrivateHosts,
    maxLength: options.maxUrlLength,
  });
  if (!(validation.ok && validation.url)) {
    throw new Error(
      `Blocked URL: ${validation.error ?? "invalid_url"} — ${validation.detail ?? rawUrl}`
    );
  }

  const url = validation.url;

  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MiB
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const redirect: RequestRedirect = options.redirect ?? "manual";
  const signal = withTimeoutSignal(timeoutMs, options.signal);

  // Every hop is validated again by safeFetchStream, including its socket DNS.
  let currentUrl: URL = url;
  let redirectsUsed = 0;
  let currentHeaders = options.headers;

  // We follow redirects manually so we can re-validate every hop's hostname.
  // This defends against an initial allowlisted URL 302-ing to an internal IP.
  while (true) {
    const res = await safeFetchStream(currentUrl.toString(), {
      ...options,
      headers: currentHeaders,
      redirect: "manual",
      signal,
    });

    if (redirect === "follow" && res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return readBounded(res, currentUrl.toString(), maxBytes);
      }
      await res.body?.cancel();
      redirectsUsed += 1;
      if (redirectsUsed > maxRedirects) {
        throw new Error(`safeFetch: too many redirects (${redirectsUsed})`);
      }
      let nextCandidate: URL;
      try {
        nextCandidate = new URL(location, currentUrl);
      } catch {
        throw new Error(`safeFetch: invalid redirect target: ${location}`);
      }
      const nextValidation = validateExternalUrl(nextCandidate.toString(), {
        allowedHosts: options.allowedHosts,
        allowPrivateHosts: options.allowPrivateHosts,
        maxLength: options.maxUrlLength,
      });
      if (!(nextValidation.ok && nextValidation.url)) {
        throw new Error(
          `safeFetch: redirect rejected — ${nextValidation.error}: ${nextValidation.detail}`
        );
      }
      const nextValidatedUrl = nextValidation.url;
      if (nextValidatedUrl.origin !== currentUrl.origin) {
        if (options.body != null) {
          throw new Error("Refusing cross-origin redirect with a request body");
        }
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders ?? {}).filter(
            ([key]) =>
              !["authorization", "cookie", "proxy-authorization"].includes(
                key.toLowerCase()
              )
          )
        );
      }
      currentUrl = nextValidatedUrl;
      continue;
    }

    if (
      redirect === "error" &&
      res.status >= 300 &&
      res.status < 400 &&
      res.headers.has("location")
    ) {
      await res.body?.cancel();
      throw new Error("Redirect not permitted");
    }
    return readBounded(res, currentUrl.toString(), maxBytes);
  }
}

/** URL/DNS preflight only. Network callers must use safeFetch or safeFetchStream. */
export async function assertUrlSafeToFetch(
  rawUrl: string,
  options: {
    allowedHosts?: string[];
    allowPrivateHosts?: boolean;
    maxLength?: number;
    resolveAndCheck?: boolean;
  } = {}
): Promise<URL> {
  const validation = validateExternalUrl(rawUrl, {
    allowedHosts: options.allowedHosts,
    allowPrivateHosts: options.allowPrivateHosts,
    maxLength: options.maxLength,
  });
  if (!(validation.ok && validation.url)) {
    throw new Error(
      `Blocked URL: ${validation.error ?? "invalid_url"} — ${validation.detail ?? rawUrl}`
    );
  }
  const resolveAndCheck =
    options.resolveAndCheck === true || defaultResolveAndCheck();
  if (resolveAndCheck) {
    await assertResolvedHostAllowed(
      validation.url.hostname,
      options.allowPrivateHosts
    );
  }
  return validation.url;
}

/**
 * Streaming fetch with the same URL policy and a policy-specific dispatcher.
 * The socket lookup validates the actual addresses supplied to Node's connector,
 * so a DNS change after preflight cannot redirect traffic into the LAN/metadata.
 * Keeps the original hostname for HTTP Host and TLS SNI/certificate validation.
 * The caller must consume or cancel the response body. Automatic redirects are
 * forbidden here; safeFetch validates and bounds each redirect itself.
 */
export async function safeFetchStream(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  if (options.redirect === "follow") {
    throw new Error("Streaming fetch cannot follow redirects");
  }
  const signal = withTimeoutSignal(options.timeoutMs ?? 15_000, options.signal);
  const url = await abortable(
    assertUrlSafeToFetch(rawUrl, {
      allowedHosts: options.allowedHosts,
      allowPrivateHosts: options.allowPrivateHosts,
      maxLength: options.maxUrlLength,
      resolveAndCheck: options.resolveAndCheck,
    }),
    signal
  );
  const checkDns = options.resolveAndCheck === true || defaultResolveAndCheck();
  const init = {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    redirect: options.redirect ?? "manual",
    signal,
    ...(checkDns
      ? { dispatcher: outboundDispatcher(options.allowPrivateHosts === true) }
      : {}),
  };
  return fetch(url, init);
}

async function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function withTimeoutSignal(
  timeoutMs: number,
  signal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readBounded(
  res: Response,
  finalUrl: string,
  maxBytes: number
): Promise<{ response: Response; body: Buffer; finalUrl: string }> {
  // Content-Length fast-path — lets us fail without actually reading a huge body.
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(
      `safeFetch: declared content-length ${declared} exceeds cap ${maxBytes}`
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
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
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

export function checkRateLimit({
  key,
  limit,
  windowMs,
}: RateLimitOptions): RateLimitVerdict {
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
          "This is our INTERNAL limiter (lib/security.ts), not Apple's 429 cooldown."
      );
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, retryAfterMs),
    };
  }
  bucket.timestamps.push(now);

  // Opportunistically garbage-collect old empty buckets.
  if (rateLimitBuckets.size > 5000) {
    for (const [k, b] of rateLimitBuckets) {
      if (b.timestamps.length === 0) {
        rateLimitBuckets.delete(k);
      }
    }
  }

  return {
    allowed: true,
    remaining: limit - bucket.timestamps.length,
    retryAfterMs: 0,
  };
}

export function rateLimitKeyForRequest(
  request: Request,
  prefix: string
): string {
  // Only honour forwarded headers behind a configured trusted proxy; otherwise
  // they're attacker-controlled. Without one, the suffix collapses to a shared
  // "local" constant so X-Forwarded-For rotation cannot multiply buckets. The
  // `prefix` still namespaces each route, so routes stay isolated from one
  // another even when they share the "local" suffix.
  const ip = clientIpFromHeaders(request.headers) ?? "local";
  return `${prefix}:${ip}`;
}

// ─────────────────────────────────────────────
// Global login brute-force backstop
// ─────────────────────────────────────────────

/**
 * The per-IP login limiter (5/min) collapses to a single shared bucket when no
 * trusted proxy is configured (X-Forwarded-For is untrusted), so a spoofed-IP
 * attacker cannot multiply buckets — but a shared bucket the attacker can also
 * fill could starve the operator. This absolute, IP-independent counter is the
 * backstop: a temporary cooldown trips after LOGIN_GLOBAL_FAILURE_LIMIT FAILED
 * attempts inside the window, bounding total brute-force tries regardless of
 * how the IP key is spoofed.
 *
 * Lockout-DoS safety: only FAILED attempts are counted, and the login route
 * lets a request already carrying a valid cookie through before consulting
 * this — so a successful operator login is never blocked and an attacker
 * tripping the counter inflicts only a temporary, self-healing cooldown, never
 * a permanent lockout.
 */
const LOGIN_GLOBAL_FAILURE_LIMIT = 100;
const LOGIN_GLOBAL_WINDOW_MS = 15 * 60_000;
const loginFailureTimestamps: number[] = [];

function pruneLoginFailures(now: number): void {
  const cutoff = now - LOGIN_GLOBAL_WINDOW_MS;
  while (
    loginFailureTimestamps.length > 0 &&
    loginFailureTimestamps[0] < cutoff
  ) {
    loginFailureTimestamps.shift();
  }
}

export function loginBruteForceTripped(): {
  retryAfterMs: number;
  tripped: boolean;
} {
  const now = Date.now();
  pruneLoginFailures(now);
  if (loginFailureTimestamps.length >= LOGIN_GLOBAL_FAILURE_LIMIT) {
    const retryAfterMs =
      loginFailureTimestamps[0] + LOGIN_GLOBAL_WINDOW_MS - now;
    return { tripped: true, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  return { tripped: false, retryAfterMs: 0 };
}

export function recordLoginFailure(): void {
  loginFailureTimestamps.push(Date.now());
}

/** Test hook — clears the global login failure window. */
export function _resetLoginBruteForce(): void {
  loginFailureTimestamps.length = 0;
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
export { isSameOriginRequest } from "./deployment-trust";

/**
 * Admin-token gate: the user can set AUDITOR_ADMIN_TOKEN in the environment
 * to require a header on every guarded request. Localhost-only installs may
 * rely on same-origin checks; LAN/domain hosts require the shared-secret gate.
 */
export function adminTokenConfigured(): boolean {
  return !!process.env.AUDITOR_ADMIN_TOKEN;
}

/**
 * Whether the deployment is reachable beyond loopback. This used to be derived
 * from the (spoofable) Host / X-Forwarded-Host headers; it is now a property of
 * the deployment CONFIG (see `lib/deployment-trust.ts`), so a `Host: localhost`
 * from a LAN attacker can no longer downgrade the instance to "local". The
 * optional request arg is kept for call-site compatibility but unused.
 */
export function requestLooksNonLocal(_request?: Request): boolean {
  return isNetworkExposed();
}

/**
 * The admin token is required for guarded routes when it is configured at all,
 * OR whenever the deployment is declared network-exposed — in which case
 * destructive mutations are refused until AUDITOR_ADMIN_TOKEN is set (this is
 * the route-layer half of the "token mandatory when exposed" guarantee; the
 * proxy enforces the same thing independently).
 */
export function adminTokenRequiredForRequest(_request?: Request): boolean {
  return adminTokenConfigured() || isNetworkExposed();
}

export {
  ADMIN_TOKEN_COOKIE,
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
} from "./admin-auth";

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
      (event.actorIp ?? "").slice(0, 64),
      (event.userAgent ?? "").slice(0, 256),
      (event.detail ?? "").slice(0, 1024),
      event.success ? 1 : 0
    );
  } catch (error) {
    console.error("[audit] failed to record event", event.action, error);
  }
}

export function requestActorIp(request: Request): string {
  // Forwarded headers are attacker-controlled unless a trusted proxy is
  // configured, so without one we record "local" rather than an IP the caller
  // chose. `actor_ip` is a write-only audit field (nothing parses it), and an
  // honest "local" beats a spoofed, misleading address in the forensic trail.
  return clientIpFromHeaders(request.headers) ?? "local";
}

// ─────────────────────────────────────────────
// JSON body size guard
// ─────────────────────────────────────────────

export {
  readBoundedBody,
  readBoundedJson,
  readOptionalBoundedJson,
  requestBodyErrorResponse,
} from "./request-body";

// ─────────────────────────────────────────────
// App Store URL allowlist + policy URL sanitiser
// ─────────────────────────────────────────────

const APP_STORE_HOSTS = ["apps.apple.com", "itunes.apple.com"];

/**
 * Accept only canonical App Store URLs. Used by /api/scrape so a client can't
 * coax the server into fetching arbitrary origins. The path must carry an
 * `/id<digits>` segment — the thing the scraper extracts as the Apple track id.
 */
export function validateAppStoreUrl(raw: unknown): UrlValidationResult {
  const base = validateExternalUrl(raw, { allowedHosts: APP_STORE_HOSTS });
  if (!(base.ok && base.url)) {
    return base;
  }
  if (!/\/id\d+(?:\/|$|\?)/i.test(base.url.pathname)) {
    return {
      ok: false,
      error: "invalid_url",
      detail: "App Store URL must contain an /id<digits> segment",
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
  if (!(result.ok && result.url)) {
    return "";
  }
  return result.url.toString();
}
