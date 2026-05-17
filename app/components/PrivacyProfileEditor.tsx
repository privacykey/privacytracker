"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { categoryLabel } from "../../lib/i18n-meta";
import { CATEGORY_META } from "../../lib/privacy-meta";
import {
  matchPreset,
  PROFILE_CATEGORY_KEYS,
  PROFILE_PRESET_KEYS,
  PROFILE_PRESET_META,
  PROFILE_PRESETS,
  PROFILE_TIERS,
  type PrivacyProfile,
  type ProfilePresetKey,
  type ProfileTier,
  TIER_META,
} from "../../lib/privacy-profile";

interface Props {
  /**
   * When true (default), clicking a preset that would overwrite an existing
   * non-matching profile shows an inline confirm before applying. Onboarding's
   * first-time path passes `false` — the editor's preloaded default isn't
   * something we need to protect from accidental clicks.
   */
  confirmOnPresetApply?: boolean;
  /** Disables every input while a save/fetch is in flight. */
  disabled?: boolean;
  /** Fires with the full new profile on every edit. Parent owns persistence. */
  onChange: (next: PrivacyProfile) => void;
  /** Current (possibly sparse) profile. Categories missing a tier are "no preference". */
  value: PrivacyProfile;
}

/**
 * Per-category threshold picker.
 *
 * Each row mirrors the Apple App Store privacy card: the category label on
 * the left, four text pills on the right — "Not collected", "Not linked",
 * "Linked", "Tracking" — and a fifth "No preference" pill to opt the row
 * out of comparison entirely. The user clicks the pill that represents the
 * WORST tier they'll tolerate for that category.
 *
 * Selected pills are coloured by tier to match the severity palette used
 * everywhere else in the app (stats heatmap, severity badges, freshness
 * pills): green for "not collected", yellow for "not linked", orange for
 * "linked", red for "tracking". This way the picker reads as a visual
 * gradient from strict (green, left) to permissive (red, right), and the
 * chosen pill's colour reinforces how invasive the threshold is at a
 * glance. Unselected pills stay neutral. CSS picks the colour up via
 * `data-tier={tier}` on each pill.
 */

export default function PrivacyProfileEditor({
  value,
  onChange,
  disabled,
  confirmOnPresetApply = true,
}: Props) {
  // i18n — category labels in the editor rows + their aria-labels.
  // CATEGORY_META still drives icon + description (translation of the
  // descriptions is tracked separately).
  const tCat = useTranslations("category");
  const tEd = useTranslations("settings.profile_editor");
  const tPre = useTranslations("settings.profile_editor.presets");
  const tPreLabel = useTranslations("settings.profile_editor.presets.labels");
  const tPreDesc = useTranslations(
    "settings.profile_editor.presets.descriptions"
  );

  // Stable list of rows so the DOM doesn't flicker when the user toggles a
  // single category. Category key order is whatever CATEGORY_META declares
  // — which is the order the App Store presents them in as well.
  const rows = useMemo(
    () =>
      PROFILE_CATEGORY_KEYS.map((key) => ({
        key,
        meta: CATEGORY_META[key],
      })),
    []
  );

  // Which preset (if any) the current state matches exactly. Used to pulse
  // the active pill and to no-op clicks on a preset the user is already on.
  const activePreset = useMemo(() => matchPreset(value), [value]);

  // When confirmOnPresetApply is true and the user clicks a preset that would
  // wipe their existing customisations, we surface an inline confirm bubble
  // tied to that pill rather than applying instantly.
  const [pendingPreset, setPendingPreset] = useState<ProfilePresetKey | null>(
    null
  );

  const setTier = (category: string, tier: ProfileTier | null) => {
    const next: PrivacyProfile = { ...value };
    if (tier === null) {
      delete next[category];
    } else {
      next[category] = tier;
    }
    onChange(next);
  };

  const setAllTiers = (tier: ProfileTier | null) => {
    const next: PrivacyProfile = {};
    if (tier !== null) {
      for (const key of PROFILE_CATEGORY_KEYS) {
        next[key] = tier;
      }
    }
    onChange(next);
  };

  const setCount = Object.values(value).filter(
    (v) => typeof v === "string"
  ).length;

  /**
   * Apply a preset, replacing the entire profile. The confirm prompt is
   * skipped if (a) the caller opted out via confirmOnPresetApply=false,
   * (b) the profile is empty, or (c) the profile already matches the
   * clicked preset (idempotent click).
   */
  const applyPreset = (presetKey: ProfilePresetKey, viaConfirm = false) => {
    const preset = PROFILE_PRESETS[presetKey];
    if (activePreset === presetKey) {
      // Already on this preset — clear any stale confirm state.
      setPendingPreset(null);
      return;
    }
    const profileIsEmpty = setCount === 0;
    if (!viaConfirm && confirmOnPresetApply && !profileIsEmpty) {
      setPendingPreset(presetKey);
      return;
    }
    setPendingPreset(null);
    onChange({ ...preset });
  };

  const cancelPendingPreset = () => setPendingPreset(null);

  return (
    <div className="privacy-profile-editor privacy-profile-strip">
      {/* Preset row — opinionated whole-profile shortcuts. Clicking a preset
          replaces every category in one move; the matching pill stays
          highlighted until the user customises a row, at which point the
          highlight clears (signalling "this is now custom"). When the
          editor already has saved preferences, an inline confirm appears
          before the preset is applied so the user doesn't accidentally
          wipe their fine-tuning. */}
      <div className="privacy-profile-presets">
        <div className="privacy-profile-presets-header">
          <span className="privacy-profile-presets-label">
            {tPre("section_label")}
          </span>
          <span className="privacy-profile-presets-hint">
            {tPre("section_hint")}
          </span>
        </div>
        <div
          aria-label={tPre("aria_group")}
          className="privacy-profile-presets-row"
          role="radiogroup"
        >
          {PROFILE_PRESET_KEYS.map((presetKey) => {
            const meta = PROFILE_PRESET_META[presetKey];
            const isActive = activePreset === presetKey;
            const isPending = pendingPreset === presetKey;
            return (
              <div
                className={`privacy-profile-preset-cell${isPending ? "has-pending-confirm" : ""}`}
                key={presetKey}
              >
                <button
                  aria-checked={isActive}
                  className={`privacy-profile-preset-pill${isActive ? "is-active" : ""}`}
                  data-preset={presetKey}
                  data-severity={meta.severityCls}
                  disabled={disabled}
                  onClick={() => applyPreset(presetKey)}
                  role="radio"
                  title={tPreDesc(presetKey)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="privacy-profile-preset-icon"
                  >
                    {meta.icon}
                  </span>
                  <span className="privacy-profile-preset-text">
                    <span className="privacy-profile-preset-title">
                      {tPreLabel(presetKey)}
                    </span>
                    <span className="privacy-profile-preset-desc">
                      {tPreDesc(presetKey)}
                    </span>
                  </span>
                </button>
                {isPending && (
                  <div
                    aria-label={tPre("confirm_aria")}
                    className="privacy-profile-preset-confirm"
                    role="dialog"
                  >
                    <p className="privacy-profile-preset-confirm-text">
                      {tPre("confirm_text", { preset: tPreLabel(presetKey) })}
                    </p>
                    <div className="privacy-profile-preset-confirm-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={disabled}
                        onClick={() => applyPreset(presetKey, true)}
                        type="button"
                      >
                        {tPre("confirm_apply")}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={disabled}
                        onClick={cancelPendingPreset}
                        type="button"
                      >
                        {tPre("confirm_cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick-set actions. Useful for users who want to start from a blank
          slate or pre-fill a lenient / strict baseline, then fine-tune just
          the few categories they actually care about. The label anchors on
          the left, the tier pills and the Clear-all icon cluster on the
          right so the user's eye lands on the controls they'll interact
          with. */}
      <div className="privacy-profile-bulk">
        <span className="privacy-profile-bulk-label">
          {tEd("quick_set_all")}
        </span>
        <div className="privacy-profile-bulk-actions">
          {PROFILE_TIERS.map((tier) => (
            <button
              className="pill-button privacy-profile-bulk-pill"
              data-tier={tier}
              disabled={disabled}
              key={tier}
              onClick={() => setAllTiers(tier)}
              title={TIER_META[tier].description}
              type="button"
            >
              {TIER_META[tier].label}
            </button>
          ))}
          <button
            aria-label={tEd("clear_all_aria")}
            className="pill-button privacy-profile-bulk-pill privacy-profile-bulk-clear"
            disabled={disabled || setCount === 0}
            onClick={() => setAllTiers(null)}
            title={tEd("clear_all_title")}
            type="button"
          >
            <span
              aria-hidden="true"
              className="privacy-profile-bulk-clear-icon"
            >
              ×
            </span>
            <span className="privacy-profile-bulk-clear-label">
              {tEd("clear_all_label")}
            </span>
          </button>
        </div>
      </div>

      <div className="privacy-profile-rows" role="list">
        {rows.map(({ key, meta }) => {
          const current = value[key] ?? null;
          const rowHasPref = current !== null;
          return (
            <div
              className={`privacy-profile-strip-row${rowHasPref ? "has-preference" : ""}`}
              key={key}
              role="listitem"
            >
              <div className="privacy-profile-row-label">
                <span aria-hidden className="privacy-profile-row-icon">
                  {meta.icon}
                </span>
                <div className="privacy-profile-row-text">
                  <div className="privacy-profile-row-title">
                    {categoryLabel(tCat, key) ?? meta.label}
                  </div>
                  <div className="privacy-profile-row-desc">
                    {meta.description}
                  </div>
                </div>
              </div>

              <div
                aria-label={tEd("row_aria", {
                  category: categoryLabel(tCat, key) ?? meta.label,
                })}
                className="privacy-profile-strip-cells"
                role="radiogroup"
              >
                {PROFILE_TIERS.map((tier) => {
                  const selected = current === tier;
                  const tierMeta = TIER_META[tier];
                  return (
                    <button
                      aria-checked={selected}
                      className={`privacy-profile-pill${selected ? "is-selected" : ""}`}
                      data-tier={tier}
                      disabled={disabled}
                      key={tier}
                      onClick={() => setTier(key, tier)}
                      role="radio"
                      title={tierMeta.description}
                      type="button"
                    >
                      {tierMeta.shortLabel}
                    </button>
                  );
                })}
                <button
                  aria-checked={current === null}
                  className={`privacy-profile-pill privacy-profile-pill-optout${current === null ? "is-selected" : ""}`}
                  disabled={disabled}
                  onClick={() => setTier(key, null)}
                  role="radio"
                  title={tEd("no_pref_title")}
                  type="button"
                >
                  <span aria-hidden>—</span>
                  <span className="visually-hidden">
                    {tEd("no_pref_label")}
                  </span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="privacy-profile-footer-help">
        {setCount === 0
          ? tEd("footer_empty")
          : tEd("footer_with_set", {
              set: setCount,
              total: PROFILE_CATEGORY_KEYS.length,
            })}
      </div>
    </div>
  );
}
