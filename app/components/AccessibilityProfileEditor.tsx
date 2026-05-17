"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  A11Y_PREFERENCE_META,
  A11Y_PREFERENCES,
  A11Y_PROFILE_FEATURE_KEYS,
  type AccessibilityPreference,
  type AccessibilityProfile,
} from "../../lib/accessibility-profile";
import {
  CANONICAL_ACCESSIBILITY_FEATURES,
  type CanonicalAccessibilityFeature,
  resolveAppleArtworkUrl,
} from "../../lib/accessibility-types";

interface Props {
  /** Disables every input while a save/fetch is in flight. */
  disabled?: boolean;
  /** Fires with the full new profile on every edit. Parent owns persistence. */
  onChange: (next: AccessibilityProfile) => void;
  /** Current (possibly sparse) profile. Features missing a preference are "no preference". */
  value: AccessibilityProfile;
}

/**
 * Per-feature preference picker.
 *
 * Each row mirrors Apple's accessibility shelf: the feature icon + title on
 * the left, and three pills on the right — "Required", "Nice to have", "—"
 * (opt out of comparison for that feature). Users click the pill that
 * represents how strongly they care about the feature. Rows with no pill
 * selected behave the same as explicitly picking "—": the feature is ignored
 * in mismatch calculations.
 *
 * Selected pills are coloured using the severity palette so "required"
 * reads as a stronger commitment than "nice" — "required" gets the strong
 * severity-track red tone (mismatch = hard fail), "nice" gets the soft
 * severity-linked orange tone (mismatch = hint). Unselected pills are
 * neutral. The opt-out pill is dash-only so it visually recedes.
 *
 * Mirrors PrivacyProfileEditor's structure so the two sections feel like a
 * single family of controls — same header, same row layout, same footer.
 */

/** Pick a renderable row icon. Prefer Apple's artwork URL → SF Symbol emoji fallback. */
function rowIcon(feature: CanonicalAccessibilityFeature): {
  img: string | null;
  emoji: string;
} {
  return {
    img: resolveAppleArtworkUrl(feature.iconTemplate, 40),
    emoji: feature.fallbackEmoji,
  };
}

export default function AccessibilityProfileEditor({
  value,
  onChange,
  disabled,
}: Props) {
  const tEd = useTranslations("settings.a11y_profile_editor");
  // Stable list of rows so the DOM doesn't flicker when the user toggles a
  // single feature. Order matches Apple's canonical listing.
  const rows = useMemo(
    () =>
      A11Y_PROFILE_FEATURE_KEYS.map((key) => ({
        key,
        feature: CANONICAL_ACCESSIBILITY_FEATURES.find(
          (f) => f.identifier === key
        )!,
      })),
    []
  );

  const setPreference = (
    feature: string,
    preference: AccessibilityPreference | null
  ) => {
    const next: AccessibilityProfile = { ...value };
    if (preference === null) {
      delete next[feature];
    } else {
      next[feature] = preference;
    }
    onChange(next);
  };

  const setAllPreferences = (preference: AccessibilityPreference | null) => {
    const next: AccessibilityProfile = {};
    if (preference !== null) {
      for (const key of A11Y_PROFILE_FEATURE_KEYS) {
        next[key] = preference;
      }
    }
    onChange(next);
  };

  const setCount = Object.values(value).filter(
    (v) => typeof v === "string"
  ).length;

  return (
    <div className="privacy-profile-editor privacy-profile-strip a11y-profile-editor">
      {/* Quick-set row — mirror of the privacy profile bulk controls. Users
          who want to blanket-mark everything "required" or "nice" can do so
          here and fine-tune individual rows afterwards. */}
      <div className="privacy-profile-bulk">
        <span className="privacy-profile-bulk-label">
          {tEd("quick_set_all")}
        </span>
        <div className="privacy-profile-bulk-actions">
          {A11Y_PREFERENCES.map((pref) => (
            <button
              className="pill-button privacy-profile-bulk-pill"
              data-a11y-pref={pref}
              disabled={disabled}
              key={pref}
              onClick={() => setAllPreferences(pref)}
              title={A11Y_PREFERENCE_META[pref].description}
              type="button"
            >
              {A11Y_PREFERENCE_META[pref].label}
            </button>
          ))}
          <button
            aria-label={tEd("clear_all_aria")}
            className="pill-button privacy-profile-bulk-pill privacy-profile-bulk-clear"
            disabled={disabled || setCount === 0}
            onClick={() => setAllPreferences(null)}
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
        {rows.map(({ key, feature }) => {
          const current = value[key] ?? null;
          const rowHasPref = current !== null;
          const icon = rowIcon(feature);
          return (
            <div
              className={`privacy-profile-strip-row${rowHasPref ? "has-preference" : ""}`}
              key={key}
              role="listitem"
            >
              <div className="privacy-profile-row-label">
                <span aria-hidden className="privacy-profile-row-icon">
                  {icon.img ? (
                    // 20×20 row-icon — using next/image here would add a
                    // wrapper element + image-optimisation pipeline for a
                    // tiny static asset, which costs more than it saves.
                    // Same pattern other tiny-icon sites use across the
                    // codebase (Nav, AboutModal, ReviewRecommendationsView).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      height={20}
                      loading="lazy"
                      src={icon.img}
                      style={{ display: "block" }}
                      width={20}
                    />
                  ) : (
                    icon.emoji
                  )}
                </span>
                <div className="privacy-profile-row-text">
                  <div className="privacy-profile-row-title">
                    {feature.title}
                  </div>
                  <div className="privacy-profile-row-desc">
                    {feature.fallbackDescription}
                  </div>
                </div>
              </div>

              <div
                aria-label={tEd("row_aria", { category: feature.title })}
                className="privacy-profile-strip-cells"
                role="radiogroup"
              >
                {A11Y_PREFERENCES.map((pref) => {
                  const selected = current === pref;
                  const prefMeta = A11Y_PREFERENCE_META[pref];
                  return (
                    <button
                      aria-checked={selected}
                      className={`privacy-profile-pill${selected ? "is-selected" : ""}`}
                      data-a11y-pref={pref}
                      disabled={disabled}
                      key={pref}
                      onClick={() => setPreference(key, pref)}
                      role="radio"
                      title={prefMeta.description}
                      type="button"
                    >
                      {prefMeta.shortLabel}
                    </button>
                  );
                })}
                <button
                  aria-checked={current === null}
                  className={`privacy-profile-pill privacy-profile-pill-optout${current === null ? "is-selected" : ""}`}
                  disabled={disabled}
                  onClick={() => setPreference(key, null)}
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
              total: A11Y_PROFILE_FEATURE_KEYS.length,
            })}
      </div>
    </div>
  );
}
