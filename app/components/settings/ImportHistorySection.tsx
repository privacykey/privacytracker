"use client";

/**
 * Import History — the full review-and-retry surface on its own page.
 *
 * This is the biggest section in Settings by a wide margin: the imports
 * list, per-row item expansion, a global status filter driven by both the
 * summary badges and notification deep-links, Apple's rate-limit queue with
 * its drain progress, per-item and bulk retries, and the inline
 * change-match / re-add widget.
 *
 * All of its state lives in `useImportHistory`, which SettingsView calls
 * and passes down whole as `ih`. That is deliberate: the delete-confirm
 * modal renders as a page-level overlay outside this section, so the hook
 * cannot be called here — two call sites would mean two independent copies
 * of the state. One object prop beats threading thirty-one bindings.
 *
 * Anchor id `import-history` matches the SettingsSidebar entry. Note the
 * compact link card (ImportHistoryLinkCard) carries the *same* id — they
 * are mutually exclusive `viewMode` branches, so only one is ever in the
 * document.
 */

import "./import-history.css";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDateFormat } from "@/lib/date-format-hook";
import {
  type ImportItemStatus,
  type ItemStatusFilter,
  itemMatchesFilter,
  type useImportHistory,
} from "@/lib/use-import-history";
import { useImportQueue } from "../ImportQueueProvider";
import RateLimitBanner from "../RateLimitBanner";
import type { TimeT } from "./format";
import { fmtShortDate } from "./format";

/** Short label + tone for the filter banner. Keyed by filter id. */
const FILTER_META: Record<ItemStatusFilter, { label: string; tone: string }> = {
  unmatched: { label: "Unmatched", tone: "warn" },
  error: { label: "Errors", tone: "bad" },
  removed: { label: "Removed", tone: "mute" },
  queued: { label: "Queued", tone: "warn" },
  problems: { label: "Problems (unmatched + error)", tone: "warn" },
};

// Status icons are deliberately light on ✗. An errored import row is still
// eligible for retry (the Retry import button on the detail row, the bulk
// Retry all on the filter banner, or the server-side queue worker), so a
// clock ("will retry") reads more accurately than a dead X. The stronger
// error tone is still carried by `tone: 'bad'` so the row shows red.
const STATUS_META: Record<
  ImportItemStatus,
  { label: string; tone: string; icon: string }
> = {
  imported: { label: "Imported", tone: "ok", icon: "✓" },
  matched: { label: "Matched", tone: "ok", icon: "✓" },
  unmatched: { label: "Unmatched", tone: "warn", icon: "⚠" },
  skipped: { label: "Skipped", tone: "mute", icon: "–" },
  error: { label: "Error", tone: "bad", icon: "⏱" },
  queued: { label: "Queued", tone: "warn", icon: "⏱" },
  removed: { label: "Removed", tone: "mute", icon: "∅" },
};

/**
 * Format a short countdown to a future timestamp for queue retry UX.
 * `~5s`, `~2m 10s`, `~1h 05m`. Returns `now` if the timestamp is in the past.
 */
function fmtQueueCountdown(t: TimeT, ts: number | null | undefined): string {
  if (!ts) {
    return t("queue_now");
  }
  const diff = ts - Date.now();
  if (diff <= 0) {
    return t("queue_now");
  }
  const secs = Math.ceil(diff / 1000);
  if (secs < 60) {
    return t("queue_seconds", { seconds: secs });
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) {
    return s > 0
      ? t("queue_minutes_seconds", { minutes: m, seconds: s })
      : t("queue_minutes", { minutes: m });
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return t("queue_hours_minutes", {
    hours: h,
    minutes: String(mm).padStart(2, "0"),
  });
}

/**
 * Short label for a PolicyRunPhase `phase` field, used to keep the bulk
 * "Privacy Policies" TaskCenter subtitle moving while the stream is
 * running. Mirrors `describePolicyPhase` in AppDetailView but kept local
 * here so SettingsView doesn't pull in a client component just for the
 * helper.
 */
/**
 * Map a known iOS / macOS / Apple device class to a small emoji glyph
 * for the import-history list. Returns null when the label doesn't
 * carry a recognisable class — callers fall back to no icon, which
 * matches the current behaviour for non-cfgutil sources (manual entry,
 * file upload, screenshot OCR).
 *
 * The OnboardWizard's cfgutil-export path encodes the class as a
 * structured " · " segment in the source label, e.g.
 *   "Apple Configurator · iPhone · Aria's iPhone"
 * so we just split, look for any segment that matches the known set,
 * and pick the matching glyph. macOS / iOS don't have great emoji for
 * iPad and Apple Watch specifically, so we use 📱 for the iPhone
 * family, 🟦 as a placeholder for iPad-shape devices, ⌚️ for Watch,
 * and 📺 for Apple TV. Unicode 16's `iPad` glyph isn't widely
 * deployed yet — fall back to 📱 if you see weird boxes on older
 * macOS versions and the prefix vanishes silently.
 */
function pickSourceIcon(
  sourceLabel: string | null,
  source: string
): { glyph: string; title: string } | null {
  if (!sourceLabel) {
    return null;
  }
  // Cheap class detection — split on the same separator OnboardWizard
  // uses, plus a few inline-prefix variants other importers might
  // produce (e.g. "iPhone backup file" from a future Configurator
  // CSV export). Case-insensitive to absorb formatting drift.
  const segments = sourceLabel.split("·").map((s) => s.trim().toLowerCase());
  const has = (needle: string) =>
    segments.some((seg) => seg === needle || seg.startsWith(`${needle} `));

  if (has("iphone")) {
    return { glyph: "📱", title: "iPhone" };
  }
  if (has("ipad")) {
    return { glyph: "📱", title: "iPad" };
  }
  if (has("ipod")) {
    return { glyph: "🎵", title: "iPod" };
  }
  if (has("appletv") || has("apple tv")) {
    return { glyph: "📺", title: "Apple TV" };
  }
  if (has("applewatch") || has("apple watch")) {
    return { glyph: "⌚️", title: "Apple Watch" };
  }

  // Source-keyed fallbacks. When the label doesn't carry a class
  // (manual entry, file upload, the import was created before this
  // feature shipped), pick a glyph from the import's `source` value
  // so the row at least has *some* visual anchor matching the
  // surrounding affordances.
  if (source === "configurator") {
    return { glyph: "📱", title: "Apple Configurator" };
  }
  if (source === "file") {
    return { glyph: "📄", title: "File upload" };
  }
  if (source === "manual") {
    return { glyph: "⌨️", title: "Manual entry" };
  }
  if (source === "screenshot" || source === "screenshots") {
    return { glyph: "📷", title: "Screenshot OCR" };
  }

  return null;
}

export default function ImportHistorySection({
  ih,
}: {
  /** The whole `useImportHistory` return value — see the note above on why
   *  this is one prop rather than thirty-one. */
  ih: ReturnType<typeof useImportHistory>;
}) {
  const dateMode = useDateFormat();
  const importQueue = useImportQueue();
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tTime = useTranslations("settings.time");
  const tPh = useTranslations("settings.placeholders");
  const tImpHistory = useTranslations("settings.import_history");
  const tImpQueue = useTranslations("settings.import_history.queue_banner");
  const tImpFilterBanner = useTranslations(
    "settings.import_history.filter_banner"
  );
  const tImpFilterMeta = useTranslations("settings.import_history.filter_meta");
  const tImpSource = useTranslations("settings.import_history.source");
  const tImpStatusMeta = useTranslations("settings.import_history.status_meta");
  const tImpActions = useTranslations("settings.import_history.actions");
  const tImpItem = useTranslations("settings.import_history.item");
  const tImpChangeMatch = useTranslations(
    "settings.import_history.change_match"
  );
  const tImpLegacy = useTranslations("settings.import_history.legacy");
  const tImpCouldntLoad = useTranslations(
    "settings.import_history.couldnt_load"
  );

  const {
    applyChangeMatch,
    changeMatch,
    clearItemFilter,
    closeChangeMatch,
    countItemsMatchingFilter,
    expandedImportId,
    expandedItems,
    expandingId,
    handleBadgeClick,
    handleCancelDrain,
    handleRemoveItemFromDashboard,
    handleRetryAllErrors,
    handleRetryImport,
    handleRetryItem,
    handleRetryQueue,
    handleRetrySingleItem,
    highlightItemId,
    imports,
    itemStatusFilter,
    openChangeMatch,
    removingItemId,
    retryAllProgress,
    retryingAll,
    retryingItemId,
    retryingQueue,
    runChangeMatchSearch,
    setChangeMatch,
    setDeleteTarget,
    setExpandedImportId,
    setExpandedItems,
    toggleImportRow,
  } = ih;

  return (
    <div className="settings-section" id="import-history">
      <h2 className="settings-section-title">{tSections("import_history")}</h2>
      <p className="settings-section-subtitle">{tSub("import_history")}</p>

      {/* Live rate-limit banners.

            Surfaces an *active* iTunes Search or App Store HTML cooldown so
            users can immediately see when "0 results" or "scrape failed"
            messages on this page are due to Apple throttling rather than
            broken matching or network errors. Polls /api/rate-limit/status
            in the background; renders nothing when idle.

            Both categories shown here because Import History is the surface
            where users land after a problem and need to understand what's
            happening — search throttling affects change-match lookups,
            scrape throttling affects the queued retry worker. They're
            shown in separate banners so each can resolve independently. */}
      <RateLimitBanner category="search" pollWhenIdle />
      <RateLimitBanner category="scrape" pollWhenIdle />

      {/* Queue status banner. Only shown when the background import worker
            still has work queued (typically because Apple rate-limited us
            during onboarding). The "Retry now" button kicks a foreground
            drain loop (handleRetryQueue) that keeps calling retryNow() until
            the queue empties, the user cancels, or Apple rate-limits us
            (in which case it waits out the cooldown automatically and
            resumes — see the auto-retry path in handleRetryQueue).

            Three render modes:
            1. Idle (no drainState): the original "X queued / next retry in Ns"
               summary + "Retry queue now" CTA.
            2. Draining (drainState != null, not paused): live progress bar
               showing "N of M done", the per-tick spinner, and a Cancel
               button.
            3. Draining + paused: progress bar PLUS a countdown to when the
               drain will auto-resume after Apple's cooldown elapses. We
               compute the countdown locally off `pausedUntil - Date.now()`
               so it ticks at 1Hz without the server having to push updates. */}
      {importQueue.state.queued > 0 &&
        (() => {
          // Bind the provider's drainState into a local for readable
          // JSX. Same shape, different owner — survives navigation.
          const drainState = importQueue.drainState;
          return (
            <div className="import-queue-banner" role="status">
              <div className="import-queue-banner-body">
                <span aria-hidden className="import-queue-banner-icon">
                  ⏳
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="import-queue-banner-title">
                    {drainState
                      ? tImpQueue("draining_title", {
                          done: Math.min(
                            drainState.processed,
                            drainState.initialTotal
                          ),
                          total: drainState.initialTotal,
                        })
                      : tImpQueue("title", {
                          count: importQueue.state.queued,
                        })}
                  </div>
                  <div className="import-queue-banner-sub">
                    {drainState?.pausedUntil &&
                    drainState.pausedUntil > Date.now()
                      ? tImpQueue("drain_paused", {
                          countdown: fmtQueueCountdown(
                            tTime,
                            drainState.pausedUntil
                          ),
                        })
                      : drainState
                        ? tImpQueue("drain_running")
                        : importQueue.state.pausedUntil &&
                            importQueue.state.pausedUntil > Date.now()
                          ? tImpQueue("paused", {
                              countdown: fmtQueueCountdown(
                                tTime,
                                importQueue.state.pausedUntil
                              ),
                            })
                          : importQueue.state.soonestNextAttemptAt &&
                              importQueue.state.soonestNextAttemptAt >
                                Date.now()
                            ? tImpQueue("next_retry", {
                                countdown: fmtQueueCountdown(
                                  tTime,
                                  importQueue.state.soonestNextAttemptAt
                                ),
                              })
                            : tImpQueue("retrying_now")}
                  </div>
                  {drainState && (
                    <div
                      aria-valuemax={drainState.initialTotal}
                      aria-valuemin={0}
                      aria-valuenow={drainState.processed}
                      className="import-queue-progress"
                      role="progressbar"
                    >
                      <div
                        className="import-queue-progress-fill"
                        style={{
                          width: `${Math.min(100, Math.round((drainState.processed / drainState.initialTotal) * 100))}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {drainState ? (
                  <button
                    className="pill-button"
                    disabled={drainState.cancelled}
                    onClick={handleCancelDrain}
                    type="button"
                  >
                    {drainState.cancelled
                      ? tImpQueue("cancelling")
                      : tImpQueue("cancel_drain")}
                  </button>
                ) : (
                  <button
                    className="pill-button"
                    disabled={retryingQueue}
                    onClick={() => void handleRetryQueue()}
                    type="button"
                  >
                    {retryingQueue ? (
                      <>
                        <span className="spinner-sm" /> {tImpQueue("retrying")}
                      </>
                    ) : (
                      tImpQueue("retry_button")
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

      {/* Active-filter banner. Shown whenever the user has arrived here
            from a notification (?filter=…) or clicked one of the per-row
            status badges. Imports with zero matching items collapse away
            while the filter is active — clear the filter to see the full
            history again.

            When the filter covers a retryable status (error / unmatched /
            problems), the banner also gets a "Retry all" button that
            sweeps every retryable item in the filter through the same
            change-match endpoint the single-row "Retry import" uses. */}
      {itemStatusFilter &&
        (() => {
          // A filter is retry-eligible if any of the statuses it covers
          // is a retryable one (error or unmatched). `problems` covers
          // both; `error` and `unmatched` cover themselves. `queued`
          // items use the queue-retry path instead, and `removed` can't
          // be retried at all.
          const filterCoversRetryable =
            itemMatchesFilter("error", itemStatusFilter) ||
            itemMatchesFilter("unmatched", itemStatusFilter);
          // Only offer the bulk button when at least one import-row has
          // counters suggesting retryable items. Avoids offering a
          // useless button for a filter like `removed` or an empty state.
          const retryableImportsPresent = (imports ?? []).some(
            (row) => (row.errored ?? 0) + (row.unmatched ?? 0) > 0
          );
          const showRetryAll = filterCoversRetryable && retryableImportsPresent;
          return (
            <div
              className={`import-history-filter-banner import-history-filter-banner-${FILTER_META[itemStatusFilter].tone}`}
              role="status"
            >
              <div className="import-history-filter-banner-body">
                <span aria-hidden className="import-history-filter-banner-icon">
                  🔎
                </span>
                <div>
                  <div className="import-history-filter-banner-title">
                    {tImpFilterBanner("showing", {
                      label: tImpFilterMeta(itemStatusFilter),
                    })}
                  </div>
                  <div className="import-history-filter-banner-sub">
                    {retryingAll && retryAllProgress
                      ? tImpFilterBanner("retrying", {
                          done: retryAllProgress.done,
                          total: retryAllProgress.total,
                        })
                      : tImpFilterBanner("hidden")}
                  </div>
                </div>
              </div>
              <div className="import-history-filter-banner-actions">
                {showRetryAll && (
                  <button
                    className="pill-button pill-button-primary"
                    disabled={retryingAll}
                    onClick={() => void handleRetryAllErrors()}
                    title={tImpFilterBanner("retry_all_title")}
                    type="button"
                  >
                    {retryingAll && retryAllProgress ? (
                      <>
                        <span className="spinner-sm" />{" "}
                        {tImpFilterBanner("retry_all_busy", {
                          done: retryAllProgress.done,
                          total: retryAllProgress.total,
                        })}
                      </>
                    ) : (
                      tImpFilterBanner("retry_all")
                    )}
                  </button>
                )}
                <button
                  className="pill-button"
                  disabled={retryingAll}
                  onClick={clearItemFilter}
                  type="button"
                >
                  {tImpFilterBanner("clear_filter")}
                </button>
              </div>
            </div>
          );
        })()}

      {imports === null ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--text-3)",
          }}
        >
          <span className="spinner-sm" /> {tImpHistory("loading_imports")}
        </div>
      ) : imports.length === 0 ? (
        <div className="import-history-empty">
          {tImpHistory("empty_no_imports")}
        </div>
      ) : (
        (() => {
          // When a filter is active, hide imports that have no matching
          // items. Keeps the user focused on the rows they asked to see
          // (e.g. only imports with unmatched apps when they clicked the
          // bell's "Unmatched apps to review" notification).
          const visibleImports = itemStatusFilter
            ? imports.filter(
                (r) => countItemsMatchingFilter(r, itemStatusFilter) > 0
              )
            : imports;
          if (visibleImports.length === 0) {
            return (
              <div className="import-history-empty">
                {tImpHistory("empty_filter_lead")}{" "}
                <button
                  className="btn btn-link"
                  onClick={clearItemFilter}
                  style={{ padding: 0 }}
                  type="button"
                >
                  {tImpHistory("empty_filter_action")}
                </button>
                {tImpHistory("empty_filter_post")}
              </div>
            );
          }
          return (
            <ul className="import-history-list">
              {visibleImports.map((importRow) => {
                const isExpanded = expandedImportId === importRow.id;
                const items = expandedItems[importRow.id];
                const loadingItems = expandingId === importRow.id && !items;
                const sourceText = importRow.sourceLabel
                  ? `"${importRow.sourceLabel}"`
                  : tImpSource(importRow.source);
                // Pick a glyph based on the device class baked into the
                // source label. The OnboardWizard's cfgutil path now
                // formats labels as "Apple Configurator · <class> · <name>"
                // so we can recognise iPhone / iPad / iPod / AppleTV /
                // AppleWatch and render an emoji prefix without needing
                // a separate database column. Returns null when no class
                // is detectable, which preserves the current "no icon"
                // behaviour for legacy rows + non-cfgutil sources (file
                // upload, manual entry, screenshot).
                const sourceIcon = pickSourceIcon(
                  importRow.sourceLabel,
                  importRow.source
                );
                // Live counters come from the `/api/imports` list payload, so
                // the summary row can render problem badges and the "Resume
                // matching" button without expanding the row first.
                //
                // `importRow.unmatched` is an aggregate server counter that
                // includes unmatched, error, and removed items; the individual
                // `queued` / `errored` / `removed` columns are joined in at
                // query time. We surface only the attention-worthy counters
                // (per user feedback: "only show something about apps not
                // imported, or errors" — the old `✓ N` tick was confusing).
                const queuedCount = importRow.queued;
                const erroredCount = importRow.errored;
                const removedCount = importRow.removed;
                const unmatchedOnly = Math.max(
                  0,
                  importRow.unmatched - erroredCount - removedCount
                );
                const hasUnmatched = unmatchedOnly > 0;
                const hasErrored = erroredCount > 0;
                const hasRemoved = removedCount > 0;
                const hasQueued = queuedCount > 0;
                // A clean import (everything imported successfully, nothing
                // pending or erroring, nothing later removed) shows no badges
                // at all — the user only sees row-level counters when there's
                // something to act on.
                const hasProblems =
                  hasQueued || hasUnmatched || hasErrored || hasRemoved;

                return (
                  <li
                    className={`import-history-row${isExpanded ? " is-open" : ""}`}
                    key={importRow.id}
                  >
                    <div className="import-history-summary">
                      <div className="import-history-meta">
                        <span className="import-history-date">
                          {fmtShortDate(importRow.createdAt, dateMode)}
                        </span>
                        <span className="import-history-sep">·</span>
                        <span className="import-history-count">
                          {tImpHistory("meta_apps_count", {
                            count: importRow.total,
                          })}
                        </span>
                        <span className="import-history-sep">·</span>
                        <span className="import-history-source">
                          {sourceIcon && (
                            <span
                              aria-hidden="true"
                              className="import-history-source-icon"
                              title={sourceIcon.title}
                            >
                              {sourceIcon.glyph}
                            </span>
                          )}
                          {sourceText}
                        </span>
                      </div>

                      {hasProblems && (
                        <div className="import-history-stats">
                          {hasQueued && (
                            <button
                              aria-pressed={itemStatusFilter === "queued"}
                              className={`import-history-stat import-history-stat-warn${itemStatusFilter === "queued" ? "is-active" : ""}`}
                              onClick={() => handleBadgeClick("queued")}
                              title={tImpHistory("stat_queued_title")}
                              type="button"
                            >
                              {tImpHistory("stat_queued", {
                                count: queuedCount,
                              })}
                            </button>
                          )}
                          {hasUnmatched && (
                            <button
                              aria-pressed={itemStatusFilter === "unmatched"}
                              className={`import-history-stat import-history-stat-warn${itemStatusFilter === "unmatched" ? "is-active" : ""}`}
                              onClick={() => handleBadgeClick("unmatched")}
                              title={tImpHistory("stat_unmatched_title")}
                              type="button"
                            >
                              {tImpHistory("stat_unmatched", {
                                count: unmatchedOnly,
                              })}
                            </button>
                          )}
                          {hasErrored && (
                            <button
                              aria-pressed={itemStatusFilter === "error"}
                              className={`import-history-stat import-history-stat-bad${itemStatusFilter === "error" ? "is-active" : ""}`}
                              onClick={() => handleBadgeClick("error")}
                              title={tImpHistory("stat_error_title")}
                              type="button"
                            >
                              {tImpHistory("stat_error", {
                                count: erroredCount,
                              })}
                            </button>
                          )}
                          {hasRemoved && (
                            <button
                              aria-pressed={itemStatusFilter === "removed"}
                              className={`import-history-stat import-history-stat-mute${itemStatusFilter === "removed" ? "is-active" : ""}`}
                              onClick={() => handleBadgeClick("removed")}
                              title={tImpHistory("stat_removed_title")}
                              type="button"
                            >
                              {tImpHistory("stat_removed", {
                                count: removedCount,
                              })}
                            </button>
                          )}
                        </div>
                      )}

                      <div className="import-history-actions">
                        {hasQueued && (
                          <button
                            className="pill-button pill-button-primary"
                            disabled={retryingQueue}
                            onClick={() => void handleRetryQueue()}
                            title={tImpActions("resume_matching_title")}
                            type="button"
                          >
                            {retryingQueue ? (
                              <>
                                <span className="spinner-sm" />{" "}
                                {tImpActions("resuming")}
                              </>
                            ) : (
                              tImpActions("resume_matching")
                            )}
                          </button>
                        )}
                        <button
                          aria-expanded={isExpanded}
                          className="pill-button"
                          onClick={() => void toggleImportRow(importRow)}
                          type="button"
                        >
                          {isExpanded
                            ? tImpActions("hide")
                            : tImpActions("view")}
                        </button>
                        <button
                          className="pill-button pill-button-danger"
                          onClick={() =>
                            setDeleteTarget({
                              importRow,
                              mode: "history-only",
                            })
                          }
                          type="button"
                        >
                          {tImpActions("delete")}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="import-history-detail">
                        {loadingItems ? (
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              alignItems: "center",
                              color: "var(--text-3)",
                              padding: "12px 2px",
                            }}
                          >
                            <span className="spinner-sm" />{" "}
                            {tImpHistory("loading_items")}
                          </div>
                        ) : items && items.length > 0 ? (
                          (() => {
                            // When a filter is active, the expanded detail only
                            // shows items whose status matches. We still keep
                            // the import-row itself visible because the parent
                            // list has already screened it with
                            // countItemsMatchingFilter > 0.
                            const visibleItems = itemStatusFilter
                              ? items.filter((it) =>
                                  itemMatchesFilter(it.status, itemStatusFilter)
                                )
                              : items;
                            if (visibleItems.length === 0) {
                              return (
                                <div
                                  className="import-history-empty"
                                  style={{ margin: 0 }}
                                >
                                  {tImpHistory("empty_no_match_filter")}
                                </div>
                              );
                            }
                            return (
                              <ul className="import-item-list">
                                {visibleItems.map((item) => {
                                  const meta = STATUS_META[item.status];
                                  const displayQuery =
                                    item.editedQuery || item.query;
                                  // `queued` gets its own retry button (kicks the
                                  // server-side worker). `unmatched`/`error` rows
                                  // get the inline change-match UI and, when a URL
                                  // is already on file, an optimistic "Retry import"
                                  // that re-scrapes the same URL.
                                  const canEditRetry =
                                    item.status === "unmatched" ||
                                    item.status === "error";
                                  const canQueueRetry =
                                    item.status === "queued";
                                  const canChangeMatch =
                                    item.status === "matched" ||
                                    item.status === "imported";
                                  const canReAdd = item.status === "removed";
                                  const editing =
                                    changeMatch?.itemId === item.id;
                                  const hasMatch = Boolean(item.appName);
                                  // Only worth offering "Retry import" when we have
                                  // a URL to hit — otherwise there's nothing to
                                  // retry and the user has to go through
                                  // Change match instead.
                                  const canRetryImport =
                                    canEditRetry && Boolean(item.url);
                                  const retryingThisItem =
                                    retryingItemId === item.id;
                                  const applying =
                                    editing &&
                                    changeMatch?.applyingAppleId !== null;
                                  // Deep-link imported items straight to the dashboard
                                  // app detail page. `matched` items don't have a
                                  // dashboard entry yet (still scraping), so we keep
                                  // the App Store link for those.
                                  const dashboardHref =
                                    item.status === "imported" && item.appId
                                      ? `/apps/${encodeURIComponent(item.appId)}`
                                      : null;
                                  const isDeepLinkTarget =
                                    highlightItemId === item.id;
                                  return (
                                    <li
                                      className={`import-item-row import-item-row-${item.status}${isDeepLinkTarget ? " import-item-row-focused" : ""}`}
                                      id={`import-item-${item.id}`}
                                      key={item.id}
                                    >
                                      <span
                                        className={`import-item-chip import-item-chip-${meta.tone}`}
                                      >
                                        <span aria-hidden>{meta.icon}</span>{" "}
                                        {tImpStatusMeta(item.status)}
                                      </span>
                                      <div className="import-item-body">
                                        <div className="import-item-query-line">
                                          {item.iconUrl ? (
                                            <img
                                              alt=""
                                              className="import-item-icon"
                                              height={22}
                                              loading="lazy"
                                              src={item.iconUrl}
                                              width={22}
                                            />
                                          ) : null}
                                          <div className="import-item-query">
                                            {displayQuery}
                                          </div>
                                        </div>
                                        {item.editedQuery &&
                                          item.editedQuery !== item.query && (
                                            <div className="import-item-sub">
                                              {tImpItem("originally_prefix")}
                                              <em>{item.query}</em>
                                            </div>
                                          )}
                                        {hasMatch ? (
                                          <div className="import-item-sub">
                                            {item.status === "removed"
                                              ? tImpItem("was_prefix")
                                              : tImpItem("arrow_prefix")}
                                            {dashboardHref ? (
                                              <Link
                                                className="import-item-match-link"
                                                href={dashboardHref}
                                              >
                                                {item.appName}
                                              </Link>
                                            ) : item.url ? (
                                              <a
                                                className="import-item-match-link"
                                                href={item.url}
                                                rel="noopener noreferrer"
                                                target="_blank"
                                              >
                                                {item.appName}
                                              </a>
                                            ) : (
                                              <span>{item.appName}</span>
                                            )}
                                            {item.developer ? (
                                              <span
                                                style={{
                                                  color: "var(--text-3)",
                                                }}
                                              >
                                                {" "}
                                                · {item.developer}
                                              </span>
                                            ) : null}
                                            {/* Secondary App Store link for imported
                                          rows — the app name now points to
                                          the dashboard, so we keep a
                                          discreet "↗ App Store" link for
                                          users who still want the Apple page. */}
                                            {dashboardHref && item.url && (
                                              <>
                                                {" · "}
                                                <a
                                                  className="import-item-external"
                                                  href={item.url}
                                                  rel="noopener noreferrer"
                                                  target="_blank"
                                                >
                                                  {tImpItem("app_store_link")}
                                                </a>
                                              </>
                                            )}
                                          </div>
                                        ) : (
                                          <div
                                            className="import-item-sub"
                                            style={{
                                              color: "var(--text-3)",
                                            }}
                                          >
                                            {tImpItem("no_match_recorded")}
                                          </div>
                                        )}
                                        {item.status === "queued" && (
                                          <div className="import-item-sub import-item-queued-note">
                                            {tImpItem("queued_lead")}{" "}
                                            {item.nextAttemptAt &&
                                            item.nextAttemptAt > Date.now()
                                              ? tImpItem("queued_next", {
                                                  countdown: fmtQueueCountdown(
                                                    tTime,
                                                    item.nextAttemptAt
                                                  ),
                                                })
                                              : tImpItem("queued_retry_now")}
                                            {typeof item.attemptCount ===
                                              "number" &&
                                              item.attemptCount > 0 && (
                                                <span
                                                  style={{
                                                    color: "var(--text-3)",
                                                  }}
                                                >
                                                  {tImpItem("queued_attempt", {
                                                    n: item.attemptCount + 1,
                                                  })}
                                                </span>
                                              )}
                                          </div>
                                        )}
                                        {item.status === "removed" && (
                                          <div
                                            className="import-item-sub"
                                            style={{
                                              color: "var(--text-3)",
                                            }}
                                          >
                                            {tImpItem("removed_note")}
                                          </div>
                                        )}
                                        {item.scrapeError &&
                                          item.status !== "queued" && (
                                            <div className="import-item-error">
                                              {item.scrapeError}
                                            </div>
                                          )}
                                      </div>
                                      <div className="import-item-actions">
                                        {/* "Retry import" sits first (left-most)
                                      so it's the default action for a row
                                      that already has an App Store URL but
                                      failed to scrape — most of the time the
                                      user just wants another go at the same
                                      URL (transient Apple 5xx, etc.) rather
                                      than digging through search results. */}
                                        {canRetryImport && !editing && (
                                          <button
                                            className="pill-button pill-button-primary"
                                            disabled={retryingThisItem}
                                            onClick={() =>
                                              void handleRetryImport(
                                                importRow,
                                                item
                                              )
                                            }
                                            type="button"
                                          >
                                            {retryingThisItem ? (
                                              <>
                                                <span className="spinner-sm" />{" "}
                                                {tImpActions("retrying")}
                                              </>
                                            ) : (
                                              tImpActions("retry_import")
                                            )}
                                          </button>
                                        )}
                                        {canChangeMatch && !editing && (
                                          <button
                                            className="pill-button"
                                            onClick={() =>
                                              openChangeMatch(item, "change")
                                            }
                                            type="button"
                                          >
                                            {tImpActions("change_match")}
                                          </button>
                                        )}
                                        {/* Per-item delete escape hatch. Available
                                      any time the item still points at a
                                      real app row — so matched / imported
                                      rows (most common), but also error /
                                      unmatched / queued rows that somehow
                                      ended up with an app_id set (partial
                                      scrape, optimistic pre-match, etc.).
                                      `removed` rows already have no app to
                                      delete. Text reads "Remove from Apps"
                                      rather than "… from dashboard" — the
                                      user thinks in "Apps", which is how
                                      the sidebar labels it. */}
                                        {!editing &&
                                          item.appId &&
                                          item.status !== "removed" && (
                                            <button
                                              className="pill-button pill-button-danger"
                                              disabled={
                                                removingItemId === item.id
                                              }
                                              onClick={() =>
                                                void handleRemoveItemFromDashboard(
                                                  importRow,
                                                  item
                                                )
                                              }
                                              type="button"
                                            >
                                              {removingItemId === item.id ? (
                                                <>
                                                  <span className="spinner-sm" />{" "}
                                                  {tImpActions("removing")}
                                                </>
                                              ) : (
                                                tImpActions("remove_from_apps")
                                              )}
                                            </button>
                                          )}
                                        {canReAdd && !editing && (
                                          <button
                                            className="pill-button"
                                            onClick={() =>
                                              openChangeMatch(item, "readd")
                                            }
                                            type="button"
                                          >
                                            {tImpActions("re_add")}
                                          </button>
                                        )}
                                        {canQueueRetry && !editing && (
                                          <button
                                            className="pill-button"
                                            disabled={
                                              retryingItemId === item.id ||
                                              retryingQueue
                                            }
                                            // Per-item retry: only this row, not
                                            // a global drain. Used to call
                                            // handleRetryQueue() which kicked the
                                            // entire backlog — confusing because
                                            // clicking "Retry" on one row started
                                            // hundreds of others. Now scoped to
                                            // exactly this item via the new
                                            // /api/imports/items/retry endpoint.
                                            onClick={() =>
                                              void handleRetrySingleItem(
                                                importRow,
                                                item
                                              )
                                            }
                                            type="button"
                                          >
                                            {retryingItemId === item.id ? (
                                              <>
                                                <span className="spinner-sm" />{" "}
                                                {tImpActions("retrying")}
                                              </>
                                            ) : (
                                              tImpActions("retry_now")
                                            )}
                                          </button>
                                        )}
                                        {canEditRetry && !editing && (
                                          <button
                                            className="pill-button"
                                            onClick={() =>
                                              handleRetryItem(importRow, item)
                                            }
                                            type="button"
                                          >
                                            {tImpActions("change_match")}
                                          </button>
                                        )}
                                        {/* Escape hatch for rows the App Store search
                                      can't reach — Safari web clips, TestFlight
                                      betas, personal builds, sideloaded apps.
                                      Deep-links to the manual-apps editor with
                                      the name prefilled. The form defaults its
                                      source to 'web_clip', which is the most
                                      common reason a Configurator row has no
                                      App Store match; users can flip the
                                      source on the next screen if needed. */}
                                        {canEditRetry && !editing && (
                                          <Link
                                            className="pill-button"
                                            href={{
                                              pathname:
                                                "/dashboard/manual-apps",
                                              query: {
                                                prefillName: displayQuery,
                                              },
                                            }}
                                          >
                                            {tImpActions("mark_manual_app")}
                                          </Link>
                                        )}
                                        {editing && (
                                          <button
                                            className="pill-button pill-button-ghost"
                                            disabled={applying}
                                            onClick={closeChangeMatch}
                                            type="button"
                                          >
                                            {tImpActions("cancel")}
                                          </button>
                                        )}
                                      </div>

                                      {editing && changeMatch && (
                                        <div className="change-match-panel">
                                          <div className="change-match-title">
                                            {changeMatch.mode === "readd"
                                              ? tImpChangeMatch("title_readd")
                                              : tImpChangeMatch("title_change")}
                                          </div>
                                          {/* Rate-limit banner — surfaces an active iTunes
                                        Search cooldown so a user staring at "0 results"
                                        understands it's Apple, not their typo. The
                                        onResume callback re-runs the same query the
                                        user already typed, so the auto-retry path
                                        feels like the search "just resumed" rather
                                        than requiring a manual click. */}
                                          <RateLimitBanner
                                            category="search"
                                            onResume={() => {
                                              if (changeMatch.query.trim()) {
                                                void runChangeMatchSearch();
                                              }
                                            }}
                                          />
                                          {/* Two-field search to mirror the CSV
                                        import flow: the iTunes Search API
                                        accepts a developer/seller hint that
                                        re-ranks candidates, which is critical
                                        for common app names (e.g. "Camera"
                                        or "Notes" where many apps share the
                                        title). Leaving Seller blank is fine —
                                        the server just ranks on name only. */}
                                          <div className="change-match-search">
                                            <label className="change-match-field">
                                              <span className="change-match-label">
                                                {tImpChangeMatch(
                                                  "app_name_label"
                                                )}
                                              </span>
                                              <input
                                                className="change-match-input"
                                                disabled={applying}
                                                onChange={(event) =>
                                                  setChangeMatch((prev) =>
                                                    prev
                                                      ? {
                                                          ...prev,
                                                          query:
                                                            event.target.value,
                                                          error: "",
                                                        }
                                                      : prev
                                                  )
                                                }
                                                onKeyDown={(event) => {
                                                  if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    void runChangeMatchSearch();
                                                  }
                                                }}
                                                placeholder={tPh("app_name_eg")}
                                                type="text"
                                                value={changeMatch.query}
                                              />
                                            </label>
                                            <label className="change-match-field">
                                              <span className="change-match-label">
                                                {tImpChangeMatch(
                                                  "seller_label"
                                                )}
                                              </span>
                                              <input
                                                className="change-match-input"
                                                disabled={applying}
                                                onChange={(event) =>
                                                  setChangeMatch((prev) =>
                                                    prev
                                                      ? {
                                                          ...prev,
                                                          developer:
                                                            event.target.value,
                                                          error: "",
                                                        }
                                                      : prev
                                                  )
                                                }
                                                onKeyDown={(event) => {
                                                  if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    void runChangeMatchSearch();
                                                  }
                                                }}
                                                placeholder={tPh(
                                                  "developer_eg"
                                                )}
                                                type="text"
                                                value={changeMatch.developer}
                                              />
                                            </label>
                                            <button
                                              className="btn btn-secondary btn-sm change-match-search-btn"
                                              disabled={
                                                applying ||
                                                changeMatch.searching ||
                                                !changeMatch.query.trim()
                                              }
                                              onClick={() =>
                                                void runChangeMatchSearch()
                                              }
                                              type="button"
                                            >
                                              {changeMatch.searching ? (
                                                <>
                                                  <span className="spinner-sm" />{" "}
                                                  {tImpChangeMatch("searching")}
                                                </>
                                              ) : (
                                                tImpChangeMatch("search")
                                              )}
                                            </button>
                                          </div>

                                          {changeMatch.error && (
                                            <div className="import-item-error">
                                              {changeMatch.error}
                                            </div>
                                          )}

                                          {changeMatch.results !== null &&
                                            !changeMatch.searching &&
                                            (changeMatch.results.length ===
                                            0 ? (
                                              <div className="change-match-empty">
                                                {tImpChangeMatch("empty")}
                                              </div>
                                            ) : (
                                              <ul className="change-match-results">
                                                {changeMatch.results.map(
                                                  (candidate) => {
                                                    const isCurrent =
                                                      item.appId ===
                                                        candidate.appleId ||
                                                      item.removedAppId ===
                                                        candidate.appleId;
                                                    const isApplying =
                                                      changeMatch.applyingAppleId ===
                                                      candidate.appleId;
                                                    return (
                                                      <li
                                                        className="change-match-result"
                                                        key={candidate.appleId}
                                                      >
                                                        {candidate.iconUrl ? (
                                                          <img
                                                            alt=""
                                                            className="change-match-icon"
                                                            height={36}
                                                            src={
                                                              candidate.iconUrl
                                                            }
                                                            width={36}
                                                          />
                                                        ) : (
                                                          <div className="change-match-icon change-match-icon-empty" />
                                                        )}
                                                        <div className="change-match-result-body">
                                                          <div className="change-match-result-name">
                                                            {candidate.name}
                                                          </div>
                                                          <div className="change-match-result-dev">
                                                            {
                                                              candidate.developer
                                                            }
                                                          </div>
                                                          <a
                                                            className="change-match-result-link"
                                                            href={candidate.url}
                                                            rel="noopener noreferrer"
                                                            target="_blank"
                                                          >
                                                            {tImpChangeMatch(
                                                              "view_app_store"
                                                            )}
                                                          </a>
                                                        </div>
                                                        <button
                                                          className="pill-button"
                                                          disabled={applying}
                                                          onClick={() =>
                                                            void applyChangeMatch(
                                                              importRow,
                                                              item,
                                                              candidate
                                                            )
                                                          }
                                                          type="button"
                                                        >
                                                          {isApplying ? (
                                                            <>
                                                              <span className="spinner-sm" />{" "}
                                                              {tImpChangeMatch(
                                                                "applying"
                                                              )}
                                                            </>
                                                          ) : isCurrent &&
                                                            changeMatch.mode ===
                                                              "change" ? (
                                                            tImpChangeMatch(
                                                              "rescrape"
                                                            )
                                                          ) : changeMatch.mode ===
                                                            "readd" ? (
                                                            tImpChangeMatch(
                                                              "re_add"
                                                            )
                                                          ) : (
                                                            tImpChangeMatch(
                                                              "use_this"
                                                            )
                                                          )}
                                                        </button>
                                                      </li>
                                                    );
                                                  }
                                                )}
                                              </ul>
                                            ))}
                                        </div>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            );
                          })()
                        ) : /* Empty-state for expanded imports. Split into two
                           cases so the user understands *why* the list is
                           empty:
                             (1) legacy imports that predate the items-write
                                 path (`itemCount === 0` server-side). We
                                 can't rebuild them — tell the user plainly.
                             (2) fetch returned but with `items === []` (rare
                                 — usually a race between the expand and a
                                 concurrent delete). Offer a reload. */
                        importRow.itemCount === 0 ? (
                          <div className="import-history-items-empty">
                            <div
                              style={{
                                fontWeight: 500,
                                marginBottom: 4,
                              }}
                            >
                              {tImpLegacy("title")}
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                color: "var(--text-3)",
                              }}
                            >
                              {tImpLegacy("body")}
                            </div>
                          </div>
                        ) : (
                          <div className="import-history-items-empty">
                            <div
                              style={{
                                fontWeight: 500,
                                marginBottom: 4,
                              }}
                            >
                              {tImpCouldntLoad("title")}
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                color: "var(--text-3)",
                                marginBottom: 8,
                              }}
                            >
                              {tImpCouldntLoad("body", {
                                count: importRow.itemCount,
                              })}
                            </div>
                            <button
                              className="pill-button"
                              onClick={() => {
                                // Drop any cached (empty) entry so
                                // toggleImportRow re-fetches.
                                setExpandedItems((prev) => {
                                  const next = { ...prev };
                                  delete next[importRow.id];
                                  return next;
                                });
                                setExpandedImportId(null);
                                setTimeout(
                                  () => void toggleImportRow(importRow),
                                  0
                                );
                              }}
                              type="button"
                            >
                              {tImpCouldntLoad("retry")}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        })()
      )}
    </div>
  );
}
