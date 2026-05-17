"use client";

/**
 * ImportQueueProvider
 *
 * Mirrors `QueuedSearchProvider` but for the Step-4 import queue. The actual
 * work lives on the server (see `lib/import-queue.ts` + the instrumentation
 * ticker) — this component just polls `/api/imports/queue`, surfaces the
 * progress in the Task Center, and exposes a `retryNow()` hook that the
 * Import History page binds to its "Retry queue now" button.
 *
 * Why a client-side provider if the work is server-driven?
 *   - We want the Task Center spinner/progress visible from any page while
 *     the worker drains. The worker itself can't talk to React.
 *   - We want the user to be able to force an immediate drain from the UI
 *     without waiting for the next ticker tick.
 *   - We want the provider to clean up its Task Center entry the moment
 *     the queue hits zero, even if we never heard back from the worker.
 *
 * The provider runs a single poll loop for the whole app — mounted once in
 * the layout. Component-level code uses `useImportQueue()` to read status
 * or trigger a manual retry.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { recordImportEvent } from "@/lib/client-diagnostics";
import { type TaskHandle, useTaskCenter } from "./TaskCenter";

export interface ImportQueueItemSnapshot {
  appId: string | null;
  appName: string | null;
  attemptCount: number;
  developer: string | null;
  iconUrl: string | null;
  id: string;
  importId: string;
  nextAttemptAt: number | null;
  query: string;
  scrapeError: string | null;
  status: string;
  url: string | null;
}

export interface ImportQueueSnapshot {
  items: ImportQueueItemSnapshot[];
  lastRunAt: number | null;
  oldestNextAttemptAt: number | null;
  pausedUntil: number | null;
  queued: number;
  running: boolean;
  soonestNextAttemptAt: number | null;
}

/**
 * Result of one drain tick. Mirrors `ImportQueueTickResult` on the
 * server side — exposed through `retryNow()` so callers driving a
 * foreground drain loop know whether to keep going (queue not empty,
 * not rate-limited) or stop (queue drained, or paused for a cooldown
 * the caller now wants to count down before resuming).
 */
export interface ImportQueueTickResult {
  /** Permanent failures (404, parse error, etc.). */
  failed: number;
  /** Epoch-ms cooldown end if paused (either pre-tick or set by this tick). */
  pausedUntil: number | null;
  /** Number of rows the tick actually claimed and tried to scrape. */
  processed: number;
  /** Items that hit a 429 mid-tick. > 0 means the queue is now paused. */
  rateLimited: number;
  /** When the tick decided not to run any items at all. */
  skipped: "paused" | "busy" | "empty" | null;
  /** Of those, how many succeeded (row flipped to `imported`). */
  succeeded: number;
}

/**
 * Drain progress state — persists across page navigation because the
 * provider lives in app/layout.tsx and never unmounts on intra-app
 * routing. SettingsView used to hold this locally, which meant the
 * progress bar + cancel button vanished the moment the user left
 * Import History, even though the drain kept going server-side. Now
 * the user can navigate away and come back to find the same progress
 * card waiting for them.
 */
export interface ImportQueueDrainState {
  /** Set true by `cancelDrain()`; loop checks each iteration and bails. */
  cancelled: boolean;
  /** Backlog size at the moment the drain started. The progress bar's
   *  denominator stays anchored to this so success doesn't move the
   *  goalposts. */
  initialTotal: number;
  /** Mirrors the server's pause fence when Apple's 429 cooldown is in
   *  effect. Banner uses this for the live countdown. */
  pausedUntil: number | null;
  /** Cumulative `tick.processed` across every tick run so far. */
  processed: number;
  /** When the current drain started. Useful for "resumed from a previous
   *  navigation" diagnostics. */
  startedAt: number;
}

export interface ImportQueueStartDrainOptions {
  forceRefresh?: boolean;
  initialSnapshot?: ImportQueueSnapshot | null;
}

interface ImportQueueApi {
  /** Cancel the active drain (if any). Aborts the in-flight fetch. */
  cancelDrain(): void;
  /** Currently-active drain state. `null` when no drain is running. */
  drainState: ImportQueueDrainState | null;
  /**
   * Subscribe to per-tick callbacks so page-level UI (Import History's
   * imports list, expanded item rows) can refresh after each tick.
   * Returns an unsubscribe function — call it on unmount.
   */
  onTickComplete(cb: (tickResult: ImportQueueTickResult) => void): () => void;
  /** Force a fresh poll (used when the user lands on Import History). */
  refresh(): Promise<ImportQueueSnapshot | null>;
  /**
   * Kick an immediate drain on the server + refresh the local cache.
   * Returns the tick result so callers driving a foreground drain
   * loop know whether to call again. Throws on transport / 5xx
   * failures (caller should treat as "drain stalled, surface error").
   *
   * Optional `signal` — when aborted, the in-flight fetch is cancelled
   * and the promise rejects with the standard AbortError. The
   * server-side tick keeps running to completion (we can't interrupt
   * fetchAndParseApp mid-flight) but already-claimed items finish and
   * durably commit; nothing is lost. The next tick simply isn't started.
   */
  retryNow(signal?: AbortSignal): Promise<ImportQueueTickResult>;
  /**
   * Start a foreground drain loop that calls retryNow() repeatedly
   * until the queue is empty, the user cancels, or all remaining items
   * are stuck behind a non-clearable error. Auto-resumes after a 429
   * cooldown elapses. No-op if a drain is already running.
   */
  startDrain(options?: ImportQueueStartDrainOptions): void;
  state: ImportQueueSnapshot;
}

const IDLE: ImportQueueSnapshot = {
  queued: 0,
  oldestNextAttemptAt: null,
  soonestNextAttemptAt: null,
  items: [],
  pausedUntil: null,
  running: false,
  lastRunAt: null,
};

const Ctx = createContext<ImportQueueApi | null>(null);

// How often we hit /api/imports/queue. Matches the server tick cadence —
// no point polling faster than the worker can drain.
const POLL_INTERVAL_MS = 10_000;

export function ImportQueueProvider({ children }: { children: ReactNode }) {
  const taskCenter = useTaskCenter();

  const [state, setState] = useState<ImportQueueSnapshot>(IDLE);
  const taskHandleRef = useRef<TaskHandle | null>(null);
  // Track the baseline total so the progress bar only moves forward. Without
  // this, the "queued" count dropping after a successful drain would look
  // like the bar was regressing.
  const baselineTotalRef = useRef(0);
  const unmountedRef = useRef(false);

  // Build the Task Center label for the current snapshot. Tiny helper so we
  // don't duplicate the formatting logic across refresh paths.
  const buildProgressLabel = useCallback(
    (snap: ImportQueueSnapshot): string => {
      if (snap.queued === 0) {
        return "Draining…";
      }
      if (snap.pausedUntil) {
        const secs = Math.max(
          1,
          Math.ceil((snap.pausedUntil - Date.now()) / 1000)
        );
        return `${snap.queued} queued · Apple rate-limited · retrying in ${secs}s`;
      }
      if (snap.soonestNextAttemptAt && snap.soonestNextAttemptAt > Date.now()) {
        const secs = Math.max(
          1,
          Math.ceil((snap.soonestNextAttemptAt - Date.now()) / 1000)
        );
        return `${snap.queued} queued · next retry in ${secs}s`;
      }
      return `${snap.queued} queued · retrying now`;
    },
    []
  );

  const syncTaskHandle = useCallback(
    (snap: ImportQueueSnapshot) => {
      if (snap.queued > 0) {
        // Bump the baseline if the queue just grew (a new 429 queued more).
        // We never shrink it: successful drains visibly progress the bar.
        if (snap.queued > baselineTotalRef.current) {
          baselineTotalRef.current = snap.queued;
        }
        const total = Math.max(baselineTotalRef.current, snap.queued);
        const done = Math.max(0, total - snap.queued);
        if (taskHandleRef.current) {
          taskHandleRef.current.setProgress(
            done,
            total,
            buildProgressLabel(snap)
          );
        } else {
          taskHandleRef.current = taskCenter.startTask({
            title: "Importing queued apps",
            subtitle: "Draining the background import queue",
            kind: "import",
            href: "/dashboard/settings/import-history",
            progress: { current: done, total, label: buildProgressLabel(snap) },
          });
        }
      } else if (taskHandleRef.current) {
        // Queue hit zero — complete the Task Center entry and reset the baseline
        // so the next 429 starts fresh.
        taskHandleRef.current.complete("done", "Queue drained");
        taskHandleRef.current = null;
        baselineTotalRef.current = 0;
      }
    },
    [buildProgressLabel, taskCenter]
  );

  const fetchStatus =
    useCallback(async (): Promise<ImportQueueSnapshot | null> => {
      try {
        const res = await fetch("/api/imports/queue", { cache: "no-store" });
        if (!res.ok) {
          return null;
        }
        const data = await res.json();
        const snap: ImportQueueSnapshot = {
          queued: Number(data?.queued) || 0,
          oldestNextAttemptAt:
            typeof data?.oldestNextAttemptAt === "number"
              ? data.oldestNextAttemptAt
              : null,
          soonestNextAttemptAt:
            typeof data?.soonestNextAttemptAt === "number"
              ? data.soonestNextAttemptAt
              : null,
          items: Array.isArray(data?.items) ? data.items : [],
          pausedUntil:
            typeof data?.pausedUntil === "number" ? data.pausedUntil : null,
          running: data?.running === true,
          lastRunAt:
            typeof data?.lastRunAt === "number" ? data.lastRunAt : null,
        };
        return snap;
      } catch (err) {
        console.warn("[import-queue] poll failed:", err);
        return null;
      }
    }, []);

  const refresh = useCallback(async (): Promise<ImportQueueSnapshot | null> => {
    const snap = await fetchStatus();
    if (!snap || unmountedRef.current) {
      return snap;
    }
    setState(snap);
    syncTaskHandle(snap);
    return snap;
  }, [fetchStatus, syncTaskHandle]);

  const retryNow = useCallback(
    async (signal?: AbortSignal): Promise<ImportQueueTickResult> => {
      recordImportEvent("queue.tick.start");
      const res = await fetch("/api/imports/queue", { method: "POST", signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      recordImportEvent("queue.tick.complete", {
        processed: data?.processed ?? 0,
        succeeded: data?.succeeded ?? 0,
        failed: data?.failed ?? 0,
        rateLimited: data?.rateLimited ?? 0,
      });
      // The POST response includes the post-tick status for free — use it
      // instead of a follow-up GET so the UI updates in a single round trip.
      if (
        data?.status &&
        typeof data.status === "object" &&
        !unmountedRef.current
      ) {
        const snap = data.status as ImportQueueSnapshot;
        setState(snap);
        syncTaskHandle(snap);
      }
      // Normalise the tick portion of the payload. Older servers (or a
      // 500-followed-by-stale-cache) might omit fields, so coerce to
      // safe defaults rather than letting `undefined` propagate into
      // a foreground drain loop's logic.
      const processed =
        typeof data?.processed === "number" ? data.processed : 0;
      const succeeded =
        typeof data?.succeeded === "number" ? data.succeeded : 0;
      const failed = typeof data?.failed === "number" ? data.failed : 0;
      const rateLimited =
        typeof data?.rateLimited === "number" ? data.rateLimited : 0;
      const pausedUntil =
        typeof data?.pausedUntil === "number" ? data.pausedUntil : null;
      const skipped =
        data?.skipped === "paused" ||
        data?.skipped === "busy" ||
        data?.skipped === "empty"
          ? data.skipped
          : null;
      return {
        processed,
        succeeded,
        failed,
        rateLimited,
        pausedUntil,
        skipped,
      };
    },
    [syncTaskHandle]
  );

  useEffect(() => {
    unmountedRef.current = false;
    // First poll shortly after mount, then on an interval.
    const first = setTimeout(() => {
      void refresh();
    }, 2000);
    const tick = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      unmountedRef.current = true;
      clearTimeout(first);
      clearInterval(tick);
      // Don't complete() here — leaving the task visible across the
      // provider's own unmount (e.g., route change) is the whole point.
    };
  }, [refresh]);

  // ── Drain orchestration ──────────────────────────────────────────
  //
  // Hoisted from SettingsView so the drain state survives navigation.
  // The loop is held in a ref so React state updates don't re-run it,
  // and a tickComplete subscriber set lets pages register per-tick
  // refreshers (loadImports, expanded-row refresh) without coupling
  // page-specific logic into the provider.

  const [drainState, setDrainState] = useState<ImportQueueDrainState | null>(
    null
  );
  const drainAbortRef = useRef<AbortController | null>(null);
  const drainCancelRef = useRef<boolean>(false);
  const drainRunningRef = useRef<boolean>(false);
  const tickSubscribersRef = useRef<
    Set<(tickResult: ImportQueueTickResult) => void>
  >(new Set());

  const onTickComplete = useCallback(
    (cb: (tickResult: ImportQueueTickResult) => void): (() => void) => {
      tickSubscribersRef.current.add(cb);
      return () => {
        tickSubscribersRef.current.delete(cb);
      };
    },
    []
  );

  const cancelDrain = useCallback(() => {
    drainCancelRef.current = true;
    if (drainAbortRef.current) {
      drainAbortRef.current.abort();
    }
    setDrainState((prev) => (prev ? { ...prev, cancelled: true } : prev));
  }, []);

  const startDrain = useCallback(
    (options: ImportQueueStartDrainOptions = {}) => {
      if (drainRunningRef.current) {
        return; // already running
      }

      drainRunningRef.current = true;
      drainCancelRef.current = false;

      // Async loop. We don't await it — let it run in the background;
      // all updates flow through React state + the subscriber callback.
      void (async () => {
        const initialSnapshot =
          options.initialSnapshot === undefined
            ? options.forceRefresh || state.queued === 0
              ? await fetchStatus()
              : state
            : options.initialSnapshot;

        if (
          !initialSnapshot ||
          initialSnapshot.queued === 0 ||
          unmountedRef.current ||
          drainCancelRef.current
        ) {
          drainRunningRef.current = false;
          return;
        }

        setState(initialSnapshot);
        syncTaskHandle(initialSnapshot);

        const initialTotal = Math.max(1, initialSnapshot.queued);
        recordImportEvent("drain.start", { initialTotal });
        drainAbortRef.current = new AbortController();
        setDrainState({
          initialTotal,
          processed: 0,
          cancelled: false,
          pausedUntil: initialSnapshot.pausedUntil,
          startedAt: Date.now(),
        });

        let processed = 0;
        try {
          while (!drainCancelRef.current) {
            let result: ImportQueueTickResult;
            try {
              result = await retryNow(drainAbortRef.current?.signal);
            } catch (err) {
              // Abort is the expected outcome of cancelDrain; everything
              // else is a real failure.
              if (err instanceof Error && err.name === "AbortError") {
                break;
              }
              console.error("[import-queue] drain tick failed:", err);
              break;
            }
            if (drainCancelRef.current) {
              break;
            }

            processed += result.processed;
            setDrainState((prev) =>
              prev
                ? { ...prev, processed, pausedUntil: result.pausedUntil }
                : prev
            );

            // Notify subscribers (Import History's imports-list refresh,
            // expanded-row refresh) — synchronous so a click → refresh
            // race doesn't end up showing stale rows. We swallow errors
            // per-subscriber so one buggy listener can't break the loop.
            for (const cb of tickSubscribersRef.current) {
              try {
                cb(result);
              } catch (e) {
                console.warn(
                  "[import-queue] tickComplete subscriber threw:",
                  e
                );
              }
            }

            if (result.skipped === "empty") {
              break;
            }

            if (result.skipped === "busy") {
              // The server's mutex is held. Wait for it to clear (the
              // 90s stale-lock timeout puts a ceiling on this), but
              // honour cancel mid-wait.
              await sleepCancellable(3000, drainCancelRef);
              continue;
            }

            if (result.pausedUntil && result.pausedUntil > Date.now()) {
              const waitMs = Math.max(0, result.pausedUntil - Date.now()) + 500;
              await sleepCancellable(waitMs, drainCancelRef);
              continue;
            }

            // Tick ran but processed nothing — every queued row is
            // either too-young (next_attempt_at in future) or in-flight.
            // Stop; the polling clock will pick it up later.
            if (result.processed === 0) {
              break;
            }
          }
        } finally {
          recordImportEvent("drain.end", { processedTotal: processed });
          if (!unmountedRef.current) {
            setDrainState(null);
          }
          drainAbortRef.current = null;
          drainCancelRef.current = false;
          drainRunningRef.current = false;
        }
      })();
    },
    [fetchStatus, retryNow, state, syncTaskHandle]
  );

  const api = useMemo<ImportQueueApi>(
    () => ({
      state,
      retryNow,
      refresh,
      drainState,
      startDrain,
      cancelDrain,
      onTickComplete,
    }),
    [
      state,
      retryNow,
      refresh,
      drainState,
      startDrain,
      cancelDrain,
      onTickComplete,
    ]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/**
 * Sleep for `ms` milliseconds OR until the cancel ref flips true,
 * whichever comes first. Polls every 250ms — heavy enough to feel
 * responsive (Cancel button bails out within ~250ms) without burning
 * CPU on a 60-second wait.
 */
async function sleepCancellable(
  ms: number,
  cancelRef: { current: boolean }
): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (cancelRef.current || Date.now() >= deadline) {
        clearInterval(id);
        resolve();
      }
    };
    const id = setInterval(tick, 250);
  });
}

export function useImportQueue(): ImportQueueApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useImportQueue must be used inside <ImportQueueProvider>."
    );
  }
  return ctx;
}
