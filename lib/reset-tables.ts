// Central reset table registries. Keep child tables before their parents so
// explicit DELETE counts stay meaningful even when FK cascades would clean up.

export const APP_DATA_TABLES_TO_TRUNCATE = [
  'annotations',
  'app_verdicts',
  'privacy_data_types',
  'privacy_categories',
  'privacy_purposes',
  'privacy_types',
  'privacy_snapshots',
  'privacy_policy_versions',
  'privacy_policy_analyses',
  'change_review_actions',
  'accessibility_features',
  // Child of apps via FK cascade — listed here so test resets also
  // explicitly truncate the table, matching the convention for every
  // other apps-scoped child.
  'related_apps_observed',
  'manual_app_events',
  'manual_app_policy_versions',
  'manual_apps',
  'apps',
  'import_items',
  'imports',
  'audit_bundle_imports',
  'notifications',
  'activity_log',
  'shortlist_entries',
] as const;

export const START_OVER_TABLES_TO_TRUNCATE = [
  ...APP_DATA_TABLES_TO_TRUNCATE,
  'feature_flag_overrides',
  'audit_log',
  'ai_debug_log',
] as const;
