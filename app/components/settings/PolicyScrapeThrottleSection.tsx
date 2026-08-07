"use client";

/**
 * Cooldown between policy re-scrapes per app. Inert while the
 * kill-switch above it is on — `scrapeDisabled` greys the inputs.
 *
 * Anchor id `policy-scrape-throttle` — see ./README.md on why ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function PolicyScrapeThrottleSection({
  handleScrapeThrottleBlur,
  saveScrapeThrottle,
  scrapeDisabled,
  scrapeThrottleAutoSave,
  scrapeThrottleEnabled,
  scrapeThrottleMinutes,
  setScrapeThrottleEnabled,
  setScrapeThrottleMinutes,
}: {
  handleScrapeThrottleBlur: () => void;
  saveScrapeThrottle: (next: { enabled: boolean; minutes: number }) => void;
  scrapeDisabled: boolean;
  scrapeThrottleAutoSave: ReturnType<
    typeof useSettingsAutoSave<{ enabled: boolean; minutes: number }>
  >;
  scrapeThrottleEnabled: boolean;
  scrapeThrottleMinutes: string;
  setScrapeThrottleEnabled: (next: boolean) => void;
  setScrapeThrottleMinutes: (next: string) => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tPolicyThrottle = useTranslations("settings.policy_throttle");

  return (
    <div className="settings-section" id="policy-scrape-throttle">
      <h2 className="settings-section-title">
        {tSections("policy_scrape_throttle")}
      </h2>
      <p className="settings-section-subtitle">
        {tSub("policy_scrape_throttle")}
      </p>
      {scrapeDisabled && (
        <p
          className="settings-section-subtitle"
          style={{ fontStyle: "italic", opacity: 0.7 }}
        >
          {tPolicyThrottle("throttle_inert_when_disabled")}
        </p>
      )}

      <label
        className="settings-field"
        style={{
          maxWidth: 420,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <input
          checked={scrapeThrottleEnabled}
          disabled={scrapeThrottleAutoSave.saving || scrapeDisabled}
          // Checkbox flips save immediately — discrete intent. Use
          // the latest minutes value (already validated on its own
          // blur) so toggling enabled→disabled→enabled keeps the
          // cooldown the user typed.
          onChange={(event) => {
            const enabled = event.target.checked;
            setScrapeThrottleEnabled(enabled);
            const parsed = Number.parseInt(scrapeThrottleMinutes, 10);
            const minutes = Number.isFinite(parsed)
              ? Math.min(10_080, Math.max(0, parsed))
              : 0;
            saveScrapeThrottle({ enabled, minutes });
          }}
          type="checkbox"
        />
        <span className="settings-field-label" style={{ margin: 0 }}>
          {tPolicyThrottle("enabled_label")}
        </span>
      </label>

      <label
        className="settings-field"
        style={{ maxWidth: 320, marginTop: 12 }}
      >
        <span className="settings-field-label">
          {tPolicyThrottle("cooldown_label")}
        </span>
        <input
          aria-describedby="policy-scrape-throttle-help"
          className="settings-input"
          disabled={
            !scrapeThrottleEnabled ||
            scrapeThrottleAutoSave.saving ||
            scrapeDisabled
          }
          max={10_080}
          min={0}
          // Auto-save on blur with validation. Same as the alert
          // input above — keystrokes update local state freely;
          // the POST only fires when the user tabs away.
          onBlur={handleScrapeThrottleBlur}
          onChange={(event) => setScrapeThrottleMinutes(event.target.value)}
          step={1}
          type="number"
          value={scrapeThrottleMinutes}
        />
        <span
          className="settings-field-help"
          id="policy-scrape-throttle-help"
          style={{ display: "block", marginTop: 4 }}
        >
          {tPolicyThrottle.rich("cooldown_help", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </span>
      </label>
    </div>
  );
}
