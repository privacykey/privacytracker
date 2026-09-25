/**
 * "Delete everything": the one full wipe behind both `/api/reset` and
 * `/api/admin/start-over`. The two routes used to wipe different subsets
 * (neither removed devices; reset also kept the activity log, flag
 * overrides, audit-bundle imports and the AI debug log) while the UI
 * promised "everything". They now share this function, and Settings offers
 * them as one action.
 *
 * What goes:
 *   - every table in USER_DATA_TABLES_TO_TRUNCATE, devices and their app
 *     links included, inside one transaction;
 *   - every `app_settings` row except SETTINGS_KEYS_KEPT_BY_WIPE;
 *   - after the transaction commits, the automatic backup snapshots in
 *     `<data>/backups` and the backup signing key. Backup files the user
 *     downloaded are not touched; they restore afterwards as "untrusted".
 *
 * What stays: the schema, the two process keys above, and the one activity
 * row this function writes after the wipe (the route adds one audit row).
 *
 * Mirrored by `wipe_everything` in core/src/server/maintenance_writes.rs,
 * statement for statement; `core/tests/fixtures/maintenance-cases.json`
 * records both the writes and the files left behind.
 */

import { recordActivity } from "./activity";
import { deleteBackupSigningKey } from "./backup";
import { deleteAllBackupSnapshots } from "./backup-snapshots";
import db from "./db";
import {
  SETTINGS_KEYS_KEPT_BY_WIPE,
  USER_DATA_TABLES_TO_TRUNCATE,
} from "./reset-tables";

export type WipeMode = "reset" | "start-over";

export interface WipeResult {
  backupSnapshotsDeleted: number;
  signingKeyDeleted: boolean;
}

/**
 * Run the wipe. Throws if the database transaction fails, in which case it
 * rolled back and nothing on disk was touched. The file deletions and the
 * activity row are best-effort: by then the data is already gone.
 */
export function wipeAllUserData(mode: WipeMode, startedAt: number): WipeResult {
  const wipe = db.transaction(() => {
    for (const table of USER_DATA_TABLES_TO_TRUNCATE) {
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch (e) {
        // Table may not exist on older installs — log and continue.
        console.warn(`[${mode}] DELETE FROM ${table} skipped:`, e);
      }
    }
    const placeholders = SETTINGS_KEYS_KEPT_BY_WIPE.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM app_settings WHERE key NOT IN (${placeholders})`
    ).run(...SETTINGS_KEYS_KEPT_BY_WIPE);
  });
  wipe();

  const result: WipeResult = {
    backupSnapshotsDeleted: deleteAllBackupSnapshots(),
    signingKeyDeleted: deleteBackupSigningKey(),
  };

  // Written AFTER the wipe so the row is the one entry in the emptied log.
  try {
    recordActivity({
      type: "reset",
      status: "ok",
      summary: "Deleted all data on this install",
      detail: { mode, ...result },
      startedAt,
    });
  } catch (e) {
    console.warn(`[${mode}] activity-log failed:`, e);
  }
  return result;
}
