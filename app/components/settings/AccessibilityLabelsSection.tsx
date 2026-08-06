"use client";

/**
 * The accessibility-labels sync toggle: whether re-syncs also scrape
 * each app's accessibility declarations.
 *
 * Anchor id `accessibility-labels` — see ./README.md on why ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function AccessibilityLabelsSection({
  saveTrackAccessibility,
  trackAccessibility,
  trackAccessibilityAutoSave,
}: {
  saveTrackAccessibility: (next: boolean) => void;
  trackAccessibility: boolean;
  trackAccessibilityAutoSave: ReturnType<typeof useSettingsAutoSave<boolean>>;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tA11yLabels = useTranslations("settings.accessibility_labels_card");

  return (
    <div className="settings-section" id="accessibility-labels">
      <h2 className="settings-section-title">
        {tSections("accessibility_labels")}
      </h2>
      <p className="settings-section-subtitle">
        {tSub("accessibility_labels")}
      </p>

      <label className="settings-checkbox-row">
        <input
          checked={trackAccessibility}
          className="settings-checkbox"
          disabled={trackAccessibilityAutoSave.saving}
          onChange={(event) =>
            void saveTrackAccessibility(event.target.checked)
          }
          type="checkbox"
        />
        <span>
          {tA11yLabels("checkbox_lead")}
          <span
            className="settings-field-help"
            style={{ display: "block", marginTop: 4 }}
          >
            {tA11yLabels("checkbox_help")}
          </span>
        </span>
      </label>
    </div>
  );
}
