/**
 * Admin-token guess limits: how many wrong tokens one client may present
 * before the server stops checking what it sends.
 *
 * Every place that says whether a presented admin token is right is a
 * place to guess it: the proxy's check in front of every private page and
 * API call, the login form, and the public status endpoint's `unlocked`.
 * All three account for failures here, by CLIENT:
 *
 * - The client is the real socket peer, which the request preloader
 *   (`lib/request-limits.cjs`) stamps on each request in a header only it
 *   can write (see `PEER_HEADER`). Behind `PRIVACYTRACKER_TRUST_PROXY` it
 *   is the last forwarded hop instead, exactly as the rate limiter reads
 *   it. With neither (a server started without the preloader) there is no
 *   client to attribute a failure to, and nothing here applies: the server
 *   behaves as it did before these limits existed, rather than sharing one
 *   bucket that any client could fill to lock out every other.
 * - Only FAILED checks count, and each distinct wrong value counts once
 *   per window. Guessing needs new values, while a browser still holding a
 *   cookie from before the token was rotated sends the same one on every
 *   request and so costs one failure, not one per request.
 * - Past `PER_CLIENT_FAILURE_LIMIT` distinct failures in the window, a
 *   token-bearing request from that client is refused with a 429 BEFORE
 *   its token is looked at, until the oldest failure leaves the window. A
 *   request with no token is not refused: it gets the ordinary 401.
 * - A global backstop bounds guessing spread across many addresses: past
 *   `GLOBAL_FAILURE_LIMIT` distinct failures in the window from all
 *   clients, only a client whose token checked out in the last
 *   `KNOWN_GOOD_MS` is still let through to the check. So an operator
 *   already signed in is never locked out by someone else's guessing.
 *
 * Nothing is counted while no admin token is configured: there is nothing
 * to guess, so a token-less loopback install is untouched.
 *
 * The state is process memory, kept on `globalThis` because the proxy and
 * the route handlers can load separate copies of this module. A restart
 * forgets it, like every other limiter. `core/src/server/token_guard.rs`
 * is the Rust server's copy of the same rules.
 */
import { createHash } from "node:crypto";
import { presentedAdminCookie, requestHasValidAdminToken } from "./admin-auth";
import { clientIpFromHeaders, trustProxy } from "./deployment-trust";

/** Header the request preloader writes: `<process stamp> <peer address>`. */
export const PEER_HEADER = "x-privacytracker-peer";
/** Where the preloader leaves its per-process stamp. */
const PEER_STAMP = Symbol.for("privacytracker.peer-stamp");

export const PER_CLIENT_FAILURE_LIMIT = 10;
export const GLOBAL_FAILURE_LIMIT = 100;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const KNOWN_GOOD_MS = 24 * 60 * 60_000;
/** Most clients remembered as recently signed in. */
const KNOWN_GOOD_MAX = 1000;
/** Past this many tracked clients, drop the ones with nothing left. */
const GC_THRESHOLD = 5000;

export const TOO_MANY_FAILURES =
  "Too many failed admin-token attempts. Try again later.";

interface GuardState {
  /** client → (hash of a wrong value → when it was first seen). */
  clients: Map<string, Map<string, number>>;
  /** `client value-hash` → when it was first seen. */
  global: Map<string, number>;
  /** client → last successful check. */
  knownGood: Map<string, number>;
}

const STATE = Symbol.for("privacytracker.admin-token-guard");

function state(): GuardState {
  const g = globalThis as { [STATE]?: GuardState };
  g[STATE] ??= { clients: new Map(), global: new Map(), knownGood: new Map() };
  return g[STATE];
}

/** Test hook: forget every failure and success. */
export function _resetAdminTokenGuard(): void {
  const s = state();
  s.clients.clear();
  s.global.clear();
  s.knownGood.clear();
}

/** `::ffff:127.0.0.1` and `127.0.0.1` are one client. */
function normalisePeer(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".")
    ? lower.slice("::ffff:".length)
    : lower;
}

/** The socket peer the preloader stamped, when this process has one. */
function stampedPeer(headers: Headers): string | null {
  const stamp = (globalThis as { [PEER_STAMP]?: unknown })[PEER_STAMP];
  if (typeof stamp !== "string" || !stamp) {
    return null;
  }
  const value = headers.get(PEER_HEADER);
  if (!value?.startsWith(`${stamp} `)) {
    return null;
  }
  const peer = normalisePeer(value.slice(stamp.length + 1));
  return peer || null;
}

/**
 * The client failures are counted against: the last forwarded hop behind
 * a trusted proxy, else the socket peer, else null.
 */
export function adminTokenClientKey(headers: Headers): string | null {
  if (trustProxy()) {
    const forwarded = clientIpFromHeaders(headers);
    if (forwarded) {
      return normalisePeer(forwarded);
    }
  }
  return stampedPeer(headers);
}

/** The token values a request presents: the header, then the cookie. */
function presentedValues(headers: Headers): string[] {
  const values: string[] = [];
  const header = headers.get("x-auditor-admin-token");
  if (header) {
    values.push(`header ${header}`);
  }
  const cookie = presentedAdminCookie(headers.get("cookie"));
  if (cookie) {
    values.push(`cookie ${cookie}`);
  }
  return values;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function prune(now: number): void {
  const s = state();
  const cutoff = now - FAILURE_WINDOW_MS;
  for (const [k, at] of s.global) {
    if (at <= cutoff) {
      s.global.delete(k);
    }
  }
  if (s.clients.size > GC_THRESHOLD) {
    for (const [client, failures] of s.clients) {
      for (const [k, at] of failures) {
        if (at <= cutoff) {
          failures.delete(k);
        }
      }
      if (failures.size === 0) {
        s.clients.delete(client);
      }
    }
  }
}

function oldest(entries: Map<string, number>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const at of entries.values()) {
    min = Math.min(min, at);
  }
  return min;
}

/**
 * Whether this client may present a token now: `retryAfterMs` when it may
 * not. Never refuses while no token is configured or no client is known.
 */
export function adminTokenAttemptsBlocked(
  client: string | null,
  now = Date.now()
): { blocked: false } | { blocked: true; retryAfterMs: number } {
  if (!(client && process.env.AUDITOR_ADMIN_TOKEN)) {
    return { blocked: false };
  }
  prune(now);
  const s = state();
  const failures = s.clients.get(client);
  if (failures) {
    const cutoff = now - FAILURE_WINDOW_MS;
    for (const [k, at] of failures) {
      if (at <= cutoff) {
        failures.delete(k);
      }
    }
    if (failures.size >= PER_CLIENT_FAILURE_LIMIT) {
      return {
        blocked: true,
        retryAfterMs: Math.max(0, oldest(failures) + FAILURE_WINDOW_MS - now),
      };
    }
  }
  if (s.global.size >= GLOBAL_FAILURE_LIMIT) {
    const lastGood = s.knownGood.get(client);
    if (lastGood === undefined || now - lastGood > KNOWN_GOOD_MS) {
      return {
        blocked: true,
        retryAfterMs: Math.max(0, oldest(s.global) + FAILURE_WINDOW_MS - now),
      };
    }
  }
  return { blocked: false };
}

/** Count one wrong value from this client (once per window per value). */
export function recordAdminTokenFailure(
  client: string | null,
  value: string,
  now = Date.now()
): void {
  if (!(client && process.env.AUDITOR_ADMIN_TOKEN)) {
    return;
  }
  const s = state();
  const h = hash(value);
  let failures = s.clients.get(client);
  if (!failures) {
    failures = new Map();
    s.clients.set(client, failures);
  }
  if (!failures.has(h)) {
    failures.set(h, now);
  }
  const globalKey = `${client} ${h}`;
  if (!s.global.has(globalKey)) {
    s.global.set(globalKey, now);
  }
}

/** Remember that this client's token checked out. */
export function recordAdminTokenSuccess(
  client: string | null,
  now = Date.now()
): void {
  if (!client) {
    return;
  }
  const s = state();
  s.knownGood.delete(client);
  s.knownGood.set(client, now);
  if (s.knownGood.size > KNOWN_GOOD_MAX) {
    const first = s.knownGood.keys().next().value;
    if (first !== undefined) {
      s.knownGood.delete(first);
    }
  }
}

export type AdminTokenCheck =
  | { outcome: "valid" }
  | { outcome: "absent" }
  | { outcome: "invalid" }
  | { outcome: "throttled"; retryAfterMs: number };

/**
 * The check the proxy and the status endpoint make: refuse a client past
 * its budget before looking at what it sent, else check the token and
 * account for the result. `absent` means no token was presented at all.
 */
export function checkAdminTokenAttempt(
  headers: Headers,
  now = Date.now()
): AdminTokenCheck {
  const values = presentedValues(headers);
  if (values.length === 0) {
    return { outcome: "absent" };
  }
  const client = adminTokenClientKey(headers);
  const verdict = adminTokenAttemptsBlocked(client, now);
  if (verdict.blocked) {
    return { outcome: "throttled", retryAfterMs: verdict.retryAfterMs };
  }
  if (requestHasValidAdminToken({ headers })) {
    recordAdminTokenSuccess(client, now);
    return { outcome: "valid" };
  }
  for (const value of values) {
    recordAdminTokenFailure(client, value, now);
  }
  return { outcome: "invalid" };
}
