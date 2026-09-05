"use client";

/**
 * Restore-a-backup dialog offered during onboarding.
 *
 * Distinct from the Settings restore dialog: this one exists so a
 * returning user can recover an install instead of re-importing from
 * scratch. Same three-phase shape though — preview what the file
 * contains, type the confirmation, then apply — because restoring the
 * wrong backup is unrecoverable.
 */

import { useTranslations } from "next-intl";
import type * as React from "react";
import type { OnboardRestorePreview, OnboardRestoreStage } from "./types";

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
  restoreModalCardRef,
}: {
  restoreStage: OnboardRestoreStage;
  /** Non-null by construction: the wizard only renders this once the
   *  server has returned a preview. */
  restorePreview: OnboardRestorePreview;
  restoreConfirmText: string;
  setRestoreConfirmText: (next: string) => void;
  restoreError: string;
  setRestoreError: (next: string) => void;
  pendingRestoreFilename: string | null;
  handleRestoreConfirm: () => void;
  resetRestoreFlow: () => void;
  restoreModalCardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tModalRestore = useTranslations("onboard.modals.restore_backup");

  return (
    <>
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
          aria-labelledby="onboard-restore-title"
          aria-modal="true"
          className="modal-card"
          onClick={(event) => event.stopPropagation()}
          ref={restoreModalCardRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="modal-badge">{tModalRestore("badge")}</div>
          <h2 className="modal-title" id="onboard-restore-title">
            {tModalRestore("title")}
          </h2>
          <p className="modal-copy">
            {pendingRestoreFilename ? (
              <>
                <strong>{pendingRestoreFilename}</strong>
                {restorePreview.exportedAt
                  ? tModalRestore("exported_suffix", {
                      date: new Date(
                        restorePreview.exportedAt
                      ).toLocaleDateString(),
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
            aria-label={tModalRestore("rows_per_table_aria")}
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
            {tModalRestore("warning")}
          </div>

          <label
            className="modal-confirm-label"
            htmlFor="onboard-restore-input"
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
            id="onboard-restore-input"
            onChange={(event) => {
              setRestoreConfirmText(event.target.value);
              if (restoreError) {
                setRestoreError("");
              }
            }}
            placeholder={tModalRestore("confirm_placeholder")}
            spellCheck={false}
            type="text"
            value={restoreConfirmText}
          />

          {restoreError && (
            <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>
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
    </>
  );
}
