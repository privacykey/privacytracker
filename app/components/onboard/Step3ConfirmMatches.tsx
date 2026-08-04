"use client";

/**
 * Step 3 — confirm what each name matched to.
 *
 * The triage surface: accepted matches, ambiguous ones where the user
 * picks between candidates, rows that found nothing and can be retried
 * or re-queried, and apps already tracked from an earlier import.
 */

import Link from "next/link";
import { COUNTRY_OPTIONS, countryLabel } from "@/lib/region";
import type {
  OnboardWizardState,
  TriageChoice,
} from "@/lib/use-onboard-wizard";
import SearchResultBlock from "./SearchResultBlock";
import type { AppCandidate, SearchResult } from "./types";
import UnavailableRowEditor from "./UnavailableRowEditor";

export default function Step3ConfirmMatches({
  w,
}: {
  /** The whole `useOnboardWizard` return value — see ./README.md on
   *  why the steps take one object rather than their bindings. */
  w: OnboardWizardState;
}) {
  const {
    blockSearchError,
    blockSearching,
    country,
    developerHints,
    editingBlock,
    handleBlockResearch,
    handleBlockSkip,
    handleCancelQueuedMatches,
    handleConfirm,
    handleRegionRematch,
    hideTrackedBlocks,
    onboardHideTrackedToggleOn,
    onboardStepConfirmMatchesOn,
    ratePending,
    rateTick,
    rematchingRegion,
    searchBlocked,
    searchResults,
    searching,
    selected,
    setEditingBlock,
    setHideTrackedBlocks,
    setImportedApps,
    setManuallyChosenQueries,
    setSearchResults,
    setSelected,
    setSkippedQueries,
    setStep,
    setTriageChoices,
    setUnmatchedSaveError,
    setUnmatchedSaveState,
    setUnmatchedSavedCount,
    setWebClipSaveError,
    setWebClipSaveState,
    setWebClipSavedCount,
    skippedQueries,
    step,
    tSearchBlock,
    tStatus,
    tStep3,
    tWiz,
    trackedByAppleId,
    trackedByBundleId,
    triageChoices,
    unmatchedSaveError,
    unmatchedSaveState,
    unmatchedSavedCount,
    webClipEntries,
    webClipSaveError,
    webClipSaveState,
    webClipSavedCount,
  } = w;

  return (
    <>
      {step === 3 &&
        onboardStepConfirmMatchesOn &&
        (() => {
          // ── Step 3 derived state ────────────────────────────────────
          //
          // `isCandidateTracked` — a candidate is "already tracked" if
          // EITHER its App Store track ID matches an existing row, OR
          // its bundle ID does. The bundle-ID fallback catches the
          // legacy-import duplicate where a previous name-search
          // import and a cfgutil bundle-ID import resolved the same
          // physical app to different track IDs. Without the bundle-
          // ID arm, Step 3's banner under-counts and the user clicks
          // "Import N apps" only to end up with duplicate rows in the
          // apps table.
          const isCandidateTracked = (candidate: AppCandidate): boolean => {
            if (trackedByAppleId.has(candidate.appleId)) {
              return true;
            }
            if (
              candidate.bundleId &&
              trackedByBundleId.has(candidate.bundleId)
            ) {
              return true;
            }
            return false;
          };

          // `trackedSelectedCount` counts how many of the user's chosen
          // candidates already exist in the local DB. Powers the
          // "N of these apps are already being tracked" banner at the
          // top of Step 3. Supersedes the Step 2 name-based nudge,
          // which could over-count because many apps share a common
          // name.
          const trackedSelectedCount = Array.from(selected.values()).filter(
            isCandidateTracked
          ).length;

          // `visibleResults` drives the rendered block list. When the
          // "Hide already-tracked apps" toggle is on, we drop any block
          // whose currently-chosen candidate matches a tracked app. If
          // no candidate is chosen yet (skipped / no matches), we keep
          // the block visible — there's nothing confident to hide.
          const visibleResults = hideTrackedBlocks
            ? searchResults.filter((result) => {
                const chosen = selected.get(result.query);
                return !(chosen && isCandidateTracked(chosen));
              })
            : searchResults;

          // `effectiveSelected` is what actually gets imported. When the
          // toggle is on, we exclude tracked rows from the import so the
          // button count and the follow-up scrape loop match what the
          // user sees. Selections for hidden rows stay in `selected` so
          // toggling back off restores the prior choices as-is.
          const effectiveSelected = hideTrackedBlocks
            ? new Map(
                Array.from(selected.entries()).filter(
                  ([, candidate]) => !isCandidateTracked(candidate)
                )
              )
            : selected;
          const effectiveCount = effectiveSelected.size;
          const statusFor = (
            result: SearchResult
          ): NonNullable<SearchResult["status"]> => {
            if (skippedQueries.has(result.query)) {
              return "skipped";
            }
            if (result.status) {
              return result.status;
            }
            if (selected.has(result.query)) {
              return "matched";
            }
            return result.candidates.length > 0 ? "matched" : "unmatched";
          };
          const pendingMatchCount = searchResults.filter(
            (result) => statusFor(result) === "pending"
          ).length;
          const summary = {
            total: searchResults.length,
            matched: searchResults.filter(
              (result) =>
                statusFor(result) === "matched" && selected.has(result.query)
            ).length,
            bundle: searchResults.filter(
              (result) =>
                statusFor(result) === "matched" &&
                result.matchSource === "bundle"
            ).length,
            name: searchResults.filter(
              (result) =>
                statusFor(result) === "matched" &&
                result.matchSource !== "bundle"
            ).length,
            pending: pendingMatchCount,
            skipped: searchResults.filter(
              (result) => statusFor(result) === "skipped"
            ).length,
            unavailable: searchResults.filter(
              (result) => statusFor(result) === "unmatched"
            ).length,
          };
          // Group by the *initial* match shape, NOT by the current
          // checkbox state. Earlier versions filtered each section on
          // `selected.has(result.query)`, so unticking a row made it
          // jump from "Matched by bundle ID" to "Needs review" mid-
          // session — confusing because the user thinks they just
          // unchecked an import, not relocated the row. With the new
          // filter, deselecting toggles the row's checkbox but keeps
          // it visually anchored to its original section. The actual
          // selected-for-import set still drives the import via
          // `effectiveSelected`, and the summary counts still reflect
          // the live selection state for accuracy.
          const sectionDefs = [
            {
              id: "bundle",
              title: tStep3("bundle_title"),
              description: tStep3("bundle_description"),
              results: visibleResults.filter(
                (result) =>
                  statusFor(result) === "matched" &&
                  result.matchSource === "bundle"
              ),
            },
            {
              id: "name",
              title: tStep3("name_title"),
              description: tStep3("name_description"),
              results: visibleResults.filter(
                (result) =>
                  statusFor(result) === "matched" &&
                  result.matchSource !== "bundle"
              ),
            },
            {
              id: "review",
              title: tStep3("review_title"),
              description: tStep3("review_description"),
              results: visibleResults.filter(
                (result) => statusFor(result) === "pending"
              ),
            },
            // "unavailable" used to bundle unmatched + skipped together,
            // but the actions a user wants on each are different: an
            // unmatched row is a candidate for the "save as manual app"
            // triage below, while a skipped row is intentionally out
            // of the import. Splitting them gives the triage a clean
            // surface and keeps skipped rows from cluttering it.
            {
              id: "unavailable",
              title: tStep3("unavailable_title"),
              description: tStep3("unavailable_description"),
              results: visibleResults.filter(
                (result) => statusFor(result) === "unmatched"
              ),
            },
            {
              id: "skipped",
              title: tStep3("skipped_title"),
              description: tStep3("skipped_description"),
              results: visibleResults.filter(
                (result) => statusFor(result) === "skipped"
              ),
            },
          ].filter((section) => section.results.length > 0);

          // List of query names that returned no App Store candidates,
          // and the subset that the user hasn't already skipped /
          // researched. Used for the bulk-action banner below the
          // tracked-banner — on a large cfgutil batch (200+ apps),
          // clicking "Skip this" per row is unworkable. The banner
          // gives a single "skip all" affordance and a count so the
          // user knows what they're collapsing.
          const unmatchedQueries = searchResults
            .filter((r) => r.candidates.length === 0)
            .map((r) => r.query);
          // Active = no candidate AND not already marked skipped. We
          // approximate "marked skipped" by checking whether the item
          // appears in itemIdByQuery (every block has an itemId; the
          // skip handler hits /api/imports/items/update without
          // removing the row, so this check is just a fuzz pass — the
          // bulk action below is idempotent against already-skipped
          // rows anyway, so a small over-count is harmless).
          const unmatchedCount = unmatchedQueries.length;

          return (
            <>
              <h1 className="wizard-title">{tWiz("confirm_matches")}</h1>
              <p className="wizard-subtitle">{tStep3("subtitle")}</p>

              {blockSearchError && (
                <p
                  role="alert"
                  style={{ color: "var(--red)", fontSize: 13, marginTop: 12 }}
                >
                  {blockSearchError}
                  {searchBlocked && (
                    <>
                      {" "}
                      <Link href="/dashboard/settings/admin#deployment-diagnostics">
                        {tStatus("search_access_blocked_link")}
                      </Link>
                    </>
                  )}
                </p>
              )}

              {/* Top summary + skip-to-import banner. Surfaces the "you can
                stop here" affordance so a 212-app review doesn't force
                the user to scroll the whole list. The button mirrors
                the footer's confirm CTA — both fire the same
                handleConfirm path. Hidden mid-search so the counts
                don't flicker during the iTunes lookup loop. */}
              {!searching && effectiveCount > 0 && (
                <div
                  className="wizard-note"
                  role="status"
                  style={{
                    marginTop: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    flexWrap: "wrap",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--r-lg)",
                    padding: "14px 16px",
                  }}
                >
                  <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        marginBottom: 4,
                      }}
                    >
                      {tStep3("ready_lead", { count: effectiveCount })}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-2)" }}>
                      {(() => {
                        const reviewable = visibleResults.filter(
                          (r) =>
                            statusFor(r) === "matched" &&
                            !selected.has(r.query) &&
                            r.candidates.length > 0
                        ).length;
                        const unmatched = visibleResults.filter(
                          (r) => statusFor(r) === "unmatched"
                        ).length;
                        const parts: string[] = [];
                        if (reviewable > 0) {
                          parts.push(
                            tStep3("ready_part_review", {
                              count: reviewable,
                            })
                          );
                        }
                        if (unmatched > 0) {
                          parts.push(
                            tStep3("ready_part_unmatched", {
                              count: unmatched,
                            })
                          );
                        }
                        if (parts.length === 0) {
                          return tStep3("ready_all_clear");
                        }
                        return tStep3("ready_more", {
                          parts: parts.join(", "),
                        });
                      })()}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={pendingMatchCount > 0 || rematchingRegion}
                    onClick={() => void handleConfirm(effectiveSelected)}
                    style={{ whiteSpace: "nowrap" }}
                    type="button"
                  >
                    {pendingMatchCount > 0
                      ? tStep3("ready_waiting", { count: pendingMatchCount })
                      : tStep3("ready_import_now", {
                          count: effectiveCount,
                        })}
                  </button>
                </div>
              )}

              {/* Already-tracked banner (moved from Step 2). Uses the exact
                appleId lookup so the count reflects the actual matches
                rather than a fuzzy name match.

                Two-phase render:
                  (a) while searches are still in flight — either the
                      initial request is pending (`searching`) or the
                      queued-search provider is sleeping through a rate
                      limit (`ratePending.pending`) — the duplicate
                      count is moving target, and flashing "3 already
                      tracked" → "7 already tracked" → "11 already
                      tracked" as each batch lands looks like a bug.
                      Show a neutral "Checking apps for duplicates…"
                      banner instead and leave the real count offstage.
                  (b) once everything has resolved, swap to the final
                      count + the hide-tracked toggle. If there's no
                      overlap at all, neither banner renders so the
                      review list stays uncluttered. */}
              {(() => {
                const stillChecking = searching || ratePending.pending;
                if (stillChecking) {
                  return (
                    <div
                      aria-live="polite"
                      className="wizard-note wizard-note-info"
                      role="status"
                      style={{
                        marginTop: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <span aria-hidden="true" className="spinner" />
                      <span>
                        <strong>{tStep3("checking_lead")}</strong>
                        {tStep3("checking_body")}
                      </span>
                    </div>
                  );
                }
                if (trackedSelectedCount === 0) {
                  return null;
                }
                return (
                  <div
                    className="wizard-note wizard-note-info"
                    style={{ marginTop: 12 }}
                  >
                    <strong>
                      {tStep3("tracked_lead", {
                        count: trackedSelectedCount,
                      })}
                    </strong>
                    {tStep3("tracked_body")}
                    {onboardHideTrackedToggleOn && (
                      <label
                        className="wizard-toggle-inline"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginTop: 10,
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        <input
                          checked={hideTrackedBlocks}
                          onChange={(event) =>
                            setHideTrackedBlocks(event.target.checked)
                          }
                          type="checkbox"
                        />
                        <span>
                          {tStep3("hide_tracked_label")}{" "}
                          <span
                            style={{
                              color: "var(--text-3)",
                              fontWeight: 400,
                            }}
                          >
                            {tStep3("hide_tracked_hint")}
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                );
              })()}

              {ratePending.pending &&
                (() => {
                  // Read `rateTick` so the countdown re-renders every second while
                  // we wait. The actual queue + timer lives in QueuedSearchProvider
                  // (layout-level) so it keeps running even if the user navigates
                  // away — this banner is just a local view on to its state.
                  void rateTick;
                  const queuedCount = ratePending.remaining;
                  const resumeAt = ratePending.resumeAt;
                  const remainingMs =
                    resumeAt === null
                      ? null
                      : Math.max(0, resumeAt - Date.now());
                  const remainingSec =
                    remainingMs === null ? null : Math.ceil(remainingMs / 1000);
                  return (
                    <div
                      aria-live="polite"
                      className="wizard-rate-banner"
                      role="status"
                    >
                      <div aria-hidden className="wizard-rate-banner-icon">
                        ⏳
                      </div>
                      <div className="wizard-rate-banner-copy">
                        <div className="wizard-rate-banner-title">
                          {tStep3("rate_limit_title")}
                        </div>
                        <div className="wizard-rate-banner-sub">
                          {tStep3("rate_limit_queued", {
                            count: queuedCount,
                          })}
                          {remainingSec === null
                            ? tStep3("rate_limit_resume_soon")
                            : tStep3("rate_limit_resume_in", {
                                sec: remainingSec,
                              })}
                          {tStep3("rate_limit_hint")}
                        </div>
                      </div>
                      <button
                        aria-label={tStep3("rate_limit_cancel_aria")}
                        className="wizard-rate-banner-cancel"
                        onClick={() => void handleCancelQueuedMatches()}
                        type="button"
                      >
                        {tStep3("rate_limit_cancel")}
                      </button>
                    </div>
                  );
                })()}

              {/* Country-rematch toolbar (kept from our branch). Lets the
                user switch App Store storefront mid-match without
                losing manual choices or skipped rows. */}
              <div className="onboard-match-toolbar">
                <div>
                  <div className="onboard-match-toolbar-title">
                    {tStep3("rematch_title", {
                      label: countryLabel(country),
                      code: country.toUpperCase(),
                    })}
                  </div>
                  <div className="onboard-match-toolbar-sub">
                    {tStep3("rematch_sub")}
                  </div>
                </div>
                <div className="onboard-match-region-controls">
                  <select
                    aria-label={tStep3("rematch_region_aria")}
                    className="settings-input settings-select"
                    disabled={rematchingRegion}
                    onChange={(event) =>
                      void handleRegionRematch(event.target.value)
                    }
                    value={country}
                  >
                    {COUNTRY_OPTIONS.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label} ({option.code.toUpperCase()})
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={rematchingRegion}
                    onClick={() => void handleRegionRematch(country)}
                    type="button"
                  >
                    {rematchingRegion ? (
                      <>
                        <span className="spinner-sm" /> {tStep3("rematching")}
                      </>
                    ) : (
                      tStep3("rematch_button")
                    )}
                  </button>
                </div>
              </div>

              {unmatchedCount > 0 && (
                // Unmatched-apps banner (from main's PR #7). Big cfgutil
                // imports routinely produce 50+ rows that didn't resolve
                // to an App Store candidate (sideloaded, region-restricted,
                // names too generic to disambiguate). One "skip all"
                // affordance keeps the review list usable.
                //
                // Note: the flat `visibleResults.map(...)` rendering that
                // originally followed this on main was dropped during the
                // merge — our branch's grouped `sectionDefs` rendering
                // below already renders the same blocks but organised by
                // status, which is the superseding UX.
                <div
                  className="wizard-note wizard-note-info"
                  style={{ marginTop: 12 }}
                >
                  <strong>
                    {tStep3("unmatched_lead", { count: unmatchedCount })}
                  </strong>
                  {tStep3("unmatched_body")}
                  <div style={{ marginTop: 10 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        for (const query of unmatchedQueries) {
                          void handleBlockSkip(query);
                        }
                      }}
                      type="button"
                    >
                      {tStep3("unmatched_skip_all", {
                        count: unmatchedCount,
                      })}
                    </button>
                  </div>
                </div>
              )}

              <div className="onboard-match-summary">
                <span>
                  {tStep3("summary_chip_imported", { count: summary.total })}
                </span>
                <span>
                  {tStep3("summary_chip_matched", { count: summary.matched })}
                </span>
                <span>
                  {tStep3("summary_chip_bundle", { count: summary.bundle })}
                </span>
                <span>
                  {tStep3("summary_chip_name", { count: summary.name })}
                </span>
                {summary.pending > 0 && (
                  <span>
                    {tStep3("summary_chip_pending", {
                      count: summary.pending,
                    })}
                  </span>
                )}
                {summary.skipped > 0 && (
                  <span>
                    {tStep3("summary_chip_skipped", {
                      count: summary.skipped,
                    })}
                  </span>
                )}
                {summary.unavailable > 0 && (
                  <span>
                    {tStep3("summary_chip_unavailable", {
                      count: summary.unavailable,
                    })}
                  </span>
                )}
                {webClipEntries.length > 0 && (
                  <span>
                    {tStep3("webclip_count_chip", {
                      count: webClipEntries.length,
                    })}
                  </span>
                )}
              </div>

              {/* Safari web-shortcuts panel. Rendered above the section list
                so the user spots and dispatches them up front — saving as
                a batch of manual web-apps is the right action 99% of the
                time, and clearing them gets the panel out of the way for
                the App Store match review below. */}
              {webClipEntries.length > 0 && (
                <section
                  aria-labelledby="webclip-section-heading"
                  className="onboard-match-section"
                >
                  <div className="onboard-match-section-header">
                    <div>
                      <h2 id="webclip-section-heading">
                        {tStep3("webclip_title")}{" "}
                        <span
                          style={{ color: "var(--text-2)", fontWeight: 400 }}
                        >
                          {tStep3("webclip_title_suffix")}
                        </span>
                      </h2>
                      <p>
                        {webClipSaveState === "saved"
                          ? tStep3("webclip_saved", {
                              count: webClipSavedCount,
                            })
                          : tStep3("webclip_lead", {
                              count: webClipEntries.length,
                            })}
                      </p>
                    </div>
                    <span>{webClipEntries.length}</span>
                  </div>
                  {webClipSaveState !== "saved" && (
                    <>
                      <ul
                        className="onboard-webclip-list"
                        style={{
                          listStyle: "none",
                          margin: "0 0 12px",
                          padding: "0 0 0 4px",
                          maxHeight: 220,
                          overflowY: "auto",
                        }}
                      >
                        {webClipEntries.map((e) => (
                          <li
                            key={e.id}
                            style={{
                              padding: "6px 0",
                              fontSize: 13,
                              color: "var(--text)",
                              borderBottom: "1px solid var(--border)",
                            }}
                          >
                            <strong>{e.name}</strong>
                            {e.bundleId && (
                              <span
                                style={{
                                  color: "var(--text-3)",
                                  marginLeft: 8,
                                  fontSize: 12,
                                }}
                              >
                                {e.bundleId.slice(0, 60)}
                                {e.bundleId.length > 60 ? "…" : ""}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {webClipSaveError && (
                        <p
                          style={{
                            color: "var(--danger)",
                            fontSize: 13,
                            margin: "0 0 8px",
                          }}
                        >
                          {webClipSaveError}
                        </p>
                      )}
                      <div
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                      >
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={webClipSaveState === "saving"}
                          onClick={async () => {
                            setWebClipSaveState("saving");
                            setWebClipSaveError("");
                            try {
                              const res = await fetch("/api/manual-apps/bulk", {
                                method: "POST",
                                headers: {
                                  "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                  apps: webClipEntries.map((e) => ({
                                    name: e.name,
                                    source: "web_clip" as const,
                                    developer: e.developer ?? null,
                                  })),
                                }),
                              });
                              const data = await res.json().catch(() => ({}));
                              if (!res.ok) {
                                throw new Error(
                                  data?.error ?? `HTTP ${res.status}`
                                );
                              }
                              const created =
                                typeof data.created === "number"
                                  ? data.created
                                  : 0;
                              setWebClipSavedCount(created);
                              setWebClipSaveState("saved");
                              // Drop the web-clip rows from importedApps so
                              // they no longer count toward summary.total and
                              // don't reappear if the user navigates back to
                              // Step 2.
                              setImportedApps((prev) =>
                                prev.filter((e) => !e.likelyWebClip)
                              );
                            } catch (err) {
                              setWebClipSaveState("error");
                              setWebClipSaveError(
                                err instanceof Error
                                  ? err.message
                                  : tStep3("webclip_save_failed")
                              );
                            }
                          }}
                          type="button"
                        >
                          {webClipSaveState === "saving" ? (
                            <>
                              <span className="spinner-sm" />{" "}
                              {tStep3("webclip_saving")}
                            </>
                          ) : (
                            tStep3("webclip_save_cta", {
                              count: webClipEntries.length,
                            })
                          )}
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}

              <div className="search-result-list">
                {sectionDefs.map((section) => {
                  // The "Not in the App Store" section needs a different row
                  // shape: each row offers a per-row triage dropdown
                  // (TestFlight / Sideloaded / Web app / Own build / Skip)
                  // and the whole section is finalised with a "Save all as
                  // manual apps" bulk CTA. The default-when-unset is
                  // `sideloaded` because it's the broadest "I know this
                  // app exists but it's not on the App Store" bucket.
                  if (section.id === "unavailable") {
                    return (
                      <section
                        className="onboard-match-section"
                        key={section.id}
                      >
                        <div className="onboard-match-section-header">
                          <div>
                            <h2>{section.title}</h2>
                            <p>
                              {unmatchedSaveState === "saved"
                                ? tStep3("unavailable_saved", {
                                    count: unmatchedSavedCount,
                                  })
                                : section.description}
                            </p>
                          </div>
                          <span>{section.results.length}</span>
                        </div>
                        {unmatchedSaveState !== "saved" && (
                          <>
                            <ul
                              style={{
                                listStyle: "none",
                                padding: 0,
                                margin: "0 0 12px",
                              }}
                            >
                              {section.results.map((result) => {
                                const choice =
                                  triageChoices.get(result.query) ??
                                  "sideloaded";
                                const isEditing = editingBlock === result.query;
                                return (
                                  <li
                                    key={result.query}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 12,
                                      padding: "10px 12px",
                                      borderBottom: "1px solid var(--border)",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    {isEditing ? (
                                      <UnavailableRowEditor
                                        busyEditing={
                                          blockSearching === result.query
                                        }
                                        initialQuery={result.query}
                                        onCancel={() => setEditingBlock(null)}
                                        onRetry={(nextQuery) => {
                                          // force=true so an unchanged
                                          // name still replays the
                                          // search — without it the
                                          // "nothing changed" guard
                                          // silently no-ops and the
                                          // button feels broken.
                                          // handleBlockResearch flags
                                          // the row in-flight via
                                          // `blockSearching` and closes
                                          // the editor on completion.
                                          void handleBlockResearch(
                                            result.query,
                                            nextQuery,
                                            undefined,
                                            true
                                          );
                                        }}
                                      />
                                    ) : (
                                      <>
                                        <strong
                                          style={{
                                            flex: "1 1 220px",
                                            minWidth: 0,
                                          }}
                                        >
                                          {result.query}
                                        </strong>
                                        <button
                                          className="link-button-inline"
                                          disabled={blockSearching !== null}
                                          onClick={() =>
                                            void handleBlockResearch(
                                              result.query,
                                              result.query,
                                              undefined,
                                              true
                                            )
                                          }
                                          style={{ fontSize: 13 }}
                                          title={tSearchBlock("retry_title")}
                                          type="button"
                                        >
                                          {blockSearching === result.query ? (
                                            <>
                                              <span className="spinner-sm" />{" "}
                                              {tSearchBlock("retry_busy")}
                                            </>
                                          ) : (
                                            tSearchBlock("retry_search")
                                          )}
                                        </button>
                                        <button
                                          className="link-button-inline"
                                          disabled={blockSearching !== null}
                                          onClick={() =>
                                            setEditingBlock(result.query)
                                          }
                                          style={{ fontSize: 13 }}
                                          type="button"
                                        >
                                          {tSearchBlock("edit_retry")}
                                        </button>
                                        <label
                                          htmlFor={`triage-${result.query}`}
                                          style={{
                                            fontSize: 12,
                                            color: "var(--text-2)",
                                          }}
                                        >
                                          {tSearchBlock("save_as_label")}
                                        </label>
                                        <select
                                          className="settings-input settings-select"
                                          id={`triage-${result.query}`}
                                          onChange={(e) => {
                                            const next = new Map(triageChoices);
                                            next.set(
                                              result.query,
                                              e.target.value as TriageChoice
                                            );
                                            setTriageChoices(next);
                                          }}
                                          style={{ minWidth: 180 }}
                                          value={choice}
                                        >
                                          <option value="sideloaded">
                                            {tStep3("triage_sideloaded")}
                                          </option>
                                          <option value="testflight">
                                            {tStep3("triage_testflight")}
                                          </option>
                                          <option value="web_clip">
                                            {tStep3("triage_web_clip")}
                                          </option>
                                          <option value="own_build">
                                            {tStep3("triage_own_build")}
                                          </option>
                                          <option value="skip">
                                            {tStep3("triage_skip")}
                                          </option>
                                        </select>
                                      </>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            {unmatchedSaveError && (
                              <p
                                style={{
                                  color: "var(--danger)",
                                  fontSize: 13,
                                  margin: "0 0 8px",
                                }}
                              >
                                {unmatchedSaveError}
                              </p>
                            )}
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={unmatchedSaveState === "saving"}
                                onClick={async () => {
                                  setUnmatchedSaveState("saving");
                                  setUnmatchedSaveError("");
                                  const payload = section.results
                                    .map((r) => {
                                      const choice =
                                        triageChoices.get(r.query) ??
                                        "sideloaded";
                                      if (choice === "skip") {
                                        return null;
                                      }
                                      return {
                                        name: r.query,
                                        source: choice,
                                        developer:
                                          developerHints.get(
                                            r.query.toLowerCase()
                                          ) ?? null,
                                      };
                                    })
                                    .filter(
                                      (row): row is NonNullable<typeof row> =>
                                        row !== null
                                    );
                                  if (payload.length === 0) {
                                    // All rows skipped — treat as save success
                                    // with count 0 so the section collapses.
                                    setUnmatchedSavedCount(0);
                                    setUnmatchedSaveState("saved");
                                    return;
                                  }
                                  try {
                                    const res = await fetch(
                                      "/api/manual-apps/bulk",
                                      {
                                        method: "POST",
                                        headers: {
                                          "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                          apps: payload,
                                        }),
                                      }
                                    );
                                    const data = await res
                                      .json()
                                      .catch(() => ({}));
                                    if (!res.ok) {
                                      throw new Error(
                                        data?.error ?? `HTTP ${res.status}`
                                      );
                                    }
                                    const created =
                                      typeof data.created === "number"
                                        ? data.created
                                        : 0;
                                    setUnmatchedSavedCount(created);
                                    setUnmatchedSaveState("saved");
                                    // Skip the just-saved rows so they
                                    // disappear from this section and don't
                                    // count toward summary.unavailable.
                                    for (const row of payload) {
                                      void handleBlockSkip(row.name);
                                    }
                                  } catch (err) {
                                    setUnmatchedSaveState("error");
                                    setUnmatchedSaveError(
                                      err instanceof Error
                                        ? err.message
                                        : tStep3("unavailable_save_failed")
                                    );
                                  }
                                }}
                                type="button"
                              >
                                {unmatchedSaveState === "saving" ? (
                                  <>
                                    <span className="spinner-sm" />{" "}
                                    {tStep3("unavailable_saving")}
                                  </>
                                ) : (
                                  tStep3("unavailable_save_cta", {
                                    count: section.results.length,
                                  })
                                )}
                              </button>
                            </div>
                          </>
                        )}
                      </section>
                    );
                  }
                  // Bundle-ID-matched rows are auto-resolved with the highest
                  // confidence we have (cfgutil supplied the bundleId; iTunes
                  // Lookup returned a direct hit). The user almost never
                  // needs to touch them, so render this section as a
                  // collapsed <details> accordion — header is always
                  // visible (count + "Show details" chevron) and the rows
                  // hide behind a single click. Other sections (Matched by
                  // name, Needs review, Skipped) stay inline because they
                  // are where the user's judgement is actually required.
                  // Bundle-ID-matched rows are auto-resolved with the
                  // highest confidence we have (cfgutil supplied the
                  // bundleId; iTunes Lookup returned a direct hit). The
                  // user almost never needs to touch them, so render
                  // this section as a collapsed <details> accordion —
                  // header is always visible (count + chevron) and the
                  // rows hide behind a single click. Other sections
                  // (Matched by name, Needs review, Skipped) stay inline
                  // because they're where the user's judgement is
                  // actually required.
                  const isBundle = section.id === "bundle";
                  const Wrapper: React.ElementType = isBundle
                    ? "details"
                    : "section";
                  const HeaderTag: React.ElementType = isBundle
                    ? "summary"
                    : "div";
                  const wrapperClass = isBundle
                    ? "onboard-match-section onboard-match-section-accordion"
                    : "onboard-match-section";
                  const headerClass = isBundle
                    ? "onboard-match-section-header onboard-match-section-summary"
                    : "onboard-match-section-header";
                  return (
                    <Wrapper className={wrapperClass} key={section.id}>
                      <HeaderTag className={headerClass}>
                        <div>
                          <h2>{section.title}</h2>
                          <p>{section.description}</p>
                        </div>
                        <span>{section.results.length}</span>
                        {isBundle && (
                          <span
                            aria-hidden="true"
                            className="onboard-match-section-chevron"
                          >
                            ▸
                          </span>
                        )}
                      </HeaderTag>
                      <div className="onboard-match-section-list">
                        {section.results.map((result) => (
                          <SearchResultBlock
                            chosen={selected.get(result.query) ?? null}
                            developerHint={
                              developerHints.get(result.query.toLowerCase()) ??
                              ""
                            }
                            editing={blockSearching === result.query}
                            key={result.query}
                            onChoose={(candidate) => {
                              if (candidate === null) {
                                const next = new Map(selected);
                                next.delete(result.query);
                                setSelected(next);
                                setManuallyChosenQueries((prev) => {
                                  const manual = new Set(prev);
                                  manual.delete(result.query);
                                  return manual;
                                });
                                setSearchResults((prev) =>
                                  prev.map((item) =>
                                    item.query === result.query
                                      ? {
                                          ...item,
                                          status:
                                            item.candidates.length > 0
                                              ? "matched"
                                              : "unmatched",
                                        }
                                      : item
                                  )
                                );
                                return;
                              }

                              setSelected(
                                new Map(selected).set(result.query, candidate)
                              );
                              setSkippedQueries((prev) => {
                                const next = new Set(prev);
                                next.delete(result.query);
                                return next;
                              });
                              setManuallyChosenQueries((prev) =>
                                new Set(prev).add(result.query)
                              );
                              setSearchResults((prev) =>
                                prev.map((item) =>
                                  item.query === result.query
                                    ? {
                                        ...item,
                                        status: "matched",
                                        matchSource: "manual",
                                      }
                                    : item
                                )
                              );
                            }}
                            onResearch={(nextQuery, nextDeveloper, force) =>
                              handleBlockResearch(
                                result.query,
                                nextQuery,
                                nextDeveloper,
                                force
                              )
                            }
                            onSkip={() => handleBlockSkip(result.query)}
                            result={result}
                            trackedByAppleId={trackedByAppleId}
                            trackedByBundleId={trackedByBundleId}
                          />
                        ))}
                      </div>
                    </Wrapper>
                  );
                })}
                {visibleResults.length === 0 && searchResults.length > 0 && (
                  // Only reachable when "Hide already-tracked apps" has
                  // filtered every block out — tell the user what happened
                  // and offer them a one-click way back to the full list.
                  <div
                    className="wizard-note wizard-note-info"
                    style={{ textAlign: "center" }}
                  >
                    {tStep3("all_hidden")}{" "}
                    <button
                      className="link-button-inline"
                      onClick={() => setHideTrackedBlocks(false)}
                      type="button"
                    >
                      {tStep3("show_all")}
                    </button>
                  </div>
                )}
              </div>

              <div className="wizard-footer-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setStep(2)}
                  type="button"
                >
                  {tStep3("back")}
                </button>
                <button
                  className="btn btn-primary"
                  data-testid="onboard-confirm-import"
                  disabled={
                    effectiveCount === 0 ||
                    pendingMatchCount > 0 ||
                    rematchingRegion
                  }
                  onClick={() => void handleConfirm(effectiveSelected)}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {pendingMatchCount > 0
                    ? tStep3("waiting_matches", { count: pendingMatchCount })
                    : tStep3("import_count", { count: effectiveCount })}
                </button>
              </div>
            </>
          );
        })()}
    </>
  );
}
