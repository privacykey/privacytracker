"use client";

/**
 * QueuedSearchProvider
 *
 * Hoists the "Apple rate-limited our search, resume the tail in N seconds"
 * loop out of OnboardWizard into a layout-level context so the work keeps
 * running if the user navigates away from /onboard. Without this, leaving the
 * wizard mid-batch would silently drop the queued names.
 *
 * Responsibilities:
 *   - Own the pending queue, country, importId, and retry timer.
 *   - Fire the retry fetch when the cooldown elapses; re-arm if Apple throttles
 *     us again; back off on transport errors.
 *   - Register a Task Center task so the progress + countdown are visible from
 *     any page (via the nav-bar dropdown). Users can cancel from there too.
 *   - Back-fill `/api/imports/items` with matched/unmatched rows so the import
 *     history reflects the full batch even if the wizard already closed.
 *   - Emit results to any mounted subscriber (the wizard) so it can splice
 *     fresh matches into its Step 3 list in real time.
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
import { type TaskHandle, useTaskCenter } from "./TaskCenter";

export interface SearchQueryRow {
  developer?: string;
  name: string;
}

interface Candidate {
  appleId: string;
  bundleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  searchQuery: string;
  url: string;
}

export interface SearchResultLike {
  candidates: Candidate[];
  query: string;
}

type ResultsListener = (fresh: SearchResultLike[]) => void;

export interface QueuedSearchState {
  /** Number of queries the provider has matched so far (for progress). */
  matched: number;
  /** True while a queue is waiting for cooldown or a fetch is in flight. */
  pending: boolean;
  /** Items still waiting on Apple. */
  remaining: number;
  /** Wall-clock ms when the next retry fires; null if fetching right now. */
  resumeAt: number | null;
  /** Original batch size when the queue was first enqueued. */
  total: number;
}

interface EnqueueInit {
  country: string;
  importId: string | null;
  queued: SearchQueryRow[];
  retryAfterMs: number;
}

interface QueuedSearchApi {
  /** User-driven cancel — drops the queue, completes the Task Center entry. */
  cancel(): void;
  /**
   * Hand off a tail to the provider. If a queue is already pending, the new
   * rows are appended and the longer of the two retry windows wins.
   */
  enqueue(init: EnqueueInit): void;
  state: QueuedSearchState;
  /** Subscribe to fresh SearchResult batches as they resolve. */
  subscribe(fn: ResultsListener): () => void;
}

const Ctx = createContext<QueuedSearchApi | null>(null);

const IDLE_STATE: QueuedSearchState = {
  pending: false,
  remaining: 0,
  total: 0,
  resumeAt: null,
  matched: 0,
};

export function QueuedSearchProvider({ children }: { children: ReactNode }) {
  const taskCenter = useTaskCenter();

  // Canonical reactive state. Components reading the context re-render when
  // this changes (e.g. the wizard's rate-limit banner).
  const [state, setState] = useState<QueuedSearchState>(IDLE_STATE);

  // Everything below uses refs so the drain loop is stable across renders.
  const queuedRef = useRef<SearchQueryRow[]>([]);
  const countryRef = useRef<string>("us");
  const importIdRef = useRef<string | null>(null);
  const totalRef = useRef<number>(0);
  const matchedRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskHandleRef = useRef<TaskHandle | null>(null);
  const listenersRef = useRef<Set<ResultsListener>>(new Set());
  const abortedRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  /**
   * Holds the latest `drain` callback so `scheduleRetry` can call it
   * without taking it as a dep. `scheduleRetry` and `drain` are
   * mutually recursive — each calls the other — and putting either
   * one in the other's `useCallback` dep array creates an identity
   * cycle that re-creates them on every render. Worse, the React
   * Compiler / Hooks v6 lint rule (`react-hooks/immutability`) flags
   * the variable-before-declared reference as a stale-closure risk.
   *
   * The ref pattern resolves both: scheduleRetry calls
   * `drainRef.current?.()`, and a tiny effect below keeps the ref
   * pointed at the latest `drain` whenever its identity changes.
   * Behavior is unchanged — at runtime, drain is always defined by
   * the time setTimeout fires, because both callbacks are created
   * during the same render pass.
   */
  const drainRef = useRef<(() => Promise<void>) | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const resetAll = useCallback(() => {
    clearTimers();
    queuedRef.current = [];
    countryRef.current = "us";
    importIdRef.current = null;
    totalRef.current = 0;
    matchedRef.current = 0;
    inFlightRef.current = false;
    abortedRef.current = false;
    taskHandleRef.current = null;
    setState(IDLE_STATE);
  }, [clearTimers]);

  const emit = useCallback((fresh: SearchResultLike[]) => {
    listenersRef.current.forEach((fn) => {
      try {
        fn(fresh);
      } catch (err) {
        console.warn("[queued-search] listener threw:", err);
      }
    });
  }, []);

  /**
   * Push matched/unmatched rows into the server-side import so the history
   * table reflects the full batch. This is fire-and-forget — failures here
   * don't abort the queue, they just get logged.
   */
  const backfillImportItems = useCallback(async (fresh: SearchResultLike[]) => {
    const importId = importIdRef.current;
    if (!importId || fresh.length === 0) {
      return;
    }
    const items = fresh.map((r) => {
      const top = r.candidates[0];
      if (!top) {
        return { query: r.query, status: "unmatched" as const };
      }
      return {
        query: r.query,
        status: "matched" as const,
        appId: top.appleId,
        appName: top.name,
        developer: top.developer,
        url: top.url,
      };
    });
    try {
      await fetch("/api/imports/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId, items }),
      });
    } catch (err) {
      console.warn("[queued-search] backfill failed:", err);
    }
  }, []);

  /**
   * Schedule the next retry + a 1-Hz tick that refreshes the countdown
   * subtitle on the Task Center entry so it animates down to zero.
   */
  const scheduleRetry = useCallback(
    (delayMs: number) => {
      clearTimers();
      if (abortedRef.current) {
        return;
      }

      const resumeAt = Date.now() + delayMs;
      setState((prev) => ({ ...prev, pending: true, resumeAt }));

      tickRef.current = setInterval(() => {
        if (abortedRef.current) {
          return;
        }
        const remaining = Math.max(0, resumeAt - Date.now());
        const secs = Math.ceil(remaining / 1000);
        taskHandleRef.current?.setProgress(
          matchedRef.current,
          totalRef.current,
          remaining > 0
            ? `Resuming in ${secs}s · ${queuedRef.current.length} queued`
            : "Resuming now…"
        );
      }, 1000);

      // Initial tick so the label reflects the right number immediately.
      taskHandleRef.current?.setProgress(
        matchedRef.current,
        totalRef.current,
        `Resuming in ${Math.ceil(delayMs / 1000)}s · ${queuedRef.current.length} queued`
      );

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Call through the ref so we always invoke the latest `drain`
        // (re-pointed by the effect below whenever its identity changes).
        // Direct reference would either need `drain` in our deps —
        // creating a useCallback identity cycle since drain depends on
        // scheduleRetry — or hit the immutability lint rule for
        // accessing a variable declared further down in the file.
        void drainRef.current?.();
      }, delayMs);
    },
    [clearTimers]
  );

  /**
   * One pass at the current queue. Drains everything that Apple returns in a
   * single /api/search call; if another 429 comes back, re-arms the timer for
   * the new tail. Loops cooperatively via scheduleRetry — we never hot-loop.
   */
  const drain = useCallback(async () => {
    if (abortedRef.current) {
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    const batch = queuedRef.current;
    if (batch.length === 0) {
      // Nothing left — mark done.
      setState({ ...IDLE_STATE });
      taskHandleRef.current?.complete(
        "done",
        `${matchedRef.current} of ${totalRef.current} matched`
      );
      resetAll();
      return;
    }

    inFlightRef.current = true;
    clearTimers();
    setState((prev) => ({ ...prev, pending: true, resumeAt: null }));
    taskHandleRef.current?.setProgress(
      matchedRef.current,
      totalRef.current,
      `Searching ${batch.length}…`
    );

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: batch, country: countryRef.current }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const fresh: SearchResultLike[] = Array.isArray(data?.results)
        ? data.results
        : [];
      const rate = data?.rateLimited as
        | { retryAfterMs: number; queued: SearchQueryRow[] }
        | undefined;

      matchedRef.current += fresh.length;
      // Surface to any subscribers (the wizard) and back-fill server-side.
      emit(fresh);
      void backfillImportItems(fresh);

      if (rate && Array.isArray(rate.queued) && rate.queued.length > 0) {
        // Apple throttled us again on the replay. Swap queue + re-arm timer.
        queuedRef.current = rate.queued;
        setState({
          pending: true,
          remaining: rate.queued.length,
          total: totalRef.current,
          resumeAt: Date.now() + rate.retryAfterMs,
          matched: matchedRef.current,
        });
        inFlightRef.current = false;
        scheduleRetry(rate.retryAfterMs);
        return;
      }

      // Queue fully drained.
      queuedRef.current = [];
      inFlightRef.current = false;
      taskHandleRef.current?.setProgress(
        totalRef.current,
        totalRef.current,
        "Complete"
      );
      taskHandleRef.current?.complete(
        "done",
        `${matchedRef.current} of ${totalRef.current} matched`
      );
      resetAll();
    } catch (err) {
      console.error("[queued-search] drain failed:", err);
      inFlightRef.current = false;
      // Transport error — back off ~30s before retrying the same batch.
      taskHandleRef.current?.update({
        message:
          err instanceof Error ? err.message : "Network error — retrying",
      });
      scheduleRetry(30_000);
    }
  }, [backfillImportItems, clearTimers, emit, resetAll, scheduleRetry]);

  // Keep drainRef pointed at the latest `drain` so `scheduleRetry`'s
  // setTimeout closure always calls the current version. See the
  // commentary on `drainRef` declaration for the full rationale.
  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  const enqueue = useCallback(
    (init: EnqueueInit) => {
      if (!Array.isArray(init.queued) || init.queued.length === 0) {
        return;
      }

      // Append onto whatever's currently waiting. The country / importId from
      // the most recent enqueue wins because the caller is the authoritative
      // source for their own session.
      abortedRef.current = false;
      const existing = queuedRef.current;
      const merged =
        existing.length > 0 ? [...existing, ...init.queued] : init.queued;
      queuedRef.current = merged;
      countryRef.current = init.country;
      importIdRef.current = init.importId;
      totalRef.current = Math.max(
        totalRef.current,
        merged.length + matchedRef.current
      );

      // Create or update the Task Center entry. We keep a single task across
      // multiple rate-limit bounces so the UI isn't flooded with duplicates.
      if (!taskHandleRef.current) {
        taskHandleRef.current = taskCenter.startTask({
          title: "Matching queued apps",
          subtitle: "Apple rate-limited the search — resuming automatically",
          kind: "import",
          href: "/onboard",
          progress: {
            current: matchedRef.current,
            total: totalRef.current,
            label: `Resuming in ${Math.ceil(init.retryAfterMs / 1000)}s · ${merged.length} queued`,
          },
          onCancel: () => {
            abortedRef.current = true;
            queuedRef.current = [];
            clearTimers();
            setState(IDLE_STATE);
            taskHandleRef.current = null;
          },
        });
      }

      setState({
        pending: true,
        remaining: merged.length,
        total: totalRef.current,
        resumeAt: Date.now() + init.retryAfterMs,
        matched: matchedRef.current,
      });
      scheduleRetry(init.retryAfterMs);
    },
    [clearTimers, scheduleRetry, taskCenter]
  );

  const subscribe = useCallback((fn: ResultsListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const cancel = useCallback(() => {
    abortedRef.current = true;
    queuedRef.current = [];
    clearTimers();
    taskHandleRef.current?.complete("cancelled", "Cancelled");
    taskHandleRef.current = null;
    setState(IDLE_STATE);
  }, [clearTimers]);

  // Safety net: clear timers when the provider itself unmounts. In normal app
  // usage this only fires on full-page reload, which tears everything down.
  useEffect(() => () => clearTimers(), [clearTimers]);

  const api = useMemo<QueuedSearchApi>(
    () => ({ state, enqueue, subscribe, cancel }),
    [state, enqueue, subscribe, cancel]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useQueuedSearch(): QueuedSearchApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useQueuedSearch must be used inside <QueuedSearchProvider>."
    );
  }
  return ctx;
}
