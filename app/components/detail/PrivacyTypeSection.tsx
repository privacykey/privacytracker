"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  categoryDescription as i18nCategoryDescription,
  categoryLabel as i18nCategoryLabel,
  severityDescription as i18nSeverityDescription,
  severityLabel as i18nSeverityLabel,
} from "../../../lib/i18n-meta";
import { CATEGORY_META, SEVERITY_CONFIG } from "../../../lib/privacy-meta";
import {
  type PrivacyProfile,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
} from "../../../lib/privacy-profile";
import InfoTooltip from "../InfoTooltip";
import PrivacyTypeIcon from "../PrivacyTypeIcon";
import type { PrivacyType } from "./types";

// ── Privacy Type Section ──────────────────────────────────────────────

export default function PrivacyTypeSection({
  privacyType,
  profile,
}: {
  privacyType: PrivacyType;
  /** Saved user profile; null disables all mismatch highlighting. */
  profile: PrivacyProfile | null;
}) {
  // i18n — for the "exceeds your privacy profile" aria-label on
  // mismatch indicators inside this section.
  const tDetail = useTranslations("app_detail");
  // Category labels + descriptions, threaded through the helpers from
  // lib/i18n-meta.ts so each card renders Apple's Simplified Chinese
  // glossary entries when the active locale is `zh`. Re-declared here
  // (rather than passed as a prop from the parent) because
  // PrivacyTypeSection runs as its own component — the parent's
  // `tCategory` / `tCategoryDesc` aren't in scope across the boundary.
  const tCategory = useTranslations("category");
  const tCategoryDesc = useTranslations("category_descriptions");
  // Reused from AppGrid — `app_grid.n_categories_aria` is the byte-identical
  // "{n} categories" plural the visible count below needs.
  const tAppGrid = useTranslations("app_grid");
  // Severity badge label + tooltip, and the tier words in the mismatch
  // tooltip, all resolve through their shared locale namespaces; the
  // English meta maps stay as fallbacks for unknown identifiers.
  const tSeverity = useTranslations("severity");
  const tTierShort = useTranslations("privacy_profile_tier_short");
  const [open, setOpen] = useState(true); // default open
  const sev = SEVERITY_CONFIG[privacyType.identifier];
  const sevLabel =
    i18nSeverityLabel(tSeverity, privacyType.identifier) ??
    sev?.label ??
    privacyType.title;
  const sevDescription =
    i18nSeverityDescription(tSeverity, privacyType.identifier) ??
    sev?.description;
  // Stable ids so aria-controls / id match even across re-renders.
  const panelId = `accordion-panel-${privacyType.identifier}`;
  const headerId = `accordion-header-${privacyType.identifier}`;

  // Translate the privacy-type identifier to the data-use tier the profile
  // compares against. "DATA_NOT_LINKED_TO_YOU" → "not_linked", etc. Unknown
  // identifiers fall through to no tier, disabling highlighting for this row.
  const typeTier = TYPE_IDENTIFIER_TO_TIER[privacyType.identifier] ?? null;

  // Pre-compute which categories exceed the profile threshold. We key by the
  // category identifier so the loop below stays cheap even with larger
  // privacy-type shelves.
  const mismatchedCats = new Set<string>();
  if (profile && typeTier) {
    const observedRank = TIER_RANK[typeTier];
    for (const cat of privacyType.categories) {
      const allowed = profile[cat.identifier];
      if (!allowed) {
        continue; // "no preference" — skip silently
      }
      if (observedRank > TIER_RANK[allowed]) {
        mismatchedCats.add(cat.identifier);
      }
    }
  }
  const hasMismatches = mismatchedCats.size > 0;

  return (
    <div className="accordion-section">
      {/*
        Accordion header. The toggle is a real `<button>` (wrapping the
        severity badge — the section's visible title) with the
        `InfoTooltip` as its SIBLING, not a descendant: the previous
        role="button" div wrapped the tooltip's own <button>, which is
        the axe `nested-interactive` violation (a focusable control
        inside a control). The row div keeps a plain onClick as a
        pointer-only convenience so the whole header stays clickable —
        same blessed pattern as the modal overlays (see biome.jsonc);
        keyboard and AT users get the native button.
      */}
      <div className="accordion-header" onClick={() => setOpen(!open)}>
        <div className="accordion-header-left">
          <div className="tooltip-inline">
            <button
              aria-controls={panelId}
              aria-expanded={open}
              className="inline-header-toggle"
              id={headerId}
              onClick={(e) => {
                // The row's convenience onClick would double-toggle.
                e.stopPropagation();
                setOpen(!open);
              }}
              type="button"
            >
              <span className={`severity-badge ${sev?.cls ?? "severity-none"}`}>
                <PrivacyTypeIcon identifier={privacyType.identifier} />
                {sevLabel}
              </span>
            </button>
            {sevDescription && <InfoTooltip text={sevDescription} />}
          </div>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {tAppGrid("n_categories_aria", {
              count: privacyType.categories.length,
            })}
          </span>
          {hasMismatches && (
            <span
              aria-label={tDetail("mismatch_chip.aria", {
                count: mismatchedCats.size,
              })}
              className="accordion-mismatch-chip"
              title={tDetail("tooltips.categories_exceed_profile")}
            >
              {tDetail("mismatch_chip.label", { count: mismatchedCats.size })}
            </span>
          )}
        </div>
        <span
          aria-hidden="true"
          style={{
            color: "var(--text-3)",
            fontSize: 12,
            transition: "transform 0.2s",
            transform: open ? "rotate(180deg)" : "none",
          }}
        >
          ▼
        </span>
      </div>

      {open && (
        <section
          aria-labelledby={headerId}
          className="accordion-body"
          id={panelId}
        >
          {privacyType.detail && (
            <p
              style={{
                fontSize: 13,
                color: "var(--text-2)",
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              {privacyType.detail}
            </p>
          )}
          <div className="category-grid">
            {privacyType.categories.map((cat) => {
              const meta = CATEGORY_META[cat.identifier];
              const isMismatch = mismatchedCats.has(cat.identifier);
              // Localised category label + description. Falls back to the
              // English META shape when the identifier isn't in the locale
              // bundle (new identifier we haven't translated yet) — same
              // pattern used everywhere else categoryLabel / categoryDescription
              // are wired.
              const localisedLabel =
                i18nCategoryLabel(tCategory, cat.identifier) ??
                meta?.label ??
                cat.title;
              const localisedDescription =
                i18nCategoryDescription(tCategoryDesc, cat.identifier) ??
                meta?.description;
              // Build a plain-language tooltip for mismatches so hovering a
              // flagged card explains the rule instead of just asserting it.
              const mismatchTitle = (() => {
                if (!(isMismatch && typeTier)) {
                  return;
                }
                const allowed = profile?.[cat.identifier];
                if (!allowed) {
                  return;
                }
                const observedLabel = tTierShort(typeTier).toLowerCase();
                const allowedLabel = tTierShort(allowed).toLowerCase();
                return tDetail("mismatch_title", {
                  label: localisedLabel,
                  observed: observedLabel,
                  allowed: allowedLabel,
                });
              })();
              return (
                /*
                  Wrapper exists so the InfoTooltip can sit BESIDE the
                  Link rather than inside it. HTML disallows interactive
                  descendants (the tooltip's <button>) inside an <a>
                  (which is what next/link renders). The wrapper is
                  position:relative so the tooltip overlay can absolute-
                  position itself over the header's icon slot — visually
                  identical to before, but the DOM tree is now flat from
                  the Link's perspective. Native link semantics
                  (Cmd-click, middle-click, right-click → "Open in new
                  tab") are preserved.
                */
                <div className="category-card-wrapper" key={cat.id}>
                  <Link
                    className={`category-card category-card-link${isMismatch ? " category-card-mismatch" : ""}`}
                    href={`/dashboard/privacy#cat-${privacyType.identifier}-${cat.identifier}`}
                    title={
                      mismatchTitle ?? tDetail("category_other_apps_title")
                    }
                  >
                    {/*
                      Mismatch flag is pinned to the top-right of the card
                      via CSS (absolute positioning) — living outside the
                      header flex flow keeps it in a consistent corner
                      regardless of how long the category label is. The
                      card itself also picks up a rose tint via
                      `.category-card-mismatch` so the whole card reads
                      as "doesn't match your profile" at a glance.
                    */}
                    {isMismatch && (
                      <span
                        aria-label={tDetail("actions.exceeds_profile_aria")}
                        className="category-card-mismatch-flag"
                      >
                        ⚠
                      </span>
                    )}
                    <div className="category-card-header">
                      <span className="category-card-icon">
                        {meta?.icon ?? "📂"}
                      </span>
                      <span aria-hidden="true" className="category-card-arrow">
                        →
                      </span>
                    </div>
                    <span className="category-card-label">
                      {localisedLabel}
                    </span>
                  </Link>
                  {/*
                    Info tooltip sits OUTSIDE the Link, absolutely
                    positioned to overlay the spot where the icon is.
                    Without this restructure the tooltip's <button>
                    would be a descendant of <a>, which HTML disallows.
                  */}
                  {localisedDescription && (
                    <span className="category-card-info-overlay">
                      <InfoTooltip side="right" text={localisedDescription} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
