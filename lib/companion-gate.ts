/**
 * The half of companion pairing that proxy.ts can import: constants, the
 * route allowlist, token hashing, and an in-memory registry of the valid
 * token hashes. No better-sqlite3 here: the proxy must not load the native
 * binding (see the trust note at the top of proxy.ts).
 *
 * The registry is the proxy's view of the `companion_tokens` table. It
 * lives on `globalThis` because under `next start` the proxy, the route
 * handlers and instrumentation.ts each get their own copy of lib/ modules
 * in one process. lib/companion.ts (which does have the database) fills it
 * at boot, keeps it current on every pairing and revoke, and installs the
 * sink that persists a token's first and last use, so the proxy never has
 * to touch SQLite itself.
 *
 * Mirrored in core/src/server/companion.rs. The allowlist, the token
 * shape, the claim window and the refusal replies must match it exactly.
 */

import { createHash } from "node:crypto";

/** Header the phone sends. Lower-case: Headers.get is case-insensitive. */
export const COMPANION_HEADER = "x-privacytracker-companion-token";
export const COMPANION_TOKEN_PREFIX = "ptc_";
export const COMPANION_SCOPE_READ = "read";
/** 15 minutes: an unused pairing code stops working after this. */
export const COMPANION_CLAIM_WINDOW_MS = 15 * 60 * 1000;
/** `last_used_at` is refreshed at most this often per token. */
export const COMPANION_LAST_USED_RESOLUTION_MS = 60 * 1000;

/**
 * The only requests a companion token may make: GET on these paths. The
 * query string is not part of the match. Anchored so the Rust mirror can
 * be a literal translation.
 */
export const COMPANION_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/api\/companion\/status$/,
  /^\/api\/apps$/,
  /^\/api\/apps\/\d{1,20}\/(?:detail|changelog|since-install|history-stats)$/,
  /^\/api\/changelog$/,
  /^\/api\/triage$/,
];

const TOKEN_RE = /^ptc_[0-9a-f]{64}$/;

export function isCompanionRoute(method: string, pathname: string): boolean {
  if (method !== "GET") {
    return false;
  }
  return COMPANION_ROUTE_PATTERNS.some((re) => re.test(pathname));
}

export function isWellFormedCompanionToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function hashCompanionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Replies the gate sends for a companion request it refuses. */
export const COMPANION_REFUSALS = {
  invalid: {
    status: 401,
    error: "Companion token is not valid. Pair this phone again.",
  },
  outOfScope: {
    status: 403,
    error:
      "A companion token can only read the app list and its history. It cannot be used here.",
  },
  unavailable: {
    status: 503,
    error: "Companion pairing is starting up. Try again in a moment.",
  },
} as const;

// ─────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────

export interface CompanionEntry {
  claimExpiresAt: number;
  firstUsedAt: number | null;
  id: string;
  label: string;
  lastUsedAt: number | null;
}

/** Persists a use: first use always, later uses at most once a minute. */
export type CompanionUsageSink = (
  id: string,
  firstUsedAt: number,
  lastUsedAt: number
) => void;

interface Registry {
  byHash: Map<string, CompanionEntry>;
  loaded: boolean;
  sink: CompanionUsageSink | null;
}

const REGISTRY_KEY = Symbol.for("privacytracker.companion-registry");

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let r = g[REGISTRY_KEY];
  if (!r) {
    r = { loaded: false, byHash: new Map(), sink: null };
    g[REGISTRY_KEY] = r;
  }
  return r;
}

export function isCompanionRegistryLoaded(): boolean {
  return registry().loaded;
}

/** Replaces every entry: boot, a full wipe, a restored backup. */
export function replaceCompanionRegistry(
  entries: Iterable<[hash: string, entry: CompanionEntry]>
): void {
  const r = registry();
  r.byHash = new Map(entries);
  r.loaded = true;
}

export function putCompanionEntry(hash: string, entry: CompanionEntry): void {
  registry().byHash.set(hash, entry);
}

export function removeCompanionEntry(id: string): void {
  const r = registry();
  for (const [hash, entry] of r.byHash) {
    if (entry.id === id) {
      r.byHash.delete(hash);
    }
  }
}

export function installCompanionUsageSink(sink: CompanionUsageSink): void {
  registry().sink = sink;
}

/** For tests: forget everything, including that the registry was loaded. */
export function _resetCompanionRegistry(): void {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  delete g[REGISTRY_KEY];
}

export type CompanionCheck =
  | { kind: "allowed"; entry: CompanionEntry }
  | { kind: "out_of_scope" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

/**
 * The gate's decision for a request that carries the companion header.
 * The allowlist is checked first, so a token sent anywhere else is refused
 * whether or not it is valid, and whatever other credential rides along.
 */
export function checkCompanionRequest(
  method: string,
  pathname: string,
  token: string,
  now = Date.now()
): CompanionCheck {
  if (!isCompanionRoute(method, pathname)) {
    return { kind: "out_of_scope" };
  }
  const r = registry();
  if (!r.loaded) {
    return { kind: "unavailable" };
  }
  const trimmed = token.trim();
  if (!isWellFormedCompanionToken(trimmed)) {
    return { kind: "invalid" };
  }
  const entry = r.byHash.get(hashCompanionToken(trimmed));
  if (!entry) {
    return { kind: "invalid" };
  }
  if (entry.firstUsedAt === null && now > entry.claimExpiresAt) {
    return { kind: "invalid" };
  }
  recordUse(r, entry, now);
  return { kind: "allowed", entry };
}

/** Looks a token up without recording a use. For the status route. */
export function lookupCompanionToken(token: string): CompanionEntry | null {
  const trimmed = token.trim();
  if (!isWellFormedCompanionToken(trimmed)) {
    return null;
  }
  return registry().byHash.get(hashCompanionToken(trimmed)) ?? null;
}

function recordUse(r: Registry, entry: CompanionEntry, now: number): void {
  const first = entry.firstUsedAt === null;
  const stale =
    entry.lastUsedAt === null ||
    now - entry.lastUsedAt >= COMPANION_LAST_USED_RESOLUTION_MS;
  if (!(first || stale)) {
    return;
  }
  if (first) {
    entry.firstUsedAt = now;
  }
  entry.lastUsedAt = now;
  try {
    r.sink?.(entry.id, entry.firstUsedAt ?? now, now);
  } catch (error) {
    console.error("[companion] failed to record a use", error);
  }
}
