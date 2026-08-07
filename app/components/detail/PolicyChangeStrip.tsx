"use client";

import { useTranslations } from "next-intl";
import {
  POLICY_LENSES,
  POLICY_RATING_META,
  type PolicySummary,
} from "../../../lib/policy-summary-meta";
import { diffLensRatings } from "./lens-ratings";

export default function PolicyChangeStrip({
  current,
  previous,
  previousAt,
  formatDate,
}: {
  current: PolicySummary;
  previous: PolicySummary;
  previousAt?: number;
  formatDate: (ts: number) => string;
}) {
  // i18n — for the from→to rating badges in each lens-shift row.
  const tRating = useTranslations("policy_rating");
  const tDetail = useTranslations("app_detail");
  // Lens labels read from the shared `policy_lens.*` namespace (same as the
  // lens grid). `shift.label` keeps the English POLICY_LENSES fallback for
  // any non-canonical key a stored summary might carry.
  const tLens = useTranslations("policy_lens");
  const shifts = diffLensRatings(current.lenses, previous.lenses);

  // If ratings didn't move but overview/highlights changed, surface that too —
  // it tells the user the wording shifted even if the headline take is the same.
  const overviewChanged =
    (current.overview || "").trim() !== (previous.overview || "").trim();
  const highlightsChanged =
    JSON.stringify(current.highlights) !== JSON.stringify(previous.highlights);

  if (shifts.length === 0 && !overviewChanged && !highlightsChanged) {
    // Previous blob exists but nothing meaningful differs. Don't spam the user.
    return null;
  }

  const sinceLabel = previousAt
    ? tDetail("policy_change_strip.since_date", {
        date: formatDate(previousAt),
      })
    : tDetail("policy_change_strip.since_fallback");

  return (
    <div className="policy-change-strip">
      <div className="policy-change-strip-header">
        <span className="policy-change-strip-kicker">
          {tDetail("policy_change_kicker")}
        </span>
        <span className="policy-change-strip-since">{sinceLabel}</span>
      </div>

      {shifts.length > 0 ? (
        <ul className="policy-change-shift-list">
          {shifts.map((shift) => {
            const fromMeta = POLICY_RATING_META[shift.from];
            const toMeta = POLICY_RATING_META[shift.to];
            const direction =
              shift.delta > 0
                ? "worsened"
                : shift.delta < 0
                  ? "improved"
                  : "moved";
            return (
              <li
                className={`policy-change-shift policy-change-shift-${direction}`}
                key={shift.key}
              >
                <span className="policy-change-shift-label">
                  {POLICY_LENSES.some((lens) => lens.key === shift.key)
                    ? tLens(shift.key)
                    : shift.label}
                </span>
                <span className="policy-change-shift-flow">
                  <span className={`policy-rating-badge ${fromMeta.cls}`}>
                    {tRating(shift.from)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="policy-change-shift-arrow"
                  >
                    →
                  </span>
                  <span className={`policy-rating-badge ${toMeta.cls}`}>
                    {tRating(shift.to)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="policy-change-strip-note">
          {tDetail("policy_change_strip.held_steady")}
        </p>
      )}
    </div>
  );
}
