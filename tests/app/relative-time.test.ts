import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_RELATIVE_TIERS,
  DASHBOARD_RELATIVE_TIERS,
  DIAGNOSTICS_RELATIVE_TIERS,
  formatRelativeTime,
  NOTIFICATION_RELATIVE_TIERS,
  type RelativeTimeOptions,
  type RelativeTimeTier,
  STATS_RELATIVE_TIERS,
} from "../../lib/relative-time";

// Fixed clock so every assertion is deterministic.
const NOW = 1_700_000_000_000;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Records exactly which key + values the formatter selected, preserving the
 *  value's JS type (so a stringified "5" reads differently from a numeric 5). */
function recorder(): RelativeTranslatorSpy {
  return (key, values) =>
    values === undefined ? key : `${key}|${JSON.stringify(values)}`;
}
type RelativeTranslatorSpy = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Render `tiers` for a timestamp `ms` before the fixed NOW. */
function at(
  ms: number,
  tiers: RelativeTimeTier[],
  options: Omit<RelativeTimeOptions, "now"> = {}
): string {
  return formatRelativeTime(recorder(), NOW - ms, tiers, {
    ...options,
    now: NOW,
  });
}

test("dashboard cascade matches the original relativeTime() buckets", () => {
  assert.equal(
    formatRelativeTime(recorder(), 0, DASHBOARD_RELATIVE_TIERS, {
      now: NOW,
      dashKey: "dash",
    }),
    "dash"
  );
  assert.equal(at(30 * SEC, DASHBOARD_RELATIVE_TIERS), "just_now");
  assert.equal(at(59 * SEC, DASHBOARD_RELATIVE_TIERS), "just_now");
  assert.equal(
    at(60 * SEC, DASHBOARD_RELATIVE_TIERS),
    'minutes_ago|{"count":1}'
  );
  assert.equal(
    at(59 * MIN, DASHBOARD_RELATIVE_TIERS),
    'minutes_ago|{"count":59}'
  );
  assert.equal(at(HOUR, DASHBOARD_RELATIVE_TIERS), 'hours_ago|{"count":1}');
  assert.equal(
    at(DAY - SEC, DASHBOARD_RELATIVE_TIERS),
    'hours_ago|{"count":23}'
  );
  assert.equal(at(DAY, DASHBOARD_RELATIVE_TIERS), "yesterday");
  assert.equal(at(2 * DAY, DASHBOARD_RELATIVE_TIERS), 'days_ago|{"count":2}');
  assert.equal(at(29 * DAY, DASHBOARD_RELATIVE_TIERS), 'days_ago|{"count":29}');
  assert.equal(
    at(30 * DAY, DASHBOARD_RELATIVE_TIERS),
    'months_ago|{"count":1}'
  );
  assert.equal(
    at(365 * DAY, DASHBOARD_RELATIVE_TIERS),
    'months_ago|{"count":12}'
  );
});

test("annotation cascade mirrors the dashboard with rel_ keys and no dash tier", () => {
  // ts=0 has no dash tier here, so it falls through to the months bucket
  // exactly like the original (which had no `!ts` guard).
  assert.equal(at(30 * SEC, ANNOTATION_RELATIVE_TIERS), "rel_just_now");
  assert.equal(
    at(5 * MIN, ANNOTATION_RELATIVE_TIERS),
    'rel_minutes|{"count":5}'
  );
  assert.equal(
    at(3 * HOUR, ANNOTATION_RELATIVE_TIERS),
    'rel_hours|{"count":3}'
  );
  assert.equal(at(DAY, ANNOTATION_RELATIVE_TIERS), "rel_yesterday");
  assert.equal(
    at(10 * DAY, ANNOTATION_RELATIVE_TIERS),
    'rel_days|{"count":10}'
  );
  assert.equal(
    at(90 * DAY, ANNOTATION_RELATIVE_TIERS),
    'rel_months|{"count":3}'
  );
});

test("diagnostics cascade keeps sub-second just-now, per-tier params, stringified values", () => {
  const opt = { stringify: true };
  assert.equal(at(500, DIAGNOSTICS_RELATIVE_TIERS, opt), "relative_just_now");
  // Stringified: the value is a quoted string, never grouped.
  assert.equal(
    at(5 * SEC, DIAGNOSTICS_RELATIVE_TIERS, opt),
    'relative_seconds_ago|{"seconds":"5"}'
  );
  assert.equal(
    at(59 * SEC, DIAGNOSTICS_RELATIVE_TIERS, opt),
    'relative_seconds_ago|{"seconds":"59"}'
  );
  assert.equal(
    at(5 * MIN, DIAGNOSTICS_RELATIVE_TIERS, opt),
    'relative_minutes_ago|{"minutes":"5"}'
  );
  // Tops out at hours — two days reads as 48h, like the original.
  assert.equal(
    at(2 * DAY, DIAGNOSTICS_RELATIVE_TIERS, opt),
    'relative_hours_ago|{"hours":"48"}'
  );
});

test("stats cascade is day-granular with a numeric (pluralisable) count", () => {
  // Same calendar day → today, regardless of hours elapsed.
  assert.equal(at(2 * HOUR, STATS_RELATIVE_TIERS), "today");
  assert.equal(at(DAY, STATS_RELATIVE_TIERS), "yesterday");
  // Count stays a NUMBER (unquoted) so the ICU plural in `days_ago` works.
  assert.equal(at(3 * DAY, STATS_RELATIVE_TIERS), 'days_ago|{"count":3}');
});

test("notification cascade reproduces the abbreviated, stringified output", () => {
  const opt = { stringify: true };
  assert.equal(at(30 * SEC, NOTIFICATION_RELATIVE_TIERS, opt), "time_just_now");
  assert.equal(
    at(5 * MIN, NOTIFICATION_RELATIVE_TIERS, opt),
    'time_minutes_ago|{"count":"5"}'
  );
  assert.equal(
    at(3 * HOUR, NOTIFICATION_RELATIVE_TIERS, opt),
    'time_hours_ago|{"count":"3"}'
  );
  assert.equal(
    at(5 * DAY, NOTIFICATION_RELATIVE_TIERS, opt),
    'time_days_ago|{"count":"5"}'
  );
  // No yesterday/months tier: one day still reads as a day count.
  assert.equal(
    at(DAY, NOTIFICATION_RELATIVE_TIERS, opt),
    'time_days_ago|{"count":"1"}'
  );
});

test("stringify flag controls the value's JS type at the boundary", () => {
  // The same elapsed span yields a numeric count without stringify…
  assert.equal(
    at(5 * MIN, NOTIFICATION_RELATIVE_TIERS),
    'time_minutes_ago|{"count":5}'
  );
  // …and a string count with it. This is the ICU-grouping / plural guard.
  assert.equal(
    at(5 * MIN, NOTIFICATION_RELATIVE_TIERS, { stringify: true }),
    'time_minutes_ago|{"count":"5"}'
  );
});
