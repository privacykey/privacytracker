"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useModalFocus } from "../../lib/use-modal-focus";

/**
 * Double-confirm modal for the step-2 upfront diff. Shows the user the
 * blunt counts ("Removing 3, adding 2") and gives them one last chance
 * to back out. Continue commits; Back returns to the Step2DiffPanel
 * with selections preserved.
 *
 * Reuses the .modal-overlay / .modal-card chrome used elsewhere
 * (delete-confirms, audit-bundle preview, etc.) so visual feel is
 * consistent across the app.
 */

export interface Step2DiffConfirmModalProps {
  addCount: number;
  /** True while the commit fetch is in flight; disables the primary
   *  button + the close affordances to prevent double-submit. */
  busy: boolean;
  deviceName: string;
  onBack: () => void;
  onConfirm: () => void;
  open: boolean;
  removeCount: number;
}

export default function Step2DiffConfirmModal({
  open,
  addCount,
  removeCount,
  deviceName,
  busy,
  onConfirm,
  onBack,
}: Step2DiffConfirmModalProps) {
  const t = useTranslations("onboard.step2_diff.confirm");
  // closeOnEscape: false — the existing handler below guards on !busy so
  // Escape is blocked while the commit is in flight; the hook's generic
  // handler doesn't know about that guard, so we keep ownership here.
  const modalCardRef = useModalFocus<HTMLDivElement>({
    open,
    onClose: onBack,
    closeOnEscape: false,
  });

  // Escape closes only when not busy (commit in flight must not be cancelled).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onBack]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onBack();
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby="step2-diff-confirm-title"
        aria-modal="true"
        className="modal-card"
        ref={modalCardRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="modal-card-header">
          <h2 id="step2-diff-confirm-title">{t("title")}</h2>
          <button
            aria-label={t("close_aria")}
            className="modal-close"
            disabled={busy}
            onClick={onBack}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="modal-card-body">
          <p style={{ fontSize: 15, lineHeight: 1.5, margin: 0 }}>
            {t.rich("body", {
              removes: removeCount,
              adds: addCount,
              device: deviceName,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </div>
        <footer
          className="modal-card-footer"
          style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
        >
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={onBack}
            type="button"
          >
            {t("back")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? t("committing") : t("continue")}
          </button>
        </footer>
      </div>
    </div>
  );
}
