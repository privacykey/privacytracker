"use client";

/**
 * One search result during the match step: the chosen candidate plus the
 * alternatives, rendered as a labelled radiogroup.
 *
 * The candidates are real `<button role="radio">` controls in a roving
 * tabindex group rather than clickable divs — that was an accessibility
 * fix (PR #136), so keep the semantics if this markup is touched.
 */

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { countryLabel } from "@/lib/region";
import {
  rovingTabIndex,
  useRovingRadioGroup,
} from "@/lib/use-roving-radiogroup";
import type { AppCandidate, SearchResult, TrackedApp } from "./types";

export default function SearchResultBlock({
  result,
  chosen,
  editing,
  developerHint,
  trackedByAppleId,
  trackedByBundleId,
  onChoose,
  onResearch,
  onSkip,
}: {
  result: SearchResult;
  chosen: AppCandidate | null;
  editing: boolean;
  /**
   * Seller / developer pre-filled from the CSV import (empty string when the
   * row had no vendor column or the user is on a manual path). Editable in
   * the edit row so users can nudge the ranking for vague names.
   */
  developerHint: string;
  trackedByAppleId: Map<string, TrackedApp>;
  /**
   * Same set, keyed by bundle ID. Catches legacy duplicates where the
   * existing app row has a different App Store track ID than the one
   * iTunes is returning for the cfgutil import. Optional so callers
   * that haven't been updated yet still render — the per-candidate
   * tracked badge just under-detects in that case.
   */
  trackedByBundleId?: Map<string, TrackedApp>;
  onChoose: (candidate: AppCandidate | null) => void;
  /**
   * `force` lets the no-matches Retry button replay the *same* query — useful
   * after an iTunes 429 wiped out this block's candidates. Without it, the
   * parent's "nothing changed" guard would short-circuit the call.
   */
  onResearch: (
    nextQuery: string,
    nextDeveloper?: string,
    force?: boolean
  ) => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(result.query);
  const [draftDeveloper, setDraftDeveloper] = useState(developerHint);
  const candidateRadioKeyDown = useRovingRadioGroup();

  // When collapsed and the user has chosen a candidate, show THAT one — not
  // the iTunes #1 pick — so "Show less" after selecting a non-top match
  // collapses to the user's actual choice instead of snapping back to #1.
  // Falls back to the first candidate for blocks the user hasn't touched.
  const chosenIsVisibleWhenCollapsed = chosen
    ? result.candidates.some((c) => c.appleId === chosen.appleId)
    : false;
  const candidates = showAll
    ? result.candidates
    : chosenIsVisibleWhenCollapsed
      ? [chosen!]
      : result.candidates.slice(0, 1);

  // A candidate is "tracked" if its App Store numeric id matches something
  // already in our DB. We surface this at two levels:
  //   • a block-level pill next to "Confirmed" when the chosen candidate is
  //     already tracked, so the user knows the import will re-sync not dupe;
  //   • a per-row chip so they can spot existing records while browsing
  //     alternate matches.
  const chosenTracked = chosen
    ? trackedByAppleId.get(chosen.appleId)
    : undefined;

  // Language for the toggle button. When a selection is confirmed, the "+X"
  // count describes "other" candidates so it stays honest.
  const t = useTranslations("onboard.search_block");
  const tPh = useTranslations("settings.placeholders");
  const otherCount = Math.max(0, result.candidates.length - 1);
  const moreLabel = chosen
    ? t("see_other_chosen", { count: otherCount })
    : t("see_other_unchosen", { count: otherCount });
  const status =
    result.status ??
    (chosen
      ? "matched"
      : result.candidates.length > 0
        ? "matched"
        : "unmatched");
  const matchMethodLabel =
    result.matchSource === "bundle"
      ? t("method_bundle")
      : result.matchSource === "manual"
        ? t("method_manual")
        : result.matchSource === "name"
          ? t("method_name")
          : null;
  const storefrontLabel = result.searchedCountry
    ? countryLabel(result.searchedCountry)
    : null;

  const beginEdit = () => {
    setDraft(result.query);
    // Sync the seller draft to the latest hint every time we open the editor,
    // so a CSV-imported value (or a prior manual edit that got persisted back
    // into developerHints) shows up pre-filled.
    setDraftDeveloper(developerHint);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft(result.query);
    setDraftDeveloper(developerHint);
  };

  const commitEdit = async () => {
    const next = draft.trim();
    const nextDev = draftDeveloper.trim();
    const nameChanged = !!next && next !== result.query;
    const devChanged = nextDev !== developerHint;
    setIsEditing(false);
    if (!next) {
      return;
    }
    if (!(nameChanged || devChanged)) {
      return;
    }
    // Pass the seller draft through so the parent can push it into the
    // shared developerHints map and include it in the next /api/search.
    // Undefined = "leave hint alone"; we only send a value when the user
    // actually touched the field.
    await onResearch(next, devChanged ? nextDev : undefined);
  };

  return (
    <div className={`search-result-item ${chosen ? "selected" : ""}`}>
      <div className="search-result-query-row">
        {isEditing ? (
          <div className="search-result-edit-fields">
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">
                {t("edit_app_name")}
              </span>
              <input
                autoFocus
                className="settings-input search-result-edit-input"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void commitEdit();
                  }
                  if (event.key === "Escape") {
                    cancelEdit();
                  }
                }}
                spellCheck={false}
                value={draft}
              />
            </label>
            <label className="search-result-edit-field">
              <span className="search-result-edit-label">
                {t("edit_seller")}{" "}
                <span className="search-result-edit-hint">
                  {developerHint
                    ? t("edit_seller_csv")
                    : t("edit_seller_optional")}
                </span>
              </span>
              <input
                className="settings-input search-result-edit-input"
                onChange={(event) => setDraftDeveloper(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void commitEdit();
                  }
                  if (event.key === "Escape") {
                    cancelEdit();
                  }
                }}
                placeholder={developerHint || tPh("developer_eg")}
                spellCheck={false}
                value={draftDeveloper}
              />
            </label>
            <div className="search-result-edit-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={editing}
                onClick={() => void commitEdit()}
                type="button"
              >
                {editing ? (
                  <>
                    <span className="spinner-sm" /> {t("researching")}
                  </>
                ) : (
                  t("research")
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={cancelEdit}
                type="button"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Top sub-row: app name on the left, status pills floated
                right via margin-left:auto on the pills wrapper. Title
                wraps to a second line on narrow viewports rather than
                colliding with the pill. */}
            <div className="search-result-query-top">
              <div className="search-result-query">
                &ldquo;{result.query}&rdquo;
              </div>
              {(chosen ||
                chosenTracked ||
                (developerHint && !chosen) ||
                status === "pending" ||
                matchMethodLabel) && (
                <div className="search-result-query-pills">
                  {status === "pending" && (
                    <span className="search-result-pending">
                      {t("pending_pill")}
                    </span>
                  )}
                  {chosen && (
                    <span
                      className="search-result-confirmed"
                      title={t("confirmed_title", {
                        name: chosen.name,
                        dev: chosen.developer,
                      })}
                    >
                      {t("confirmed")}
                    </span>
                  )}
                  {matchMethodLabel && (
                    <span className="search-result-method">
                      {matchMethodLabel}
                    </span>
                  )}
                  {chosenTracked && (
                    // Renamed from "Already tracking" to "Re-sync App info"
                    // because the former described the *state* (you
                    // already have this) while the latter describes
                    // the *action* that will happen if they import it
                    // again — which is what the user actually needs to
                    // know at this point in the flow. The old per-row
                    // "Tracked" chip that used to echo this on the
                    // candidate row has been removed in favour of this
                    // single block-level pill so the row stops showing
                    // two redundant tracking indicators.
                    <span
                      className="search-result-tracked"
                      title={t("tracked_pill_title", {
                        name: chosenTracked.name,
                      })}
                    >
                      {t("tracked_pill")}
                    </span>
                  )}
                  {developerHint && !chosen && (
                    <span
                      className="search-result-hint"
                      title={t("seller_chip_title")}
                    >
                      {t("seller_chip", { dev: developerHint })}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Bottom sub-row: action buttons. On mobile this wraps
                under the title so the pill never gets crowded out. */}
            <div className="search-result-query-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={beginEdit}
                type="button"
              >
                {t("edit_button")}
              </button>
              {chosen && (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={editing}
                  onClick={() => void onSkip()}
                  type="button"
                >
                  {t("skip_this")}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {status === "pending" ? (
        <div className="search-result-empty search-result-pending-body">
          <p className="search-result-empty-copy">
            {t("pending_copy")}
            {result.sourceBundleId
              ? t("pending_bundle_suffix", { id: result.sourceBundleId })
              : ""}
          </p>
          <div className="search-result-empty-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={editing}
              onClick={() => void onSkip()}
              type="button"
            >
              {t("skip_this")}
            </button>
          </div>
        </div>
      ) : result.candidates.length === 0 ? (
        <div className="search-result-empty">
          <p className="search-result-empty-copy">
            {result.sourceBundleId
              ? storefrontLabel
                ? t("no_record_bundle_storefront", {
                    id: result.sourceBundleId,
                    storefront: storefrontLabel,
                  })
                : t("no_record_bundle", { id: result.sourceBundleId })
              : `${t("no_matches_lead")}${isEditing ? t("no_matches_editing") : t("no_matches_idle")}`}
          </p>
          {!isEditing && (
            <div className="search-result-empty-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={editing}
                onClick={() => void onResearch(result.query, undefined, true)}
                title={t("retry_title")}
                type="button"
              >
                {editing ? (
                  <>
                    <span className="spinner-sm" /> {t("retry_busy")}
                  </>
                ) : (
                  t("retry_search")
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={beginEdit}
                type="button"
              >
                {t("edit_name_seller")}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={editing}
                onClick={() => void onSkip()}
                type="button"
              >
                {t("skip_this")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Native radio semantics for candidate selection (roving
              radiogroup pattern — see lib/use-roving-radiogroup.ts and
              the biome.jsonc a11y-override rationale): Tab enters the
              group on the chosen row, arrows move with selection-
              follows-focus, and clicking/Space on the chosen row again
              still clears it (toggle radios — the hook's checked guard
              keeps arrow passes from clearing on the way through). */}
          <div
            aria-label={t("candidates_group_aria", { query: result.query })}
            onKeyDown={candidateRadioKeyDown}
            role="radiogroup"
          >
            {candidates.map((candidate, candidateIndex) => {
              // Bundle-ID fallback catches the legacy-import duplicate
              // case where the same physical app exists under a
              // different App Store track ID — see TrackedApp comment.
              const candidateTracked =
                trackedByAppleId.get(candidate.appleId) ??
                (candidate.bundleId
                  ? trackedByBundleId?.get(candidate.bundleId)
                  : undefined);
              const bundleMismatch = Boolean(
                result.sourceBundleId &&
                  candidate.bundleId &&
                  result.sourceBundleId.toLowerCase() !==
                    candidate.bundleId.toLowerCase()
              );
              const isChosen = chosen?.appleId === candidate.appleId;
              return (
                <button
                  aria-checked={isChosen}
                  // The `tracked` modifier applies row-level styling (tint
                  // + left border). The inline "Tracked" chip next to the
                  // candidate name is back on top of that — removing it
                  // made the selected-candidate case ambiguous when the
                  // block-level "Re-sync App info" pill scrolled off-
                  // screen on long lists, so the per-row chip earns its
                  // keep even with some visual duplication.
                  className={`candidate-row ${isChosen ? "chosen" : ""} ${candidateTracked ? "tracked" : ""}`}
                  key={candidate.appleId}
                  onClick={() => onChoose(isChosen ? null : candidate)}
                  role="radio"
                  tabIndex={rovingTabIndex(
                    isChosen,
                    candidateIndex,
                    chosenIsVisibleWhenCollapsed
                  )}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `2px solid ${isChosen ? "var(--blue)" : "var(--border-strong)"}`,
                      background: isChosen ? "var(--blue)" : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: "#fff",
                      flexShrink: 0,
                      transition: "all 0.15s",
                    }}
                  >
                    {isChosen ? "✓" : ""}
                  </span>

                  {candidate.iconUrl && (
                    <Image
                      // Decorative inside the radio button — the adjacent
                      // candidate-name text IS the accessible name; a
                      // non-empty alt would read the name twice.
                      alt=""
                      className="candidate-icon"
                      height={40}
                      src={candidate.iconUrl}
                      style={{ objectFit: "cover" }}
                      unoptimized
                      width={40}
                    />
                  )}
                  <div className="candidate-body">
                    <div className="candidate-name">
                      {candidate.name}
                      {/* Inline "already tracking" chip. Renders for every
                        tracked candidate (not just the chosen one) so
                        users browsing alternate matches can still tell
                        which rows would re-sync rather than add a
                        duplicate. When this candidate is the one the
                        user picked, we also show the block-level
                        "Re-sync App info" pill — the duplication is
                        deliberate: the chip is visible alongside the
                        name even on long lists where the block header
                        has scrolled off. */}
                      {candidateTracked && (
                        <span
                          aria-label={t("candidate_tracking_aria")}
                          className="candidate-tracked-chip"
                        >
                          {t("candidate_tracking_chip")}
                        </span>
                      )}
                      {bundleMismatch && (
                        <span className="candidate-bundle-warning">
                          Bundle differs
                        </span>
                      )}
                    </div>
                    <div className="candidate-dev">{candidate.developer}</div>
                    {result.sourceBundleId && (
                      <div className="candidate-dev">
                        Imported {result.sourceBundleId}
                        {candidate.bundleId
                          ? ` · App Store ${candidate.bundleId}`
                          : ""}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {result.candidates.length > 1 && (
            <button
              className="show-more-btn"
              onClick={() => setShowAll(!showAll)}
              type="button"
            >
              {showAll ? t("show_less") : moreLabel}
            </button>
          )}
        </>
      )}
    </div>
  );
}
