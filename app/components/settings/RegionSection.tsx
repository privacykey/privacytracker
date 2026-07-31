"use client";

/**
 * App Store storefront picker. The storefront decides which regional
 * App Store the scraper reads, so changing it changes what privacy
 * labels come back for every tracked app.
 *
 * Auto-saves on change: local state updates synchronously so the select
 * stays responsive, then the POST fires and its toast reports the
 * outcome. There is no Save button — the "current" badge compares
 * against `savedCountry` so you can tell what is actually persisted
 * while a save is in flight.
 *
 * Anchor id `region` matches the SettingsSidebar entry, and the
 * `app-country` input id is referenced by its own label — see
 * ./README.md on why these ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import { COUNTRY_OPTIONS, normalizeCountry } from "@/lib/region";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import LanguageSuggestionBanner from "../LanguageSuggestionBanner";
import type { LanguageSuggestion } from "./types";

export default function RegionSection({
  country,
  setCountry,
  savedCountry,
  autoSave,
  languageSuggestion,
  onDismissLanguageSuggestion,
}: {
  country: string;
  setCountry: (next: string) => void;
  /** What the server currently has; drives the "current" badge. */
  savedCountry: string;
  autoSave: ReturnType<typeof useSettingsAutoSave<string>>;
  /** Set after a region save when the new storefront's expected language
   *  differs from the active UI locale; null when there's nothing to
   *  suggest. */
  languageSuggestion: LanguageSuggestion | null;
  onDismissLanguageSuggestion: () => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tRegion = useTranslations("settings.region");

  return (
    <div className="settings-section" id="region">
      <h2 className="settings-section-title">
        {tSections("app_store_region")}
      </h2>
      <p className="settings-section-subtitle">{tSub("app_store_region")}</p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
        }}
      >
        <label
          htmlFor="app-country"
          style={{ fontSize: 14, color: "var(--text-2)" }}
        >
          {tRegion("storefront_label")}
        </label>
        <select
          className="settings-select"
          disabled={autoSave.saving}
          id="app-country"
          onChange={(e) => {
            const next = normalizeCountry(e.target.value);
            setCountry(next);
            void autoSave.save(next);
          }}
          style={{ minWidth: 220 }}
          value={country}
        >
          {COUNTRY_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label} ({opt.code.toUpperCase()})
            </option>
          ))}
        </select>

        {country === savedCountry && (
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tRegion("current")}
          </span>
        )}
      </div>

      {/* Hits /api/locale on click (same path as the LocaleSwitcher) and
          reloads; dismissing clears it until the next region change. */}
      {languageSuggestion && (
        <LanguageSuggestionBanner
          onDismiss={onDismissLanguageSuggestion}
          target={languageSuggestion}
        />
      )}
    </div>
  );
}
