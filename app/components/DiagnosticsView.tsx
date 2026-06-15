"use client";

/**
 * DiagnosticsView — live runtime metrics dashboard.
 *
 * Layered design so one page serves three audiences:
 *
 *   1. End users — top status banner rolls every signal up to a single
 *      green / yellow / red verdict ("Healthy" / "Some warnings" /
 *      "Issues detected") with one-line plain-English summaries.
 *   2. Developers debugging — dense numeric cards underneath. p50/p95/p99
 *      event-loop, V8 heap, page faults, slow-query log, DB pragmas,
 *      disk usage, background-job state, rate-limit cooldowns,
 *      feature-flag drift, and a rolling error tail.
 *   3. Support tickets — a Copy diagnostics button calls
 *      /api/diagnostics/bundle and writes the full snapshot to the
 *      clipboard so users can paste it into a GitHub issue without
 *      hunting through the page.
 *
 * Polling cadence:
 *   - Runtime metrics — every {@link RUNTIME_POLL_MS} (2 s); event-loop
 *     lag is the headline "is this app stalling right now" signal.
 *   - DB / disk / errors / jobs / rate limits / flags — every
 *     {@link AUX_POLL_MS} (6 s); less time-critical, cheaper to skip a
 *     beat.
 *
 * Sparklines are populated client-side from the rolling runtime polls
 * — we keep up to {@link HISTORY_CAP} samples in component state. No
 * server-side time series; the rolling window is enough for "is it
 * trending the wrong way *right now*".
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ClientDiagnosticsSnapshot,
  clearClientDiagnostics,
  snapshotClientDiagnostics,
} from "@/lib/client-diagnostics";
import {
  DIAGNOSTICS_RELATIVE_TIERS,
  formatRelativeTime,
} from "@/lib/relative-time";
import Sparkline from "./Sparkline";

const RUNTIME_POLL_MS = 2000;
const AUX_POLL_MS = 6000;
/** Approximately 60 s of runtime samples at the 2 s cadence. */
const HISTORY_CAP = 30;

// ── Type contracts (matching the API responses) ───────────────────────

interface SlowQueryRecord {
  at: number;
  durationMs: number;
  error?: string;
  method: "all" | "get" | "run" | "iterate";
  paramCount: number;
  sql: string;
}

interface RuntimeMetrics {
  /** Server-side ring of recent API request timings, surfaced alongside
   *  slow queries so the user can see "the import-queue POST took 4s". */
  apiTimings?: {
    thresholdMs: number;
    totalSinceStart: number;
    slowSinceStart: number;
    recent: ApiTimingRecord[];
  };
  dbWorker?: DbWorkerTimings;
  eventLoop: {
    windowSeconds: number;
    samples: number;
    minMs: number;
    meanMs: number;
    maxMs: number;
    stddevMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    severity: "ok" | "warn" | "danger";
  } | null;
  generatedAt: string;
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  resourceUsage: {
    userCpuSeconds: number;
    systemCpuSeconds: number;
    maxRssMb: number;
    minorPageFaults: number;
    majorPageFaults: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
  /** Live + recent App Store scrape attempts with per-phase timings. */
  scrapeActivity?: {
    totalSinceStart: number;
    inProgress: InProgressScrape[];
    recent: ScrapeRecord[];
  };
  slowQueries: {
    thresholdMs: number;
    totalSinceStart: number;
    profilingEnabled: boolean;
    recent: SlowQueryRecord[];
  };
  uptimeSeconds: number;
  v8Heap: {
    totalHeapSizeMb: number;
    usedHeapSizeMb: number;
    heapSizeLimitMb: number;
    mallocedMemoryMb: number;
    externalMemoryMb: number;
    heapFractionUsed: number;
  };
}

interface ApiTimingRecord {
  at: number;
  durationMs: number;
  error?: string;
  method: string;
  route: string;
  status: number;
}

interface DbWorkerTimingRecord {
  at: number;
  chunkSize: number | "infinity";
  durationMs: number;
  error?: string;
  failedAtIndex?: number;
  inline: boolean;
  outcome: "ok" | "error";
  statementCount: number;
  totalChanges: number;
  workerDurationMs?: number;
}

interface DbWorkerTimings {
  failedSinceStart: number;
  inlineSinceStart: number;
  pendingRequests: number;
  recent: DbWorkerTimingRecord[];
  totalSinceStart: number;
  workerCached: boolean;
  workerDisabled: boolean;
  workerEnabled: boolean;
}

interface ScrapePhaseMark {
  atOffsetMs: number;
  phase: string;
}

interface InProgressScrape {
  id: string;
  phases: ScrapePhaseMark[];
  resync: boolean;
  runningMs: number;
  startedAt: number;
  url: string;
}

interface ScrapeRecord {
  appName?: string;
  error?: string;
  id: string;
  outcome: "success" | "error" | "rate_limited";
  phases: ScrapePhaseMark[];
  resync: boolean;
  startedAt: number;
  totalMs: number;
  url: string;
}

interface DatabaseHealth {
  busyTimeoutMs: number;
  fileBytes: number;
  foreignKeysEnabled: 0 | 1;
  freelistCount: number;
  integrityCheck: {
    status: "ok" | "error";
    detail?: string;
    checkedAt: number;
    durationMs: number;
  } | null;
  journalMode: string;
  pageCount: number;
  pageSize: number;
  path: string;
  shmBytes: number;
  utilisationPct: number;
  walAutocheckpoint: number;
  walBytes: number;
}

interface DiskSnapshot {
  backupSnapshotCount: number;
  dataDir: string;
  dataDirBytes: number;
  files: { db: number; wal: number; shm: number; backups: number };
  freeBytes: number;
  freePct: number;
  lastBackupSnapshotAt: number | null;
  totalBytes: number;
}

interface ErrorLogEntry {
  at: number;
  level: "error" | "warn";
  message: string;
  truncated: boolean;
}

interface ActiveJobs {
  policy: ActiveJobView;
  serverNow?: number;
  sync: ActiveJobView;
  wayback: ActiveJobView;
}
interface ActiveJobView {
  currentAppName: string | null;
  initiator: "manual" | "scheduled" | "automatic" | "resume" | null;
  mutexHeld: boolean;
  running: boolean;
  stale: boolean;
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    done: number;
    failed: number;
    remaining: number;
  } | null;
}

interface RateLimitCategoryState {
  bucketCapacity?: number;
  bucketTokens?: number;
  category: "search" | "scrape";
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  reason: string | null;
  resumeAt: number | null;
}
interface RateLimits {
  scrape: RateLimitCategoryState;
  search: RateLimitCategoryState;
  serverNow: number;
}

interface FlagRow {
  currentValue: string;
  hardDefault: string;
  key: string;
  override: string | null;
  surface: string;
  wired: boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────

/** Minimal translator shape so the formatting helpers stay outside the
 *  component tree. Callers pass a `diagnostics_page.format`-scoped
 *  translator from useTranslations. Numeric values are pre-stringified
 *  before interpolation so ICU number formatting (locale grouping)
 *  can't alter the output. */
type FormatTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) {
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins.toString().padStart(2, "0")}m`;
}

function formatRelative(t: FormatTranslator, at: number): string {
  return formatRelativeTime(t, at, DIAGNOSTICS_RELATIVE_TIERS, {
    stringify: true,
  });
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  if (value === 0) {
    return "0";
  }
  if (value < 1) {
    return value.toFixed(2);
  }
  if (value < 100) {
    return value.toFixed(1);
  }
  return Math.round(value).toString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(t: FormatTranslator, ms: number): string {
  if (ms < 1000) {
    return t("duration_ms", { value: String(Math.round(ms)) });
  }
  if (ms < 60_000) {
    return t("duration_s", { value: (ms / 1000).toFixed(1) });
  }
  return t("duration_min", { value: String(Math.round(ms / 60_000)) });
}

// ── Status rollup ─────────────────────────────────────────────────────

type Severity = "ok" | "warn" | "danger";

/** Structured status note. Key is a translation key under
 *  `diagnostics_page.banner`; `params` is the ICU placeholder map.
 *  The banner component looks them up via t() so the rollup itself
 *  stays pure logic + free of useTranslations boilerplate. */
interface StatusNote {
  key: string;
  params?: Record<string, string | number>;
}
interface StatusSummary {
  notes: StatusNote[];
  overall: Severity;
}

/**
 * Roll the available signals up into a single severity + a short list of
 * note keys. Conservative: any one signal in `danger` makes the whole
 * banner red; any one in `warn` makes it yellow.
 */
function rollupStatus(
  state: {
    runtime: RuntimeMetrics | null;
    database: DatabaseHealth | null;
    disk: DiskSnapshot | null;
    errors: ErrorLogEntry[];
    jobs: ActiveJobs | null;
    rateLimits: RateLimits | null;
  },
  tFormat: FormatTranslator
): StatusSummary {
  const notes: StatusNote[] = [];
  let overall: Severity = "ok";
  const bump = (sev: Severity) => {
    if (sev === "danger" || (sev === "warn" && overall === "ok")) {
      overall = sev;
    }
  };

  if (state.runtime) {
    if (state.runtime.eventLoop && state.runtime.eventLoop.severity !== "ok") {
      bump(state.runtime.eventLoop.severity);
      notes.push({
        key:
          state.runtime.eventLoop.severity === "danger"
            ? "event_loop_danger"
            : "event_loop_warn",
        params: { p99: formatMs(state.runtime.eventLoop.p99Ms) },
      });
    }
    if (state.runtime.v8Heap.heapFractionUsed >= 0.85) {
      bump("danger");
      notes.push({
        key: "heap_full",
        params: {
          pct: Math.round(state.runtime.v8Heap.heapFractionUsed * 100),
        },
      });
    } else if (state.runtime.v8Heap.heapFractionUsed >= 0.7) {
      bump("warn");
    }
    if (state.runtime.resourceUsage.majorPageFaults >= 1000) {
      bump("danger");
      notes.push({ key: "swapping" });
    }
  }

  if (state.disk) {
    if (state.disk.totalBytes > 0 && state.disk.freePct < 5) {
      bump("danger");
      notes.push({
        key: "disk_critical",
        params: { free: formatBytes(state.disk.freeBytes) },
      });
    } else if (state.disk.totalBytes > 0 && state.disk.freePct < 10) {
      bump("warn");
      notes.push({ key: "disk_low", params: { pct: state.disk.freePct } });
    }
  }

  if (state.database?.integrityCheck?.status === "error") {
    bump("danger");
    const detail = state.database.integrityCheck.detail;
    notes.push(
      detail
        ? {
            key: "integrity_failed_with_detail",
            params: { detail: detail.slice(0, 120) },
          }
        : { key: "integrity_failed_no_detail" }
    );
  }

  if (state.rateLimits) {
    const rl = state.rateLimits;
    const stuck = (["search", "scrape"] as const).filter(
      (c) => rl[c].cooldownActive
    );
    if (stuck.length) {
      bump("warn");
      notes.push({
        key: "rate_limited",
        params: {
          cats: stuck.join(" + "),
          remaining: stuck
            .map((c) => formatDuration(tFormat, rl[c].cooldownRemainingMs))
            .join(" / "),
        },
      });
    }
  }

  if (state.errors.length > 0) {
    const recentErrors = state.errors.filter(
      (e) => e.level === "error" && Date.now() - e.at < 5 * 60_000
    );
    if (recentErrors.length >= 5) {
      bump("warn");
      notes.push({
        key: "errors_recent",
        params: { count: recentErrors.length },
      });
    }
  }

  if (notes.length === 0) {
    notes.push({ key: "no_issues" });
  }

  return { overall, notes };
}

async function fetchMergedDiagnosticsBundle(): Promise<string> {
  const r = await fetch("/api/diagnostics/bundle", { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}`);
  }
  const serverBundle = (await r.json()) as Record<string, unknown>;
  const clientSnapshot = snapshotClientDiagnostics();
  const merged = {
    ...serverBundle,
    clientDiagnostics: {
      ...clientSnapshot,
      capturedFromPath: window.location.pathname,
      browserGeneratedAt: new Date().toISOString(),
    },
  };
  return JSON.stringify(merged, null, 2);
}

// ── Top-level component ────────────────────────────────────────────────

export default function DiagnosticsView() {
  const t = useTranslations("diagnostics_page");
  const tToolbar = useTranslations("diagnostics_page.toolbar");
  const tErrors = useTranslations("diagnostics_page.errors");
  const tFormat = useTranslations("diagnostics_page.format");

  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [database, setDatabase] = useState<DatabaseHealth | null>(null);
  const [disk, setDisk] = useState<DiskSnapshot | null>(null);
  const [errors, setErrors] = useState<ErrorLogEntry[]>([]);
  const [jobs, setJobs] = useState<ActiveJobs | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(null);
  const [flagOverrides, setFlagOverrides] = useState<FlagRow[]>([]);

  // Client-side diagnostics — read directly from the in-process module
  // (no HTTP roundtrip needed since DiagnosticsView is itself a client
  // component running in the same context that buffers the rings).
  const [clientDiag, setClientDiag] =
    useState<ClientDiagnosticsSnapshot | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState<
    "clear" | "profile" | "integrity" | "copy" | null
  >(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");

  // Rolling histories for sparklines. Each entry is one runtime poll.
  const [history, setHistory] = useState<{
    p99: number[];
    rssMb: number[];
    heapPct: number[];
    cpuPct: number[];
  }>({ p99: [], rssMb: [], heapPct: [], cpuPct: [] });

  const inflightRuntimeRef = useRef(false);
  const inflightAuxRef = useRef(false);
  // Last time a runtime poll completed successfully. When this gets stale
  // (>15s), the page renders a "server unresponsive" banner — the most
  // useful signal during an import-hang since the server can't answer
  // /api/diagnostics/runtime while it's busy holding the DB lock.
  const [lastRuntimeAt, setLastRuntimeAt] = useState<number | null>(null);
  const [serverStallMs, setServerStallMs] = useState(0);

  // ── Fetchers ────────────────────────────────────────────────────────

  const fetchRuntime = useCallback(async () => {
    if (inflightRuntimeRef.current) {
      return;
    }
    inflightRuntimeRef.current = true;
    // Short deadline so a hung server doesn't stall the polling loop
    // forever — the inflight guard would otherwise lock subsequent ticks
    // out. AbortController + a timer keeps the failure visible.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      const r = await fetch("/api/diagnostics/runtime", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const body = (await r.json()) as RuntimeMetrics;
      setMetrics(body);
      setError(null);
      setLastRuntimeAt(Date.now());
      setServerStallMs(0);

      // Append to sparkline history. Cap to HISTORY_CAP so the buffer
      // doesn't grow without bound during long sessions.
      const cpuPct =
        body.uptimeSeconds > 0
          ? Math.min(
              100,
              ((body.resourceUsage.userCpuSeconds +
                body.resourceUsage.systemCpuSeconds) /
                body.uptimeSeconds) *
                100
            )
          : 0;
      setHistory((prev) => ({
        p99: [...prev.p99, body.eventLoop?.p99Ms ?? 0].slice(-HISTORY_CAP),
        rssMb: [...prev.rssMb, body.memory.rssMb].slice(-HISTORY_CAP),
        heapPct: [
          ...prev.heapPct,
          Math.round(body.v8Heap.heapFractionUsed * 100),
        ].slice(-HISTORY_CAP),
        cpuPct: [...prev.cpuPct, cpuPct].slice(-HISTORY_CAP),
      }));
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? tErrors("runtime_poll_timeout")
            : e.message
          : tErrors("fetch_failed");
      setError(msg);
      if (lastRuntimeAt) {
        setServerStallMs(Date.now() - lastRuntimeAt);
      }
    } finally {
      clearTimeout(deadline);
      inflightRuntimeRef.current = false;
    }
  }, [lastRuntimeAt]);

  /** Fetch every "auxiliary" (slower-cadence) endpoint in parallel. We
   *  catch each independently so a single broken subsystem doesn't blank
   *  the rest of the dashboard. */
  const fetchAuxiliary = useCallback(async () => {
    if (inflightAuxRef.current) {
      return;
    }
    inflightAuxRef.current = true;
    try {
      const settled = await Promise.allSettled([
        fetch("/api/diagnostics/database", { cache: "no-store" }).then((r) =>
          r.ok
            ? (r.json() as Promise<DatabaseHealth>)
            : Promise.reject(new Error(`db HTTP ${r.status}`))
        ),
        fetch("/api/diagnostics/disk", { cache: "no-store" }).then((r) =>
          r.ok
            ? (r.json() as Promise<DiskSnapshot>)
            : Promise.reject(new Error(`disk HTTP ${r.status}`))
        ),
        fetch("/api/diagnostics/errors?limit=50", { cache: "no-store" }).then(
          (r) =>
            r.ok
              ? (r.json() as Promise<{
                  entries: ErrorLogEntry[];
                  capacity: number;
                }>)
              : Promise.reject(new Error(`errors HTTP ${r.status}`))
        ),
        fetch("/api/tasks/active", { cache: "no-store" }).then((r) =>
          r.ok
            ? (r.json() as Promise<ActiveJobs>)
            : Promise.reject(new Error(`jobs HTTP ${r.status}`))
        ),
        fetch("/api/rate-limit/status", { cache: "no-store" }).then((r) =>
          r.ok
            ? (r.json() as Promise<RateLimits>)
            : Promise.reject(new Error(`rate HTTP ${r.status}`))
        ),
        fetch("/api/feature-flags", { cache: "no-store" }).then((r) =>
          r.ok
            ? (r.json() as Promise<{ flags: FlagRow[] }>)
            : Promise.reject(new Error(`flags HTTP ${r.status}`))
        ),
      ]);
      if (settled[0].status === "fulfilled") {
        setDatabase(settled[0].value);
      }
      if (settled[1].status === "fulfilled") {
        setDisk(settled[1].value);
      }
      if (settled[2].status === "fulfilled") {
        setErrors(settled[2].value.entries);
      }
      if (settled[3].status === "fulfilled") {
        setJobs(settled[3].value);
      }
      if (settled[4].status === "fulfilled") {
        setRateLimits(settled[4].value);
      }
      if (settled[5].status === "fulfilled") {
        // Only surface flags whose current value differs from the
        // hard default — the full list is long and the diff is what
        // matters for "why is feature X behaving oddly".
        const diffs = settled[5].value.flags.filter(
          (f) => f.currentValue !== f.hardDefault || f.override !== null
        );
        setFlagOverrides(diffs);
      }
    } finally {
      inflightAuxRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchRuntime();
    void fetchAuxiliary();
    setClientDiag(snapshotClientDiagnostics());
  }, [fetchRuntime, fetchAuxiliary]);

  // Client-diagnostics poll — same cadence as the runtime poll, but the
  // snapshot is synchronous so we don't need an in-flight guard. Paused
  // alongside the rest of the dashboard.
  useEffect(() => {
    if (paused) {
      return;
    }
    const id = setInterval(() => {
      setClientDiag(snapshotClientDiagnostics());
    }, RUNTIME_POLL_MS);
    return () => clearInterval(id);
  }, [paused]);

  // Runtime poll
  useEffect(() => {
    if (paused) {
      return;
    }
    const id = window.setInterval(() => {
      void fetchRuntime();
    }, RUNTIME_POLL_MS);
    return () => window.clearInterval(id);
  }, [paused, fetchRuntime]);

  // Auxiliary poll
  useEffect(() => {
    if (paused) {
      return;
    }
    const id = window.setInterval(() => {
      void fetchAuxiliary();
    }, AUX_POLL_MS);
    return () => window.clearInterval(id);
  }, [paused, fetchAuxiliary]);

  // ── Actions ─────────────────────────────────────────────────────────

  const handleClear = useCallback(async () => {
    setBusy("clear");
    try {
      const [runtimeRes, errorsRes] = await Promise.all([
        fetch("/api/diagnostics/runtime", { method: "DELETE" }),
        fetch("/api/diagnostics/errors", { method: "DELETE" }),
      ]);
      if (runtimeRes.ok) {
        const body = (await runtimeRes.json()) as RuntimeMetrics;
        setMetrics(body);
        // Also reset client-side sparkline history so the line restarts
        // from the moment the user clicked Clear.
        setHistory({ p99: [], rssMb: [], heapPct: [], cpuPct: [] });
        setError(null);
      } else {
        setError(tErrors("clear_failed_http", { status: runtimeRes.status }));
      }
      if (errorsRes.ok) {
        const body = (await errorsRes.json()) as { entries: ErrorLogEntry[] };
        setErrors(body.entries);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : tErrors("clear_failed"));
    } finally {
      setBusy(null);
    }
  }, []);

  const handleToggleProfiling = useCallback(async () => {
    if (!metrics) {
      return;
    }
    setBusy("profile");
    try {
      const r = await fetch("/api/diagnostics/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profilingEnabled: !metrics.slowQueries.profilingEnabled,
        }),
      });
      if (r.ok) {
        const body = (await r.json()) as RuntimeMetrics;
        setMetrics(body);
      } else {
        setError(tErrors("toggle_failed_http", { status: r.status }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : tErrors("toggle_failed"));
    } finally {
      setBusy(null);
    }
  }, [metrics]);

  const handleIntegrityCheck = useCallback(async () => {
    setBusy("integrity");
    try {
      const r = await fetch("/api/diagnostics/database", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runIntegrityCheck: true }),
      });
      if (r.ok) {
        const body = (await r.json()) as DatabaseHealth;
        setDatabase(body);
      } else {
        setError(tErrors("integrity_check_failed_http", { status: r.status }));
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : tErrors("integrity_check_failed")
      );
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * Download the bundle as a `.json` file. Fetches the same blob the
   * Copy button uses, wraps it in a Blob URL, and clicks a synthetic
   * `<a download>`. More reliable than `window.open` because the
   * server returns `application/json` (no Content-Disposition), which
   * browsers render inline rather than save.
   */
  const handleDownloadBundle = useCallback(async () => {
    try {
      const json = await fetchMergedDiagnosticsBundle();
      setClientDiag(snapshotClientDiagnostics());
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privacytracker-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a short delay so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : tErrors("download_failed"));
    }
  }, []);

  const handleCopyBundle = useCallback(async () => {
    setBusy("copy");
    setCopyState("idle");
    try {
      const json = await fetchMergedDiagnosticsBundle();
      setClientDiag(snapshotClientDiagnostics());
      // navigator.clipboard requires HTTPS or localhost; both apply here.
      // Fallback to a hidden textarea + execCommand only if the API is
      // missing — Safari < 13 / very old browsers.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      } else {
        const ta = document.createElement("textarea");
        ta.value = json;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 2500);
    } catch (e) {
      setCopyState("err");
      setError(e instanceof Error ? e.message : tErrors("copy_failed"));
      window.setTimeout(() => setCopyState("idle"), 2500);
    } finally {
      setBusy(null);
    }
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────

  const slowSorted = useMemo(() => {
    if (!metrics) {
      return [];
    }
    return [...metrics.slowQueries.recent].sort((a, b) => b.at - a.at);
  }, [metrics]);

  const status = useMemo(
    () =>
      rollupStatus(
        {
          runtime: metrics,
          database,
          disk,
          errors,
          jobs,
          rateLimits,
        },
        tFormat
      ),
    [metrics, database, disk, errors, jobs, rateLimits]
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="page-container diagnostics-page">
      <div className="page-header diagnostics-header">
        <div>
          <h1 className="page-title">{t("title")}</h1>
          <p className="page-subtitle">
            {t("subtitle", { seconds: Math.round(RUNTIME_POLL_MS / 1000) })}
          </p>
        </div>
        <div className="diagnostics-toolbar">
          <button
            className="btn btn-secondary"
            disabled={busy === "copy"}
            onClick={() => {
              void handleCopyBundle();
            }}
            title={tToolbar("copy_title")}
            type="button"
          >
            {copyState === "ok"
              ? tToolbar("copied")
              : copyState === "err"
                ? tToolbar("copy_failed")
                : busy === "copy"
                  ? tToolbar("copying")
                  : tToolbar("copy")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              void handleDownloadBundle();
            }}
            title={tToolbar("download_title")}
            type="button"
          >
            {tToolbar("download")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setPaused((p) => !p)}
            title={paused ? tToolbar("resume_title") : tToolbar("pause_title")}
            type="button"
          >
            {paused ? tToolbar("resume") : tToolbar("pause")}
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy === "clear"}
            onClick={() => {
              void handleClear();
            }}
            title={tToolbar("clear_title")}
            type="button"
          >
            {busy === "clear" ? tToolbar("clearing") : tToolbar("clear")}
          </button>
        </div>
      </div>

      <StatusBanner summary={status} />

      {/* Server-unresponsive banner. If runtime polls have stopped landing
          for >15s, the Node sidecar is likely blocked on something (DB
          lock during a scrape commit is the usual suspect). Banner stays
          up until a fresh poll succeeds. */}
      {serverStallMs > 15_000 && (
        <div
          aria-live="polite"
          className="diagnostics-error"
          role="status"
          style={{
            background:
              "var(--orange-dim, color-mix(in srgb, var(--orange) 18%, transparent))",
            color: "var(--orange)",
          }}
        >
          {t("stall_banner", {
            seconds: Math.round(serverStallMs / 1000),
            time: lastRuntimeAt
              ? formatRelative(tFormat, lastRuntimeAt)
              : t("stall_banner_earlier_poll"),
          })}
        </div>
      )}

      {error && (
        <div className="diagnostics-error" role="alert">
          {error}
        </div>
      )}

      {metrics ? (
        <div className="diagnostics-grid">
          <EventLoopCard
            eventLoop={metrics.eventLoop}
            history={history.p99}
            uptimeSeconds={metrics.uptimeSeconds}
          />
          <MemoryCard
            historyHeap={history.heapPct}
            historyRss={history.rssMb}
            memory={metrics.memory}
            v8Heap={metrics.v8Heap}
          />
          <ResourceCard
            historyCpu={history.cpuPct}
            resourceUsage={metrics.resourceUsage}
            uptimeSeconds={metrics.uptimeSeconds}
          />
          <DatabaseCard
            busy={busy === "integrity"}
            database={database}
            onRunIntegrityCheck={() => {
              void handleIntegrityCheck();
            }}
          />
          <DiskCard disk={disk} />
          <BackgroundJobsCard jobs={jobs} />
          <RateLimitsCard rateLimits={rateLimits} />
          <SlowQueryCard
            busy={busy === "profile"}
            onToggleProfiling={() => {
              void handleToggleProfiling();
            }}
            recent={slowSorted}
            slowQueries={metrics.slowQueries}
          />
          {metrics.scrapeActivity && (
            <ScrapeActivityCard activity={metrics.scrapeActivity} />
          )}
          {metrics.apiTimings && (
            <ApiTimingsCard timings={metrics.apiTimings} />
          )}
          {metrics.dbWorker && <DbWorkerCard timings={metrics.dbWorker} />}
          {clientDiag && (
            <ClientActivityCard
              onClear={() => {
                clearClientDiagnostics();
                setClientDiag(snapshotClientDiagnostics());
              }}
              snapshot={clientDiag}
            />
          )}
          <ErrorLogCard entries={errors} />
          <FlagsCard rows={flagOverrides} />
        </div>
      ) : (
        <div className="empty-state" style={{ padding: 32 }}>
          {t("loading_runtime")}
        </div>
      )}
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────

function StatusBanner({ summary }: { summary: StatusSummary }) {
  const t = useTranslations("diagnostics_page.banner");
  const heading =
    summary.overall === "danger"
      ? t("issues_detected")
      : summary.overall === "warn"
        ? t("some_warnings")
        : t("healthy");
  return (
    <section
      aria-live="polite"
      className={`diagnostics-status diagnostics-status--${summary.overall}`}
      role="status"
    >
      <div className="diagnostics-status-head">
        <span aria-hidden="true" className="diagnostics-status-dot" />
        <h2 className="diagnostics-status-title">{heading}</h2>
      </div>
      <ul className="diagnostics-status-notes">
        {summary.notes.map((note, i) => (
          // The cast is unfortunate but next-intl's `t()` types reject
          // dynamic keys without it. The keys come from rollupStatus
          // which is the only producer, so the runtime guarantee
          // matches the type intent.
          <li key={i}>{t(note.key as never, note.params as never)}</li>
        ))}
      </ul>
    </section>
  );
}

function EventLoopCard({
  eventLoop,
  uptimeSeconds,
  history,
}: {
  eventLoop: RuntimeMetrics["eventLoop"];
  uptimeSeconds: number;
  history: number[];
}) {
  const t = useTranslations("diagnostics_page.card_event_loop");
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      {eventLoop ? (
        <>
          <div className="diagnostics-metric-row diagnostics-metric-row--hero">
            <div className="diagnostics-metric">
              <span className="diagnostics-metric-label">{t("p99")}</span>
              <span
                className={`diagnostics-metric-value diagnostics-severity-${eventLoop.severity}`}
              >
                {formatMs(eventLoop.p99Ms)}
                <small>ms</small>
              </span>
              <Sparkline
                ariaLabel={t("spark_label", {
                  seconds: (HISTORY_CAP * RUNTIME_POLL_MS) / 1000,
                })}
                severity={eventLoop.severity}
                values={history}
              />
            </div>
            <SeverityBadge severity={eventLoop.severity} />
          </div>
          <dl className="diagnostics-kvs">
            <KV label={t("p50")} value={`${formatMs(eventLoop.p50Ms)} ms`} />
            <KV label={t("p95")} value={`${formatMs(eventLoop.p95Ms)} ms`} />
            <KV label={t("mean")} value={`${formatMs(eventLoop.meanMs)} ms`} />
            <KV label={t("max")} value={`${formatMs(eventLoop.maxMs)} ms`} />
            <KV
              label={t("stddev")}
              value={`${formatMs(eventLoop.stddevMs)} ms`}
            />
            <KV
              label={t("window")}
              value={`${formatUptime(eventLoop.windowSeconds)}`}
            />
            <KV
              label={t("samples")}
              value={eventLoop.samples.toLocaleString()}
            />
            <KV label={t("uptime")} value={formatUptime(uptimeSeconds)} />
          </dl>
        </>
      ) : (
        <div className="diagnostics-empty">{t("no_samples")}</div>
      )}
    </section>
  );
}

function MemoryCard({
  memory,
  v8Heap,
  historyRss,
  historyHeap,
}: {
  memory: RuntimeMetrics["memory"];
  v8Heap: RuntimeMetrics["v8Heap"];
  historyRss: number[];
  historyHeap: number[];
}) {
  const t = useTranslations("diagnostics_page.card_memory");
  const heapPct = Math.round(v8Heap.heapFractionUsed * 100);
  const heapSeverity: Severity =
    v8Heap.heapFractionUsed >= 0.85
      ? "danger"
      : v8Heap.heapFractionUsed >= 0.7
        ? "warn"
        : "ok";
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("rss")}</span>
          <span className="diagnostics-metric-value">
            {memory.rssMb}
            <small>MB</small>
          </span>
          <Sparkline ariaLabel={t("spark_rss")} values={historyRss} />
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("v8_heap")}</span>
          <span
            className={`diagnostics-metric-value diagnostics-severity-${heapSeverity}`}
          >
            {heapPct}
            <small>%</small>
          </span>
          <Sparkline
            ariaLabel={t("spark_heap")}
            severity={heapSeverity}
            values={historyHeap}
          />
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t("heap_used")} value={`${memory.heapUsedMb} MB`} />
        <KV label={t("heap_total")} value={`${memory.heapTotalMb} MB`} />
        <KV label={t("heap_limit")} value={`${v8Heap.heapSizeLimitMb} MB`} />
        <KV label={t("external")} value={`${memory.externalMb} MB`} />
        <KV label={t("array_buffers")} value={`${memory.arrayBuffersMb} MB`} />
        <KV label={t("malloced")} value={`${v8Heap.mallocedMemoryMb} MB`} />
      </dl>
    </section>
  );
}

function ResourceCard({
  resourceUsage,
  uptimeSeconds,
  historyCpu,
}: {
  resourceUsage: RuntimeMetrics["resourceUsage"];
  uptimeSeconds: number;
  historyCpu: number[];
}) {
  const t = useTranslations("diagnostics_page.card_resource");
  const cpuPct =
    uptimeSeconds > 0
      ? Math.round(
          ((resourceUsage.userCpuSeconds + resourceUsage.systemCpuSeconds) /
            uptimeSeconds) *
            100
        )
      : 0;
  const majorFaultsSeverity: Severity =
    resourceUsage.majorPageFaults >= 1000
      ? "danger"
      : resourceUsage.majorPageFaults >= 100
        ? "warn"
        : "ok";
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("avg_cpu")}</span>
          <span className="diagnostics-metric-value">
            {cpuPct}
            <small>%</small>
          </span>
          <Sparkline ariaLabel={t("spark_cpu")} values={historyCpu} />
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("major_faults")}</span>
          <span
            className={`diagnostics-metric-value diagnostics-severity-${majorFaultsSeverity}`}
          >
            {resourceUsage.majorPageFaults.toLocaleString()}
          </span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV
          label={t("user_cpu")}
          value={`${resourceUsage.userCpuSeconds.toFixed(1)} s`}
        />
        <KV
          label={t("system_cpu")}
          value={`${resourceUsage.systemCpuSeconds.toFixed(1)} s`}
        />
        <KV label={t("peak_rss")} value={`${resourceUsage.maxRssMb} MB`} />
        <KV
          label={t("minor_faults")}
          value={resourceUsage.minorPageFaults.toLocaleString()}
        />
        <KV
          label={t("vol_ctx_sw")}
          value={resourceUsage.voluntaryContextSwitches.toLocaleString()}
        />
        <KV
          label={t("invol_ctx_sw")}
          value={resourceUsage.involuntaryContextSwitches.toLocaleString()}
        />
      </dl>
    </section>
  );
}

function DatabaseCard({
  database,
  busy,
  onRunIntegrityCheck,
}: {
  database: DatabaseHealth | null;
  busy: boolean;
  onRunIntegrityCheck: () => void;
}) {
  const t = useTranslations("diagnostics_page.card_database");
  const tLoad = useTranslations("diagnostics_page");
  const tFormat = useTranslations("diagnostics_page.format");
  if (!database) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t("title")}</h2>
          <p className="diagnostics-card-help">{t("subtitle_loading")}</p>
        </header>
        <div className="diagnostics-empty">{tLoad("loading")}</div>
      </section>
    );
  }
  const fragSeverity: Severity = database.utilisationPct < 60 ? "warn" : "ok";
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("file_size")}</span>
          <span className="diagnostics-metric-value">
            {formatBytes(database.fileBytes)}
          </span>
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("utilisation")}</span>
          <span
            className={`diagnostics-metric-value diagnostics-severity-${fragSeverity}`}
          >
            {database.utilisationPct}
            <small>%</small>
          </span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t("wal")} value={formatBytes(database.walBytes)} />
        <KV label={t("shm")} value={formatBytes(database.shmBytes)} />
        <KV label={t("pages")} value={database.pageCount.toLocaleString()} />
        <KV label={t("page_size")} value={formatBytes(database.pageSize)} />
        <KV
          label={t("free_pages")}
          value={database.freelistCount.toLocaleString()}
        />
        <KV label={t("journal")} value={database.journalMode} />
        <KV label={t("busy_timeout")} value={`${database.busyTimeoutMs} ms`} />
        <KV
          label={t("fk_enforcement")}
          value={database.foreignKeysEnabled ? t("fk_on") : t("fk_off")}
        />
      </dl>
      <div className="diagnostics-card-actions">
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={onRunIntegrityCheck}
          title={t("integrity_check_title")}
          type="button"
        >
          {busy ? t("running") : t("run_integrity_check")}
        </button>
        {database.integrityCheck && (
          <span
            className={`diagnostics-pill diagnostics-severity-${database.integrityCheck.status === "ok" ? "ok" : "danger"}`}
            title={database.integrityCheck.detail ?? ""}
          >
            {database.integrityCheck.status === "ok" ? "✓" : "✗"}{" "}
            {database.integrityCheck.status}
            {" · "}
            {formatRelative(tFormat, database.integrityCheck.checkedAt)}
            {" · "}
            {formatDuration(tFormat, database.integrityCheck.durationMs)}
          </span>
        )}
      </div>
    </section>
  );
}

function DiskCard({ disk }: { disk: DiskSnapshot | null }) {
  const t = useTranslations("diagnostics_page.card_disk");
  const tLoad = useTranslations("diagnostics_page");
  const tFormat = useTranslations("diagnostics_page.format");
  if (!disk) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t("title")}</h2>
          <p className="diagnostics-card-help">{t("subtitle_loading")}</p>
        </header>
        <div className="diagnostics-empty">{tLoad("loading")}</div>
      </section>
    );
  }
  const freeSeverity: Severity =
    disk.totalBytes === 0
      ? "ok"
      : disk.freePct < 5
        ? "danger"
        : disk.freePct < 10
          ? "warn"
          : "ok";
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("free")}</span>
          <span
            className={`diagnostics-metric-value diagnostics-severity-${freeSeverity}`}
          >
            {disk.totalBytes > 0 ? `${disk.freePct}%` : tLoad("em_dash")}
          </span>
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t("data_dir")}</span>
          <span className="diagnostics-metric-value">
            {formatBytes(disk.dataDirBytes)}
          </span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t("free_space")} value={formatBytes(disk.freeBytes)} />
        <KV label={t("volume_total")} value={formatBytes(disk.totalBytes)} />
        <KV label={t("db")} value={formatBytes(disk.files.db)} />
        <KV label={t("wal")} value={formatBytes(disk.files.wal)} />
        <KV label={t("shm")} value={formatBytes(disk.files.shm)} />
        <KV label={t("backups_dir")} value={formatBytes(disk.files.backups)} />
        <KV
          label={t("snapshots")}
          value={disk.backupSnapshotCount.toString()}
        />
        <KV
          label={t("last_backup")}
          value={
            disk.lastBackupSnapshotAt
              ? formatRelative(tFormat, disk.lastBackupSnapshotAt)
              : t("last_backup_none")
          }
        />
      </dl>
    </section>
  );
}

function BackgroundJobsCard({ jobs }: { jobs: ActiveJobs | null }) {
  const t = useTranslations("diagnostics_page.card_jobs");
  const tLoad = useTranslations("diagnostics_page");
  if (!jobs) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t("title")}</h2>
          <p className="diagnostics-card-help">{t("subtitle_loading")}</p>
        </header>
        <div className="diagnostics-empty">{tLoad("loading")}</div>
      </section>
    );
  }
  const dash = tLoad("em_dash");
  const rows: Array<{ name: string; view: ActiveJobView }> = [
    { name: t("row_sync"), view: jobs.sync },
    { name: t("row_wayback"), view: jobs.wayback },
    { name: t("row_policy"), view: jobs.policy },
  ];
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>{t("col_job")}</th>
              <th>{t("col_state")}</th>
              <th>{t("col_initiator")}</th>
              <th>{t("col_current")}</th>
              <th>{t("col_progress")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ name, view }) => {
              const stateLabel = view.running
                ? t("state_running")
                : view.stale
                  ? t("state_stale")
                  : t("state_idle");
              const sevCls = view.stale
                ? "diagnostics-severity-danger"
                : view.running
                  ? "diagnostics-severity-warn"
                  : "";
              const progress = view.summary
                ? t("progress_format", {
                    done: view.summary.done,
                    total: view.summary.total,
                    failed: view.summary.failed,
                  })
                : dash;
              return (
                <tr key={name}>
                  <td>{name}</td>
                  <td className={sevCls}>
                    <code>{stateLabel}</code>
                  </td>
                  <td>{view.initiator ?? dash}</td>
                  <td>{view.currentAppName ?? dash}</td>
                  <td>{progress}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RateLimitsCard({ rateLimits }: { rateLimits: RateLimits | null }) {
  const t = useTranslations("diagnostics_page.card_rate_limits");
  const tLoad = useTranslations("diagnostics_page");
  const tFormat = useTranslations("diagnostics_page.format");
  if (!rateLimits) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t("title")}</h2>
          <p className="diagnostics-card-help">{t("subtitle_loading")}</p>
        </header>
        <div className="diagnostics-empty">{tLoad("loading")}</div>
      </section>
    );
  }
  const dash = tLoad("em_dash");
  const cats: Array<{ label: string; v: RateLimitCategoryState }> = [
    { label: t("row_search"), v: rateLimits.search },
    { label: t("row_scrape"), v: rateLimits.scrape },
  ];
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>{t("col_category")}</th>
              <th>{t("col_cooldown")}</th>
              <th>{t("col_remaining")}</th>
              <th>{t("col_bucket")}</th>
              <th>{t("col_reason")}</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(({ label, v }) => (
              <tr key={v.category}>
                <td>{label}</td>
                <td>
                  <code
                    className={
                      v.cooldownActive ? "diagnostics-severity-danger" : ""
                    }
                  >
                    {v.cooldownActive
                      ? t("cooldown_active")
                      : t("cooldown_idle")}
                  </code>
                </td>
                <td>
                  {v.cooldownActive
                    ? formatDuration(tFormat, v.cooldownRemainingMs)
                    : dash}
                </td>
                <td>
                  {typeof v.bucketTokens === "number" &&
                  typeof v.bucketCapacity === "number"
                    ? `${v.bucketTokens.toFixed(1)} / ${v.bucketCapacity}`
                    : dash}
                </td>
                <td className="diagnostics-sql">{v.reason ?? dash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SlowQueryCard({
  slowQueries,
  recent,
  busy,
  onToggleProfiling,
}: {
  slowQueries: RuntimeMetrics["slowQueries"];
  recent: SlowQueryRecord[];
  busy: boolean;
  onToggleProfiling: () => void;
}) {
  const t = useTranslations("diagnostics_page.card_slow_query");
  const tFormat = useTranslations("diagnostics_page.format");
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 className="diagnostics-card-title">
              {t("title")}
              <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
                {t("threshold_pill", { ms: slowQueries.thresholdMs })}
              </span>
            </h2>
            <p className="diagnostics-card-help">
              {t("help", {
                total: slowQueries.totalSinceStart,
                recent: recent.length,
              })}
            </p>
          </div>
          <label className="diagnostics-toggle">
            <input
              checked={slowQueries.profilingEnabled}
              disabled={busy}
              onChange={onToggleProfiling}
              type="checkbox"
            />
            <span>{t("toggle_label")}</span>
          </label>
        </div>
      </header>
      {recent.length === 0 ? (
        <div className="diagnostics-empty">
          {slowQueries.profilingEnabled ? t("no_slow") : t("profiling_off")}
        </div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t("col_time")}</th>
                <th style={{ width: 90 }}>{t("col_duration")}</th>
                <th style={{ width: 70 }}>{t("col_method")}</th>
                <th style={{ width: 70 }}>{t("col_params")}</th>
                <th>{t("col_sql")}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((q, i) => {
                const sevCls =
                  q.durationMs >= 1000
                    ? "diagnostics-severity-danger"
                    : q.durationMs >= 250
                      ? "diagnostics-severity-warn"
                      : "";
                return (
                  <tr key={`${q.at}-${i}`}>
                    <td title={new Date(q.at).toISOString()}>
                      {formatRelative(tFormat, q.at)}
                    </td>
                    <td className={sevCls}>{formatMs(q.durationMs)} ms</td>
                    <td>
                      <code>{q.method}</code>
                    </td>
                    <td>{q.paramCount}</td>
                    <td className="diagnostics-sql">
                      <code>{q.sql}</code>
                      {q.error && (
                        <div className="diagnostics-error-line" role="note">
                          ✗ {q.error}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ErrorLogCard({ entries }: { entries: ErrorLogEntry[] }) {
  const t = useTranslations("diagnostics_page.card_error_log");
  const tFormat = useTranslations("diagnostics_page.format");
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">
          {t("help", { count: entries.length })}
        </p>
      </header>
      {entries.length === 0 ? (
        <div className="diagnostics-empty">{t("no_errors")}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t("col_time")}</th>
                <th style={{ width: 70 }}>{t("col_level")}</th>
                <th>{t("col_message")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td title={new Date(e.at).toISOString()}>
                    {formatRelative(tFormat, e.at)}
                  </td>
                  <td>
                    <code
                      className={`diagnostics-severity-${e.level === "error" ? "danger" : "warn"}`}
                    >
                      {e.level}
                    </code>
                  </td>
                  <td className="diagnostics-sql">
                    <code>{e.message}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Per-scrape activity from lib/scrape-activity.ts. Two sub-tables:
 *   - In-progress scrapes (with their elapsed time + phase trail). If a
 *     scrape is sitting on a single phase for many seconds, that's the
 *     bottleneck.
 *   - Completed scrapes (newest first) with per-phase wall-clock costs
 *     so you can see which step is slow on average.
 *
 * Phase names emitted by fetchAndParseApp: apple_fetched, parsed,
 * committed, policy_done. A scrape stuck before apple_fetched is on the
 * network; before parsed is on HTML / iTunes Lookup; before committed is
 * on the DB; before policy_done is on the developer privacy-policy fetch.
 */
function ScrapeActivityCard({
  activity,
}: {
  activity: NonNullable<RuntimeMetrics["scrapeActivity"]>;
}) {
  const t = useTranslations("diagnostics_page.card_scrape_activity");
  const tCols = useTranslations("diagnostics_page.table_headers");
  const tFormat = useTranslations("diagnostics_page.format");
  const { inProgress, recent } = activity;
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          {t("title")}
          {inProgress.length > 0 && (
            <span
              className="diagnostics-pill diagnostics-severity-warn"
              style={{ marginLeft: 8 }}
            >
              <span aria-hidden="true">⚠</span>{" "}
              {t("in_flight_pill", { count: String(inProgress.length) })}
            </span>
          )}
        </h2>
        <p className="diagnostics-card-help">
          {t("help", { total: activity.totalSinceStart.toLocaleString() })}
        </p>
      </header>

      {inProgress.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              margin: "0 0 6px",
              color: "var(--text-2)",
            }}
          >
            {t("in_progress_heading")}
          </h3>
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>{t("col_running")}</th>
                  <th>{tCols("url")}</th>
                  <th>{t("col_last_phase")}</th>
                  <th style={{ width: 100 }}>{t("col_phase_age")}</th>
                  <th style={{ width: 70 }}>{t("col_resync")}</th>
                </tr>
              </thead>
              <tbody>
                {inProgress.map((p) => {
                  const lastPhase = p.phases.at(-1);
                  const phaseAge = lastPhase
                    ? p.runningMs - lastPhase.atOffsetMs
                    : p.runningMs;
                  const stuck = phaseAge >= 2000;
                  return (
                    <tr key={p.id}>
                      <td>
                        <code
                          className={
                            p.runningMs >= 5000
                              ? "diagnostics-severity-danger"
                              : p.runningMs >= 2000
                                ? "diagnostics-severity-warn"
                                : ""
                          }
                        >
                          {formatMs(p.runningMs)} ms
                        </code>
                      </td>
                      <td className="diagnostics-sql">
                        <code>{p.url}</code>
                      </td>
                      <td>
                        <code>{lastPhase?.phase ?? "(no marks yet)"}</code>
                      </td>
                      <td>
                        <code
                          className={stuck ? "diagnostics-severity-warn" : ""}
                        >
                          {formatMs(phaseAge)} ms
                        </code>
                      </td>
                      <td>{p.resync ? "yes" : "no"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h3
        style={{
          fontSize: 13,
          fontWeight: 600,
          margin: "0 0 6px",
          color: "var(--text-2)",
        }}
      >
        {t("recent_heading")}
      </h3>
      {recent.length === 0 ? (
        <div className="diagnostics-empty">{t("empty")}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{tCols("time")}</th>
                <th>{t("col_app")}</th>
                <th style={{ width: 80 }}>{tCols("outcome")}</th>
                <th style={{ width: 90 }}>{t("col_total")}</th>
                <th>{t("col_per_phase")}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => {
                const outcomeCls =
                  s.outcome === "success"
                    ? ""
                    : s.outcome === "rate_limited"
                      ? "diagnostics-severity-warn"
                      : "diagnostics-severity-danger";
                // Render the per-phase deltas. The first phase's offset
                // is the time from scrape start; subsequent phases show
                // delta-from-previous so the slow step is obvious.
                const phaseDeltas: string[] = [];
                let prevOffset = 0;
                for (const ph of s.phases) {
                  const delta = ph.atOffsetMs - prevOffset;
                  phaseDeltas.push(`${ph.phase}=${formatMs(delta)}`);
                  prevOffset = ph.atOffsetMs;
                }
                const tail = s.totalMs - prevOffset;
                if (tail > 0) {
                  phaseDeltas.push(`tail=${formatMs(tail)}`);
                }
                return (
                  <tr key={s.id}>
                    <td title={new Date(s.startedAt).toISOString()}>
                      {formatRelative(tFormat, s.startedAt)}
                    </td>
                    <td className="diagnostics-sql">
                      <code>{s.appName ?? s.url}</code>
                      {s.error && (
                        <div
                          style={{
                            marginTop: 2,
                            fontSize: 11,
                            color: "var(--rose)",
                          }}
                        >
                          {s.error}
                        </div>
                      )}
                    </td>
                    <td>
                      <code className={outcomeCls}>{s.outcome}</code>
                    </td>
                    <td>
                      <code
                        className={
                          s.totalMs >= 3000 ? "diagnostics-severity-warn" : ""
                        }
                      >
                        {formatMs(s.totalMs)} ms
                      </code>
                    </td>
                    <td className="diagnostics-sql">
                      <code>{phaseDeltas.join(" · ") || "—"}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Recent API requests captured by the server-side withApiTiming wrapper.
 * Useful during import hangs to spot "POST /api/imports/queue took 4s".
 * Currently only the import-queue route is wrapped; other routes can opt
 * in by wrapping their handler with withApiTiming(route, handler).
 */
function ApiTimingsCard({
  timings,
}: {
  timings: NonNullable<RuntimeMetrics["apiTimings"]>;
}) {
  const t = useTranslations("diagnostics_page.card_api_timings");
  const tCols = useTranslations("diagnostics_page.table_headers");
  const tFormat = useTranslations("diagnostics_page.format");
  const sorted = useMemo(
    () => [...timings.recent].sort((a, b) => b.at - a.at),
    [timings.recent]
  );
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          {t("title")}
          <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
            {t("slow_pill", { ms: String(timings.thresholdMs) })}
          </span>
        </h2>
        <p className="diagnostics-card-help">
          {t("help", {
            total: timings.totalSinceStart.toLocaleString(),
            slow: timings.slowSinceStart.toLocaleString(),
            showing: String(sorted.length),
          })}
        </p>
      </header>
      {sorted.length === 0 ? (
        <div className="diagnostics-empty">{t("empty")}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{tCols("time")}</th>
                <th style={{ width: 60 }}>{tCols("method")}</th>
                <th>{t("col_route")}</th>
                <th style={{ width: 80 }}>{tCols("status")}</th>
                <th style={{ width: 90 }}>{tCols("duration")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((rec, i) => {
                const erroring = rec.status === 0 || rec.status >= 400;
                const slow = rec.durationMs >= timings.thresholdMs;
                const cls = erroring
                  ? "diagnostics-severity-danger"
                  : slow
                    ? "diagnostics-severity-warn"
                    : "";
                return (
                  <tr key={`${rec.at}-${i}`}>
                    <td title={new Date(rec.at).toISOString()}>
                      {formatRelative(tFormat, rec.at)}
                    </td>
                    <td>
                      <code>{rec.method}</code>
                    </td>
                    <td className="diagnostics-sql">
                      <code>{rec.route}</code>
                    </td>
                    <td>
                      <code
                        className={
                          erroring ? "diagnostics-severity-danger" : ""
                        }
                      >
                        {rec.status || (rec.error ? "ERR" : "—")}
                      </code>
                    </td>
                    <td>
                      <code className={cls}>{formatMs(rec.durationMs)} ms</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DbWorkerCard({ timings }: { timings: DbWorkerTimings }) {
  const t = useTranslations("diagnostics_page.card_db_worker");
  const tCols = useTranslations("diagnostics_page.table_headers");
  const tFormat = useTranslations("diagnostics_page.format");
  const sorted = useMemo(
    () => [...timings.recent].sort((a, b) => b.at - a.at),
    [timings.recent]
  );
  const inlinePct =
    timings.totalSinceStart > 0
      ? Math.round((timings.inlineSinceStart / timings.totalSinceStart) * 100)
      : 0;
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          {t("title")}
          {!timings.workerEnabled && (
            <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
              {t("inline_fallback_pill")}
            </span>
          )}
          {timings.pendingRequests > 0 && (
            <span className="diagnostics-pill" style={{ marginLeft: 6 }}>
              {t("pending_pill", { count: String(timings.pendingRequests) })}
            </span>
          )}
        </h2>
        <p className="diagnostics-card-help">
          {t("help", {
            total: timings.totalSinceStart.toLocaleString(),
            failed: timings.failedSinceStart.toLocaleString(),
            inline: timings.inlineSinceStart.toLocaleString(),
            pct: String(inlinePct),
            showing: String(sorted.length),
          })}
        </p>
      </header>
      {sorted.length === 0 ? (
        <div className="diagnostics-empty">{t("empty")}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{tCols("time")}</th>
                <th style={{ width: 80 }}>{t("col_mode")}</th>
                <th style={{ width: 90 }}>{tCols("outcome")}</th>
                <th style={{ width: 90 }}>{t("col_statements")}</th>
                <th style={{ width: 80 }}>{t("col_changes")}</th>
                <th style={{ width: 90 }}>{tCols("duration")}</th>
                <th>{t("col_error")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((batch, i) => {
                const erroring = batch.outcome === "error";
                const slow = batch.durationMs >= 1000;
                return (
                  <tr key={`${batch.at}-${i}`}>
                    <td title={new Date(batch.at).toISOString()}>
                      {formatRelative(tFormat, batch.at)}
                    </td>
                    <td>
                      <code
                        className={
                          batch.inline ? "diagnostics-severity-warn" : ""
                        }
                      >
                        {batch.inline ? "inline" : "worker"}
                      </code>
                    </td>
                    <td>
                      <code
                        className={
                          erroring ? "diagnostics-severity-danger" : ""
                        }
                      >
                        {batch.outcome}
                      </code>
                    </td>
                    <td>
                      <code>
                        {batch.statementCount.toLocaleString()} /{" "}
                        {batch.chunkSize}
                      </code>
                    </td>
                    <td>
                      <code>{batch.totalChanges.toLocaleString()}</code>
                    </td>
                    <td>
                      <code
                        className={
                          erroring
                            ? "diagnostics-severity-danger"
                            : slow
                              ? "diagnostics-severity-warn"
                              : ""
                        }
                      >
                        {formatMs(batch.durationMs)} ms
                      </code>
                    </td>
                    <td className="diagnostics-sql">
                      <code>
                        {batch.error
                          ? `${batch.error}${batch.failedAtIndex === undefined ? "" : ` @${batch.failedAtIndex}`}`
                          : batch.workerDurationMs === undefined
                            ? "—"
                            : `worker ${formatMs(batch.workerDurationMs)} ms`}
                      </code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Client-side activity captured in the renderer process: long tasks
 * (main-thread work that blocked the UI), in-flight fetches, and a
 * timeline of import-flow milestones. Reads directly from the
 * client-diagnostics module — no HTTP roundtrip.
 */
function ClientActivityCard({
  snapshot,
  onClear,
}: {
  snapshot: ClientDiagnosticsSnapshot;
  onClear: () => void;
}) {
  const t = useTranslations("diagnostics_page.card_client_activity");
  const tCols = useTranslations("diagnostics_page.table_headers");
  const tFormat = useTranslations("diagnostics_page.format");
  const longTasksSorted = useMemo(
    () =>
      [...snapshot.longTasks.recent].sort((a, b) => b.at - a.at).slice(0, 30),
    [snapshot.longTasks.recent]
  );
  const importEventsSorted = useMemo(
    () => [...snapshot.importEvents].sort((a, b) => b.at - a.at).slice(0, 40),
    [snapshot.importEvents]
  );
  const inflight = snapshot.fetches.inflight;
  const recentFetches = useMemo(
    () =>
      [...snapshot.fetches.recent]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 20),
    [snapshot.fetches.recent]
  );
  const longestInflight = inflight[0]?.durationMs ?? 0;
  const installedAgo = snapshot.installedAt
    ? Math.max(0, snapshot.generatedAt - snapshot.installedAt)
    : 0;

  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 className="diagnostics-card-title">
              {t("title")}
              <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
                {t("long_task_pill", {
                  ms: String(snapshot.longTasks.thresholdMs),
                })}
              </span>
              {!snapshot.longTaskObserverActive && (
                <span className="diagnostics-pill" style={{ marginLeft: 6 }}>
                  {t("raf_fallback_pill")}
                </span>
              )}
            </h2>
            <p className="diagnostics-card-help">
              {t("help", {
                longTasks: snapshot.longTasks.totalSinceStart.toLocaleString(),
                slowFetches: snapshot.fetches.slowCount.toLocaleString(),
                failed: snapshot.fetches.failedCount.toLocaleString(),
                inflight: String(inflight.length),
              })}
              {inflight.length > 0 && longestInflight > 1000 && (
                <>
                  {" · "}
                  {t("help_oldest_pending", {
                    seconds: String(Math.round(longestInflight / 100) / 10),
                  })}
                </>
              )}
              {installedAgo > 0 && (
                <>
                  {" · "}
                  {t("help_capturing", {
                    duration: formatDuration(tFormat, installedAgo),
                  })}
                </>
              )}
            </p>
          </div>
          <button className="btn btn-secondary" onClick={onClear} type="button">
            {t("clear_button")}
          </button>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        }}
      >
        {/* Long tasks */}
        <div>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              margin: "0 0 6px",
              color: "var(--text-2)",
            }}
          >
            {t("long_tasks_heading")}{" "}
            {longTasksSorted.length > 0 &&
              t("long_tasks_count", { count: longTasksSorted.length })}
          </h3>
          {longTasksSorted.length === 0 ? (
            <div
              className="diagnostics-empty"
              style={{ padding: 12, fontSize: 12 }}
            >
              {t("long_tasks_empty")}{" "}
              {snapshot.longTaskObserverActive
                ? t("long_tasks_empty_responsive")
                : t("long_tasks_empty_webkit")}
            </div>
          ) : (
            <div className="diagnostics-table-wrap">
              <table className="diagnostics-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>{tCols("time")}</th>
                    <th style={{ width: 100 }}>{tCols("duration")}</th>
                    <th>{t("col_source")}</th>
                  </tr>
                </thead>
                <tbody>
                  {longTasksSorted.map((lt, i) => (
                    <tr key={`${lt.at}-${i}`}>
                      <td title={new Date(lt.at).toISOString()}>
                        {formatRelative(tFormat, lt.at)}
                      </td>
                      <td>
                        <code
                          className={
                            lt.durationMs >= 200
                              ? "diagnostics-severity-danger"
                              : "diagnostics-severity-warn"
                          }
                        >
                          {formatMs(lt.durationMs)} ms
                        </code>
                      </td>
                      <td>
                        <code>{lt.source}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Fetch activity */}
        <div>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              margin: "0 0 6px",
              color: "var(--text-2)",
            }}
          >
            {t("fetch_heading", { ms: snapshot.fetches.slowThresholdMs })}
          </h3>
          {inflight.length === 0 && recentFetches.length === 0 ? (
            <div
              className="diagnostics-empty"
              style={{ padding: 12, fontSize: 12 }}
            >
              {t("fetch_empty")}
            </div>
          ) : (
            <div className="diagnostics-table-wrap">
              <table className="diagnostics-table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>{t("col_phase")}</th>
                    <th style={{ width: 60 }}>{tCols("method")}</th>
                    <th>{tCols("url")}</th>
                    <th style={{ width: 80 }}>{tCols("status")}</th>
                    <th style={{ width: 90 }}>{tCols("duration")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inflight.map((f, i) => (
                    <tr key={`if-${i}`}>
                      <td>
                        <code className="diagnostics-severity-warn">
                          inflight
                        </code>
                      </td>
                      <td>
                        <code>{f.method}</code>
                      </td>
                      <td className="diagnostics-sql">
                        <code>{f.url}</code>
                      </td>
                      <td>—</td>
                      <td>
                        <code>{formatMs(f.durationMs)} ms</code>
                      </td>
                    </tr>
                  ))}
                  {recentFetches.map((f, i) => {
                    const erroring =
                      f.phase === "failed" ||
                      (f.status !== undefined && f.status >= 400);
                    return (
                      <tr key={`f-${f.startedAt}-${i}`}>
                        <td>
                          <code
                            className={
                              erroring ? "diagnostics-severity-danger" : ""
                            }
                          >
                            {f.phase}
                          </code>
                        </td>
                        <td>
                          <code>{f.method}</code>
                        </td>
                        <td
                          className="diagnostics-sql"
                          title={f.error || undefined}
                        >
                          <code>{f.url}</code>
                        </td>
                        <td>
                          <code
                            className={
                              erroring ? "diagnostics-severity-danger" : ""
                            }
                          >
                            {f.status ?? "—"}
                          </code>
                        </td>
                        <td>
                          <code>{formatMs(f.durationMs)} ms</code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Import events timeline */}
      {importEventsSorted.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              margin: "0 0 6px",
              color: "var(--text-2)",
            }}
          >
            {t("import_heading", { count: importEventsSorted.length })}
          </h3>
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>{tCols("time")}</th>
                  <th style={{ width: 200 }}>{t("col_event")}</th>
                  <th>{t("col_detail")}</th>
                </tr>
              </thead>
              <tbody>
                {importEventsSorted.map((ev, i) => (
                  <tr key={`${ev.at}-${i}`}>
                    <td title={new Date(ev.at).toISOString()}>
                      {formatRelative(tFormat, ev.at)}
                    </td>
                    <td>
                      <code>{ev.name}</code>
                    </td>
                    <td className="diagnostics-sql">
                      <code>{ev.detail ?? "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function FlagsCard({ rows }: { rows: FlagRow[] }) {
  const t = useTranslations("diagnostics_page.card_flags");
  const tLoad = useTranslations("diagnostics_page");
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t("title")}</h2>
        <p className="diagnostics-card-help">{t("help")}</p>
      </header>
      {rows.length === 0 ? (
        <div className="diagnostics-empty">{t("no_overrides")}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th>{t("col_key")}</th>
                <th>{t("col_default")}</th>
                <th>{t("col_current")}</th>
                <th>{t("col_override")}</th>
                <th>{t("col_wired")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <code>{r.key}</code>
                  </td>
                  <td>
                    <code>{r.hardDefault}</code>
                  </td>
                  <td>
                    <code>{r.currentValue}</code>
                  </td>
                  <td>
                    {r.override === null ? (
                      tLoad("em_dash")
                    ) : (
                      <code>{r.override}</code>
                    )}
                  </td>
                  <td>{r.wired ? t("wired_yes") : t("wired_no")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="diagnostics-kv">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const t = useTranslations("diagnostics_page.severity_pill");
  const label =
    severity === "danger"
      ? t("beach_balling")
      : severity === "warn"
        ? t("jank")
        : t("healthy");
  return (
    <span
      className={`diagnostics-severity-pill diagnostics-severity-${severity}`}
    >
      {label}
    </span>
  );
}
