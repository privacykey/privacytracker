"use client";

/**
 * The global policy-scrape kill-switch. Stronger than the throttle:
 * when on, fetchAndStorePolicySource short-circuits for every caller
 * except the explicit force path (see AGENTS.md).
 *
 * Anchor id `policy-scrape-disabled` — see ./README.md on why ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function PolicyScrapeKillSwitchSection({
  scrapeDisabled,
  scrapeDisabledAutoSave,
  setScrapeDisabled,
}: {
  scrapeDisabled: boolean;
  scrapeDisabledAutoSave: ReturnType<
    typeof useSettingsAutoSave<{ disabled: boolean }>
  >;
  setScrapeDisabled: (next: boolean) => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tPolicyThrottle = useTranslations("settings.policy_throttle");

  return (
    <div className="settings-section" id="policy-scrape-disabled">
      <h2 className="settings-section-title">
        {tSections("policy_scrape_disabled")}
      </h2>
      <p className="settings-section-subtitle">
        {tSub("policy_scrape_disabled")}
      </p>

      <label
        className="settings-field"
        style={{
          maxWidth: 480,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <input
          aria-describedby="policy-scrape-disabled-help"
          checked={scrapeDisabled}
          className="settings-checkbox"
          disabled={scrapeDisabledAutoSave.saving}
          onChange={(event) => {
            const disabled = event.target.checked;
            setScrapeDisabled(disabled);
            void scrapeDisabledAutoSave.save({ disabled });
          }}
          type="checkbox"
        />
        <span className="settings-field-label" style={{ margin: 0 }}>
          {tPolicyThrottle("scrape_disabled_label")}
        </span>
      </label>
      <span
        className="settings-field-help"
        id="policy-scrape-disabled-help"
        style={{ display: "block", marginTop: 8, maxWidth: 600 }}
      >
        {tPolicyThrottle.rich("scrape_disabled_help", {
          strong: (chunks) => <strong>{chunks}</strong>,
          em: (chunks) => <em>{chunks}</em>,
        })}
      </span>
    </div>
  );
}
