"use client";

/**
 * The Settings activity log: a paged, filtered, live-polling view over
 * `GET /api/activity`.
 *
 * This lived inline in SettingsView as ~14 pieces of state, 6 mirror refs,
 * two fetchers and four effects. Every one of them was read by exactly one
 * accordion, so the whole subsystem moved here rather than being drilled
 * through props — the panel that renders it now calls this hook and gets a
 * single object back.
 *
 * The returned field names are deliberately unprefixed (`log`, `loading`,
 * `typeFilter`) because the `activity*` prefix only existed to keep them
 * apart from the other ~90 state declarations they used to share a scope
 * with. Callers that want the old names can rename on destructure.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Activity row returned by /api/activity. Mirrors lib/activity.ts
 * ActivityRow, but kept duplicated here so the client bundle doesn't pull the
 * server-only `db` import chain via that module.
 */
export interface ActivityLogRow {
  appId: string | null;
  appName: string | null;
  detail: Record<string, unknown> | null;
  durationMs: number | null;
  endedAt: number | null;
  id: string;
  startedAt: number;
  status: string;
  summary: string | null;
  type: string;
}

export type ActivitySortBy = "started_at" | "ended_at" | "duration_ms";
export type ActivitySortDir = "asc" | "desc";

const ACTIVITY_PAGE = 40;
const ACTIVITY_POLL_MS = 3000;

/**
 * Convert the user-facing time-window preset into an absolute epoch-ms
 * lower bound at request time. We compute `since` here (not on the
 * server) so the API stays fully stateless — no "since-now" semantics
 * tucked away behind a server-clock assumption.
 */
function timeWindowToSince(window: string): number | null {
  if (!window) {
    return null;
  }
  const now = Date.now();
  const units: Record<string, number> = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  const delta = units[window];
  return typeof delta === "number" ? now - delta : null;
}

export function useActivityLog({
  onLoadError,
}: {
  /** Fired when a user-initiated load fails. Polling failures stay silent
   *  on purpose — see `pollActivityLog`. */
  onLoadError: () => void;
}) {
  // Lazy-loaded on first accordion open; `log` stays null until then so we
  // don't pay the network round-trip on every Settings visit.
  const [log, setLog] = useState<ActivityLogRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>("");
  // Secondary filters — all three are empty string = "no filter", so the
  // existing loaders can treat absence the same way they already treat
  // `typeFilter === ''`. Time window is expressed as a preset key
  // that the loader converts into an absolute `since` timestamp at request
  // time (computed client-side to keep the API stateless).
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [timeWindow, setTimeWindow] = useState<string>(""); // '', '5m', '15m', '1h', '6h', '24h', '7d'
  const [sortBy, setSortBy] = useState<ActivitySortBy>("started_at");
  const [sortDir, setSortDir] = useState<ActivitySortDir>("desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // User-facing pause switch. Polling also yields to manual-action inflight
  // state (loadingRef) and to `document.hidden` so background tabs
  // don't spam the server.
  const [livePaused, setLivePaused] = useState(false);
  // When a poll prepends a new row we briefly flash the "Live" indicator so
  // the user gets visual confirmation that a fresh row just landed — not just
  // that polling is wired up. `flashing` is flipped true on arrival
  // and auto-cleared ~1.2s later by the effect below.
  const [flashing, setFlashing] = useState(false);

  /**
   * Apply all active activity filters + sort to the URLSearchParams used by
   * both `load` and `pollActivityLog`. Pulled into a helper so the
   * two stay in lockstep — drift here was how an earlier iteration ended up
   * polling for unfiltered rows while the user was looking at an "errors
   * only" view.
   */
  const applyActivityQueryParams = (
    params: URLSearchParams,
    overrides?: {
      type?: string;
      status?: string;
      timeWindow?: string;
      sortBy?: string;
      sortDir?: string;
    }
  ) => {
    const type = overrides?.type ?? typeFilter;
    const status = overrides?.status ?? statusFilter;
    const activeWindow = overrides?.timeWindow ?? timeWindow;
    const by = overrides?.sortBy ?? sortBy;
    const dir = overrides?.sortDir ?? sortDir;
    if (type) {
      params.set("type", type);
    }
    if (status) {
      params.set("status", status);
    }
    const since = timeWindowToSince(activeWindow);
    if (since !== null) {
      params.set("since", String(since));
    }
    if (by) {
      params.set("sortBy", by);
    }
    if (dir) {
      params.set("sortDir", dir);
    }
  };

  const load = async (append = false) => {
    setLoading(true);
    try {
      const offset = append ? (log?.length ?? 0) : 0;
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE));
      params.set("offset", String(offset));
      applyActivityQueryParams(params);
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) {
        onLoadError();
        setLoading(false);
        return;
      }
      const data = (await res.json()) as {
        rows?: ActivityLogRow[];
        total?: number;
      };
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const nextTotal =
        typeof data.total === "number" ? data.total : rows.length;
      setTotal(nextTotal);
      setLog((prev) => (append && prev ? [...prev, ...rows] : rows));
      const loadedCount = (append && log ? log.length : 0) + rows.length;
      setHasMore(loadedCount < nextTotal);
    } catch (error) {
      console.error("[settings] Failed to load activity log:", error);
      onLoadError();
    }
    setLoading(false);
  };

  // When any of the filters or sort order change, refresh from scratch (but
  // only after the panel has been opened at least once — otherwise the
  // dropdowns firing on mount would kick a spurious fetch).
  useEffect(() => {
    if (log === null) {
      return;
    }
    // `load` is declared above but not memoised; listing it would re-run
    // this effect on every render. The stale-closure concern applies to
    // useCallback, not useEffect.
    // eslint-disable-next-line react-hooks/immutability
    void load(false);
    setExpandedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter, timeWindow, sortBy, sortDir]);

  // ── Live activity polling ─────────────────────────────────────────────
  //
  // While the accordion is open we re-fetch the first page every few seconds
  // and prepend rows we haven't seen yet (keyed by id). This keeps the list
  // feeling live without a server-side event channel.
  //
  // Refs are used so the polling effect can close over the latest filter +
  // loading flag without rebuilding the interval on every state change (which
  // would reset the timer mid-tick and make polling irregular).
  const typeFilterRef = useRef<string>(typeFilter);
  useEffect(() => {
    typeFilterRef.current = typeFilter;
  }, [typeFilter]);
  const statusFilterRef = useRef<string>(statusFilter);
  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);
  const timeWindowRef = useRef<string>(timeWindow);
  useEffect(() => {
    timeWindowRef.current = timeWindow;
  }, [timeWindow]);
  const sortByRef = useRef<ActivitySortBy>(sortBy);
  useEffect(() => {
    sortByRef.current = sortBy;
  }, [sortBy]);
  const sortDirRef = useRef<ActivitySortDir>(sortDir);
  useEffect(() => {
    sortDirRef.current = sortDir;
  }, [sortDir]);
  const loadingRef = useRef<boolean>(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const pollActivityLog = useCallback(async () => {
    // Yield to user-initiated fetches so we don't prepend rows mid-scroll
    // or clobber a "Load more" result that's still in flight.
    if (loadingRef.current) {
      return;
    }
    try {
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE));
      params.set("offset", "0");
      applyActivityQueryParams(params, {
        type: typeFilterRef.current,
        status: statusFilterRef.current,
        timeWindow: timeWindowRef.current,
        sortBy: sortByRef.current,
        sortDir: sortDirRef.current,
      });
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as {
        rows?: ActivityLogRow[];
        total?: number;
      };
      const fresh = Array.isArray(data.rows) ? data.rows : [];
      const nextTotal =
        typeof data.total === "number" ? data.total : fresh.length;
      // `total` may legitimately decrease (retention trims the table at
      // 2,000 rows), so we always sync the footer to the server's latest.
      setTotal(nextTotal);
      setLog((prev) => {
        if (prev === null) {
          return prev;
        }
        const existingIds = new Set(prev.map((r) => r.id));
        const newOnly = fresh.filter((r) => !existingIds.has(r.id));
        if (newOnly.length === 0) {
          return prev;
        }
        // Fire the visual pulse from within the state updater so we only
        // flash when a prepend actually happens.
        setFlashing(true);
        return [...newOnly, ...prev];
      });
    } catch {
      // Swallow transient polling errors — the "↻ Refresh" button is still
      // available if the connection stays down, and noisy console logs on
      // every failed tick would bury real problems.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyActivityQueryParams is stable from closure
  }, []);

  // Boolean gate rather than depending on `log` directly — otherwise
  // the effect tears down and resets the timer on every successful prepend.
  const logLoaded = log !== null;

  // Auto-clear the "just-pulsed" flash ~1.2s after the most recent prepend.
  // Decoupled from the polling effect so rapid back-to-back arrivals still
  // reset the timer cleanly without disturbing the interval.
  useEffect(() => {
    if (!flashing) {
      return;
    }
    const t = window.setTimeout(() => setFlashing(false), 1200);
    return () => window.clearTimeout(t);
  }, [flashing]);

  useEffect(() => {
    if (!(open && logLoaded) || livePaused) {
      return;
    }
    const tick = () => {
      // Hidden tabs: skip the fetch but keep the interval ticking so we
      // resume immediately on visibility change (via the listener below).
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void pollActivityLog();
    };
    const interval = window.setInterval(tick, ACTIVITY_POLL_MS);
    // Immediate catch-up poll when the tab regains focus so the list
    // reflects anything that landed while we were backgrounded.
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void pollActivityLog();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open, logLoaded, livePaused, pollActivityLog]);

  return {
    log,
    loading,
    hasMore,
    total,
    typeFilter,
    setTypeFilter,
    statusFilter,
    setStatusFilter,
    timeWindow,
    setTimeWindow,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    expandedId,
    setExpandedId,
    open,
    setOpen,
    livePaused,
    setLivePaused,
    flashing,
    load,
  };
}
