"use client";

/**
 * "Alert me when a privacy policy changed in the last N days" threshold.
 *
 * Auto-saves on blur rather than on change: the field is a number input,
 * so mid-edit values ("", "12x", a half-typed 3650) would otherwise fire
 * a write on every keystroke. Garbage stays local until focus leaves, and
 * the toast reports the outcome — there is no Save button.
 *
 * Anchor id `policy-alerts` matches the SettingsSidebar entry, and
 * `policy-diff-alert-days-help` is referenced by the input's
 * aria-describedby — see ./README.md on why these ids are load-bearing.
 */

import { useTranslations } from "next-intl";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export default function PolicyAlertsSection({
  days,
  setDays,
  autoSave,
  onBlur,
}: {
  /** Kept as a string so a mid-edit empty field doesn't coerce to 0. */
  days: string;
  setDays: (next: string) => void;
  autoSave: ReturnType<typeof useSettingsAutoSave<number>>;
  onBlur: () => void;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tPolicyAlerts = useTranslations("settings.policy_alerts");

  return (
    <div className="settings-section" id="policy-alerts">
      <h2 className="settings-section-title">
        {tSections("policy_change_alerts")}
      </h2>
      <p className="settings-section-subtitle">
        {tSub("policy_change_alerts")}
      </p>

      <label className="settings-field" style={{ maxWidth: 320 }}>
        <span className="settings-field-label">
          {tPolicyAlerts("field_label")}
        </span>
        <input
          aria-describedby="policy-diff-alert-days-help"
          className="settings-input"
          disabled={autoSave.saving}
          max={3650}
          min={0}
          onBlur={onBlur}
          onChange={(event) => setDays(event.target.value)}
          step={1}
          type="number"
          value={days}
        />
        <span
          className="settings-field-help"
          id="policy-diff-alert-days-help"
          style={{ display: "block", marginTop: 4 }}
        >
          {tPolicyAlerts.rich("field_help", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </span>
      </label>
    </div>
  );
}
