"use client";

/**
 * Step 4 — the import itself, app by app.
 *
 * Mostly progress reporting, because the run is long and can be
 * rate-limited by Apple partway through. A 429 does not fail the import:
 * the remaining apps are queued server-side and drained by a background
 * worker, which is what the queued-row states here are showing.
 */

import type { OnboardWizardState } from "@/lib/use-onboard-wizard";

export default function Step4ImportProgress({
  w,
}: {
  /** The whole `useOnboardWizard` return value — see ./README.md on
   *  why the steps take one object rather than their bindings. */
  w: OnboardWizardState;
}) {
  const {
    done,
    importDetailsOpen,
    importQueue,
    onboardImportRateLimitHandoffOn,
    onboardPostBackgroundWorkerOn,
    onboardStepImportProgressOn,
    router,
    scrapeActiveRowRef,
    scrapeCancelRef,
    scrapeList,
    scrapeListEndRef,
    scrapeRateLimit,
    scrapeRateTick,
    setImportDetailsOpen,
    setStep,
    step,
    tStep4,
    tWiz,
  } = w;

  return (
    <>
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
                  base + tStep4("subtitle_done_queued", { count: queuedCount })
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
              ? Math.min(total, Math.max(completedCount, drainState.processed))
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
            onToggle={(event) => setImportDetailsOpen(event.currentTarget.open)}
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
    </>
  );
}
