"use client";

/**
 * Backup & Restore — export the database as a file, restore one back, and
 * configure automatic snapshots.
 *
 * The restore flow is three-phase (pick a file, preview what the server
 * found in it, confirm), which is why `restoreStage` is a state machine
 * rather than a boolean: restoring the wrong backup is unrecoverable, so
 * the preview step is not skippable.
 *
 * Anchor id `backup` matches the SettingsSidebar entry — see ./README.md.
 */

import { useTranslations } from "next-intl";
import type { Dispatch, SetStateAction } from "react";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import AuditBundleImport from "../AuditBundleImport";
import { fmtBytes, fmtDate } from "./format";
import type {
  BackupRestoreStage,
  BackupSnapshotRow,
  BackupSnapshotSettings,
  SyncStatus,
} from "./types";

export default function BackupSection({
  status,
  exportingBackup,
  handleExportBackup,
  restoreStage,
  restoreError,
  handleRestoreFileChosen,
  backupSnapshotSettings,
  setBackupSnapshotSettings,
  saveBackupSnapshots,
  backupSnapshotsAutoSave,
  backupSnapshots,
  backupSnapshotDirectory,
  creatingBackupSnapshot,
  handleCreateBackupSnapshot,
}: {
  /** Sync status — a running sync blocks restore, which would race it. */
  status: SyncStatus | null;
  exportingBackup: boolean;
  handleExportBackup: () => void;
  /** Where the three-phase restore currently is. */
  restoreStage: BackupRestoreStage;
  restoreError: string;
  handleRestoreFileChosen: (file: File) => void;
  backupSnapshotSettings: BackupSnapshotSettings;
  setBackupSnapshotSettings: Dispatch<SetStateAction<BackupSnapshotSettings>>;
  saveBackupSnapshots: (next: {
    enabled: boolean;
    intervalHours: number;
    retentionCount: number;
  }) => void;
  backupSnapshotsAutoSave: ReturnType<
    typeof useSettingsAutoSave<BackupSnapshotSettings>
  >;
  backupSnapshots: BackupSnapshotRow[];
  backupSnapshotDirectory: string;
  creatingBackupSnapshot: boolean;
  handleCreateBackupSnapshot: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tBackupCard = useTranslations("settings.backup_card");

  return (
    <div className="settings-section" id="backup">
      <h2 className="settings-section-title">{tSections("backup_restore")}</h2>
      <p className="settings-section-subtitle">{tSub("backup_restore")}</p>

      <div className="backup-grid">
        <div className="backup-card">
          <div className="backup-card-title">
            {tBackupCard("download_title")}
          </div>
          <p className="backup-card-copy">{tBackupCard("download_copy")}</p>
          <button
            className="btn btn-secondary"
            disabled={exportingBackup}
            onClick={handleExportBackup}
            type="button"
          >
            {exportingBackup
              ? tBackupCard("download_busy")
              : tBackupCard("download_button")}
          </button>
        </div>

        <div className="backup-card">
          <div className="backup-card-title">
            {tBackupCard("restore_title")}
          </div>
          <p className="backup-card-copy">
            {tBackupCard("restore_copy_lead")}{" "}
            <strong>{tBackupCard("restore_copy_strong")}</strong>{" "}
            {tBackupCard("restore_copy_after")}
          </p>
          <label
            className={`btn btn-secondary${status?.isRunning || restoreStage === "previewing" || restoreStage === "applying" ? "is-disabled" : ""}`}
            style={{
              cursor: status?.isRunning ? "not-allowed" : "pointer",
            }}
          >
            {restoreStage === "previewing"
              ? tBackupCard("restore_busy")
              : tBackupCard("restore_choose")}
            <input
              accept="application/json,.json"
              disabled={
                Boolean(status?.isRunning) ||
                restoreStage === "previewing" ||
                restoreStage === "applying"
              }
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Clear the input so choosing the same filename twice still
                // triggers onChange (common UX pain with <input type="file">).
                event.target.value = "";
                if (file) {
                  handleRestoreFileChosen(file);
                }
              }}
              style={{ display: "none" }}
              type="file"
            />
          </label>
          {status?.isRunning && (
            <p
              style={{
                fontSize: 12,
                color: "var(--text-3)",
                marginTop: 8,
              }}
            >
              {tBackupCard("wait_for_sync")}
            </p>
          )}
          {restoreError && restoreStage === "idle" && (
            <p
              style={{
                fontSize: 12,
                color: "var(--danger)",
                marginTop: 8,
              }}
            >
              {restoreError}
            </p>
          )}
        </div>
      </div>

      <div className="backup-snapshot-panel">
        <div className="backup-snapshot-header">
          <div>
            <div className="backup-card-title">
              {tBackupCard("snapshots_title")}
            </div>
            <p className="backup-snapshot-copy">
              {tBackupCard("snapshots_copy")}
            </p>
          </div>
          <span
            className={`backup-snapshot-state${backupSnapshotSettings.enabled ? " is-on" : ""}`}
          >
            {backupSnapshotSettings.enabled
              ? tBackupCard("snapshots_state_on")
              : tBackupCard("snapshots_state_off")}
          </span>
        </div>

        <label className="settings-checkbox-row backup-snapshot-toggle">
          <input
            checked={backupSnapshotSettings.enabled}
            className="settings-checkbox"
            disabled={backupSnapshotsAutoSave.saving}
            // Auto-save: flipping enabled saves immediately with the
            // existing interval/retention values. The PUT route
            // returns the persisted blob which we re-baseline via
            // applyBackupSnapshotPayload (handles clamping etc.).
            onChange={(event) => {
              const enabled = event.target.checked;
              setBackupSnapshotSettings((prev) => ({
                ...prev,
                enabled,
              }));
              saveBackupSnapshots({
                enabled,
                intervalHours: backupSnapshotSettings.intervalHours,
                retentionCount: backupSnapshotSettings.retentionCount,
              });
            }}
            type="checkbox"
          />
          <span>
            <span className="settings-field-label">
              {tBackupCard("snapshots_enabled_label")}
            </span>
            <span
              className="settings-field-help"
              style={{ display: "block", marginTop: 4 }}
            >
              {tBackupCard("snapshots_enabled_help")}
            </span>
          </span>
        </label>

        <div className="settings-field-grid backup-snapshot-controls">
          <label className="settings-field">
            <span className="settings-field-label">
              {tBackupCard("snapshots_interval_label")}
            </span>
            <select
              className="settings-input settings-select"
              disabled={backupSnapshotsAutoSave.saving}
              // Discrete dropdown → save on change.
              onChange={(event) => {
                const intervalHours = Number(event.target.value);
                setBackupSnapshotSettings((prev) => ({
                  ...prev,
                  intervalHours,
                }));
                saveBackupSnapshots({
                  enabled: backupSnapshotSettings.enabled,
                  intervalHours,
                  retentionCount: backupSnapshotSettings.retentionCount,
                });
              }}
              value={backupSnapshotSettings.intervalHours}
            >
              <option value={6}>{tBackupCard("snapshots_interval_6h")}</option>
              <option value={12}>
                {tBackupCard("snapshots_interval_12h")}
              </option>
              <option value={24}>
                {tBackupCard("snapshots_interval_24h")}
              </option>
              <option value={168}>
                {tBackupCard("snapshots_interval_168h")}
              </option>
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">
              {tBackupCard("snapshots_retention_label")}
            </span>
            <input
              className="settings-input"
              disabled={backupSnapshotsAutoSave.saving}
              max={100}
              min={1}
              // Numeric → save on blur. The clamp above already
              // guarantees 1..100 by the time we get here.
              onBlur={() => {
                saveBackupSnapshots({
                  enabled: backupSnapshotSettings.enabled,
                  intervalHours: backupSnapshotSettings.intervalHours,
                  retentionCount: backupSnapshotSettings.retentionCount,
                });
              }}
              onChange={(event) => {
                const raw = Number.parseInt(event.target.value, 10);
                const retentionCount = Number.isFinite(raw)
                  ? Math.min(100, Math.max(1, raw))
                  : 1;
                setBackupSnapshotSettings((prev) => ({
                  ...prev,
                  retentionCount,
                }));
              }}
              type="number"
              value={backupSnapshotSettings.retentionCount}
            />
          </label>
        </div>

        <div className="backup-snapshot-actions">
          {/* Save button removed — fields auto-save above. The
                "Create snapshot now" button stays since it's a
                separate action (POST creates a fresh snapshot rather
                than persisting settings). */}
          <button
            className="btn btn-secondary"
            disabled={creatingBackupSnapshot}
            onClick={() => void handleCreateBackupSnapshot()}
            type="button"
          >
            {creatingBackupSnapshot
              ? tBackupCard("snapshots_creating")
              : tBackupCard("snapshots_create")}
          </button>
        </div>

        <dl className="backup-snapshot-meta">
          <div>
            <dt>{tBackupCard("snapshots_directory")}</dt>
            <dd>
              <code title={backupSnapshotDirectory}>
                {backupSnapshotDirectory ||
                  tBackupCard("snapshots_directory_empty")}
              </code>
            </dd>
          </div>
          <div>
            <dt>{tBackupCard("snapshots_last")}</dt>
            <dd>
              {backupSnapshotSettings.lastRunAt
                ? fmtDate(tSettings, backupSnapshotSettings.lastRunAt)
                : tBackupCard("snapshots_never")}
            </dd>
          </div>
          <div>
            <dt>{tBackupCard("snapshots_next")}</dt>
            <dd>
              {backupSnapshotSettings.enabled
                ? backupSnapshotSettings.nextRunAt
                  ? fmtDate(tSettings, backupSnapshotSettings.nextRunAt)
                  : tBackupCard("snapshots_next_due")
                : tBackupCard("snapshots_not_scheduled")}
            </dd>
          </div>
        </dl>

        <div className="backup-snapshot-list-heading">
          {tBackupCard("snapshots_latest")}
        </div>
        {backupSnapshots.length === 0 ? (
          <p className="backup-snapshot-empty">
            {tBackupCard("snapshots_none")}
          </p>
        ) : (
          <div className="backup-snapshot-list">
            {backupSnapshots.slice(0, 5).map((row) => (
              <div className="backup-snapshot-row" key={row.filename}>
                <div className="backup-snapshot-file">
                  <strong>{row.filename}</strong>
                  <span>
                    {tBackupCard("snapshots_file_meta", {
                      date: fmtDate(tSettings, row.createdAt),
                      size: fmtBytes(row.sizeBytes),
                    })}
                  </span>
                </div>
                <a
                  className="btn btn-secondary backup-snapshot-download"
                  download={row.filename}
                  href={`/api/backup/snapshots/${encodeURIComponent(row.filename)}`}
                >
                  {tBackupCard("snapshots_download")}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      <p
        style={{
          fontSize: 12,
          color: "var(--text-3)",
          marginTop: 12,
        }}
      >
        {tBackupCard("destructive_hint")}
      </p>

      {/*
          Audit-bundle import — counterpart to the export button down in
          "Export Data". Lives in the Backup & Restore section because
          (a) it's the symmetric "receive a file someone shared with
          you" surface, and (b) it shares the same ?confirm=preview-then-
          commit pattern as the database restore flow above. The
          underlying merge is non-destructive (apps you have stay,
          notes get appended) — see lib/audit-bundle-import.ts §4.8.
        */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px solid var(--border)",
        }}
      >
        <AuditBundleImport />
      </div>
    </div>
  );
}
