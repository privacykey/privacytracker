"use client";

/**
 * The Wayback bulk-import subsystem: run state, the NDJSON streaming run,
 * pause/resume/cancel control, the purge-all confirm flow, the
 * show-imported-history toggle, and the poller that reattaches to a run
 * this tab did not start (the server-side mutex survives navigation; the
 * original streaming body does not).
 *
 * Moved out of SettingsView as one unit — every piece here was read only
 * by the Wayback card and its confirm modal. `hydrateShowImported` is the
 * seam for SettingsView's shared settings loader, which reads every
 * settings key in one request (same pattern as use-ai-settings' hydrate).
 *
 * On mount the hook rehydrates itself: the last-run summary, and — when
 * the persisted mutex says a run is already in flight — the live progress
 * snapshot, after which the poller keeps it fresh until the run ends.
 */

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { WaybackRunStatus } from "@/app/components/settings/types";
import type { useTaskCenter } from "@/app/components/TaskCenter";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useSettingsAutoSave } from "@/lib/use-settings-auto-save";

export function useWayback({
  showToast,
  taskCenter,
}: {
  showToast: (msg: string) => void;
  taskCenter: ReturnType<typeof useTaskCenter>;
}) {
  const tWayback = useTranslations("settings.wayback");
  const tBulkStream = useTranslations("settings.bulk_stream");
  const tToast = useTranslations("settings.toasts");

  // Historical import (Wayback Machine). `waybackRunning` tracks whether a
  // streaming bulk import is in flight so we can disable both buttons. The
  // `waybackShowImported` toggle is persisted via the settings API and flows
  // through to the per-app ChangelogTimeline as a visibility filter — when
  // off, the imported rows stay in the DB but the timeline hides them.
  const [waybackRunning, setWaybackRunning] = useState(false);
  const [waybackRunStatus, setWaybackRunStatus] =
    useState<WaybackRunStatus>("idle");
  const [waybackControlBusy, setWaybackControlBusy] = useState<
    null | "pause" | "resume" | "cancel" | "force"
  >(null);
  const [waybackRemoving, setWaybackRemoving] = useState(false);
  // Controls the in-app confirm modal for "Remove all imported history".
  // We avoid `window.confirm` so the UX matches the rest of the app — the
  // reset and delete-import modals use the same `.modal-overlay` pattern.
  const [waybackRemoveOpen, setWaybackRemoveOpen] = useState(false);
  // Ref tracks whether *this* tab currently owns the active bulk-import
  // stream (vs. having rehydrated `waybackRunning` from the server's
  // persisted mutex after a navigation). Used to suppress the GET-poller
  // while the local NDJSON stream is actively updating the same state —
  // otherwise both sources race and the "12/34 · Netflix" line flickers.
  const waybackLocalStreamRef = useRef(false);
  const [waybackSummary, setWaybackSummary] = useState<string | null>(null);
  const [waybackShowImported, setWaybackShowImported] = useState(true);
  const [savedWaybackShowImported, setSavedWaybackShowImported] =
    useState(true);
  // The "is this toggle saving" flag now lives on `waybackToggleAutoSave.saving`.
  // Accessibility nutrition labels UI toggle. The scraper always collects the
  // "Accessibility" shelf (VoiceOver, Voice Control, Larger Text, …) regardless
  // of this flag — it just gates whether the chip on the detail page, the
  // grid filter, and the stats chart are rendered. Default on for new installs
  // so users discover the feature; flipping it off hides everything without
  // stopping data collection, so re-enabling later brings history back.
  const [trackAccessibility, setTrackAccessibility] = useState(true);
  const [savedTrackAccessibility, setSavedTrackAccessibility] = useState(true);

  // Live-progress tracker, populated from the NDJSON stream so the status
  // block can show "12/34 · Netflix" while the run is in flight. `null`
  // means no run is active (or we're between two app-start events at the
  // start of a run before the first progress tick). Running totals mirror
  // the server-side `BulkTotals` shape so the status card doesn't have to
  // reach into the final summary row to render.
  const [waybackProgress, setWaybackProgress] = useState<{
    index: number;
    total: number;
    currentAppName: string | null;
    imported: number;
    unchanged: number;
    skipped: number;
    failed: number;
  } | null>(null);
  // Tracks whether the currently-running bulk import was triggered manually
  // by this user (the normal case) or auto-resumed by instrumentation.ts
  // after a server restart. The status card shows a distinct "↻ Resumed
  // after restart" banner for the resume case so users understand why a
  // run is in flight without them having clicked anything. `null` means
  // we haven't probed the server yet (or no run is active).
  const [waybackInitiator, setWaybackInitiator] = useState<
    "manual" | "resume" | null
  >(null);
  // Snapshot of the most recent bulk import's summary row, hydrated from
  // /api/activity on mount so reloading the Settings page still shows
  // "last run: 3 imported, 1 failed". Cleared after a fresh run completes
  // so the live tally takes over without mixing stale totals.
  const [waybackLastRun, setWaybackLastRun] = useState<{
    status: "ok" | "partial" | "error" | "cancelled";
    startedAt: number;
    endedAt: number | null;
    summary: string | null;
    totals: {
      appsAttempted: number;
      appsWithImports: number;
      targetsAttempted: number;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null;
  } | null>(null);

  /**
   * Probe the Wayback import-all GET endpoint to find out whether a bulk run
   * is currently in flight. Used on mount to rehydrate the status card after
   * a navigation: if the server-side mutex is still set we can't reattach
   * to the original POST body (it closed when the user navigated away), but
   * we *can* read the persisted progress blob and keep polling until the
   * run finishes. When the poller observes `running === false`, it calls
   * `loadWaybackLastRun()` so the card flips from "in progress" to the
   * final summary without a reload.
   */
  const loadWaybackProgress = async (): Promise<{
    running: boolean;
    status: WaybackRunStatus;
    initiator: "manual" | "resume" | null;
    progress: {
      index: number;
      total: number;
      currentAppName: string | null;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null;
  } | null> => {
    try {
      const res = await fetch("/api/wayback/import-all");
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      const running = !!data?.running;
      const rawStatus = typeof data?.status === "string" ? data.status : "";
      const status: WaybackRunStatus =
        rawStatus === "running" ||
        rawStatus === "pause_requested" ||
        rawStatus === "paused" ||
        rawStatus === "cancel_requested" ||
        rawStatus === "stale"
          ? rawStatus
          : running
            ? "running"
            : "idle";
      // Derive initiator from the state blob. When no blob exists (e.g. a
      // stale mutex mid-heal) we fall back to null so the UI doesn't claim
      // "resumed" for a run we can't characterise.
      const rawInitiator = (data?.state as { initiator?: unknown } | null)
        ?.initiator;
      const initiator: "manual" | "resume" | null =
        rawInitiator === "manual" || rawInitiator === "resume"
          ? rawInitiator
          : null;
      let progress: {
        index: number;
        total: number;
        currentAppName: string | null;
        imported: number;
        unchanged: number;
        skipped: number;
        failed: number;
      } | null = null;
      // Map the runner's richer response onto the card's existing shape so
      // we don't have to rewrite every consumer:
      //   index  = summary.done + summary.inProgress  (apps we've reached)
      //   total  = summary.total
      //   totals = state.totals  (imported/unchanged/skipped/failed)
      // This keeps live-stream updates (coming from `setWaybackProgress` in
      // the POST handler below) and poll-driven updates on the same shape.
      if (data?.summary && data?.state) {
        const summary = data.summary as {
          total?: number;
          done?: number;
          inProgress?: number;
        };
        const totals =
          (data.state as { totals?: Record<string, unknown> }).totals ?? {};
        progress = {
          index: Number(summary.done ?? 0) + Number(summary.inProgress ?? 0),
          total: Number(summary.total ?? 0),
          currentAppName:
            typeof data.currentAppName === "string"
              ? data.currentAppName
              : null,
          imported: Number(totals.imported ?? 0),
          unchanged: Number(totals.unchanged ?? 0),
          skipped: Number(totals.skipped ?? 0),
          failed: Number(totals.failed ?? 0),
        };
      }
      return { running, status, initiator, progress };
    } catch (error) {
      console.warn("[settings] loadWaybackProgress failed:", error);
      return null;
    }
  };

  /**
   * Hydrate the Wayback "last run" status block from the activity log. We
   * fetch the most recent N wayback_import rows and pick the newest one
   * whose detail blob has `mode: 'bulk'` — that's the batch-summary row
   * inserted by `/api/wayback/import-all`. The per-app rows (mode: 'app'
   * or 'bulk-app') are intentionally skipped here because the status card
   * is describing the whole batch, not individual scrapes.
   */
  const loadWaybackLastRun = async () => {
    try {
      const res = await fetch("/api/activity?type=wayback_import&limit=30");
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const summaryRow = rows.find(
        (row: { detail?: { mode?: string; removed?: boolean } | null }) =>
          row.detail?.mode === "bulk" && !row.detail?.removed
      );
      if (!summaryRow) {
        return;
      }
      const detailTotals =
        (summaryRow.detail as { totals?: Record<string, unknown> } | null)
          ?.totals ?? null;
      const normalisedTotals = detailTotals
        ? {
            appsAttempted: Number(detailTotals.appsAttempted ?? 0),
            appsWithImports: Number(detailTotals.appsWithImports ?? 0),
            targetsAttempted: Number(detailTotals.targetsAttempted ?? 0),
            imported: Number(detailTotals.imported ?? 0),
            unchanged: Number(detailTotals.unchanged ?? 0),
            skipped: Number(detailTotals.skipped ?? 0),
            failed: Number(detailTotals.failed ?? 0),
          }
        : null;
      const status = summaryRow.status as
        | "ok"
        | "partial"
        | "error"
        | "cancelled"
        | undefined;
      setWaybackLastRun({
        status: status ?? "ok",
        startedAt: Number(summaryRow.startedAt ?? 0),
        endedAt:
          typeof summaryRow.endedAt === "number" ? summaryRow.endedAt : null,
        summary:
          typeof summaryRow.summary === "string" ? summaryRow.summary : null,
        totals: normalisedTotals,
      });
    } catch (error) {
      console.warn("[settings] loadWaybackLastRun failed:", error);
    }
  };

  // Poll the GET endpoint while the persisted mutex reports a run in flight
  // that *this tab* didn't start. Stops the moment we observe `running ===
  // false` and re-hydrates the "Last run" summary so the status card flips
  // cleanly from "3/12 · Netflix" → "Last run: 3 imported, 1 failed".
  // The local `runBulkWaybackImport` path already keeps its own state fresh
  // from the NDJSON stream, so we skip the poller while *this* tab owns the
  // active fetch — otherwise we'd double-update `waybackProgress` from two
  // sources at slightly different cadences and see the values flicker.
  useEffect(() => {
    if (!waybackRunning) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      // Skip the network call while the local stream owns the state —
      // otherwise both sources race on setWaybackProgress and the status
      // numbers flicker as they converge.
      if (waybackLocalStreamRef.current) {
        return;
      }
      const snap = await loadWaybackProgress();
      if (cancelled || !snap) {
        return;
      }
      setWaybackRunStatus(snap.status);
      if (snap.running) {
        setWaybackInitiator(snap.initiator);
        if (snap.progress) {
          setWaybackProgress(snap.progress);
        }
      } else {
        // Run finished on the server (or was aborted). Release our local
        // "running" flag and pull the final summary into the card.
        setWaybackRunning(false);
        if (snap.status !== "paused" && snap.status !== "pause_requested") {
          setWaybackProgress(null);
        }
        setWaybackInitiator(null);
        if (snap.status !== "paused" && snap.status !== "pause_requested") {
          void loadWaybackLastRun();
        }
      }
    };
    const id = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [waybackRunning]);

  /**
   * Drive `POST /api/wayback/import-all?stream=1` in NDJSON streaming mode.
   * Same TaskCenter wiring as the policy-sync path so the user can navigate
   * away — the bulk import can take a while, since archive.org's Save/
   * availability endpoints add tens of seconds per app and we run
   * sequentially to stay polite. Totals are displayed inline once the
   * stream closes; anything that arrives on the wire mid-run is relayed
   * into the task subtitle as "n/N · AppName".
   */
  const runBulkWaybackImport = async (options: { force?: boolean } = {}) => {
    if (waybackRunning && !options.force) {
      return;
    }
    if (options.force) {
      setWaybackControlBusy("force");
    }
    // Mark this tab as the owner of the active stream so the cross-tab
    // rehydration poller gets out of the way. Cleared in `finally`.
    waybackLocalStreamRef.current = true;
    setWaybackRunning(true);
    setWaybackRunStatus("running");
    setWaybackInitiator("manual");
    setWaybackSummary(null);
    // Reset any stale live state from a prior run. Note we deliberately
    // don't clear `waybackLastRun` here — keeping the previous summary
    // visible alongside "in progress…" helps users confirm a new run is
    // actually replacing the right one.
    setWaybackProgress({
      index: 0,
      total: 0,
      currentAppName: null,
      imported: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });

    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: tWayback("task_title"),
      subtitle: tWayback("task_preparing"),
      kind: "sync",
      href: "/dashboard/settings/admin#wayback-import",
      onCancel: () => {
        void controlWaybackImport("cancel");
      },
    });

    let totals: {
      appsAttempted: number;
      appsWithImports: number;
      targetsAttempted: number;
      imported: number;
      unchanged: number;
      skipped: number;
      failed: number;
    } | null = null;
    let terminalStatus: WaybackRunStatus | null = null;

    try {
      const params = new URLSearchParams({ stream: "1" });
      if (options.force) {
        params.set("force", "1");
      }
      const res = await fetch(`/api/wayback/import-all?${params.toString()}`, {
        method: "POST",
        signal: controller.signal,
      });

      if (!(res.ok && res.body)) {
        const errBody = await res.json().catch(() => null);
        const message =
          errBody?.error ??
          tWayback("bulk_failed_http", { status: res.status });
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setWaybackSummary(message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          let event: any;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event.type === "batch-start") {
            setWaybackRunStatus("running");
            handle.update({
              subtitle: tBulkStream("queued_subtitle", {
                total: Number(event.total ?? 0),
              }),
            });
            setWaybackProgress((prev) => ({
              ...(prev ?? {
                imported: 0,
                unchanged: 0,
                skipped: 0,
                failed: 0,
              }),
              index: 0,
              total: Number(event.total ?? 0),
              currentAppName: null,
              imported: 0,
              unchanged: 0,
              skipped: 0,
              failed: 0,
            }));
          } else if (event.type === "app-start") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            handle.update({
              subtitle: tBulkStream("progress_subtitle", {
                current: n,
                total,
                name: event.name,
              }),
            });
            setWaybackProgress((prev) =>
              prev
                ? {
                    ...prev,
                    index: n,
                    total: Number(event.total ?? prev.total),
                    currentAppName: String(event.name ?? ""),
                  }
                : prev
            );
          } else if (event.type === "target") {
            // `target` events are high-volume (one per quarter per app); we
            // don't push them into the task subtitle to avoid flickering,
            // but they drive the overall progress on the in-memory totals.
          } else if (event.type === "app-done") {
            const n = (event.index ?? 0) + 1;
            const total = event.total ?? "?";
            const imported = event.result?.imported ?? 0;
            const failed = event.result?.failed ?? 0;
            const badge =
              event.error || failed > 0 ? "⚠" : imported > 0 ? "⟳" : "✓";
            handle.update({
              subtitle: tBulkStream("progress_subtitle_badged", {
                current: n,
                total,
                badge,
                name: event.name,
              }),
            });
            setWaybackProgress((prev) =>
              prev
                ? {
                    ...prev,
                    index: n,
                    imported:
                      prev.imported + Number(event.result?.imported ?? 0),
                    unchanged:
                      prev.unchanged + Number(event.result?.unchanged ?? 0),
                    skipped: prev.skipped + Number(event.result?.skipped ?? 0),
                    // A top-level `event.error` means the entire app call
                    // threw — count it as a single failed app alongside the
                    // per-target failed counts so "Failed: N" on the status
                    // card always adds up to the number of apps the user
                    // should investigate.
                    failed:
                      prev.failed +
                      Number(event.result?.failed ?? 0) +
                      (event.error ? 1 : 0),
                  }
                : prev
            );
          } else if (event.type === "summary") {
            totals = event.totals;
          } else if (event.type === "paused") {
            terminalStatus = "paused";
            const remaining = Number(event.summary?.remaining ?? 0);
            const total = Number(event.summary?.total ?? 0);
            const line = tWayback("bulk_paused", { remaining, total });
            setWaybackSummary(line);
            handle.complete("cancelled", line);
            showToast(line);
          } else if (event.type === "cancelled") {
            terminalStatus = "idle";
            const remaining = Number(event.summary?.remaining ?? 0);
            const total = Number(event.summary?.total ?? 0);
            const line = tWayback("bulk_cancelled", { remaining, total });
            setWaybackSummary(line);
            handle.complete("cancelled", line);
            showToast(line);
          } else if (event.type === "error") {
            throw new Error(event.error ?? tWayback("bulk_failed"));
          }
        }
      }

      if (totals) {
        const parts: string[] = [];
        parts.push(tWayback("bulk_part_imported", { count: totals.imported }));
        if (totals.unchanged) {
          parts.push(tWayback("bulk_part_no_op", { count: totals.unchanged }));
        }
        if (totals.skipped) {
          parts.push(tWayback("bulk_part_skipped", { count: totals.skipped }));
        }
        if (totals.failed) {
          parts.push(tWayback("bulk_part_failed", { count: totals.failed }));
        }
        const line = tWayback("bulk_summary", {
          count: totals.appsAttempted,
          parts: parts.join(", "),
        });
        setWaybackSummary(line);
        terminalStatus = "idle";
        handle.complete(totals.failed > 0 ? "error" : "done", line);
        showToast(totals.failed > 0 ? `⚠ ${line}` : `✓ ${line}`);
      } else if (!terminalStatus) {
        terminalStatus = "idle";
        handle.complete("done", tWayback("task_finished"));
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        terminalStatus = "cancel_requested";
        setWaybackRunStatus("cancel_requested");
        handle.complete("cancelled", tWayback("cancel_requested"));
      } else {
        console.error("[settings] Wayback import failed:", err);
        const message = (err as Error)?.message ?? tWayback("bulk_failed");
        showToast(tToast("save_failed_with_message", { message }));
        handle.complete("error", message);
        setWaybackSummary(message);
      }
    } finally {
      waybackLocalStreamRef.current = false;
      setWaybackRunning(false);
      setWaybackControlBusy(null);
      // Clear the in-flight progress tracker and re-hydrate the last-run
      // summary from the activity log so the status card transitions from
      // "12/34 · Netflix" to "Last run: 3 imported, 1 failed — just now"
      // without needing a page reload. The activity row is written by the
      // server before the stream closes, so by the time we land here the
      // new summary should be queryable.
      if (terminalStatus !== "paused") {
        setWaybackProgress(null);
      }
      setWaybackRunStatus(terminalStatus ?? "idle");
      setWaybackInitiator(null);
      if (terminalStatus !== "paused") {
        void loadWaybackLastRun();
      }
    }
  };

  const controlWaybackImport = async (
    action: "pause" | "resume" | "cancel"
  ) => {
    if (waybackControlBusy) {
      return;
    }
    setWaybackControlBusy(action);
    try {
      const res = await fetch("/api/wayback/import-all", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          data?.error ?? `Wayback ${action} failed (${res.status})`;
        showToast(tToast("save_failed_with_message", { message }));
        return;
      }
      const nextStatus =
        typeof data?.status === "string"
          ? (data.status as WaybackRunStatus)
          : null;
      if (nextStatus) {
        setWaybackRunStatus(nextStatus);
      }
      if (action === "pause") {
        showToast(
          tWayback(
            nextStatus === "paused" ? "toast_paused" : "toast_pause_requested"
          )
        );
      } else if (action === "resume") {
        setWaybackRunning(true);
        setWaybackRunStatus("running");
        setWaybackInitiator("manual");
        showToast(tWayback("toast_resumed"));
        const snap = await loadWaybackProgress();
        if (snap?.progress) {
          setWaybackProgress(snap.progress);
        }
      } else {
        setWaybackRunStatus(
          nextStatus === "cancel_requested" ? "cancel_requested" : "idle"
        );
        if (nextStatus !== "cancel_requested") {
          setWaybackRunning(false);
          setWaybackProgress(null);
          void loadWaybackLastRun();
        }
        showToast(
          tWayback(
            nextStatus === "cancel_requested"
              ? "toast_cancel_requested"
              : "toast_cancelled"
          )
        );
      }
    } catch (err) {
      const message = (err as Error)?.message ?? `Wayback ${action} failed`;
      showToast(tToast("save_failed_with_message", { message }));
    } finally {
      setWaybackControlBusy(null);
    }
  };

  /**
   * Purge every wayback-sourced snapshot row across the database. Guarded
   * behind a `window.confirm` because the deletion is permanent — the user
   * would need to re-run the import to get the rows back. We intentionally
   * don't offer an undo since `privacy_snapshots` rows are cheap to
   * reconstruct and more complicated rollback would mask bugs.
   */
  /**
   * Dismiss the confirm modal. Guarded so we don't let the user close it
   * while a DELETE is in flight — otherwise clicking outside the card
   * would hide the spinner mid-request and leave the UI in a confusing
   * "did that actually work?" state.
   */
  const closeWaybackRemoveModal = () => {
    if (waybackRemoving) {
      return;
    }
    setWaybackRemoveOpen(false);
  };

  const removeAllWaybackHistory = async () => {
    if (waybackRemoving) {
      return;
    }

    setWaybackRemoving(true);
    try {
      const res = await fetch("/api/wayback/import-all", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = body?.error ?? `Remove failed (${res.status})`;
        showToast(tToast("save_failed_with_message", { message }));
        setWaybackSummary(message);
        return;
      }
      const data = await res.json();
      const deleted = Number(data?.deleted ?? 0);
      const line = `Removed ${deleted} imported history row${deleted === 1 ? "" : "s"}`;
      setWaybackSummary(line);
      showToast(tToast("saved_value", { message: line }));
      // A delete writes its own `wayback_import` activity row (mode: 'bulk',
      // removed: true), which `loadWaybackLastRun` filters out — so the
      // status card keeps showing the *import* summary, not the deletion.
      // No refresh needed.
    } catch (err) {
      const message = (err as Error)?.message ?? "Remove failed";
      showToast(tToast("save_failed_with_message", { message }));
      setWaybackSummary(message);
    } finally {
      setWaybackRemoving(false);
      setWaybackRemoveOpen(false);
    }
  };

  /**
   * Auto-save hook for the "show imported Wayback history in timelines"
   * toggle. The toggle flips imported rows on/off in every per-app
   * ChangelogTimeline without re-importing — server keeps the rows; the
   * UI just respects the flag.
   *
   * The hook itself doesn't manage local state, so the wrapper below
   * does the optimistic update + rollback dance: flip state synchronously
   * for instant feedback, await the POST, revert if the hook reports a
   * non-`ok` outcome (the hook also emits the red toast). On success we
   * advance the savedX watermark so the "current" / dirty checks stay
   * correct.
   */
  const waybackToggleAutoSave = useSettingsAutoSave<boolean>({
    endpoint: "/api/settings",
    buildBody: (value) => ({ wayback_show_imported: value }),
    successMessage: (value) =>
      value
        ? tWayback("toast_show_imported_on")
        : tWayback("toast_show_imported_off"),
    taskLabel: (value) =>
      value
        ? tWayback("task_label_show_imported_on")
        : tWayback("task_label_show_imported_off"),
    onSaved: (value) => setSavedWaybackShowImported(value),
  });

  const saveWaybackShowImported = async (next: boolean) => {
    setWaybackShowImported(next);
    const result = await waybackToggleAutoSave.save(next);
    if (result !== "ok") {
      // Revert optimistic state so the checkbox doesn't lie. The hook
      // already pushed the red error toast.
      setWaybackShowImported(savedWaybackShowImported);
    }
  };

  const waybackRemoveModalRef = useModalFocus<HTMLDivElement>({
    open: waybackRemoveOpen,
    onClose: closeWaybackRemoveModal,
  });
  // Rehydrate on mount: the last-run summary always, and the live
  // progress snapshot when the persisted mutex says a run is already in
  // flight (started in another tab or before a navigation). The poller
  // effect above takes over from there while `waybackRunning` is true.
  useEffect(() => {
    void loadWaybackLastRun();
    let cancelled = false;
    (async () => {
      const snap = await loadWaybackProgress();
      if (!snap || cancelled) {
        return;
      }
      setWaybackRunStatus(snap.status);
      setWaybackRunning(snap.running);
      setWaybackInitiator(snap.initiator);
      if (snap.progress) {
        setWaybackProgress(snap.progress);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once effect
  }, []);

  /** Settings-loader seam: SettingsView fetches every settings key in one
   *  request and hands the wayback slice over here. */
  const hydrateShowImported = (next: boolean) => {
    setWaybackShowImported(next);
    setSavedWaybackShowImported(next);
  };

  return {
    hydrateShowImported,
    waybackRunning,
    setWaybackRunning,
    waybackRunStatus,
    setWaybackRunStatus,
    waybackControlBusy,
    setWaybackControlBusy,
    waybackRemoving,
    setWaybackRemoving,
    waybackRemoveOpen,
    setWaybackRemoveOpen,
    waybackLocalStreamRef,
    waybackSummary,
    setWaybackSummary,
    waybackShowImported,
    setWaybackShowImported,
    savedWaybackShowImported,
    setSavedWaybackShowImported,
    trackAccessibility,
    setTrackAccessibility,
    savedTrackAccessibility,
    setSavedTrackAccessibility,
    waybackProgress,
    setWaybackProgress,
    waybackInitiator,
    setWaybackInitiator,
    waybackLastRun,
    setWaybackLastRun,
    loadWaybackProgress,
    loadWaybackLastRun,
    runBulkWaybackImport,
    controlWaybackImport,
    closeWaybackRemoveModal,
    removeAllWaybackHistory,
    waybackToggleAutoSave,
    saveWaybackShowImported,
    waybackRemoveModalRef,
  };
}
