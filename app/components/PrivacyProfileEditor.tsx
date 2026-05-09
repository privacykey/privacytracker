'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { CATEGORY_META } from '../../lib/privacy-meta';
import { categoryLabel } from '../../lib/i18n-meta';
import {
  PROFILE_CATEGORY_KEYS,
  PROFILE_TIERS,
  TIER_META,
  type PrivacyProfile,
  type ProfileTier,
} from '../../lib/privacy-profile';

interface Props {
  /** Current (possibly sparse) profile. Categories missing a tier are "no preference". */
  value: PrivacyProfile;
  /** Fires with the full new profile on every edit. Parent owns persistence. */
  onChange: (next: PrivacyProfile) => void;
  /** Disables every input while a save/fetch is in flight. */
  disabled?: boolean;
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

export default function PrivacyProfileEditor({ value, onChange, disabled }: Props) {
  // i18n — category labels in the editor rows + their aria-labels.
  // CATEGORY_META still drives icon + description (translation of the
  // descriptions is tracked separately).
  const tCat = useTranslations('category');
  const tEd = useTranslations('settings.profile_editor');

  // Stable list of rows so the DOM doesn't flicker when the user toggles a
  // single category. Category key order is whatever CATEGORY_META declares
  // — which is the order the App Store presents them in as well.
  const rows = useMemo(() => PROFILE_CATEGORY_KEYS.map(key => ({
    key,
    meta: CATEGORY_META[key],
  })), []);

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
      for (const key of PROFILE_CATEGORY_KEYS) next[key] = tier;
    }
    onChange(next);
  };

  const setCount = Object.values(value).filter(v => typeof v === 'string').length;

  return (
    <div className="privacy-profile-editor privacy-profile-strip">
      {/* Quick-set actions. Useful for users who want to start from a blank
          slate or pre-fill a lenient / strict baseline, then fine-tune just
          the few categories they actually care about. The label anchors on
          the left, the tier pills and the Clear-all icon cluster on the
          right so the user's eye lands on the controls they'll interact
          with. */}
      <div className="privacy-profile-bulk">
        <span className="privacy-profile-bulk-label">
          {tEd('quick_set_all')}
        </span>
        <div className="privacy-profile-bulk-actions">
          {PROFILE_TIERS.map(tier => (
            <button
              key={tier}
              type="button"
              className="pill-button privacy-profile-bulk-pill"
              data-tier={tier}
              onClick={() => setAllTiers(tier)}
              disabled={disabled}
              title={TIER_META[tier].description}
            >
              {TIER_META[tier].label}
            </button>
          ))}
          <button
            type="button"
            className="pill-button privacy-profile-bulk-pill privacy-profile-bulk-clear"
            onClick={() => setAllTiers(null)}
            disabled={disabled || setCount === 0}
            title={tEd('clear_all_title')}
            aria-label={tEd('clear_all_aria')}
          >
            <span className="privacy-profile-bulk-clear-icon" aria-hidden="true">×</span>
            <span className="privacy-profile-bulk-clear-label">{tEd('clear_all_label')}</span>
          </button>
        </div>
      </div>

      <div className="privacy-profile-rows" role="list">
        {rows.map(({ key, meta }) => {
          const current = value[key] ?? null;
          const rowHasPref = current !== null;
          return (
            <div
              key={key}
              className={`privacy-profile-strip-row${rowHasPref ? ' has-preference' : ''}`}
              role="listitem"
            >
              <div className="privacy-profile-row-label">
                <span className="privacy-profile-row-icon" aria-hidden>
                  {meta.icon}
                </span>
                <div className="privacy-profile-row-text">
                  <div className="privacy-profile-row-title">
                    {categoryLabel(tCat, key) ?? meta.label}
                  </div>
                  <div className="privacy-profile-row-desc">{meta.description}</div>
                </div>
              </div>

              <div
                className="privacy-profile-strip-cells"
                role="radiogroup"
                aria-label={tEd('row_aria', { category: categoryLabel(tCat, key) ?? meta.label })}
              >
                {PROFILE_TIERS.map(tier => {
                  const selected = current === tier;
                  const tierMeta = TIER_META[tier];
                  return (
                    <button
                      key={tier}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-tier={tier}
                      className={`privacy-profile-pill${selected ? ' is-selected' : ''}`}
                      onClick={() => setTier(key, tier)}
                      disabled={disabled}
                      title={tierMeta.description}
                    >
                      {tierMeta.shortLabel}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="radio"
                  aria-checked={current === null}
                  className={`privacy-profile-pill privacy-profile-pill-optout${current === null ? ' is-selected' : ''}`}
                  onClick={() => setTier(key, null)}
                  disabled={disabled}
                  title={tEd('no_pref_title')}
                >
                  <span aria-hidden>—</span>
                  <span className="visually-hidden">{tEd('no_pref_label')}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="privacy-profile-footer-help">
        {setCount === 0
          ? tEd('footer_empty')
          : tEd('footer_with_set', { set: setCount, total: PROFILE_CATEGORY_KEYS.length })}
      </div>
    </div>
  );
}
