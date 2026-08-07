"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type {
  AccessibilityPreference,
  AccessibilityProfile,
} from "../../../lib/accessibility-profile";
import {
  CANONICAL_ACCESSIBILITY_FEATURES,
  type CanonicalAccessibilityFeature,
} from "../../../lib/accessibility-types";
import type { App } from "./types";

/**
 * Accessibility panel — renders the declared-feature list for an app
 * alongside the canonical baseline, so users can see at a glance which
 * features Apple publishes support fields for AND which ones the
 * developer has actually claimed. When the shelf is present but empty,
 * the panel says so plainly instead of pretending the tab has content.
 *
 * Kept deliberately server-source-free: all data comes from the `app`
 * prop the server component already loaded via `getAppWithPrivacy`.
 */
export default function AccessibilityPanel({
  app,
  formatDate,
  a11yProfile,
}: {
  app: App;
  formatDate: (ts: number) => string;
  /** Saved accessibility profile; null means "no preferences set". */
  a11yProfile: AccessibilityProfile | null;
}) {
  // i18n — for the "Your accessibility preferences" aria-label on the
  // profile chip rendered inside this panel.
  const tDetail = useTranslations("app_detail");
  const declared = app.accessibilityFeatures ?? [];
  const declaredByIdentifier = new Map(declared.map((f) => [f.identifier, f]));

  // Merge: canonical first (in the order Apple lists them on the App Store
  // shelf), followed by any declared features we don't recognise as
  // canonical. This ordering keeps the UI stable across Apple catalog
  // changes — adding a new feature Apple publishes won't reshuffle the list.
  interface Row {
    canonical: CanonicalAccessibilityFeature | null;
    declared: boolean;
    description: string | null;
    key: string;
    /** User's preference for this feature; null when unset. */
    preference: AccessibilityPreference | null;
    title: string;
  }

  // Normalise the profile into a quick-lookup map even when the caller
  // passed `null` so the row builder can do a single `profileLookup.get`
  // per feature without a branch. Features the user hasn't set stay
  // `undefined` in the map and surface as `preference: null` on the row.
  const profileLookup = new Map<string, AccessibilityPreference>();
  if (a11yProfile) {
    for (const [key, value] of Object.entries(a11yProfile)) {
      if (typeof value === "string") {
        profileLookup.set(key, value);
      }
    }
  }

  const rows: Row[] = [];
  for (const canonical of CANONICAL_ACCESSIBILITY_FEATURES) {
    const hit = declaredByIdentifier.get(canonical.identifier);
    rows.push({
      key: canonical.identifier,
      title: canonical.title,
      description: hit?.description ?? canonical.fallbackDescription ?? null,
      declared: !!hit,
      canonical,
      preference: profileLookup.get(canonical.identifier) ?? null,
    });
    if (hit) {
      declaredByIdentifier.delete(canonical.identifier);
    }
  }
  for (const extra of declaredByIdentifier.values()) {
    rows.push({
      key: extra.identifier,
      title: extra.title,
      description: extra.description,
      declared: true,
      canonical: null,
      preference: profileLookup.get(extra.identifier) ?? null,
    });
  }

  const declaredCount = declared.length;
  const canonicalCount = CANONICAL_ACCESSIBILITY_FEATURES.length;
  const coveragePct = canonicalCount
    ? Math.round(
        (rows.filter((r) => r.declared && r.canonical).length /
          canonicalCount) *
          100
      )
    : 0;

  // Aggregate counts for the profile key card — how many features the user
  // has marked at each tier, and how many of those this app declares vs
  // misses. Used to populate the key header above the feature list.
  const preferenceStats: Record<
    AccessibilityPreference,
    { total: number; missing: number }
  > = {
    required: { total: 0, missing: 0 },
    nice: { total: 0, missing: 0 },
  };
  const declaredIdentifiers = new Set(declared.map((f) => f.identifier));
  for (const [key, preference] of profileLookup) {
    preferenceStats[preference].total += 1;
    if (!declaredIdentifiers.has(key)) {
      preferenceStats[preference].missing += 1;
    }
  }
  const profileActive = profileLookup.size > 0;
  const totalPreferred = profileLookup.size;
  const totalMissingPreferred =
    preferenceStats.required.missing + preferenceStats.nice.missing;

  return (
    <div className="a11y-panel">
      {/* Summary card — headline "X of Y declared" so users can size up
          coverage at a glance before scanning the per-feature list. */}
      <div className="a11y-summary-card">
        <div className="a11y-summary-headline">
          <span className="a11y-summary-count">{declaredCount}</span>
          <span className="a11y-summary-total">
            {tDetail("a11y_summary.of_total", { count: canonicalCount })}
          </span>
        </div>
        <div className="a11y-summary-sub">
          {app.hasAccessibilityLabels === 1
            ? tDetail("a11y_summary.coverage", { pct: coveragePct })
            : tDetail("a11y_summary.shelf_empty")}{" "}
          <span className="a11y-summary-synced">
            {tDetail("a11y_summary.last_synced", {
              date: formatDate(app.lastSynced),
            })}
          </span>
        </div>
      </div>

      {/* Profile key — shown only when the user has saved at least one
          preference. Acts as a legend for the teal highlight on preferred
          rows below, and summarises how well this app matches their
          profile in a single glance. */}
      {profileActive && (
        <div
          aria-label={tDetail("actions.your_a11y_prefs_aria")}
          className={`a11y-profile-key${
            totalMissingPreferred === 0 ? "a11y-profile-key-match" : ""
          }`}
          role="note"
        >
          <div className="a11y-profile-key-header">
            <span className="a11y-profile-key-eyebrow">
              {tDetail("actions.your_a11y_prefs_aria")}
            </span>
            <span className="a11y-profile-key-summary">
              {totalMissingPreferred === 0
                ? tDetail("a11y_profile_key_all_declared", {
                    count: totalPreferred,
                  })
                : tDetail("a11y_profile_key_missing_count", {
                    missing: totalMissingPreferred,
                    total: totalPreferred,
                  })}
            </span>
          </div>
          <div className="a11y-profile-key-tiers">
            {preferenceStats.required.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-required">
                <span aria-hidden="true" className="a11y-profile-key-swatch" />
                <strong>{preferenceStats.required.total}</strong>{" "}
                {tDetail("a11y_profile_key_tier_required")}
                {preferenceStats.required.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    {tDetail("a11y_profile_key_tier_missing", {
                      count: preferenceStats.required.missing,
                    })}
                  </span>
                )}
              </span>
            )}
            {preferenceStats.nice.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-nice">
                <span aria-hidden="true" className="a11y-profile-key-swatch" />
                <strong>{preferenceStats.nice.total}</strong>{" "}
                {tDetail("a11y_profile_key_tier_nice")}
                {preferenceStats.nice.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    {tDetail("a11y_profile_key_tier_missing", {
                      count: preferenceStats.nice.missing,
                    })}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="a11y-profile-key-hint">
            {tDetail.rich("a11y_profile_key_hint", {
              link: (chunks) => (
                <Link href="/dashboard/settings/you#accessibility-profile">
                  {chunks}
                </Link>
              ),
            })}
          </div>
        </div>
      )}

      {/* Informational note — self-declared labels are a signal, not proof. */}
      <p className="a11y-disclaimer" role="note">
        <span aria-hidden="true">ⓘ</span> {tDetail("a11y_disclaimer")}
      </p>

      <div className="a11y-feature-list">
        {rows.map((row) => (
          <div
            className={[
              "a11y-feature-row",
              row.declared ? "is-declared" : "is-missing",
              row.preference ? `has-preference pref-${row.preference}` : "",
              row.preference && !row.declared ? "preference-missing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={row.key}
          >
            <div aria-hidden="true" className="a11y-feature-status">
              {row.declared ? (
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="18"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                  width="18"
                >
                  <polyline points="4 12 10 18 20 6" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="18"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                  width="18"
                >
                  <line x1="6" x2="18" y1="6" y2="18" />
                  <line x1="18" x2="6" y1="6" y2="18" />
                </svg>
              )}
            </div>
            <div className="a11y-feature-body">
              <div className="a11y-feature-title">
                {row.title}
                {!row.canonical && (
                  <span
                    className="a11y-feature-new-badge"
                    title={tDetail("tooltips.a11y_feature_post_build")}
                  >
                    {tDetail("a11y_feature_new_badge")}
                  </span>
                )}
                {row.preference && (
                  <span
                    className={`a11y-feature-pref-chip a11y-feature-pref-chip-${row.preference}`}
                    title={tDetail(`a11y_pref_chip.${row.preference}_desc`)}
                  >
                    {tDetail(`a11y_pref_chip.${row.preference}`)}
                  </span>
                )}
              </div>
              {row.description && (
                <div className="a11y-feature-desc">{row.description}</div>
              )}
              <div
                aria-label={
                  row.declared
                    ? tDetail("a11y_state.declared_aria")
                    : tDetail("a11y_state.not_declared_aria")
                }
                className="a11y-feature-state"
              >
                {row.declared
                  ? tDetail("a11y_state.declared_label")
                  : tDetail("a11y_state.not_declared_label")}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
