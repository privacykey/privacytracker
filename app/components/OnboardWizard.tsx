"use client";

import Link from "next/link";
import {
  AI_PROVIDER_OPTIONS,
  providerRequiresApiKey,
  providerSupportsApiKey,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from "../../lib/ai-config";
import type { DeviceClass } from "../../lib/device";
import { COUNTRY_OPTIONS, countryLabel } from "../../lib/region";
import {
  type TriageChoice,
  useOnboardWizard,
} from "../../lib/use-onboard-wizard";
import DeviceSyncDiffOverlay from "./DeviceSyncDiffOverlay";
import LiveTextModal from "./LiveTextModal";
import CancelSummariesModal from "./onboard/CancelSummariesModal";
import PolicyRunPanel from "./onboard/PolicyRunPanel";
import RateLimitPauseModal from "./onboard/RateLimitPauseModal";
import RestoreBackupModal from "./onboard/RestoreBackupModal";
import SearchResultBlock from "./onboard/SearchResultBlock";
import Step1ChooseMethod from "./onboard/Step1ChooseMethod";
import Step2EnterApps from "./onboard/Step2EnterApps";
import type { AppCandidate, SearchResult } from "./onboard/types";
import UnavailableRowEditor from "./onboard/UnavailableRowEditor";

const ONBOARD_AI_OPTIONS = AI_PROVIDER_OPTIONS;

interface OnboardWizardProps {
  /**
   * Server-resolved flags whose first paint must match the runtime-aware
   * resolver. Client-side `useFlag` falls back to hard defaults before the
   * resolver cache is hydrated, which is not enough for Tauri-only gates.
   */
  flags?: {
    methodConfigurator: boolean;
  };
  /**
   * Server-sniffed device class from the UA header. Drives the initial
   * method-card layout so the first paint shows the right primary option
   * for this device. Refined client-side by `refineDeviceOnClient` once
   * viewport width / touch points become observable.
   */
  initialDevice?: DeviceClass;
}

export default function OnboardWizard({
  initialDevice = "desktop",
  flags,
}: OnboardWizardProps) {
  const w = useOnboardWizard({ initialDevice, flags });
  const {
    stepLabels,
    router,
    importQueue,
    tWiz,
    tSearchBlock,
    tStepIndicator,
    tOnboard,
    tAiStep,
    tAiOptions,
    tStep3,
    tStep4,
    tStatus,
    onboardHideTrackedToggleOn,
    onboardStepAiSummariesOn,
    onboardPostDashboardSkipOn,
    onboardPostBackgroundWorkerOn,
    onboardImportRateLimitHandoffOn,
    onboardStepConfirmMatchesOn,
    onboardStepImportProgressOn,
    step,
    setStep,
    wizardRadioKeyDown,
    liveTextModalOpen,
    setLiveTextModalOpen,
    country,
    ratePending,
    rateTick,
    settingsLoaded,
    storedAi,
    aiProvider,
    aiApiKey,
    setAiApiKey,
    aiBaseUrl,
    setAiBaseUrl,
    aiModel,
    setAiModel,
    savingAi,
    aiError,
    setImportedApps,
    developerHints,
    webClipEntries,
    searchResults,
    setSearchResults,
    selected,
    setSelected,
    webClipSaveState,
    setWebClipSaveState,
    webClipSavedCount,
    setWebClipSavedCount,
    webClipSaveError,
    setWebClipSaveError,
    triageChoices,
    setTriageChoices,
    unmatchedSaveState,
    setUnmatchedSaveState,
    unmatchedSavedCount,
    setUnmatchedSavedCount,
    unmatchedSaveError,
    setUnmatchedSaveError,
    setManuallyChosenQueries,
    skippedQueries,
    setSkippedQueries,
    rematchingRegion,
    searching,
    searchBlocked,
    blockSearchError,
    blockSearching,
    hideTrackedBlocks,
    setHideTrackedBlocks,
    trackedByAppleId,
    trackedByBundleId,
    scrapeList,
    done,
    importDetailsOpen,
    setImportDetailsOpen,
    scrapeRateLimit,
    rateLimitPauseModal,
    setRateLimitPauseModal,
    scrapeCancelRef,
    scrapeRateTick,
    editingBlock,
    setEditingBlock,
    policyProgress,
    policyRunDone,
    activePhase,
    phaseAvgMs,
    cancelModalOpen,
    setCancelModalOpen,
    scrapeActiveRowRef,
    scrapeListEndRef,
    etaTick,
    restoreStage,
    restorePreview,
    pendingRestoreFilename,
    restoreError,
    setRestoreError,
    restoreConfirmText,
    setRestoreConfirmText,
    resetRestoreFlow,
    restoreModalCardRef,
    cancelModalCardRef,
    rateLimitModalCardRef,
    handleRestoreConfirm,
    aiTestStatus,
    aiTestMessage,
    aiTestLatency,
    testAiConnection,
    isPreviewMode,
    resyncDeviceId,
    resyncOverlayOpen,
    setResyncOverlayOpen,
    resyncOverlayApps,
    handleBlockResearch,
    handleBlockSkip,
    handleCancelQueuedMatches,
    handleRegionRematch,
    handleConfirm,
    aiSettingsComplete,
    runPolicyRegeneration,
    requestStop,
    providerOptions,
    selectedModelPreset,
    onProviderChange,
  } = w;
  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        {/*
          Dev-only preview banner — sits above the stepper when the
          wizard was opened via `/onboard?preview=fresh` from the
          DevMenu. Click-through is fine on every step except the
          final submit (Step 4's scrape batch), which short-circuits
          server-side calls when this mode is active. Distinct purple
          border so it's never mistaken for a real onboarding banner.
        */}
        {isPreviewMode && (
          <div className="wizard-preview-banner" role="status">
            <span aria-hidden="true" className="wizard-preview-banner-icon">
              👁
            </span>
            <div>
              <strong>{tOnboard("preview_banner.lead")}</strong>
              <span className="wizard-preview-banner-sub">
                {tOnboard("preview_banner.body")}
              </span>
            </div>
          </div>
        )}
        {/* Step indicator is informational only (not a navigation control),
            so expose it as an ordered list with aria-current="step" on the
            active one. Screen readers announce position in the sequence. */}
        <ol
          aria-label={tStepIndicator("aria", {
            step,
            total: stepLabels.length,
          })}
          className="wizard-steps"
        >
          {stepLabels.map(([value, label], index) => {
            const isActive = step === value;
            const isDone = step > value;
            const statusWord = isDone
              ? tStepIndicator("completed")
              : isActive
                ? tStepIndicator("current")
                : tStepIndicator("upcoming");
            return (
              <li
                aria-current={isActive ? "step" : undefined}
                className="wizard-step-node"
                key={value}
                style={{ flex: index < stepLabels.length - 1 ? 1 : "none" }}
              >
                <span className="sr-only">{statusWord}: </span>
                <div
                  aria-hidden="true"
                  className={`wizard-step-circle ${isDone ? "done" : isActive ? "active" : "inactive"}`}
                >
                  {isDone ? "✓" : value}
                </div>
                <span
                  className={`wizard-step-label ${isActive ? "active" : isDone ? "done" : ""}`}
                >
                  {label}
                </span>
                {index < stepLabels.length - 1 && (
                  <div
                    aria-hidden="true"
                    className={`wizard-step-line ${isDone ? "done" : ""}`}
                  />
                )}
              </li>
            );
          })}
        </ol>

        {step === 5 &&
          !onboardStepAiSummariesOn &&
          (() => {
            // Wave I: when `flag.onboarding.step.ai_summaries` resolves
            // off, the wizard skips the optional summary step entirely
            // and routes straight to the dashboard. The fire-once router
            // push happens inside an effect-style IIFE because `step ===
            // 5` only renders briefly before the navigation completes.
            if (typeof window !== "undefined") {
              queueMicrotask(() => router.push("/dashboard"));
            }
            return (
              <div
                className="wizard-note wizard-note-info"
                style={{ marginTop: 16 }}
              >
                {tOnboard("skipping_ai")}
              </div>
            );
          })()}

        {step === 5 &&
          onboardStepAiSummariesOn &&
          policyProgress.length === 0 && (
            <>
              <div className="wizard-subtle-eyebrow">{tAiStep("eyebrow")}</div>
              <h1 className="wizard-title">{tWiz("ai_summarise")}</h1>
              {/*
              Two-paragraph lede explaining *why* the policy step exists at
              all. Privacy labels = what the developer tells Apple; privacy
              policies = the closer-to-complete picture (subprocessors,
              retention, sale-of-data, etc.). We surface the watch-for-
              changes promise here so users understand the value even if
              they say "no thanks" to the AI summarisation offer below.
            */}
              <p className="wizard-subtitle">{tAiStep("lede")}</p>
              <p className="wizard-subtitle">{tAiStep("lede_paragraph_2")}</p>

              <h2 className="wizard-section-heading" style={{ marginTop: 24 }}>
                {tAiStep("ai_offer_heading")}
              </h2>
              <p className="wizard-subtitle">{tAiStep("subtitle")}</p>

              <div
                aria-label={tAiStep("provider_aria")}
                className="method-grid"
                onKeyDown={wizardRadioKeyDown}
                role="radiogroup"
              >
                {ONBOARD_AI_OPTIONS.map((option) => {
                  const selected = aiProvider === option.value;
                  return (
                    <button
                      aria-checked={selected}
                      className={`method-card ${selected ? "active" : ""}`}
                      key={option.value}
                      onClick={() => onProviderChange(option.value)}
                      role="radio"
                      tabIndex={selected ? 0 : -1}
                      type="button"
                    >
                      <div className="method-card-top">
                        <span className="method-card-badge">
                          {tAiStep("provider_badge")}
                        </span>
                        <span aria-hidden="true" className="method-card-radio">
                          {selected ? "✓" : ""}
                        </span>
                      </div>
                      <div className="method-card-title">
                        {option.labelKey
                          ? tAiOptions(option.labelKey)
                          : option.label}
                      </div>
                      <p className="method-card-copy">
                        {tAiOptions(option.descKey)}
                      </p>
                      <div className="method-card-hint">
                        {option.value === "openai"
                          ? tAiStep("hint_openai")
                          : option.value === "anthropic"
                            ? tAiStep("hint_anthropic")
                            : tAiStep("hint_custom")}
                      </div>
                    </button>
                  );
                })}
              </div>

              {aiProvider !== "disabled" && (
                <>
                  <div className="settings-field-grid">
                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("base_url_label")}
                      </span>
                      <input
                        className="settings-input"
                        onChange={(event) => setAiBaseUrl(event.target.value)}
                        placeholder={resolveDefaultBaseUrl(aiProvider)}
                        spellCheck={false}
                        type="text"
                        value={aiBaseUrl}
                      />
                    </label>

                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("popular_models_label")}
                      </span>
                      <select
                        className="settings-input settings-select"
                        onChange={(event) => {
                          if (event.target.value !== "__custom__") {
                            setAiModel(event.target.value);
                          }
                        }}
                        value={selectedModelPreset}
                      >
                        {providerOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                        <option value="__custom__">
                          {tAiStep("custom_model_option")}
                        </option>
                      </select>
                    </label>
                  </div>

                  <div
                    className="settings-field-grid"
                    style={{ marginTop: 16 }}
                  >
                    <label className="settings-field">
                      <span className="settings-field-label">
                        {tAiStep("model_id_label")}
                      </span>
                      <input
                        className="settings-input"
                        onChange={(event) => setAiModel(event.target.value)}
                        placeholder={resolveDefaultModel(aiProvider)}
                        spellCheck={false}
                        type="text"
                        value={aiModel}
                      />
                    </label>

                    {providerSupportsApiKey(aiProvider) && (
                      <label className="settings-field">
                        <span className="settings-field-label">
                          {tAiStep("api_key_label")}
                        </span>
                        <input
                          autoComplete="off"
                          className="settings-input"
                          onChange={(event) => setAiApiKey(event.target.value)}
                          // i18n-exempt — literal API-key prefix formats ("sk-ant-...", "sk-..."), locale-neutral
                          placeholder={
                            aiProvider === "anthropic"
                              ? "sk-ant-..."
                              : aiProvider === "openai"
                                ? "sk-..."
                                : tAiStep("api_key_placeholder_custom")
                          }
                          spellCheck={false}
                          type="password"
                          value={aiApiKey}
                        />
                        <span className="settings-field-help">
                          {providerRequiresApiKey(aiProvider)
                            ? tAiStep("api_key_help_required")
                            : tAiStep("api_key_help_optional")}
                        </span>
                      </label>
                    )}
                  </div>

                  <div className="ai-test-row" style={{ marginTop: 16 }}>
                    <button
                      className="btn btn-secondary ai-test-button"
                      disabled={
                        aiTestStatus === "testing" || !aiSettingsComplete
                      }
                      onClick={() => void testAiConnection()}
                      type="button"
                    >
                      <span
                        className={`ai-test-dot ai-test-dot-${aiTestStatus}`}
                      >
                        {aiTestStatus === "testing" ? (
                          <span className="spinner-sm" />
                        ) : null}
                      </span>
                      {aiTestStatus === "testing"
                        ? tAiStep("test_busy")
                        : aiTestStatus === "ok" || aiTestStatus === "fail"
                          ? tAiStep("test_retry")
                          : tAiStep("test_idle")}
                    </button>
                    {(aiTestMessage || aiTestLatency !== null) && (
                      <div
                        className={`ai-test-message ai-test-message-${aiTestStatus}`}
                      >
                        {aiTestStatus === "ok"
                          ? "✓ "
                          : aiTestStatus === "fail"
                            ? "⚠ "
                            : ""}
                        {aiTestMessage ||
                          (aiTestStatus === "ok"
                            ? tAiStep("test_reachable")
                            : "")}
                        {aiTestLatency !== null && (
                          <span className="ai-test-latency">
                            {tAiStep("test_latency", { ms: aiTestLatency })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {storedAi && !aiError && settingsLoaded && (
                <div
                  className="wizard-note wizard-note-green"
                  style={{ marginTop: 16 }}
                >
                  {tAiStep("stored_loaded")}
                </div>
              )}

              {aiError && (
                <div
                  className="wizard-note wizard-note-red"
                  style={{ marginTop: 16 }}
                >
                  {aiError}
                </div>
              )}

              <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
                {onboardPostDashboardSkipOn && (
                  <button
                    className="btn btn-secondary btn-lg"
                    disabled={savingAi}
                    onClick={() => router.push("/dashboard")}
                    type="button"
                  >
                    {tAiStep("skip_dashboard")}
                  </button>
                )}
                <button
                  className="btn btn-primary btn-lg"
                  disabled={
                    savingAi ||
                    !settingsLoaded ||
                    aiProvider === "disabled" ||
                    !aiSettingsComplete
                  }
                  onClick={() => void runPolicyRegeneration()}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {savingAi ? (
                    <>
                      <span className="spinner" /> {tAiStep("saving_ai")}
                    </>
                  ) : (
                    tAiStep("save_and_generate", {
                      count: scrapeList.filter(
                        (item) => item.status === "success"
                      ).length,
                    })
                  )}
                </button>
              </div>
            </>
          )}

        {step === 5 &&
          onboardStepAiSummariesOn &&
          policyProgress.length > 0 && (
            <PolicyRunPanel
              activePhase={activePhase}
              etaTick={etaTick}
              onCancelRequest={() => setCancelModalOpen(true)}
              onViewDashboard={() => router.push("/dashboard")}
              phaseAvgMs={phaseAvgMs}
              progress={policyProgress}
              runDone={policyRunDone}
            />
          )}

        <Step1ChooseMethod w={w} />

        <Step2EnterApps w={w} />

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
                        <Link href="/dashboard/settings#deployment-diagnostics">
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
                      remainingMs === null
                        ? null
                        : Math.ceil(remainingMs / 1000);
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
                                const res = await fetch(
                                  "/api/manual-apps/bulk",
                                  {
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
                                  }
                                );
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
                                  const isEditing =
                                    editingBlock === result.query;
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
                                              const next = new Map(
                                                triageChoices
                                              );
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
                                developerHints.get(
                                  result.query.toLowerCase()
                                ) ?? ""
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

        {step === 4 && onboardStepImportProgressOn && (
          <>
            <h1 className="wizard-title">
              {done ? tWiz("import_complete") : tWiz("import_running")}
            </h1>
            <p className="wizard-subtitle" style={{ marginBottom: 24 }}>
              {(() => {
                if (!done) {
                  return tStep4("subtitle_background");
                }
                const successCount = scrapeList.filter(
                  (item) => item.status === "success"
                ).length;
                const queuedCount = scrapeList.filter(
                  (item) => item.status === "queued"
                ).length;
                const base = tStep4("subtitle_done_base", {
                  success: successCount,
                  total: scrapeList.length,
                });
                if (queuedCount > 0) {
                  return (
                    base +
                    tStep4("subtitle_done_queued", { count: queuedCount })
                  );
                }
                return base;
              })()}
            </p>

            {(() => {
              void scrapeRateTick;
              const total = scrapeList.length;
              const successCount = scrapeList.filter(
                (item) => item.status === "success"
              ).length;
              const errorCount = scrapeList.filter(
                (item) => item.status === "error"
              ).length;
              const queuedCount = scrapeList.filter(
                (item) => item.status === "queued" || item.status === "pending"
              ).length;
              const completedCount = successCount + errorCount;
              const drainState = importQueue.drainState;
              const attemptedCount = drainState
                ? Math.min(
                    total,
                    Math.max(completedCount, drainState.processed)
                  )
                : completedCount;
              const drainPausedUntil = drainState?.pausedUntil ?? null;
              const drainPaused = Boolean(
                drainPausedUntil && drainPausedUntil > Date.now()
              );
              const drainPausedSec = drainPausedUntil
                ? Math.max(1, Math.ceil((drainPausedUntil - Date.now()) / 1000))
                : 0;
              const progressPct =
                total > 0
                  ? Math.max(4, Math.round((attemptedCount / total) * 100))
                  : 0;
              return (
                <div
                  aria-live="polite"
                  className="onboard-import-status-card"
                  role="status"
                >
                  <div className="onboard-import-status-topline">
                    <div>
                      <div className="onboard-import-status-title">
                        {done
                          ? tStep4("status_done", {
                              done: completedCount,
                              total,
                            })
                          : tStep4("status_running", {
                              done: attemptedCount,
                              total,
                            })}
                      </div>
                      <div className="onboard-import-status-sub">
                        {drainPaused
                          ? tStep4("rate_limit_sub", { sec: drainPausedSec })
                          : queuedCount > 0
                            ? tStep4("status_background_hint", {
                                count: queuedCount,
                              })
                            : errorCount > 0
                              ? tStep4("status_done_with_errors", {
                                  count: errorCount,
                                })
                              : tStep4("status_done_clean")}
                      </div>
                    </div>
                    {!done && <span aria-hidden className="spinner-sm" />}
                  </div>
                  <div aria-hidden className="onboard-import-progress">
                    <div
                      className="onboard-import-progress-fill"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="onboard-import-status-meta">
                    <span>
                      {tStep4("status_imported", { count: successCount })}
                    </span>
                    <span>
                      {tStep4("status_waiting", { count: queuedCount })}
                    </span>
                    {errorCount > 0 && (
                      <span>
                        {tStep4("status_attention", { count: errorCount })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            {onboardImportRateLimitHandoffOn &&
              scrapeRateLimit &&
              (() => {
                // Touch `scrapeRateTick` so the seconds value re-renders every
                // second while we wait out Apple's cooldown.
                void scrapeRateTick;
                const remainingMs = Math.max(
                  0,
                  scrapeRateLimit.resumeAt - Date.now()
                );
                const remainingSec = Math.ceil(remainingMs / 1000);
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
                        {tStep4("rate_limit_title")}
                      </div>
                      <div className="wizard-rate-banner-sub">
                        {tStep4("rate_limit_sub", { sec: remainingSec })}
                      </div>
                    </div>
                    {onboardPostBackgroundWorkerOn && (
                      <button
                        aria-label={tStep4("rate_limit_handoff_aria")}
                        className="wizard-rate-banner-cancel"
                        onClick={() => {
                          scrapeCancelRef.current = true;
                        }}
                        type="button"
                      >
                        {tStep4("rate_limit_handoff")}
                      </button>
                    )}
                  </div>
                );
              })()}

            <details
              className="onboard-import-details"
              onToggle={(event) =>
                setImportDetailsOpen(event.currentTarget.open)
              }
              open={importDetailsOpen}
            >
              <summary>
                <span>
                  {tStep4("details_summary", { count: scrapeList.length })}
                </span>
                <span aria-hidden className="onboard-import-details-chevron">
                  ⌄
                </span>
              </summary>
              {scrapeList.length > 10 && !done && (
                <div className="scrape-jump-row">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const el = scrapeListEndRef.current;
                      if (!el) {
                        return;
                      }
                      try {
                        el.scrollIntoView({ block: "end", behavior: "smooth" });
                      } catch {
                        el.scrollIntoView();
                      }
                    }}
                    type="button"
                  >
                    {tStep4("scroll_to_bottom")}
                  </button>
                </div>
              )}
              <div className="scrape-list-wrap">
                <div className="scrape-list">
                  {scrapeList.map((item, index) => (
                    <div
                      className={`scrape-row ${item.status === "error" ? "error" : ""} ${item.status === "queued" ? "queued" : ""}`}
                      key={`${item.url}-${index}`}
                      ref={
                        item.status === "scraping"
                          ? scrapeActiveRowRef
                          : undefined
                      }
                    >
                      <div className="scrape-status-icon">
                        {item.status === "pending" && (
                          <span style={{ color: "var(--text-3)" }}>○</span>
                        )}
                        {item.status === "scraping" && (
                          <span className="spinner-sm" />
                        )}
                        {item.status === "success" && (
                          <span style={{ color: "var(--green)" }}>✓</span>
                        )}
                        {item.status === "error" && (
                          <span
                            aria-label={tStep4("row_failed_aria")}
                            style={{ color: "var(--red)" }}
                          >
                            !
                          </span>
                        )}
                        {item.status === "queued" && (
                          <span
                            aria-label={tStep4("row_queued_aria")}
                            style={{ color: "var(--orange)" }}
                          >
                            ⏱
                          </span>
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="scrape-name">{item.name}</div>
                        {item.status === "error" && item.error && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--red)" }}
                          >
                            {item.error}
                          </div>
                        )}
                        {item.status === "queued" && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--orange)" }}
                          >
                            {item.error ?? tStep4("row_queued_default")}
                            {/*
                              `row_queued_retry_in` (a "Next retry in NNNs"
                              countdown) used to render here, derived from
                              the row's next_attempt_at. It was misleading:
                              once the server worker claims a row it pushes
                              next_attempt_at out by 10 minutes as an
                              in-flight fence (lib/imports.ts ::
                              claimQueuedBatch), so the user saw a 600s
                              countdown for a row that was actually about
                              to finish scraping in seconds. We drop the
                              timer entirely — the static "Queued / retrying"
                              copy is the truthful signal.
                            */}
                          </div>
                        )}
                        {item.status === "success" && item.changesDetected && (
                          <div
                            className="scrape-sub"
                            style={{ color: "var(--orange)" }}
                          >
                            {tStep4("row_changes_detected")}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div aria-hidden ref={scrapeListEndRef} />
              </div>
            </details>

            {(done || scrapeList.length > 0) && (
              <div className="wizard-footer-actions" style={{ marginTop: 28 }}>
                <button
                  className="btn btn-secondary btn-lg"
                  onClick={() => router.push("/dashboard")}
                  type="button"
                >
                  {tStep4("skip_dashboard")}
                </button>
                {!done && (
                  <button
                    className="btn btn-secondary btn-lg"
                    onClick={() =>
                      router.push("/dashboard/settings/import-history")
                    }
                    type="button"
                  >
                    {tStep4("view_history")}
                  </button>
                )}
                <button
                  className="btn btn-primary btn-lg"
                  data-testid="onboard-next-ai"
                  disabled={
                    scrapeList.filter((item) => item.status === "success")
                      .length === 0
                  }
                  onClick={() => setStep(5)}
                  style={{ flex: 1 }}
                  type="button"
                >
                  {tStep4("next_ai")}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {(restoreStage === "confirm" || restoreStage === "applying") &&
        restorePreview && (
          <RestoreBackupModal
            handleRestoreConfirm={handleRestoreConfirm}
            pendingRestoreFilename={pendingRestoreFilename}
            resetRestoreFlow={resetRestoreFlow}
            restoreConfirmText={restoreConfirmText}
            restoreError={restoreError}
            restoreModalCardRef={restoreModalCardRef}
            restorePreview={restorePreview}
            restoreStage={restoreStage}
            setRestoreConfirmText={setRestoreConfirmText}
            setRestoreError={setRestoreError}
          />
        )}

      <CancelSummariesModal
        cancelModalCardRef={cancelModalCardRef}
        cancelModalOpen={cancelModalOpen}
        requestStop={requestStop}
        setCancelModalOpen={setCancelModalOpen}
      />

      {/* Rate-limit pause modal. Opened by the scrape loop on the first
          Apple 429. Gives the user two concrete next steps so they don't
          just sit watching a frozen progress list:
            • "View Import History" — opens Settings → Import History so
              they can watch the background queue worker drain the rest.
            • "Summarise privacy policies" — advances the wizard to step 5
              (AI summaries) for whatever apps imported cleanly before the
              rate-limit hit. Hidden when nothing imported successfully,
              since there'd be nothing to summarise. */}
      <RateLimitPauseModal
        rateLimitModalCardRef={rateLimitModalCardRef}
        rateLimitPauseModal={rateLimitPauseModal}
        router={router}
        setRateLimitPauseModal={setRateLimitPauseModal}
        setStep={setStep}
      />

      <LiveTextModal
        onClose={() => setLiveTextModalOpen(false)}
        open={liveTextModalOpen}
      />

      {/* Re-sync diff overlay — only mounts when the wizard was opened
       *  with `?resync=<deviceId>` and the import has finished. The
       *  overlay drives /api/device-sync/preview + /api/device-sync/commit
       *  on top of the apps the import just resolved. */}
      {resyncDeviceId && (
        <DeviceSyncDiffOverlay
          currentImport={resyncOverlayApps}
          deviceId={resyncDeviceId}
          onClose={() => setResyncOverlayOpen(false)}
          onCommit={(result) => {
            setResyncOverlayOpen(false);
            // Bounce the user to the Devices page with a flash toast so
            // they see "Re-sync: 2 added, 3 removed." It's the natural
            // place to land — they came from there. `merged` counts
            // legacy duplicate rows collapsed during the commit (see
            // DiffBundleIdMerge in lib/device-sync.ts).
            const params = new URLSearchParams();
            params.set("resync_added", String(result.added));
            params.set("resync_removed", String(result.removed));
            params.set("resync_orphaned", String(result.orphanedAndDeleted));
            if (result.merged > 0) {
              params.set("resync_merged", String(result.merged));
            }
            router.push(`/dashboard/settings/devices?${params.toString()}`);
          }}
          open={resyncOverlayOpen}
        />
      )}
    </div>
  );
}

// --- PolicyRunPanel ---------------------------------------------------------
//
// Full-width progress panel shown on step 5 once a policy run kicks off.
// Replaces the config form so the user can't accidentally edit settings mid-run.
