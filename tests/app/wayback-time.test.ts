import assert from "node:assert/strict";
import test from "node:test";
import {
  describeWaybackDuration,
  formatWaybackClockTime,
  parseRetryAfterMs,
} from "../../lib/wayback-time";

const MINUTE = 60_000;
// Local wall-clock times, so the assertions hold in any time zone.
const NOW = new Date(2026, 9, 8, 13, 50).getTime();
const AT_1432 = new Date(2026, 9, 8, 14, 32).getTime();

test("a clock time today is the time alone", () => {
  assert.equal(formatWaybackClockTime(AT_1432, "iso", NOW), "14:32");
  assert.equal(formatWaybackClockTime(AT_1432, "dmy", NOW), "14:32");
  assert.match(formatWaybackClockTime(AT_1432, "mdy", NOW), /^2:32\sPM$/u);
  assert.match(formatWaybackClockTime(AT_1432, "auto", NOW), /32/);
});

test("a clock time on another day carries its date", () => {
  const tomorrow = new Date(2026, 9, 9, 0, 15).getTime();
  assert.equal(
    formatWaybackClockTime(tomorrow, "iso", NOW),
    "2026-10-09 00:15"
  );
});

test("a clock time that is not a number formats as nothing", () => {
  assert.equal(formatWaybackClockTime(Number.NaN, "iso", NOW), "");
});

test("durations round to what an estimate can claim", () => {
  assert.equal(describeWaybackDuration(0), null);
  assert.equal(describeWaybackDuration(-5 * MINUTE), null);
  assert.equal(describeWaybackDuration(Number.NaN), null);
  assert.deepEqual(describeWaybackDuration(20_000), {
    key: "duration_under_minute",
  });
  assert.deepEqual(describeWaybackDuration(40_000), {
    key: "duration_minutes",
    values: { minutes: 1 },
  });
  assert.deepEqual(describeWaybackDuration(25 * MINUTE), {
    key: "duration_minutes",
    values: { minutes: 25 },
  });
  assert.deepEqual(describeWaybackDuration(59.4 * MINUTE), {
    key: "duration_minutes",
    values: { minutes: 59 },
  });
  assert.deepEqual(describeWaybackDuration(59.6 * MINUTE), {
    key: "duration_hours",
    values: { hours: 1 },
  });
  // Above an hour, the nearest 5 minutes.
  assert.deepEqual(describeWaybackDuration(112 * MINUTE), {
    key: "duration_hours_minutes",
    values: { hours: 1, minutes: 50 },
  });
  assert.deepEqual(describeWaybackDuration(118 * MINUTE), {
    key: "duration_hours",
    values: { hours: 2 },
  });
  assert.deepEqual(describeWaybackDuration(598 * MINUTE), {
    key: "duration_hours",
    values: { hours: 10 },
  });
  // Above ten hours, the nearest hour.
  assert.deepEqual(describeWaybackDuration(680 * MINUTE), {
    key: "duration_hours",
    values: { hours: 11 },
  });
});

test("the body's retryAfterMs wins over the Retry-After header", () => {
  assert.equal(parseRetryAfterMs(90_000, "30", NOW), 90_000);
});

test("the Retry-After header stands in when the body has no delay", () => {
  // Node omits the key, Rust sends null; both mean "ask the header".
  assert.equal(parseRetryAfterMs(undefined, "120", NOW), 120_000);
  assert.equal(parseRetryAfterMs(null, " 45 ", NOW), 45_000);
  assert.equal(parseRetryAfterMs(0, "60", NOW), 60_000);
  const date = new Date(NOW + 5 * MINUTE).toUTCString();
  const fromDate = parseRetryAfterMs(null, date, NOW);
  assert.ok(fromDate !== null && Math.abs(fromDate - 5 * MINUTE) < 1000);
});

test("no usable delay anywhere reads as unknown", () => {
  assert.equal(parseRetryAfterMs(undefined, null, NOW), null);
  assert.equal(parseRetryAfterMs(-1, "", NOW), null);
  assert.equal(parseRetryAfterMs("90000", "0", NOW), null);
  assert.equal(parseRetryAfterMs(null, "soon", NOW), null);
  assert.equal(
    parseRetryAfterMs(null, new Date(NOW - MINUTE).toUTCString(), NOW),
    null
  );
});
