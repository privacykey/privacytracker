import assert from "node:assert/strict";
import test from "node:test";
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
