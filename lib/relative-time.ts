/**
 * Shared "X minutes ago" relative-time formatter.
 *
 * Five surfaces (dashboard hero/rows, annotations, diagnostics, stats,
 * notification bell) each used to hand-roll the same ms → bucket cascade.
 * The arithmetic now lives here once; each caller supplies a declarative
 * tier list that maps a time bucket to one of its own i18n keys, so every
 * surface keeps its existing next-intl namespace and Crowdin-managed copy.
 *
 * Behaviour is a faithful mirror of the originals for every real (past)
 * timestamp. The one deliberate nuance: a *future* timestamp (clock skew)
 * resolves to the first tier whose bound it falls under — for the
 * stats day-cascade that means "Today" rather than the original's
 * nonsensical "-1 days ago". All five originals already collapsed future
 * timestamps into their "just now"/first tier, so the others are unchanged.
 */

/** Minimal next-intl translator shape. Every caller's `useTranslations`
 *  result is structurally assignable to this. */
export type RelativeTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Which elapsed-time unit a tier interpolates into its message. */
export type RelativeUnit = "seconds" | "minutes" | "hours" | "days" | "months";

export interface RelativeTimeTier {
  /** i18n key handed to the translator. */
  key: string;
  /** Exclusive upper bound, in whole seconds. Omit on the final catch-all
   *  tier (it matches everything the earlier tiers didn't). */
  maxSeconds?: number;
  /** Interpolation parameter name. Defaults to "count". */
  param?: string;
  /** Elapsed unit to interpolate. Omit for value-less messages
   *  ("just now", "yesterday", "today"). */
  unit?: RelativeUnit;
}

export interface RelativeTimeOptions {
  /** Key rendered when `ts` is falsy (0 / NaN / undefined). */
  dashKey?: string;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
  /** Pass the numeric value as a string so ICU number-grouping (and plural
   *  selection) can't alter the rendered digits. Required where the original
   *  used a template literal (diagnostics, notification bell). Leave off where
   *  the message is an ICU plural that needs a real number (stats). */
  stringify?: boolean;
}

interface RelativeParts {
  days: number;
  hours: number;
  minutes: number;
  months: number;
  seconds: number;
}

/** Floor the elapsed span into every unit the tiers might ask for. Computing
 *  days/months from the already-floored seconds is identical to flooring the
 *  raw millisecond span directly — `floor(floor(x/1000)/86400) === floor(x/86400000)`
 *  holds for all real x — so this reproduces the stats/diagnostics ms-based
 *  originals exactly. */
function computeParts(elapsedMs: number): RelativeParts {
  const seconds = Math.floor(elapsedMs / 1000);
  const days = Math.floor(seconds / 86_400);
  return {
    seconds,
    minutes: Math.floor(seconds / 60),
    hours: Math.floor(seconds / 3600),
    days,
    months: Math.floor(days / 30),
  };
}

export function formatRelativeTime(
  t: RelativeTranslator,
  ts: number,
  tiers: RelativeTimeTier[],
  options: RelativeTimeOptions = {}
): string {
  if (!ts && options.dashKey) {
    return t(options.dashKey);
  }
  const now = options.now ?? Date.now();
  const parts = computeParts(now - ts);
  for (const tier of tiers) {
    if (tier.maxSeconds !== undefined && parts.seconds >= tier.maxSeconds) {
      continue;
    }
    if (!tier.unit) {
      return t(tier.key);
    }
    const value = parts[tier.unit];
    return t(tier.key, {
      [tier.param ?? "count"]: options.stringify ? String(value) : value,
    });
  }
  // Unreachable for well-formed tier lists (the last tier omits maxSeconds and
  // therefore always matches); kept so the function is total.
  const last = tiers.at(-1);
  return last ? t(last.key) : "";
}

// ── Per-surface tier presets ──────────────────────────────────────────
// The arrays hold key *names*; the copy itself lives in locales/<lang>.json
// under each surface's own namespace.

/** dashboard.relative_time — full cascade, numeric `count`, has a dash tier
 *  (passed via options) and a months roll-up. */
export const DASHBOARD_RELATIVE_TIERS: RelativeTimeTier[] = [
  { maxSeconds: 60, key: "just_now" },
  { maxSeconds: 3600, key: "minutes_ago", unit: "minutes" },
  { maxSeconds: 86_400, key: "hours_ago", unit: "hours" },
  { maxSeconds: 172_800, key: "yesterday" },
  { maxSeconds: 2_592_000, key: "days_ago", unit: "days" },
  { key: "months_ago", unit: "months" },
];

/** annotations.rel_* — same cascade as the dashboard, rel_-prefixed keys,
 *  no dash tier. */
export const ANNOTATION_RELATIVE_TIERS: RelativeTimeTier[] = [
  { maxSeconds: 60, key: "rel_just_now" },
  { maxSeconds: 3600, key: "rel_minutes", unit: "minutes" },
  { maxSeconds: 86_400, key: "rel_hours", unit: "hours" },
  { maxSeconds: 172_800, key: "rel_yesterday" },
  { maxSeconds: 2_592_000, key: "rel_days", unit: "days" },
  { key: "rel_months", unit: "months" },
];

/** diagnostics_page.format.relative_* — sub-second "just now", a seconds
 *  tier, tops out at hours; per-tier param names, values stringified. */
export const DIAGNOSTICS_RELATIVE_TIERS: RelativeTimeTier[] = [
  { maxSeconds: 1, key: "relative_just_now" },
  {
    maxSeconds: 60,
    key: "relative_seconds_ago",
    unit: "seconds",
    param: "seconds",
  },
  {
    maxSeconds: 3600,
    key: "relative_minutes_ago",
    unit: "minutes",
    param: "minutes",
  },
  { key: "relative_hours_ago", unit: "hours", param: "hours" },
];

/** stats.* — day-granularity only. `days_ago` is an ICU plural, so its value
 *  stays numeric (do NOT stringify this preset). */
export const STATS_RELATIVE_TIERS: RelativeTimeTier[] = [
  { maxSeconds: 86_400, key: "today" },
  { maxSeconds: 172_800, key: "yesterday" },
  { key: "days_ago", unit: "days" },
];

/** notifications.time_* — abbreviated "m/h/d ago", no yesterday or months
 *  tier. Stringified to match the original template-literal output. */
export const NOTIFICATION_RELATIVE_TIERS: RelativeTimeTier[] = [
  { maxSeconds: 60, key: "time_just_now" },
  { maxSeconds: 3600, key: "time_minutes_ago", unit: "minutes" },
  { maxSeconds: 86_400, key: "time_hours_ago", unit: "hours" },
  { key: "time_days_ago", unit: "days" },
];
