/**
 * Pins the update-check failure backoff.
 *
 * Before it existed, a failed live check stamped only the error — never
 * the clock — so with GitHub unreachable every subsequent call went back
 * to the network. On an offline install that meant a fetch attempt (plus
 * an 8s timeout) on every surface that reads update status, indefinitely.
 *
 * The backoff is deliberately one-sided: `force` (the user-initiated
 * ?refresh=1 path) bypasses it and keeps only its own 5-minute throttle,
 * because a human clicking "check now" is entitled to a real attempt.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setSetting } from "../../lib/scheduler";
import { checkForUpdate, failureBackoffMs } from "../../lib/update-check";

test("failureBackoffMs doubles per consecutive failure, capped at the TTL", () => {
  const MIN15 = 15 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  assert.equal(failureBackoffMs(0), 0);
  assert.equal(failureBackoffMs(1), MIN15);
  assert.equal(failureBackoffMs(2), 2 * MIN15);
  assert.equal(failureBackoffMs(3), 4 * MIN15);
  // 2^10 * 15min would be ~10.6 days — the cap holds it to the success TTL.
  assert.equal(failureBackoffMs(11), DAY);
  // Garbage in the settings row must not produce a negative or NaN window.
  assert.equal(failureBackoffMs(-3), 0);
});

test("a failed live check backs off; force still goes to the network", async (t) => {
  // Make the module's fetch fail fast and observably.
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetches += 1;
    return Promise.reject(new Error("simulated offline"));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // Clean slate: no cache, no prior failures, no force-throttle stamp.
  setSetting("update_last_checked", "0");
  setSetting("update_last_failed", "0");
  setSetting("update_fail_count", "0");
  setSetting("update_last_forced_check", "0");
  setSetting("update_check_enabled", "true");

  // First call: goes out, fails, records the failure.
  const first = await checkForUpdate();
  assert.equal(first.performed, true);
  assert.match(first.error ?? "", /simulated offline/);
  assert.equal(fetches, 1);

  // Second call: inside the backoff window — no network.
  const second = await checkForUpdate();
  assert.equal(second.performed, false);
  assert.equal(second.skipReason, "backoff");
  assert.equal(fetches, 1);

  // Forced call: bypasses the backoff (its own 5-min throttle was reset
  // above), goes out, fails again, and increments the failure count.
  const forced = await checkForUpdate({ force: true });
  assert.equal(forced.performed, true);
  assert.equal(fetches, 2);

  // And the consecutive-failure count grew, so the window widened.
  const third = await checkForUpdate();
  assert.equal(third.skipReason, "backoff");
  assert.equal(fetches, 2);
});
