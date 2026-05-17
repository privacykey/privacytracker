/**
 * Central rate-limit state tracker for Apple's two endpoints:
 *   - iTunes Search (~20 req/min, returns HTTP 429 with Retry-After).
 *   - App Store HTML (similar ceiling; soft-throttles arrive as HTTP 403
 *     on IP-based bans — treated as a rate signal, see scraper.ts).
 *
 * Single source of truth for when it's safe to hit either endpoint again.
 * Used by lib/scraper.ts, the bulk runners (sync, policy, wayback), and
 * GET /api/rate-limit/status. State is persisted in `app_settings` so a
 * restart doesn't forget that we're mid-cooldown.
 *
 * Categories are tracked separately because Apple sometimes throttles one
 * endpoint but not the other. Proactive cap (token bucket) is a cooperative
 * pacer; only a real 429/403 from Apple hardens into a "no requests for N
 * seconds" block. The proactive budget is deliberately more conservative
 * than Apple's documented limit (~14 req/min for search vs Apple's ~20).
 */

import { getSetting, setSetting } from "./scheduler";

// All four keys live in `app_settings`. Keep the names stable — a renamed
// key is a forgotten cooldown on next deploy. `_until` keys store ms-since-
// epoch as a string; `_reason` keys store an English forensic log line.
const KEY_SEARCH_UNTIL = "rate_limit_search_until";
const KEY_SEARCH_REASON = "rate_limit_search_reason";
const KEY_SCRAPE_UNTIL = "rate_limit_scrape_until";
const KEY_SCRAPE_REASON = "rate_limit_scrape_reason";

export type RateLimitCategory = "search" | "scrape";

const CATEGORY_KEYS: Record<
  RateLimitCategory,
  { until: string; reason: string }
> = {
  search: { until: KEY_SEARCH_UNTIL, reason: KEY_SEARCH_REASON },
  scrape: { until: KEY_SCRAPE_UNTIL, reason: KEY_SCRAPE_REASON },
};

/**
 * Snapshot of one category's rate-limit state. `active === true` means a
 *hard* cooldown is in effect (Apple gave us a 429/403). The proactive
 * soft pacer doesn't surface here. `resumeAt` is ms-since-epoch (0 when
 * inactive). `reason` is an English log line — not translated.
 */
export interface RateLimitSnapshot {
  active: boolean;
  category: RateLimitCategory;
  reason: string;
  resumeAt: number;
}

/** Combined snapshot returned by `getAllRateLimits()` and the API. */
export interface RateLimitStatusResponse {
  scrape: RateLimitSnapshot;
  search: RateLimitSnapshot;
  /** Unix-ms timestamp of the response, so UI can correct for client clock skew. */
  serverNow: number;
}

function readCategory(category: RateLimitCategory): RateLimitSnapshot {
  const { until, reason } = CATEGORY_KEYS[category];
  // Coerce + guard a corrupted setting to "not throttled" rather than throwing.
  const rawUntil = getSetting(until, "0");
  const resumeAt = Number.parseInt(rawUntil, 10);
  const validResumeAt =
    Number.isFinite(resumeAt) && resumeAt > 0 ? resumeAt : 0;
  const active = validResumeAt > Date.now();
  return {
    category,
    active,
    resumeAt: active ? validResumeAt : 0,
    // Don't surface a stale reason once the cooldown has elapsed.
    reason: active ? getSetting(reason, "") : "",
  };
}

/** Get the current state for a single category. */
export function getRateLimit(category: RateLimitCategory): RateLimitSnapshot {
  return readCategory(category);
}

/** Get the current state for both categories plus a server timestamp. */
export function getAllRateLimits(): RateLimitStatusResponse {
  return {
    search: readCategory("search"),
    scrape: readCategory("scrape"),
    serverNow: Date.now(),
  };
}

/**
 * How many ms remain on the cooldown for `category`. Returns 0 if there's
 * no active cooldown. Used by the proactive pacer to short-circuit early.
 */
export function getRemainingCooldownMs(category: RateLimitCategory): number {
  const snap = readCategory(category);
  return snap.active ? Math.max(0, snap.resumeAt - Date.now()) : 0;
}

/**
 * Hard-record a rate-limit event from Apple. If we're already in a cooldown
 * longer than the new one, keep the longer — Apple sometimes returns a
 * generous Retry-After for the first 429 and tighter values for subsequent
 * 429s, and the tighter value would make us retry too early.
 * Returns the new resumeAt.
 */
export function recordRateLimit(
  category: RateLimitCategory,
  retryAfterMs: number,
  reason: string
): number {
  const { until, reason: reasonKey } = CATEGORY_KEYS[category];
  const newResumeAt = Date.now() + Math.max(0, retryAfterMs);
  const existing = Number.parseInt(getSetting(until, "0"), 10);
  const validExisting = Number.isFinite(existing) ? existing : 0;
  const finalResumeAt = Math.max(newResumeAt, validExisting);
  setSetting(until, String(finalResumeAt));
  setSetting(reasonKey, reason);
  return finalResumeAt;
}

/**
 * Clear an active cooldown for `category`. Used by the manual-retry button.
 * If we're wrong and Apple is still blocking, the next request will
 * re-record the limit on its 429 response.
 */
export function clearRateLimit(category: RateLimitCategory): void {
  const { until, reason } = CATEGORY_KEYS[category];
  setSetting(until, "0");
  setSetting(reason, "");
}

// Token bucket per category. Tokens regenerate at a steady rate; each
// outbound request consumes one. When empty, sleeps the caller for at most
// 800ms. State lives in module memory — it's a smoothing device, not a
// durable contract. The hard reactive cooldown is persisted separately.

interface TokenBucket {
  capacity: number;
  lastRefillAt: number;
  refillIntervalMs: number;
  tokens: number;
}

const BUCKETS: Record<RateLimitCategory, TokenBucket> = {
  // iTunes Search: budget of 14 req/min (Apple ~20). 4-token burst.
  // 60_000 / 14 ≈ 4286ms; rounded down so refill is slightly faster than
  // the budget cap.
  search: {
    capacity: 4,
    tokens: 4,
    refillIntervalMs: 4200,
    lastRefillAt: Date.now(),
  },
  // App Store HTML: budget of 18 req/min (Apple ~30). 6-token burst lets a
  // small bulk sync start without pacing for the first wave.
  scrape: {
    capacity: 6,
    tokens: 6,
    refillIntervalMs: 3300,
    lastRefillAt: Date.now(),
  },
};

function refillBucket(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed <= 0) {
    return;
  }
  const newTokens = Math.floor(elapsed / bucket.refillIntervalMs);
  if (newTokens <= 0) {
    return;
  }
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + newTokens);
  bucket.lastRefillAt = now;
}

/**
 * Reserve a slot for an outbound request. Returns ASAP if a token is
 * available. Sleeps for at most 800ms if the bucket is empty; after that
 * we return regardless and let the reactive 429 path take over if needed.
 * Throws nothing. Always resolves.
 */
export async function acquireRateLimitToken(
  category: RateLimitCategory
): Promise<void> {
  const bucket = BUCKETS[category];
  refillBucket(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }
  const waitMs = Math.min(800, bucket.refillIntervalMs);
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  refillBucket(bucket);
  // Decrement even if no fresh token — the call site will make the request
  // either way and the next retry will pace correctly.
  bucket.tokens = Math.max(0, bucket.tokens - 1);
}

/**
 * Test-only: reset the soft buckets to full. The hard cooldown isn't
 * touched — call `clearRateLimit` explicitly for that.
 */
export function _resetSoftBuckets(): void {
  for (const cat of Object.keys(BUCKETS) as RateLimitCategory[]) {
    const bucket = BUCKETS[cat];
    bucket.tokens = bucket.capacity;
    bucket.lastRefillAt = Date.now();
  }
}
