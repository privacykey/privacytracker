"use client";

/**
 * Confirm dialog for restoring a backup file.
 *
 * Deliberately the heaviest of the five: restoring replaces the whole
 * database, so the user sees what the server found in the file (app and
 * snapshot counts, any warnings) and has to type the confirmation phrase
 * before the button enables. `applying` disables every dismiss path so a
 * half-applied restore can't be interrupted.
 */

import { useTranslations } from "next-intl";
import type { DateFormatMode } from "@/lib/date-format";
import type { useModalFocus } from "@/lib/use-modal-focus";
import { fmtShortDate } from "./format";
import type { BackupRestorePreview, BackupRestoreStage } from "./types";

export default function RestoreBackupModal({
  restoreStage,
  restorePreview,
  restoreConfirmText,
  setRestoreConfirmText,
  restoreError,
  setRestoreError,
  pendingRestoreFilename,
  handleRestoreConfirm,
  resetRestoreFlow,
  restoreModalRef,
  exportingBackup,
  handleExportBackup,
  dateMode,
}: {
  restoreStage: BackupRestoreStage;
  restorePreview: BackupRestorePreview | null;
  restoreConfirmText: string;
  setRestoreConfirmText: (next: string) => void;
  restoreError: string;
  setRestoreError: (next: string) => void;
  pendingRestoreFilename: string | null;
  handleRestoreConfirm: () => void;
  resetRestoreFlow: () => void;
  restoreModalRef: ReturnType<typeof useModalFocus<HTMLDivElement>>;
  exportingBackup: boolean;
  handleExportBackup: () => void;
  dateMode: DateFormatMode;
}) {
  const tAria = useTranslations("settings.aria");
  const tPh = useTranslations("settings.placeholders");
  const tBackupCard = useTranslations("settings.backup_card");
  const tModalRestore = useTranslations("settings.modals.restore_backup");

  return (
    <>
      {(restoreStage === "confirm" || restoreStage === "applying") &&
        restorePreview && (
          <div
            className="modal-overlay"
            onClick={() => {
              if (restoreStage !== "applying") {
                resetRestoreFlow();
              }
            }}
          >
            <div
              aria-labelledby="restore-backup-title"
              aria-modal="true"
              className="modal-card"
              onClick={(event) => event.stopPropagation()}
              ref={restoreModalRef}
              role="dialog"
              tabIndex={-1}
            >
              <div className="modal-badge">{tModalRestore("badge")}</div>
              <h2 className="modal-title" id="restore-backup-title">
                {tModalRestore("title")}
              </h2>
              <p className="modal-copy">
                {pendingRestoreFilename ? (
                  <>
                    <strong>{pendingRestoreFilename}</strong>
                    {restorePreview.exportedAt
                      ? tModalRestore("exported_suffix", {
                          date: fmtShortDate(
                            restorePreview.exportedAt,
                            dateMode
                          ),
                        })
                      : null}{" "}
                    {tModalRestore("version_suffix", {
                      version: restorePreview.version,
                    })}{" "}
                    {tModalRestore("rows", { count: restorePreview.totalRows })}
                  </>
                ) : (
                  tModalRestore("no_filename", {
                    count: restorePreview.totalRows,
                    tables: restorePreview.perTable.length,
                  })
                )}
              </p>

              <div
                aria-label={tAria("rows_per_table")}
                className="backup-preview-table"
              >
                {restorePreview.perTable
                  .filter((row) => row.rows > 0)
                  .map((row) => (
                    <div className="backup-preview-row" key={row.name}>
                      <span className="backup-preview-name">{row.name}</span>
                      <span className="backup-preview-count">
                        {row.rows.toLocaleString()}
                      </span>
                    </div>
                  ))}
              </div>

              {restorePreview.warnings.length > 0 && (
                <ul className="backup-preview-warnings">
                  {restorePreview.warnings.map((warning, index) => (
                    <li key={index}>⚠ {warning}</li>
                  ))}
                </ul>
              )}

              <div className="modal-warning" style={{ marginTop: 12 }}>
                <strong>{tModalRestore("warning_lead")}</strong>
                {tModalRestore("warning_body")}
              </div>

              <div className="destructive-backup-offer">
                <div className="destructive-backup-copy">
                  {tBackupCard("download_current_before_restore")}
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={exportingBackup || restoreStage === "applying"}
                  onClick={handleExportBackup}
                  type="button"
                >
                  {exportingBackup
                    ? tBackupCard("download_busy")
                    : tBackupCard("download_before_destructive")}
                </button>
              </div>

              <label
                className="modal-confirm-label"
                htmlFor="restore-confirm-input"
              >
                {tModalRestore.rich("confirm_label", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </label>
              <input
                autoComplete="off"
                autoCorrect="off"
                className="modal-confirm-input"
                disabled={restoreStage === "applying"}
                id="restore-confirm-input"
                onChange={(event) => {
                  setRestoreConfirmText(event.target.value);
                  if (restoreError) {
                    setRestoreError("");
                  }
                }}
                placeholder={tPh("restore_confirm")}
                spellCheck={false}
                type="text"
                value={restoreConfirmText}
              />

              {restoreError && (
                <p
                  style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}
                >
                  {restoreError}
                </p>
              )}

              <div className="modal-actions">
                <button
                  className="btn btn-ghost"
                  disabled={restoreStage === "applying"}
                  onClick={resetRestoreFlow}
                  type="button"
                >
                  {tModalRestore("cancel")}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={
                    restoreStage === "applying" ||
                    restoreConfirmText.trim().toUpperCase() !== "RESTORE"
                  }
                  onClick={handleRestoreConfirm}
                  type="button"
                >
                  {restoreStage === "applying"
                    ? tModalRestore("restoring")
                    : tModalRestore("confirm")}
                </button>
              </div>
            </div>
          </div>
        )}
    </>
  );
}
