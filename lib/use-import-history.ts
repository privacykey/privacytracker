"use client";

/**
 * Everything behind the Import History section: the imports list, per-row
 * item expansion, the status filter, the rate-limit queue drain, per-item
 * and bulk retries, the change-match / re-add widget, and the two delete
 * flows.
 *
 * This was ~1,100 lines living directly in SettingsView, interleaved with
 * unrelated handlers for the AI debug log and the backup card. Every one of
 * those bindings was read only by Import History (the delete-confirm modal
 * at the bottom of the page is part of the same feature — it just renders
 * as a page-level overlay, so `deleteTarget` is returned rather than kept
 * private).
 *
 * The five inputs are the genuinely external ones: the queue provider, the
 * router pair for deep-link handling, and the toast helper with its
 * translator. Nothing else crossed the boundary.
 */

import type { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { useImportQueue } from "@/app/components/ImportQueueProvider";

export type ImportSource = "screenshots" | "file" | "manual";
export type ImportItemStatus =
  | "matched"
  | "unmatched"
  | "skipped"
  | "imported"
  | "error"
  // `queued` marks an item where Apple rate-limited us during the initial
  // import. The background worker drains these automatically on a timer;
  // the user can also kick a retry from this UI.
  | "queued"
  // `removed` marks an item whose app was imported once but later removed from
  // tracking. We keep the full history row so the user can still see what was
  // matched and optionally re-add it, but a background sync won't resurrect it.
  | "removed";

export interface ImportRow {
  completedAt: number | null;
  createdAt: number;
  errored: number;
  id: string;
  imported: number;
  itemCount: number;
  matched: number;
  /**
   * Live counters joined in from `import_items` at query time (see
   * `listImports` / `getImportRow` in `lib/imports.ts`). These let the
   * collapsed summary row decide whether to show problem badges or the
   * "Resume matching" button without first fetching the item list.
   *
   * `itemCount` diverges from `total` only for legacy imports that ran
   * before the items-write code path existed — we use that gap to show
   * a clearer empty state on View.
   */
  queued: number;
  removed: number;
  source: ImportSource;
  sourceLabel: string | null;
  total: number;
  unmatched: number;
}

export interface ImportItemRow {
  appId: string | null;
  appName: string | null;
  attemptCount?: number;
  country?: string | null;
  developer: string | null;
  editedQuery: string | null;
  iconUrl?: string | null;
  id: string;
  importId: string;
  nextAttemptAt?: number | null;
  query: string;
  removedAppId: string | null;
  scrapeError: string | null;
  status: ImportItemStatus;
  url: string | null;
}

/** iTunes Search candidate — minimal shape; matches /api/search responses. */
export interface AppCandidate {
  appleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  url: string;
}

/**
 * When the user opens the "Change match" / "Re-add" inline widget on a row,
 * we stash the widget state here. Only one row can be editing at a time.
 */
export interface ChangeMatchState {
  applyingAppleId: string | null;
  /**
   * Optional seller / developer hint. Mirrors the `developer` column in the
   * onboarding CSV import — when set, the iTunes Search API is called with a
   * `rows: [{ name, developer }]` payload so the server can re-rank
   * candidates whose developer matches. Blank string means "no hint, rank
   * purely on name" (same behaviour as the old single-input search).
   */
  developer: string;
  error: string;
  itemId: string;
  /** 'change' for currently-imported items; 're-add' for removed items. */
  mode: "change" | "readd";
  query: string;
  results: AppCandidate[] | null;
  searching: boolean;
}

export type DeleteMode = "history-only" | "with-apps";

export interface DeleteTarget {
  importRow: ImportRow;
  mode: DeleteMode;
}

/**
 * Status filter applied to the Import History item list. Drives the clickable
 * summary badges (click "3 unmatched" → filter=unmatched) and the notification
 * deep-links ("Unmatched apps to review" → ?filter=unmatched; "Import needs
 * attention" → ?filter=problems).
 *
 * `problems` is the union of unmatched + error rows — used when the user just
 * wants "show me everything that didn't land" without committing to a single
 * status.
 */
export type ItemStatusFilter =
  | "unmatched"
  | "error"
  | "removed"
  | "queued"
  | "problems";

/** Does the given item pass the given filter? null filter always passes. */
export function itemMatchesFilter(
  status: ImportItemStatus,
  filter: ItemStatusFilter | null
): boolean {
  if (!filter) {
    return true;
  }
  if (filter === "problems") {
    return status === "unmatched" || status === "error";
  }
  return status === filter;
}

/** Staged target for the "Remove from Apps" confirm dialog. */
export interface PendingItemRemoval {
  appId: string;
  importRow: ImportRow;
  item: ImportItemRow;
}

export function useImportHistory({
  importQueue,
  router,
  searchParams,
  showToast,
  tToast,
}: {
  importQueue: ReturnType<typeof useImportQueue>;
  router: ReturnType<typeof useRouter>;
  searchParams: ReturnType<typeof useSearchParams>;
  showToast: (msg: string) => void;
  /** Namespaced at `settings.toasts`. */
  tToast: (key: string, values?: Record<string, string | number>) => string;
}) {
  // Import history state
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [expandedImportId, setExpandedImportId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<
    Record<string, ImportItemRow[]>
  >({});
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  // One-at-a-time inline change-match / re-add widget. When null, no row is
  // being edited.
  const [changeMatch, setChangeMatch] = useState<ChangeMatchState | null>(null);

  // Tick counter used to re-render queued-row countdowns every second. We
  // only bump it while the user has queued items and an import expanded,
  // otherwise the interval is a no-op. The counter value is never read — it
  // just forces a render so `fmtQueueCountdown` recomputes against Date.now().
  const [, setNowTick] = useState(0);
  // Set true while we're kicking a manual drain (bulk "Retry queue now" /
  // per-row retry), so the UI can show a spinner + disable concurrent clicks.
  const [retryingQueue, setRetryingQueue] = useState(false);
  /**
   * Progress state for the foreground drain loop now lives in
   * `ImportQueueProvider` so it survives intra-app navigation — leaving
   * Import History and coming back finds the same progress UI waiting
   * (the provider sits in app/layout.tsx and never unmounts on route
   * change). We just observe `importQueue.drainState` here and call
   * `importQueue.startDrain()` / `importQueue.cancelDrain()` to drive it.
   *
   * The ref + local state from before were removed; this file no longer
   * owns the loop at all. We only register a per-tick callback (below)
   * so the imports list + expanded rows refresh after each tick.
   */
  // Global status filter applied across every expanded import row. null =
  // no filter (default). Read from the `?filter=` URL param on mount so
  // notification deep-links can land pre-filtered; also settable by the
  // clickable summary badges on each import row.
  const [itemStatusFilter, setItemStatusFilter] =
    useState<ItemStatusFilter | null>(null);
  // Bookkeeping: we only want to auto-expand the "most relevant" import
  // *once* per filter change, not on every render. Otherwise the user
  // collapsing the row would just get re-expanded on the next render.
  const autoExpandedForFilter = useRef<string | null>(null);
  // Deep-link focus target: the per-app provenance footer links here with
  // `?importId=…&item=…`, and we auto-expand the row + scroll/highlight the
  // specific item once per landing so the user lands exactly on the row
  // they want to fix. Ref-guarded so a later re-render (e.g. the user
  // collapses the row) doesn't fight them.
  const deepLinkTargetRef = useRef<string | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  // Id of the import item currently being removed from the dashboard. Used to
  // disable + spinner the inline "Remove from dashboard" button on the
  // expanded import-history row (per-item, not per-import — a user may remove
  // several items in quick succession and each row manages its own state).
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  /**
   * Confirm-modal target for the inline "Remove from Apps" button on
   * an import-history row. Stages the import row + item + appId so the
   * dialog body can show what will be deleted, and so the same modal
   * can drive the actual deletion via `confirmRemoveItemFromDashboard`.
   * Mirrors the `.modal-overlay` / `.modal-card` pattern used elsewhere
   * in this view (wayback-remove, reset-app).
   */
  const [pendingItemRemoval, setPendingItemRemoval] =
    useState<PendingItemRemoval | null>(null);
  // Id of the import item currently re-scraping its existing App Store URL.
  // Drives the spinner on the "Retry import" button — separate from the
  // change-match apply state so a bare retry (no search UI) doesn't need to
  // open the change-match panel just to reuse its loading state.
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  // Bulk-retry state for the "Retry all" button on the filter banner. We
  // run the retries in sequence on the client (one per request) so Apple
  // doesn't see us hammer it in parallel. Progress is reported in the
  // button label + a post-run toast summary.
  interface RetryAllProgress {
    done: number;
    failed: number;
    succeeded: number;
    total: number;
  }
  const [retryingAll, setRetryingAll] = useState(false);
  const [retryAllProgress, setRetryAllProgress] =
    useState<RetryAllProgress | null>(null);

  const loadImports = async () => {
    try {
      const res = await fetch("/api/imports");
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as ImportRow[];
      setImports(data);
    } catch (error) {
      // Leave existing state; a toast would be noisy on first load.
      console.warn("[settings] Failed to load import history:", error);
    }
  };

  /**
   * Read `?filter=` on mount (and whenever the query changes) and mirror it
   * into the filter state. Valid values are the `ItemStatusFilter` keys.
   * Anything else is ignored so a malformed deep-link doesn't crash the page.
   */
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const raw = searchParams.get("filter");
    const valid: ItemStatusFilter[] = [
      "unmatched",
      "error",
      "removed",
      "queued",
      "problems",
    ];
    if (raw && (valid as string[]).includes(raw)) {
      setItemStatusFilter(raw as ItemStatusFilter);
    } else if (raw === null) {
      setItemStatusFilter(null);
    }
  }, [searchParams]);

  /**
   * Deep-link handler for `?importId=…&item=…`, used by the single-app
   * detail page's provenance footer. Two phases:
   *
   *   1) Once `imports` has loaded, expand the matching row via the normal
   *      `toggleImportRow` path so the items fetch runs through the same
   *      spinner + error handling as a manual click.
   *   2) Once that import's items array is available, scroll the target
   *      item into view and flag it for a temporary highlight border.
   *
   * `deepLinkTargetRef` keys both phases off the composite "importId|itemId"
   * so the effect is a one-shot — a later state change (user collapsing
   * the row, clicking another link) doesn't fight them. Highlighting is
   * cleared after ~2.5s so the flash is noticeable without being noisy.
   */
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const deepImportId = searchParams.get("importId");
    const deepItemId = searchParams.get("item");
    if (!deepImportId) {
      return;
    }
    const key = `${deepImportId}|${deepItemId ?? ""}`;
    if (deepLinkTargetRef.current === key) {
      return;
    }

    if (!imports) {
      return; // still loading — try again after loadImports resolves
    }
    const target = imports.find((row) => row.id === deepImportId);
    if (!target) {
      // Import referenced by the link no longer exists (user deleted it).
      // Mark the deep-link as "done" so we don't loop; the filter banner
      // / toast on the fixed row was always optional.
      deepLinkTargetRef.current = key;
      return;
    }

    deepLinkTargetRef.current = key;
    if (expandedImportId !== target.id) {
      // toggleImportRow is hoisted from below; the immutability rule's
      // stale-closure concern doesn't apply inside useEffect (the body
      // re-runs on each effect invocation, capturing the latest binding).
      // eslint-disable-next-line react-hooks/immutability
      void toggleImportRow(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, imports]);

  // Phase 2 of the deep-link: items finished loading, now scroll to the
  // requested item and flash it. `expandedItems[importId]` becoming truthy
  // is the signal that the fetch resolved.
  useEffect(() => {
    if (!searchParams) {
      return;
    }
    const deepImportId = searchParams.get("importId");
    const deepItemId = searchParams.get("item");
    if (!(deepImportId && deepItemId)) {
      return;
    }
    const items = expandedItems[deepImportId];
    if (!items || items.length === 0) {
      return;
    }
    if (!items.some((it) => it.id === deepItemId)) {
      return;
    }

    // Defer to the next frame so React has actually committed the rendered
    // <li> for the target — without this, getElementById can return null on
    // the first pass.
    const handle = window.requestAnimationFrame(() => {
      const node = document.getElementById(`import-item-${deepItemId}`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setHighlightItemId(deepItemId);
    });
    const clear = window.setTimeout(() => setHighlightItemId(null), 2500);
    return () => {
      window.cancelAnimationFrame(handle);
      window.clearTimeout(clear);
    };
  }, [searchParams, expandedItems]);

  /**
   * Count attention-worthy items on an import row for a given filter. Used
   * to drive both the "auto-expand the most recent matching import" effect
   * and the "hide imports with zero matches" filter banner.
   *
   * The math mirrors the summary-row badge computation: `unmatchedOnly`
   * subtracts out errored + removed because the server aggregates those
   * into the `unmatched` column.
   */
  const countItemsMatchingFilter = useCallback(
    (row: ImportRow, filter: ItemStatusFilter | null): number => {
      if (!filter) {
        return row.total;
      }
      const errored = row.errored ?? 0;
      const removed = row.removed ?? 0;
      const unmatchedOnly = Math.max(
        0,
        (row.unmatched ?? 0) - errored - removed
      );
      if (filter === "unmatched") {
        return unmatchedOnly;
      }
      if (filter === "error") {
        return errored;
      }
      if (filter === "removed") {
        return removed;
      }
      if (filter === "queued") {
        return row.queued ?? 0;
      }
      if (filter === "problems") {
        return unmatchedOnly + errored;
      }
      return 0;
    },
    []
  );

  /**
   * When the filter changes, auto-expand the most-recent import that has
   * matching items. Tracked via a ref so the expansion only happens *once*
   * per filter change — otherwise collapsing the row would just get re-
   * expanded on the next render.
   */
  useEffect(() => {
    if (!itemStatusFilter) {
      autoExpandedForFilter.current = null;
      return;
    }
    if (!imports || imports.length === 0) {
      return;
    }
    // Key the guard on the specific filter value so switching from
    // `unmatched` to `error` re-triggers the auto-expand against the new
    // filter's best candidate.
    if (autoExpandedForFilter.current === itemStatusFilter) {
      return;
    }
    const target = imports.find(
      (row) => countItemsMatchingFilter(row, itemStatusFilter) > 0
    );
    if (!target) {
      autoExpandedForFilter.current = itemStatusFilter;
      return;
    }
    autoExpandedForFilter.current = itemStatusFilter;
    // Reuse toggleImportRow so the items are fetched through the same
    // path as a manual click (including the loading spinner).
    if (expandedImportId !== target.id) {
      void toggleImportRow(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemStatusFilter, imports, countItemsMatchingFilter]);

  /**
   * Toggle-or-set a filter from a summary-row badge click. Clicking the
   * already-active filter clears it (second click = "oh, never mind").
   * Also mirrors the change into the URL so reloads and shares keep it.
   */
  const handleBadgeClick = (next: ItemStatusFilter) => {
    const resolved = itemStatusFilter === next ? null : next;
    setItemStatusFilter(resolved);
    // Reset the auto-expand guard so the newly-selected filter can expand
    // its most-relevant import next tick.
    autoExpandedForFilter.current = null;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (resolved) {
        url.searchParams.set("filter", resolved);
      } else {
        url.searchParams.delete("filter");
      }
      window.history.replaceState(null, "", url.toString());
    }
  };

  /** Clear the filter (banner "Clear" button). Mirrors out of the URL too. */
  const clearItemFilter = () => {
    setItemStatusFilter(null);
    autoExpandedForFilter.current = null;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("filter");
      window.history.replaceState(null, "", url.toString());
    }
  };

  const toggleImportRow = async (importRow: ImportRow) => {
    if (expandedImportId === importRow.id) {
      setExpandedImportId(null);
      return;
    }

    setExpandedImportId(importRow.id);

    if (expandedItems[importRow.id]) {
      return;
    }

    setExpandingId(importRow.id);
    try {
      const res = await fetch(
        `/api/imports?id=${encodeURIComponent(importRow.id)}`
      );
      if (!res.ok) {
        showToast(tToast("import_details_load_failed"));
        setExpandingId(null);
        return;
      }
      const data = (await res.json()) as {
        import: ImportRow;
        items: ImportItemRow[];
      };
      setExpandedItems((prev) => ({ ...prev, [importRow.id]: data.items }));
    } catch (error) {
      console.error("[settings] Failed to load import details:", error);
      showToast(tToast("import_details_load_failed"));
    }
    setExpandingId(null);
  };

  const handleRetryItem = (_importRow: ImportRow, item: ImportItemRow) => {
    // Previously: bounced the user back to /onboard with ?retry=&item=.
    // Now that Import History has its own page with a fully-inline
    // change-match search (see `openChangeMatch` + the `change-match-panel`
    // JSX on each expanded row), the redirect is a worse experience —
    // the user loses their place in the history, the onboarding wizard
    // is geared toward first-run, and the fix lands in the same table
    // they're already looking at. So 'Change match' now opens the same
    // search-and-apply flow used on matched/imported rows.
    openChangeMatch(item, "change");
  };

  /**
   * Re-scrape an import item against the App Store URL it already has on
   * record — the "optimistic retry" path. Used for rows that failed to
   * import the first time *despite* having a URL (typically status=error
   * with a transient scrape failure: Apple 5xx, HTML shape drift that's
   * since been fixed, a flaky network on the user's end).
   *
   * Piggy-backs on the change-match endpoint because it already does
   * exactly this — scrape a URL, replace the item's match, flip status
   * to `imported`. We just reuse `item.url` as the target so there's no
   * user choice involved. If the retry fails again, the error bubbles
   * into `scrapeError` the same way the first attempt did, and the user
   * can fall through to "Change match" for a different URL.
   */
  const handleRetryImport = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    if (!item.url) {
      showToast(tToast("no_url_for_retry"));
      return;
    }
    if (retryingItemId) {
      return;
    }
    setRetryingItemId(item.id);
    try {
      const res = await fetch("/api/imports/items/change-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, url: item.url }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error ?? tToast("retry_failed_http", { status: res.status });
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      const updated = data?.item as ImportItemRow | undefined;
      if (updated) {
        // Splice the refreshed row back in so the status chip flips from
        // error/unmatched → imported without a full list reload.
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      showToast(
        tToast("reimported", {
          name: updated?.appName ?? item.appName ?? item.query ?? "",
        })
      );
      // Counters moved — refresh the summary row + the dashboard's app list.
      await loadImports();
      router.refresh();
    } catch (error) {
      console.error("[settings] retry import failed:", error);
      showToast(tToast("retry_import_failed"));
    } finally {
      setRetryingItemId(null);
    }
  };

  /**
   * Bulk-retry every retryable item in the current filter. Only error and
   * unmatched items with an App Store URL qualify — the rest (no URL at
   * all, or statuses the filter includes that aren't retryable in this
   * sense, like `removed`) are left alone.
   *
   * Runs sequentially so we don't parallel-hammer Apple. Each successful
   * retry splices the refreshed row into `expandedItems` just like the
   * single-item path does, so any open detail pane updates live. Counters
   * and the outer dashboard are refreshed once at the very end.
   *
   * Strategy: we walk every import that has problems according to its
   * summary counters, fetching its items on demand if we don't already
   * have them cached in `expandedItems`, then filter the result to
   * (status ∈ {error, unmatched}) ∧ url ∧ matches-active-filter.
   */
  const handleRetryAllErrors = async () => {
    if (retryingAll) {
      return;
    }
    if (imports === null || imports.length === 0) {
      return;
    }
    // Scope: when a filter is active we use it; otherwise we default to the
    // widest retryable set (unmatched + error). This keeps the button useful
    // when the banner is triggered by "problems" but also lets a power user
    // shift-click it from the `error` filter to retry only errors.
    const scope: ItemStatusFilter = itemStatusFilter ?? "problems";
    const isRetryableStatus = (status: ImportItemStatus) =>
      status === "error" || status === "unmatched";

    setRetryingAll(true);
    setRetryAllProgress(null);

    try {
      // Pass 1: for every import that reports problems in its counters,
      // make sure we have its items in memory. Fetch missing ones in
      // parallel (small N — one per import row) but cap concurrency with
      // a simple Promise.all; per-item retries still run serially below.
      const candidateImports = imports.filter((row) => {
        if (
          !(
            itemMatchesFilter("error", scope) ||
            itemMatchesFilter("unmatched", scope)
          )
        ) {
          return false;
        }
        return (row.errored ?? 0) + (row.unmatched ?? 0) > 0;
      });

      // Collect retryable items from the cache, then fetch anything that
      // isn't cached yet.
      const itemsToRetry: Array<{ importRow: ImportRow; item: ImportItemRow }> =
        [];
      const needFetch: ImportRow[] = [];
      for (const row of candidateImports) {
        const cached = expandedItems[row.id];
        if (cached) {
          for (const item of cached) {
            if (
              isRetryableStatus(item.status) &&
              itemMatchesFilter(item.status, scope) &&
              item.url
            ) {
              itemsToRetry.push({ importRow: row, item });
            }
          }
        } else {
          needFetch.push(row);
        }
      }

      if (needFetch.length > 0) {
        const fetched = await Promise.all(
          needFetch.map(async (row) => {
            try {
              const res = await fetch(
                `/api/imports?id=${encodeURIComponent(row.id)}`
              );
              if (!res.ok) {
                return { row, items: [] as ImportItemRow[] };
              }
              const data = (await res.json()) as { items?: ImportItemRow[] };
              return { row, items: data.items ?? [] };
            } catch (error) {
              console.warn(
                "[settings] retry-all fetch failed for",
                row.id,
                error
              );
              return { row, items: [] as ImportItemRow[] };
            }
          })
        );
        for (const { row, items } of fetched) {
          for (const item of items) {
            if (
              isRetryableStatus(item.status) &&
              itemMatchesFilter(item.status, scope) &&
              item.url
            ) {
              itemsToRetry.push({ importRow: row, item });
            }
          }
        }
      }

      if (itemsToRetry.length === 0) {
        showToast(tToast("no_matching_to_retry"));
        return;
      }

      setRetryAllProgress({
        done: 0,
        total: itemsToRetry.length,
        succeeded: 0,
        failed: 0,
      });

      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < itemsToRetry.length; i++) {
        const { importRow, item } = itemsToRetry[i];
        try {
          const res = await fetch("/api/imports/items/change-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId: item.id, url: item.url }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok) {
            succeeded++;
            const updated = data?.item as ImportItemRow | undefined;
            if (updated) {
              setExpandedItems((prev) => {
                const current = prev[importRow.id];
                if (!current) {
                  return prev;
                }
                return {
                  ...prev,
                  [importRow.id]: current.map((row) =>
                    row.id === item.id ? updated : row
                  ),
                };
              });
            }
          } else {
            failed++;
          }
        } catch (error) {
          console.warn("[settings] retry-all item failed:", item.id, error);
          failed++;
        }
        setRetryAllProgress({
          done: i + 1,
          total: itemsToRetry.length,
          succeeded,
          failed,
        });
      }

      // Refresh counters + outer dashboard once at the end.
      await loadImports();
      router.refresh();

      if (failed === 0) {
        showToast(tToast("retry_all_success", { succeeded }));
      } else if (succeeded === 0) {
        showToast(tToast("retry_all_all_failed", { failed }));
      } else {
        showToast(tToast("retry_all_partial", { succeeded, failed }));
      }
    } catch (error) {
      console.error("[settings] retry-all failed:", error);
      showToast(tToast("bulk_retry_failed"));
    } finally {
      setRetryingAll(false);
      setRetryAllProgress(null);
    }
  };

  /**
   * Kick the server-side import queue worker immediately. Used both by the
   * bulk "Retry queue now" header button and the per-row retry button on
   * queued items (clearing the global pause + zeroing per-item
   * `nextAttemptAt` is a single server-side operation).
   */
  /**
   * Kick the provider's drain loop. The actual orchestration lives in
   * ImportQueueProvider so the progress UI survives navigation. This
   * function just delegates and waits long enough to flip the
   * `retryingQueue` button-busy flag back off when the drain ends.
   *
   * Used to be a 100-line foreground loop in this file — that whole
   * block moved to the provider. See ImportQueueProvider.startDrain
   * for the loop invariants and rate-limit handling.
   */
  const handleRetryQueue = async () => {
    if (retryingQueue) {
      return;
    }
    setRetryingQueue(true);
    importQueue.startDrain();
    // The provider sets drainState=null when its loop exits; we watch
    // that via a useEffect below to flip retryingQueue back off.
  };

  /**
   * Retry a single queued import item — distinct from `handleRetryQueue`
   * which kicks the global drain. The per-row "Retry now" button used to
   * call handleRetryQueue, which meant clicking retry on ONE row started
   * EVERY queued row draining at once. Now this just scrapes the one
   * item and updates that row's status.
   *
   * Falls into the same Apple-rate-limit framework as the global drain
   * (the scraper records a 429 centrally), so a 429 here surfaces in
   * the same RateLimitBanner the global drain uses. The row's status
   * stays `queued` with a fresh next_attempt_at so the next global
   * drain will pick it up after the cooldown.
   */
  const handleRetrySingleItem = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    if (retryingItemId !== null) {
      return;
    }
    setRetryingItemId(item.id);
    try {
      const res = await fetch("/api/imports/items/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error ?? tToast("retry_failed_http", { status: res.status });
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      // Splice the updated item back into the expanded list so the row
      // visibly transitions queued → imported / error / queued-again.
      const updated = data?.item as ImportItemRow | undefined;
      if (updated) {
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      // Refresh the import-row counters so "X queued / Y errored" badges
      // reflect the change.
      await loadImports();
      // Toast the outcome so the user has clear feedback even when the
      // row is offscreen / collapsed.
      if (data?.status === "imported") {
        showToast(
          tToast("imported_app", { name: updated?.appName ?? item.query })
        );
      } else if (data?.status === "error") {
        showToast(tToast("retry_failed_see_row"));
      } else if (data?.rateLimited?.retryAfterMs) {
        const sec = Math.round(data.rateLimited.retryAfterMs / 1000);
        showToast(tToast("rate_limited_auto_retry", { seconds: sec }));
      }
    } catch (err) {
      console.error("[settings] single-item retry failed:", err);
      showToast(
        tToast("save_failed_with_message", {
          message: tToast("retry_failed_connection"),
        })
      );
    } finally {
      setRetryingItemId(null);
    }
  };

  /**
   * Cancel a foreground drain in progress. Sets both the ref-backed
   * flag (which the loop checks every iteration) and the React state
   * (which drives the UI feedback). Already-claimed items finish
   * their scrape — we don't try to abort the network call mid-flight,
   * just stop claiming new rows.
   */
  const handleCancelDrain = () => {
    importQueue.cancelDrain();
  };

  // Watch the provider's drainState so we can flip retryingQueue back
  // off when the loop ends (either naturally — queue empty — or
  // because the user cancelled). The provider clears drainState to
  // null on loop exit; this effect fires on that transition.
  useEffect(() => {
    if (importQueue.drainState === null && retryingQueue) {
      setRetryingQueue(false);
    }
  }, [importQueue.drainState, retryingQueue]);

  // Per-tick refresh — register a callback the provider invokes after
  // every tick. Refreshes the imports list (so per-row counts update
  // live during the drain) and any expanded items (so individual
  // rows visibly transition queued → imported / error in real time).
  useEffect(() => {
    // The tick result is unused here — we only need to know that
    // *some* tick completed so we can refresh local state. Drop the
    // parameter entirely to keep the lint clean.
    const unsubscribe = importQueue.onTickComplete(async () => {
      // Refresh the parent imports list (queued / errored / imported
      // counts on each row). Kept lightweight — server returns just
      // counts + meta, not the full item lists.
      try {
        await loadImports();
      } catch (e) {
        console.warn("[settings] loadImports refresh after tick failed:", e);
      }
      // Refresh expanded items so individual rows update in place.
      const expandedIds = Object.keys(expandedItems);
      if (expandedIds.length > 0) {
        await Promise.all(
          expandedIds.map(async (id) => {
            try {
              const res = await fetch(
                `/api/imports?id=${encodeURIComponent(id)}`
              );
              if (!res.ok) {
                return;
              }
              const data = (await res.json()) as {
                import: ImportRow;
                items: ImportItemRow[];
              };
              setExpandedItems((prev) =>
                prev[id] ? { ...prev, [id]: data.items } : prev
              );
            } catch (error) {
              console.warn("[settings] tick refresh failed for", id, error);
            }
          })
        );
      }
    });
    return unsubscribe;
    // expandedItems is referenced inside the callback but we DON'T
    // want to re-register on every expand/collapse — that'd recreate
    // the subscription mid-drain. Reading the latest value works fine
    // because the callback fires ad-hoc, not from a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importQueue]);

  /**
   * Remove a single imported app from the dashboard without touching the rest
   * of the import batch. The server-side DELETE /api/apps?id=… cascades the
   * app row out of the privacy tables and flips every import item that
   * pointed at it to `status = 'removed'` (via `markImportItemsRemovedForApp`)
   * so the history row remembers what was deleted and a future retry won't
   * silently re-add it.
   *
   * Intended for the inline "Remove from Apps" button on an import item
   * that has a real `appId` attached — matched/imported/queued/error rows
   * that somehow got an app_id all qualify. The user asked for the ability
   * to either fix a bad match OR delete it outright from the same row.
   */
  const handleRemoveItemFromDashboard = async (
    importRow: ImportRow,
    item: ImportItemRow
  ) => {
    const appId = item.appId;
    if (!appId) {
      return;
    }
    if (removingItemId) {
      return;
    }
    // Stage the modal — the actual deletion runs from
    // `confirmRemoveItemFromDashboard` once the user clicks Confirm.
    setPendingItemRemoval({ importRow, item, appId });
  };

  /**
   * Stage 2 of the import-item removal flow. Same network code as the
   * old inline `handleRemoveItemFromDashboard` body — only the `confirm`
   * gate moved out into a real modal owned by `pendingItemRemoval`.
   */
  const confirmRemoveItemFromDashboard = async () => {
    const target = pendingItemRemoval;
    if (!target) {
      return;
    }
    const { importRow, item, appId } = target;
    if (removingItemId) {
      return;
    }
    setRemovingItemId(item.id);
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(appId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        let msg = "Could not remove app";
        try {
          const body = await res.json();
          msg = body?.error || msg;
        } catch {
          /* no-op */
        }
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }
      // Refresh this import's items + the top-level list so counters + the
      // row's status pill move in lockstep.
      try {
        const detail = await fetch(
          `/api/imports?id=${encodeURIComponent(importRow.id)}`
        );
        if (detail.ok) {
          const data = (await detail.json()) as {
            import: ImportRow;
            items: ImportItemRow[];
          };
          setExpandedItems((prev) =>
            prev[importRow.id] ? { ...prev, [importRow.id]: data.items } : prev
          );
        }
      } catch (err) {
        console.warn("[settings] remove refresh failed:", err);
      }
      await loadImports();
      showToast(tToast("removed_from_apps"));
      setPendingItemRemoval(null);
    } catch (error) {
      console.error("[settings] remove app failed:", error);
      showToast(tToast("remove_app_failed"));
    }
    setRemovingItemId(null);
  };

  const openChangeMatch = (item: ImportItemRow, mode: "change" | "readd") => {
    setChangeMatch({
      itemId: item.id,
      mode,
      query: item.editedQuery || item.query,
      // Pre-fill the seller hint from whatever the item already has on it —
      // either the developer we resolved the last time we scraped this row,
      // or the hint carried in from the original CSV import. Falls back to
      // empty string so the input is controlled.
      developer: item.developer ?? "",
      results: null,
      searching: false,
      error: "",
      applyingAppleId: null,
    });
  };

  const closeChangeMatch = () => setChangeMatch(null);

  const runChangeMatchSearch = async () => {
    if (!changeMatch) {
      return;
    }
    const name = changeMatch.query.trim();
    if (!name) {
      setChangeMatch((prev) =>
        prev ? { ...prev, error: "Enter an app name to search." } : prev
      );
      return;
    }
    const developer = changeMatch.developer.trim();
    setChangeMatch((prev) =>
      prev ? { ...prev, searching: true, error: "", results: null } : prev
    );
    try {
      // When the user has provided a seller hint, send the structured `rows`
      // payload so the server can re-rank iTunes candidates against the
      // developer — same treatment the onboarding import gives CSV rows that
      // carry a seller column. Falling back to `names` preserves the old
      // behaviour for name-only searches.
      const body = developer
        ? { rows: [{ name, developer }] }
        : { names: [name] };
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setChangeMatch((prev) =>
          prev
            ? {
                ...prev,
                searching: false,
                error: data?.error ?? "Search failed.",
              }
            : prev
        );
        return;
      }
      const results =
        Array.isArray(data.results) && data.results[0]?.candidates
          ? (data.results[0].candidates as AppCandidate[])
          : [];
      setChangeMatch((prev) =>
        prev ? { ...prev, searching: false, results, error: "" } : prev
      );
    } catch (error) {
      console.error("[settings] change-match search failed:", error);
      setChangeMatch((prev) =>
        prev
          ? {
              ...prev,
              searching: false,
              error: "Search failed. Check your connection.",
            }
          : prev
      );
    }
  };

  const applyChangeMatch = async (
    importRow: ImportRow,
    item: ImportItemRow,
    candidate: AppCandidate
  ) => {
    if (!changeMatch) {
      return;
    }
    setChangeMatch((prev) =>
      prev ? { ...prev, applyingAppleId: candidate.appleId, error: "" } : prev
    );
    try {
      const editedQuery = changeMatch.query.trim();
      const res = await fetch("/api/imports/items/change-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          url: candidate.url,
          editedQuery:
            editedQuery && editedQuery !== item.query ? editedQuery : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error ?? `Change-match failed (HTTP ${res.status})`;
        setChangeMatch((prev) =>
          prev ? { ...prev, applyingAppleId: null, error: msg } : prev
        );
        showToast(tToast("save_failed_with_message", { message: msg }));
        return;
      }

      const updated = data?.item as ImportItemRow | undefined;
      // Splice the updated item back into the expanded list so the UI reflects
      // the new match without a full reload of every item in the batch.
      if (updated) {
        setExpandedItems((prev) => {
          const current = prev[importRow.id];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [importRow.id]: current.map((row) =>
              row.id === item.id ? updated : row
            ),
          };
        });
      }
      showToast(
        changeMatch.mode === "readd"
          ? `✓ Re-added "${candidate.name}"`
          : `✓ Match updated to "${candidate.name}"`
      );
      closeChangeMatch();
      // Counters moved (imported/removed/matched) — refresh the summary row.
      await loadImports();
      // Dashboard's app list changed as well (new app added, possibly old
      // one removed) — nudge a revalidation.
      router.refresh();
    } catch (error) {
      console.error("[settings] apply change-match failed:", error);
      setChangeMatch((prev) =>
        prev
          ? { ...prev, applyingAppleId: null, error: "Could not apply match." }
          : prev
      );
      showToast(tToast("apply_match_failed"));
    }
  };

  const confirmDeleteImport = async () => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    try {
      const query = new URLSearchParams({
        id: deleteTarget.importRow.id,
        removeApps: deleteTarget.mode === "with-apps" ? "true" : "false",
      });
      const res = await fetch(`/api/imports?${query.toString()}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(
          tToast("save_failed_with_message", {
            message: data?.error ?? tToast("delete_failed_fallback"),
          })
        );
        setDeleting(false);
        return;
      }

      if (deleteTarget.mode === "with-apps") {
        const count = data?.deletedApps ?? 0;
        showToast(
          count
            ? `✓ Import removed · ${count} app${count === 1 ? "" : "s"} deleted`
            : "✓ Import removed"
        );
      } else {
        showToast(tToast("import_entry_removed"));
      }

      setDeleteTarget(null);
      setExpandedImportId((prev) =>
        prev === deleteTarget.importRow.id ? null : prev
      );
      setExpandedItems((prev) => {
        if (!prev[deleteTarget.importRow.id]) {
          return prev;
        }
        const next = { ...prev };
        delete next[deleteTarget.importRow.id];
        return next;
      });
      await loadImports();

      // If apps were deleted, the dashboard's app list is stale; nudge a refresh
      // on navigation by requesting the router to revalidate.
      if (deleteTarget.mode === "with-apps") {
        router.refresh();
      }
    } catch (error) {
      console.error("[settings] Import delete failed:", error);
      showToast(tToast("delete_failed"));
    }
    setDeleting(false);
  };

  // One-second tick to keep queued-row countdowns ("next retry in ~42s")
  // fresh between the 10s provider polls. We only run the interval while
  // there are queued items — no point re-rendering otherwise.
  const hasQueuedItems =
    importQueue.state.queued > 0 ||
    Object.values(expandedItems).some((list) =>
      list.some((i) => i.status === "queued")
    );
  useEffect(() => {
    if (!hasQueuedItems) {
      return;
    }
    const id = setInterval(() => setNowTick((t) => (t + 1) & 0xff_ff), 1000);
    return () => clearInterval(id);
  }, [hasQueuedItems]);

  return {
    imports,
    expandedImportId,
    setExpandedImportId,
    expandedItems,
    setExpandedItems,
    expandingId,
    deleteTarget,
    setDeleteTarget,
    deleting,
    changeMatch,
    setChangeMatch,
    retryingQueue,
    itemStatusFilter,
    highlightItemId,
    removingItemId,
    pendingItemRemoval,
    setPendingItemRemoval,
    retryingItemId,
    retryingAll,
    retryAllProgress,
    loadImports,
    countItemsMatchingFilter,
    handleBadgeClick,
    clearItemFilter,
    toggleImportRow,
    handleRetryItem,
    handleRetryImport,
    handleRetryAllErrors,
    handleRetryQueue,
    handleRetrySingleItem,
    handleCancelDrain,
    handleRemoveItemFromDashboard,
    confirmRemoveItemFromDashboard,
    openChangeMatch,
    closeChangeMatch,
    runChangeMatchSearch,
    applyChangeMatch,
    confirmDeleteImport,
  };
}
