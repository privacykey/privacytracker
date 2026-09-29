import assert from "node:assert/strict";
import test from "node:test";
import { TABLES_IN_INSERT_ORDER } from "../../lib/backup";
import db from "../../lib/db";
import {
  APP_DATA_TABLES_TO_TRUNCATE,
  SETTINGS_KEYS_KEPT_BY_WIPE,
  USER_DATA_TABLES_TO_TRUNCATE,
} from "../../lib/reset-tables";

const STALE_TABLE_NAMES = new Set(["import_batches", "manual_app_versions"]);

test("reset table registries do not contain removed legacy names", () => {
  for (const table of USER_DATA_TABLES_TO_TRUNCATE) {
    assert.equal(
      STALE_TABLE_NAMES.has(table),
      false,
      `${table} should not be reset directly`
    );
  }
});

test("the full wipe covers the app-data wipe plus devices, flags and logs", () => {
  for (const table of APP_DATA_TABLES_TO_TRUNCATE) {
    assert.equal(
      USER_DATA_TABLES_TO_TRUNCATE.includes(table),
      true,
      `the full wipe should include ${table}`
    );
  }
  for (const table of [
    "devices",
    "app_devices",
    "feature_flag_overrides",
    "audit_log",
    "ai_debug_log",
    "activity_log",
    "audit_bundle_imports",
  ] as const) {
    assert.equal(
      USER_DATA_TABLES_TO_TRUNCATE.includes(table),
      true,
      `the full wipe should include ${table}`
    );
  }
  // The dev helper deliberately keeps devices; only the full wipe drops them.
  assert.equal(
    (APP_DATA_TABLES_TO_TRUNCATE as readonly string[]).includes("devices"),
    false
  );
});

test("every table in the live schema is emptied by the full wipe", () => {
  // `app_settings` is emptied by its own statement (less the kept keys), so
  // it is the one table that is not in the list. Anything else missing here
  // is a table "Delete everything" would silently leave behind.
  const schemaTables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const covered = new Set<string>([
    ...USER_DATA_TABLES_TO_TRUNCATE,
    "app_settings",
  ]);
  const missing = schemaTables.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `tables the wipe leaves behind: ${missing}`);
  // And the backup's table list, which is the other definition of "all the
  // user's data", is covered too.
  const missingFromBackupList = TABLES_IN_INSERT_ORDER.filter(
    (name) => !covered.has(name)
  );
  assert.deepEqual(missingFromBackupList, []);
});

test("the wipe lists every table once, children before parents", () => {
  assert.equal(
    new Set(USER_DATA_TABLES_TO_TRUNCATE).size,
    USER_DATA_TABLES_TO_TRUNCATE.length
  );
  const at = (name: string) =>
    (USER_DATA_TABLES_TO_TRUNCATE as readonly string[]).indexOf(name);
  assert.ok(at("app_devices") < at("devices"));
  assert.ok(at("import_items") < at("imports"));
  assert.ok(at("privacy_categories") < at("privacy_types"));
});

test("only process bookkeeping survives in app_settings", () => {
  assert.deepEqual([...SETTINGS_KEYS_KEPT_BY_WIPE].sort(), [
    "feature_flag_migration_version",
    "runtime_environment",
  ]);
});
