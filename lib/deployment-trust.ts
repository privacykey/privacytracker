/**
 * Deployment-trust config — the single source of truth for "what hostname
 * do we answer to" and "is this instance reachable beyond loopback".
 *
 * WHY THIS MODULE EXISTS (and why it imports nothing): the trust decisions
 * here are consumed in two runtimes — the Next.js middleware/proxy sandbox
 * (`proxy.ts`) and ordinary Node route handlers (via `lib/security.ts`). The
 * proxy sandbox cannot load native modules, so it must NOT transitively import
 * `lib/db` (better-sqlite3). `lib/security.ts` does import the DB, which is why
 * `proxy.ts` historically kept its own private copies of these helpers. This
 * module breaks that duplication: it reads only `process.env` and operates on
 * plain strings / `Headers`, so BOTH callers can import it safely.
 *
 * Design choices:
 * - Trust is derived from DEPLOYMENT CONFIG, never from spoofable request
 *   headers. A `Host: localhost` from a LAN attacker no longer downgrades the
 *   instance to "local".
 * - `process.env` is read on every call. The values are tiny and the parsing
 *   is trivial string work, so there is no cache — which means tests can mutate
 *   `process.env` and see the effect immediately with no reset hook.
 *
 * Env vars (all optional; the default posture is loopback-only):
 * - PRIVACYTRACKER_ALLOWED_HOSTS  — comma list, APPENDED to the always-allowed
 *   loopback set. A non-loopback entry also flips the instance to
 *   "network-exposed" (so the admin token becomes mandatory).
 * - PRIVACYTRACKER_TRUST_PROXY    — boolean. Trust X-Forwarded-* headers. We
 *   cannot verify the socket peer without a custom server, so this is an
 *   explicit operator assertion that a trusted reverse proxy sits in front.
 * - PRIVACYTRACKER_NETWORK_EXPOSED — boolean. Force the token-mandatory posture.
 * - PRIVACYTRACKER_BIND_HOST      — optional explicit bind interface. A specific
 *   non-loopback IP ⇒ network-exposed. (We deliberately do NOT trust HOSTNAME
 *   as a bind signal unless it parses as an IP, because Docker sets HOSTNAME to
 *   the container id — a random hostname that must not be mistaken for a bind
 *   address.)
 */

export type BindClassification =
  | "loopback"
  | "wildcard"
  | "specific"
  | "unknown";

export interface DeploymentTrustPosture {
  allowedHostPatterns: string[];
  allowedHostsConfigured: boolean;
  bindAmbiguous: boolean;
  bindClassification: BindClassification;
  networkExposed: boolean;
  trustProxy: boolean;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function firstHeaderValue(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (!raw) {
    return null;
  }
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

/**
 * Normalise a Host / X-Forwarded-Host value to a bare lowercase hostname:
 * strips brackets + port from `[::1]:3000`, an IPv6 zone id (`fe80::1%eth0`),
 * a single trailing FQDN dot, and the `:port` from `host:port`. Bare IPv6
 * literals (multiple colons, no brackets) are kept intact rather than being
 * truncated at the first colon. Returns null for empty/missing input.
 *
 * This consolidates the three previously-divergent copies that lived in
 * proxy.ts, lib/security.ts, and lib/deployment-diagnostics.ts.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let h = raw.trim().toLowerCase();
  if (!h) {
    return null;
  }
  if (h.startsWith("[")) {
    // Bracketed IPv6, optionally with a port: [::1]:3000 → ::1
    const end = h.indexOf("]");
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else if ((h.match(/:/g)?.length ?? 0) <= 1) {
    // At most one colon → treat as host:port and drop the port. (Bare IPv6
    // literals have 2+ colons and fall through untouched.)
    h = h.split(":")[0];
  }
  const pct = h.indexOf("%");
  if (pct >= 0) {
    h = h.slice(0, pct); // strip IPv6 zone id
  }
  if (h.endsWith(".")) {
    h = h.slice(0, -1); // strip a single trailing FQDN dot
  }
  return h || null;
}

function isLoopbackNormalized(h: string): boolean {
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h === "::" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * Canonical loopback classification. Treats all of 127.0.0.0/8, ::1, the
 * unspecified addresses 0.0.0.0 / ::, localhost and *.localhost as loopback.
 * (Fixes the old diagnostics check that only matched the literal "127.0.0.1".)
 */
export function isLoopbackHost(raw: string | null | undefined): boolean {
  const h = normalizeHost(raw);
  return h ? isLoopbackNormalized(h) : false;
}

function patternBareHost(pattern: string): string {
  return pattern.startsWith("*.") ? pattern.slice(2) : pattern;
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

function envHostList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const wildcard = part.trim().toLowerCase().startsWith("*.");
    const normalized = normalizeHost(wildcard ? part.trim().slice(2) : part);
    if (normalized) {
      out.push(wildcard ? `*.${normalized}` : normalized);
    }
  }
  return out;
}

/** The configured (non-loopback) allowlist patterns. Loopback is implicit. */
export function getAllowedHostPatterns(): string[] {
  return envHostList("PRIVACYTRACKER_ALLOWED_HOSTS");
}

/**
 * Is the given Host value one we answer to? Loopback is ALWAYS allowed (so the
 * in-container healthcheck on 127.0.0.1 keeps working regardless of config);
 * the env allowlist only ADDS hosts. A missing/empty host is rejected.
 */
export function isHostAllowed(raw: string | null | undefined): boolean {
  const h = normalizeHost(raw);
  if (!h) {
    return false;
  }
  if (isLoopbackNormalized(h)) {
    return true;
  }
  return getAllowedHostPatterns().some((p) => hostMatchesPattern(h, p));
}

/** Operator has asserted a trusted reverse proxy sits in front. */
export function trustProxy(): boolean {
  return envFlag("PRIVACYTRACKER_TRUST_PROXY");
}

/**
 * The host the *client* used, as best we can trust it: X-Forwarded-Host when a
 * trusted proxy is configured, otherwise the literal Host header. Untrusted
 * X-Forwarded-Host is ignored entirely — checking it against the allowlist
 * would be pointless since an attacker can set it to "localhost".
 */
export function effectiveHostFromHeaders(headers: Headers): string | null {
  if (trustProxy()) {
    const fwd = firstHeaderValue(headers, "x-forwarded-host");
    if (fwd) {
      return fwd;
    }
  }
  return headers.get("host");
}

/**
 * The client IP, or null when we cannot attribute one. Returns null unless a
 * trusted proxy is configured — without one, X-Forwarded-For / X-Real-IP are
 * attacker-controlled and must not key rate limits or audit rows. With a
 * trusted proxy we take the RIGHTMOST X-Forwarded-For hop (the one our proxy
 * appended), not the spoofable leftmost. Assumes a single trusted hop.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  if (!trustProxy()) {
    return null;
  }
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.at(-1)?.toLowerCase() ?? null;
    }
  }
  const real = headers.get("x-real-ip");
  return real ? real.trim().toLowerCase() : null;
}

function ipLiteralFamily(h: string): "v4" | "v6" | null {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    return "v4";
  }
  if (h.includes(":")) {
    return "v6";
  }
  return null;
}

function bindHostRaw(): string | null {
  const explicit = process.env.PRIVACYTRACKER_BIND_HOST?.trim();
  if (explicit) {
    return explicit;
  }
  // HOSTNAME is the *container id* under Docker (not a bind address), so only
  // honour it when it parses as an IP / known bind token — never a hostname.
  const hn = process.env.HOSTNAME?.trim();
  if (hn) {
    const n = normalizeHost(hn);
    if (n && (ipLiteralFamily(n) || isLoopbackNormalized(n))) {
      return hn;
    }
  }
  return null;
}

export function bindClassification(): BindClassification {
  const b = normalizeHost(bindHostRaw());
  if (!b) {
    return "unknown";
  }
  if (b === "0.0.0.0" || b === "::") {
    return "wildcard";
  }
  if (isLoopbackNormalized(b)) {
    return "loopback";
  }
  if (ipLiteralFamily(b)) {
    return "specific";
  }
  return "unknown";
}

function allowlistHasNonLoopback(): boolean {
  return getAllowedHostPatterns().some(
    (p) => !isLoopbackNormalized(patternBareHost(p))
  );
}

/**
 * Is this instance declared reachable beyond loopback? True when the operator
 * sets PRIVACYTRACKER_NETWORK_EXPOSED, lists a non-loopback host in the
 * allowlist, or binds to a specific non-loopback IP. A wildcard (0.0.0.0/::)
 * or unknown bind is deliberately NOT treated as exposed — inside Docker we
 * cannot observe the host-side port map, so we fail to the safe default and
 * rely on the startup warning + the Host allowlist to surface real exposure.
 */
export function isNetworkExposed(): boolean {
  if (envFlag("PRIVACYTRACKER_NETWORK_EXPOSED")) {
    return true;
  }
  if (allowlistHasNonLoopback()) {
    return true;
  }
  return bindClassification() === "specific";
}

/**
 * True when we genuinely cannot tell whether the instance is loopback-only —
 * a wildcard (0.0.0.0/::) or unclassifiable bind. Drives the boot-time warning
 * (combined with "no admin token configured" by the caller).
 */
export function bindIsAmbiguous(): boolean {
  const c = bindClassification();
  return c === "wildcard" || c === "unknown";
}

export function describeDeploymentTrust(): DeploymentTrustPosture {
  const patterns = getAllowedHostPatterns();
  return {
    allowedHostPatterns: patterns,
    allowedHostsConfigured: patterns.length > 0,
    bindAmbiguous: bindIsAmbiguous(),
    bindClassification: bindClassification(),
    networkExposed: isNetworkExposed(),
    trustProxy: trustProxy(),
  };
}
