import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_DATA_TABLES_TO_TRUNCATE,
  START_OVER_TABLES_TO_TRUNCATE,
} from "../../lib/reset-tables";

const STALE_TABLE_NAMES = new Set(["import_batches", "manual_app_versions"]);

test("reset table registries do not contain removed legacy names", () => {
  for (const table of START_OVER_TABLES_TO_TRUNCATE) {
    assert.equal(
      STALE_TABLE_NAMES.has(table),
      false,
      `${table} should not be reset directly`
    );
  }
});

test("start-over reset covers the app-data wipe plus full user settings state", () => {
  for (const table of APP_DATA_TABLES_TO_TRUNCATE) {
    assert.equal(
      START_OVER_TABLES_TO_TRUNCATE.includes(table),
      true,
      `start-over should include ${table}`
    );
  }

  assert.equal(
    START_OVER_TABLES_TO_TRUNCATE.includes("feature_flag_overrides"),
    true
  );
  assert.equal(START_OVER_TABLES_TO_TRUNCATE.includes("audit_log"), true);
  assert.equal(START_OVER_TABLES_TO_TRUNCATE.includes("ai_debug_log"), true);
});
