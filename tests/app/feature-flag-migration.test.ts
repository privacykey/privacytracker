import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { runFeatureFlagMigration } from "../../lib/migrations/v1_feature_flags";
import { getSetting, setSetting } from "../../lib/scheduler";

/**
 * Pins the `focus_goal_rename` migration step (MIGRATION_VERSION 2): existing
 * installs that stored the old goal keys (understand/declutter) get moved onto
 * the re-keyed names (monitor/cleanup) on first boot, idempotently.
 */
test("focus_goal_rename migration moves understand→monitor, declutter→cleanup", () => {
  const keys = [
    "feature_flag_migration_version",
    "flag.focus.goal.understand",
    "flag.focus.goal.declutter",
    "flag.focus.goal.monitor",
    "flag.focus.goal.cleanup",
  ];
  const prior = new Map(keys.map((key) => [key, getSetting(key, "")]));
  try {
    // Simulate a pre-rename install: old goal keys set, new keys empty, and
    // the migration version below the rename version so the step runs.
    setSetting("feature_flag_migration_version", "1");
    setSetting("flag.focus.goal.understand", "true");
    setSetting("flag.focus.goal.declutter", "true");
    setSetting("flag.focus.goal.monitor", "");
    setSetting("flag.focus.goal.cleanup", "");

    runFeatureFlagMigration();

    // Values moved onto the new keys; old keys dropped.
    assert.equal(getSetting("flag.focus.goal.monitor", ""), "true");
    assert.equal(getSetting("flag.focus.goal.cleanup", ""), "true");
    assert.equal(getSetting("flag.focus.goal.understand", ""), "");
    assert.equal(getSetting("flag.focus.goal.declutter", ""), "");
    assert.equal(getSetting("feature_flag_migration_version", ""), "2");

    // Idempotent: re-running from the pre-rename version with the old keys
    // already gone leaves the new keys intact (no clobber, no throw).
    setSetting("feature_flag_migration_version", "1");
    runFeatureFlagMigration();
    assert.equal(getSetting("flag.focus.goal.monitor", ""), "true");
    assert.equal(getSetting("flag.focus.goal.cleanup", ""), "true");
  } finally {
    for (const [key, value] of prior) {
      setSetting(key, value);
    }
  }
});

// A stored value a step cannot use must be dropped, not fail the step. A
// failed step leaves the version unwritten, and instrumentation.ts logs the
// error and boots on, so the same value failed the same step at every boot:
// the steps after it never ran, and each boot added its migration rows.

/** Read back for a key with no row, which `getSetting` cannot tell from "". */
const ABSENT = "(no row)";

/** Runs `body`, then puts each key back as it was, a missing row included. */
function withSettingsRestored(keys: string[], body: () => void): void {
  const prior = new Map(keys.map((key) => [key, getSetting(key, ABSENT)]));
  try {
    body();
  } finally {
    for (const [key, value] of prior) {
      if (value === ABSENT) {
        db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
      } else {
        setSetting(key, value);
      }
    }
  }
}

function failedMigrationRows(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM activity_log WHERE type = 'migration' AND status = 'error'"
    )
    .get() as { n: number };
  return row.n;
}

test("notification_prefs that is JSON but not an object is dropped, and the later steps run", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  // `null` failed its step (`Object.hasOwn(null, …)` throws); the others
  // named no types. Each is now dropped as unparseable JSON is.
  for (const blob of ["null", "[true]", "5", '"label_changes"', "false"]) {
    withSettingsRestored(
      [
        "feature_flag_migration_version",
        "notification_prefs",
        "flag.focus.goal.understand",
        "flag.focus.goal.monitor",
      ],
      () => {
        setSetting("feature_flag_migration_version", "1");
        setSetting("notification_prefs", blob);
        // The goal rename is the last step, so it runs only if the prefs
        // step before it gets through.
        setSetting("flag.focus.goal.understand", "true");
        setSetting("flag.focus.goal.monitor", "");
        const failedBefore = failedMigrationRows();
        warn.mock.resetCalls();

        assert.equal(runFeatureFlagMigration().length, 6, blob);

        assert.equal(getSetting("notification_prefs", ABSENT), ABSENT, blob);
        assert.equal(getSetting("flag.focus.goal.monitor", ""), "true", blob);
        assert.equal(getSetting("flag.focus.goal.understand", ABSENT), ABSENT);
        assert.equal(getSetting("feature_flag_migration_version", ""), "2");
        assert.equal(failedMigrationRows(), failedBefore, blob);
        assert.deepEqual(
          warn.mock.calls.map((call) => call.arguments[0]),
          ["[Migration] notification_prefs is not a JSON object, dropping"],
          blob
        );
        // The next boot finds the version written and does nothing.
        assert.deepEqual(runFeatureFlagMigration(), [], blob);
      }
    );
  }
});

test("a user_intent naming an inherited property is dropped as an unknown intent", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  // `INTENT_MAP[intent]` found the inherited member, whose audience is
  // undefined, so writing the focus failed the NOT NULL value column.
  for (const intent of [
    "toString",
    "valueOf",
    "constructor",
    "hasOwnProperty",
    "__proto__",
  ]) {
    withSettingsRestored(
      [
        "feature_flag_migration_version",
        "user_intent",
        "flag.focus.audience",
        "flag.focus.goal.understand",
        "flag.focus.goal.monitor",
      ],
      () => {
        setSetting("feature_flag_migration_version", "1");
        setSetting("user_intent", intent);
        setSetting("flag.focus.goal.understand", "true");
        setSetting("flag.focus.goal.monitor", "");
        const audience = getSetting("flag.focus.audience", ABSENT);
        const failedBefore = failedMigrationRows();
        warn.mock.resetCalls();

        assert.equal(runFeatureFlagMigration().length, 6, intent);

        assert.equal(getSetting("user_intent", ABSENT), ABSENT, intent);
        assert.equal(getSetting("flag.focus.audience", ABSENT), audience);
        assert.equal(getSetting("flag.focus.goal.monitor", ""), "true", intent);
        assert.equal(getSetting("feature_flag_migration_version", ""), "2");
        assert.equal(failedMigrationRows(), failedBefore, intent);
        assert.deepEqual(
          warn.mock.calls.map((call) => call.arguments[0]),
          [`[Migration] Unknown user_intent value '${intent}', skipping`],
          intent
        );
        assert.deepEqual(runFeatureFlagMigration(), [], intent);
      }
    );
  }
});
