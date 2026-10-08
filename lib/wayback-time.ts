/**
 * Time formatting for the Wayback import surfaces: the clock time a wait
 * or a retry ends ("resumes at 14:32"), the rough time a bulk run has
 * left ("About 1 h 50 min left"), and the retry delay a throttled
 * per-app import was given.
 *
 * Pure and client-safe. Clock times follow Settings → Appearance → Date
 * format the same way `formatDate` in `lib/date-format.ts` does: `iso` is
 * a fixed 24-hour `HH:MM`, `dmy` / `mdy` borrow the en-GB / en-US
 * conventions, and `auto` is the browser's locale.
 */

import { type DateFormatMode, formatDate } from "./date-format";

const MINUTE_MS = 60_000;

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The local clock time of `epochMs`, for "resumes at …" and "try again
 * after …". A time on another day than `now` carries its date too, so a
 * wait that crosses midnight never reads as one in the past.
 */
export function formatWaybackClockTime(
  epochMs: number,
  mode: DateFormatMode,
  now: number = Date.now()
): string {
  if (!Number.isFinite(epochMs)) {
    return "";
  }
  const date = new Date(epochMs);
  if (!sameLocalDay(date, new Date(now))) {
    return formatDate(epochMs, mode, { withTime: true });
  }
  if (mode === "iso") {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const locale =
    mode === "dmy" ? "en-GB" : mode === "mdy" ? "en-US" : undefined;
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return formatWaybackClockTime(epochMs, "iso", now);
  }
}

/** A duration as one of the `settings.wayback.duration_*` messages. */
export type WaybackDuration =
  | { key: "duration_under_minute" }
  | { key: "duration_minutes"; values: { minutes: number } }
  | { key: "duration_hours"; values: { hours: number } }
  | {
      key: "duration_hours_minutes";
      values: { hours: number; minutes: number };
    };

/**
 * A remaining time, rounded to what an estimate can honestly claim: the
 * nearest minute below an hour, the nearest 5 minutes below ten hours,
 * the nearest hour after that. Null for nothing left (or no number).
 */
export function describeWaybackDuration(ms: number): WaybackDuration | null {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const exactMinutes = ms / MINUTE_MS;
  if (exactMinutes < 0.5) {
    return { key: "duration_under_minute" };
  }
  let step = 1;
  if (exactMinutes >= 600) {
    step = 60;
  } else if (exactMinutes >= 60) {
    step = 5;
  }
  const minutes = Math.max(1, Math.round(exactMinutes / step) * step);
  if (minutes < 60) {
    return { key: "duration_minutes", values: { minutes } };
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? { key: "duration_hours", values: { hours } }
    : { key: "duration_hours_minutes", values: { hours, minutes: rest } };
}

/**
 * How long a throttled request was told to wait, in ms. The JSON body's
 * `retryAfterMs` wins (both backends send it on a 503
 * `archive_unavailable`, null or absent when archive.org gave no
 * Retry-After); the `Retry-After` header, in seconds or as an HTTP date,
 * is the fallback. Null when neither says anything usable.
 */
export function parseRetryAfterMs(
  bodyRetryAfterMs: unknown,
  retryAfterHeader: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (
    typeof bodyRetryAfterMs === "number" &&
    Number.isFinite(bodyRetryAfterMs) &&
    bodyRetryAfterMs > 0
  ) {
    return bodyRetryAfterMs;
  }
  const header = retryAfterHeader?.trim();
  if (!header) {
    return null;
  }
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return seconds > 0 ? seconds * 1000 : null;
  }
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? at - now : null;
}
