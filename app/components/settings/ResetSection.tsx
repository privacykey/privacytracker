"use client";

/**
 * Reset App — the destructive danger zone, deliberately the last section
 * on the page and in the sidebar so it never sits between routine admin
 * actions. Keep that position in sync with SettingsSidebar: the scroll-spy
 * walks sections in sidebar order and assumes it matches document order.
 *
 * Two distinct destructive actions live here. "Reset all data" wipes
 * everything; "Start over" preserves the DB schema and migration version,
 * so the next page load renders onboarding cleanly instead of re-running
 * migrations against a freshly-blank DB.
 *
 * Anchor id `reset` matches the SettingsSidebar entry — see ./README.md.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SyncStatus } from "./types";

export default function ResetSection({
  status,
  settingsAdminResetOn,
  settingsAdminStartOverOn,
  setResetStep,
  exportingBackup,
  handleExportBackup,
}: {
  /** A running sync blocks the destructive actions. */
  status: SyncStatus | null;
  settingsAdminResetOn: boolean;
  settingsAdminStartOverOn: boolean;
  /** Opens the multi-step reset confirmation owned by SettingsView. */
  setResetStep: (next: 0 | 1 | 2) => void;
  exportingBackup: boolean;
  handleExportBackup: () => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tResetCard = useTranslations("settings.reset_app_card");
  const tBackupCard = useTranslations("settings.backup_card");

  return (
    <div className="settings-section settings-section-danger" id="reset">
      <h2 className="settings-section-title">{tSections("reset_app")}</h2>
      <p className="settings-section-subtitle">{tSub("reset_app")}</p>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {settingsAdminResetOn && (
          <button
            className="btn btn-danger"
            disabled={Boolean(status?.isRunning)}
            onClick={() => setResetStep(1)}
            type="button"
          >
            {tResetCard("reset_button")}
          </button>
        )}

        {/* Round 3 PR 5: Start Over — same scope as Reset, but preserves
                the DB schema + migration version. Routes to /welcome on
                completion via the §4.10 hybrid-redirect. */}
        {settingsAdminStartOverOn && (
          <StartOverButton
            backupBusy={exportingBackup}
            backupBusyLabel={tBackupCard("download_busy")}
            backupLabel={tBackupCard("download_before_destructive")}
            disabled={Boolean(status?.isRunning)}
            onDownloadBackup={handleExportBackup}
          />
        )}
      </div>
      {status?.isRunning && (
        <p
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            marginTop: 12,
          }}
        >
          {tResetCard("wait_for_sync")}
        </p>
      )}
    </div>
  );
}

function StartOverButton({
  disabled,
  onDownloadBackup,
  backupBusy,
  backupLabel,
  backupBusyLabel,
}: {
  disabled: boolean;
  onDownloadBackup: () => void | Promise<void>;
  backupBusy: boolean;
  backupLabel: string;
  backupBusyLabel: string;
}) {
  const router = useRouter();
  // i18n — namespace lives next to the Reset App card so the two
  // danger-zone components share the same vocabulary in both
  // locale bundles.
  const t = useTranslations("settings.start_over");
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartOver() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/start-over", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      router.push("/welcome");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("default_error"));
      setSubmitting(false);
    }
  }

  if (step === 0) {
    return (
      <button
        className="btn btn-secondary"
        disabled={disabled}
        onClick={() => setStep(1)}
        type="button"
      >
        {t("trigger")}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 13 }}>
        {step === 1 ? t("step_1_prompt") : t("step_2_prompt")}
      </span>
      {step === 2 && (
        <div className="destructive-backup-offer destructive-backup-offer-inline">
          <div className="destructive-backup-copy">{t("backup_hint")}</div>
          <button
            className="btn btn-secondary"
            disabled={backupBusy || submitting}
            onClick={() => void onDownloadBackup()}
            type="button"
          >
            {backupBusy ? backupBusyLabel : backupLabel}
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {step === 1 ? (
          <button
            className="btn btn-danger"
            disabled={submitting}
            onClick={() => setStep(2)}
            type="button"
          >
            {t("step_1_confirm")}
          </button>
        ) : (
          <button
            className="btn btn-danger"
            disabled={submitting}
            onClick={() => void handleStartOver()}
            type="button"
          >
            {submitting ? t("wiping") : t("step_2_confirm")}
          </button>
        )}
        <button
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => setStep(0)}
          type="button"
        >
          {t("cancel")}
        </button>
      </div>
      {error && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </span>
      )}
    </div>
  );
}
