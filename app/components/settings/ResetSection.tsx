"use client";

/**
 * Reset App: the destructive danger zone, deliberately the last section
 * on the page and in the sidebar so it never sits between routine admin
 * actions. Keep that position in sync with SettingsSidebar: the scroll-spy
 * walks sections in sidebar order and assumes it matches document order.
 *
 * One action lives here: "Delete all data". It used to be two ("Reset all
 * data" and "Start over") that wiped different subsets while both promised
 * everything; the server now runs one wipe for both routes
 * (lib/wipe-all-data.ts), so the UI offers it once. The confirmation
 * dialog, which names what goes and asks for a typed word, is
 * ResetAppModal, owned by SettingsView.
 *
 * Either flag (`flag.settings.admin.reset`, `flag.settings.admin.start_over`)
 * shows it: both used to gate a full wipe, and one being off should not
 * hide the action the other still allows.
 *
 * Anchor id `reset` matches the SettingsSidebar entry — see ./README.md.
 */

import { useTranslations } from "next-intl";
import type { SyncStatus } from "./types";

export default function ResetSection({
  status,
  openResetModal,
}: {
  /** A running sync blocks the destructive action. */
  status: SyncStatus | null;
  /** Opens the confirmation owned by SettingsView. */
  openResetModal: () => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tResetCard = useTranslations("settings.reset_app_card");

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
        <button
          className="btn btn-danger"
          disabled={Boolean(status?.isRunning)}
          onClick={openResetModal}
          type="button"
        >
          {tResetCard("reset_button")}
        </button>
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
