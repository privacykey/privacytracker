// Central reset table registries. Keep child tables before their parents so
// explicit DELETE counts stay meaningful even when FK cascades would clean up.
//
// Mirrored in core/src/server/maintenance_writes.rs, in the same order: the
// maintenance oracle records every DELETE, so the two lists must agree.

export const APP_DATA_TABLES_TO_TRUNCATE = [
  "annotations",
  "app_verdicts",
  "privacy_data_types",
  "privacy_categories",
  "privacy_purposes",
  "privacy_types",
  "privacy_snapshots",
  "privacy_policy_versions",
  "privacy_policy_analyses",
  "change_review_actions",
  "accessibility_features",
  // Child of apps via FK cascade — listed here so test resets also
  // explicitly truncate the table, matching the convention for every
  // other apps-scoped child.
  "related_apps_observed",
  "manual_app_events",
  "manual_app_policy_versions",
  "manual_apps",
  "apps",
  "import_items",
  "imports",
  "audit_bundle_imports",
  "notifications",
  "activity_log",
  "shortlist_entries",
] as const;

/**
 * Every table "Delete everything" empties: both `/api/reset` and
 * `/api/admin/start-over` (lib/wipe-all-data.ts), which are one action.
 * The app-data wipe above, plus what only a full wipe removes: the devices
 * and their app links (device names, ECIDs, owner labels and permission
 * attestations are about real people), feature-flag overrides, the audit
 * trail and the AI debug log. `app_settings` is emptied separately, less
 * the keys in {@link SETTINGS_KEYS_KEPT_BY_WIPE}.
 *
 * `tests/app/reset-tables.test.ts` fails when a table in the live schema is
 * in neither this list nor `app_settings`, so a new table has to be
 * classified here before it can ship.
 */
export const USER_DATA_TABLES_TO_TRUNCATE = [
  ...APP_DATA_TABLES_TO_TRUNCATE,
  "app_devices",
  "devices",
  "feature_flag_overrides",
  "audit_log",
  "ai_debug_log",
] as const;

/**
 * `app_settings` keys a full wipe keeps. Neither is user data: both describe
 * this install's process, not its owner.
 *
 *   - `feature_flag_migration_version`: without it the next boot re-runs the
 *     flag migration over an empty table, which does nothing but add its
 *     `migration` rows to the freshly emptied activity log.
 *   - `runtime_environment`: written at boot ("desktop" or ""); dropping it
 *     would make a desktop install resolve its flags as the web build until
 *     the next restart.
 */
export const SETTINGS_KEYS_KEPT_BY_WIPE = [
  "feature_flag_migration_version",
  "runtime_environment",
] as const;
