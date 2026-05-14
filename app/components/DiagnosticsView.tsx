'use client';

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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Sparkline from './Sparkline';
import {
  snapshotClientDiagnostics,
  clearClientDiagnostics,
  type ClientDiagnosticsSnapshot,
} from '@/lib/client-diagnostics';

const RUNTIME_POLL_MS = 2_000;
const AUX_POLL_MS = 6_000;
/** Approximately 60 s of runtime samples at the 2 s cadence. */
const HISTORY_CAP = 30;

// ── Type contracts (matching the API responses) ───────────────────────

interface SlowQueryRecord {
  sql: string;
  durationMs: number;
  method: 'all' | 'get' | 'run' | 'iterate';
  paramCount: number;
  at: number;
  error?: string;
}

interface RuntimeMetrics {
  generatedAt: string;
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  v8Heap: {
    totalHeapSizeMb: number;
    usedHeapSizeMb: number;
    heapSizeLimitMb: number;
    mallocedMemoryMb: number;
    externalMemoryMb: number;
    heapFractionUsed: number;
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
    severity: 'ok' | 'warn' | 'danger';
  } | null;
  slowQueries: {
    thresholdMs: number;
    totalSinceStart: number;
    profilingEnabled: boolean;
    recent: SlowQueryRecord[];
  };
  /** Server-side ring of recent API request timings, surfaced alongside
   *  slow queries so the user can see "the import-queue POST took 4s". */
  apiTimings?: {
    thresholdMs: number;
    totalSinceStart: number;
    slowSinceStart: number;
    recent: ApiTimingRecord[];
  };
  /** Live + recent App Store scrape attempts with per-phase timings. */
  scrapeActivity?: {
    totalSinceStart: number;
    inProgress: InProgressScrape[];
    recent: ScrapeRecord[];
  };
  dbWorker?: DbWorkerTimings;
}

interface ApiTimingRecord {
  at: number;
  route: string;
  method: string;
  durationMs: number;
  status: number;
  error?: string;
}

interface DbWorkerTimingRecord {
  at: number;
  statementCount: number;
  chunkSize: number | 'infinity';
  durationMs: number;
  workerDurationMs?: number;
  totalChanges: number;
  inline: boolean;
  outcome: 'ok' | 'error';
  failedAtIndex?: number;
  error?: string;
}

interface DbWorkerTimings {
  totalSinceStart: number;
  failedSinceStart: number;
  inlineSinceStart: number;
  pendingRequests: number;
  workerEnabled: boolean;
  workerCached: boolean;
  workerDisabled: boolean;
  recent: DbWorkerTimingRecord[];
}

interface ScrapePhaseMark {
  phase: string;
  atOffsetMs: number;
}

interface InProgressScrape {
  id: string;
  url: string;
  startedAt: number;
  runningMs: number;
  phases: ScrapePhaseMark[];
  resync: boolean;
}

interface ScrapeRecord {
  id: string;
  startedAt: number;
  url: string;
  appName?: string;
  totalMs: number;
  phases: ScrapePhaseMark[];
  outcome: 'success' | 'error' | 'rate_limited';
  error?: string;
  resync: boolean;
}

interface DatabaseHealth {
  path: string;
  fileBytes: number;
  walBytes: number;
  shmBytes: number;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  utilisationPct: number;
  journalMode: string;
  busyTimeoutMs: number;
  foreignKeysEnabled: 0 | 1;
  walAutocheckpoint: number;
  integrityCheck: {
    status: 'ok' | 'error';
    detail?: string;
    checkedAt: number;
    durationMs: number;
  } | null;
}

interface DiskSnapshot {
  dataDir: string;
  dataDirBytes: number;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  files: { db: number; wal: number; shm: number; backups: number };
  lastBackupSnapshotAt: number | null;
  backupSnapshotCount: number;
}

interface ErrorLogEntry {
  at: number;
  level: 'error' | 'warn';
  message: string;
  truncated: boolean;
}

interface ActiveJobs {
  wayback: ActiveJobView;
  sync: ActiveJobView;
  policy: ActiveJobView;
  serverNow?: number;
}
interface ActiveJobView {
  running: boolean;
  mutexHeld: boolean;
  stale: boolean;
  initiator: 'manual' | 'scheduled' | 'automatic' | 'resume' | null;
  currentAppName: string | null;
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
  category: 'search' | 'scrape';
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  resumeAt: number | null;
  reason: string | null;
  bucketTokens?: number;
  bucketCapacity?: number;
}
interface RateLimits {
  search: RateLimitCategoryState;
  scrape: RateLimitCategoryState;
  serverNow: number;
}

interface FlagRow {
  key: string;
  surface: string;
  hardDefault: string;
  currentValue: string;
  override: string | null;
  wired: boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins.toString().padStart(2, '0')}m`;
}

function formatRelative(at: number): string {
  const delta = Date.now() - at;
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  if (value < 1) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return Math.round(value).toString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

// ── Status rollup ─────────────────────────────────────────────────────

type Severity = 'ok' | 'warn' | 'danger';

/** Structured status note. Key is a translation key under
 *  `diagnostics_page.banner`; `params` is the ICU placeholder map.
 *  The banner component looks them up via t() so the rollup itself
 *  stays pure logic + free of useTranslations boilerplate. */
interface StatusNote {
  key: string;
  params?: Record<string, string | number>;
}
interface StatusSummary {
  overall: Severity;
  notes: StatusNote[];
}

/**
 * Roll the available signals up into a single severity + a short list of
 * note keys. Conservative: any one signal in `danger` makes the whole
 * banner red; any one in `warn` makes it yellow.
 */
function rollupStatus(state: {
  runtime: RuntimeMetrics | null;
  database: DatabaseHealth | null;
  disk: DiskSnapshot | null;
  errors: ErrorLogEntry[];
  jobs: ActiveJobs | null;
  rateLimits: RateLimits | null;
}): StatusSummary {
  const notes: StatusNote[] = [];
  let overall: Severity = 'ok';
  const bump = (sev: Severity) => {
    if (sev === 'danger' || (sev === 'warn' && overall === 'ok')) overall = sev;
  };

  if (state.runtime) {
    if (state.runtime.eventLoop) {
      if (state.runtime.eventLoop.severity !== 'ok') {
        bump(state.runtime.eventLoop.severity);
        notes.push({
          key: state.runtime.eventLoop.severity === 'danger'
            ? 'event_loop_danger'
            : 'event_loop_warn',
          params: { p99: formatMs(state.runtime.eventLoop.p99Ms) },
        });
      }
    }
    if (state.runtime.v8Heap.heapFractionUsed >= 0.85) {
      bump('danger');
      notes.push({
        key: 'heap_full',
        params: { pct: Math.round(state.runtime.v8Heap.heapFractionUsed * 100) },
      });
    } else if (state.runtime.v8Heap.heapFractionUsed >= 0.7) {
      bump('warn');
    }
    if (state.runtime.resourceUsage.majorPageFaults >= 1000) {
      bump('danger');
      notes.push({ key: 'swapping' });
    }
  }

  if (state.disk) {
    if (state.disk.totalBytes > 0 && state.disk.freePct < 5) {
      bump('danger');
      notes.push({ key: 'disk_critical', params: { free: formatBytes(state.disk.freeBytes) } });
    } else if (state.disk.totalBytes > 0 && state.disk.freePct < 10) {
      bump('warn');
      notes.push({ key: 'disk_low', params: { pct: state.disk.freePct } });
    }
  }

  if (state.database?.integrityCheck?.status === 'error') {
    bump('danger');
    const detail = state.database.integrityCheck.detail;
    notes.push(
      detail
        ? { key: 'integrity_failed_with_detail', params: { detail: detail.slice(0, 120) } }
        : { key: 'integrity_failed_no_detail' },
    );
  }

  if (state.rateLimits) {
    const rl = state.rateLimits;
    const stuck = (['search', 'scrape'] as const).filter(c => rl[c].cooldownActive);
    if (stuck.length) {
      bump('warn');
      notes.push({
        key: 'rate_limited',
        params: {
          cats: stuck.join(' + '),
          remaining: stuck.map(c => formatDuration(rl[c].cooldownRemainingMs)).join(' / '),
        },
      });
    }
  }

  if (state.errors.length > 0) {
    const recentErrors = state.errors.filter(e => e.level === 'error' && Date.now() - e.at < 5 * 60_000);
    if (recentErrors.length >= 5) {
      bump('warn');
      notes.push({ key: 'errors_recent', params: { count: recentErrors.length } });
    }
  }

  if (notes.length === 0) {
    notes.push({ key: 'no_issues' });
  }

  return { overall, notes };
}

async function fetchMergedDiagnosticsBundle(): Promise<string> {
  const r = await fetch('/api/diagnostics/bundle', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
  const t = useTranslations('diagnostics_page');
  const tToolbar = useTranslations('diagnostics_page.toolbar');

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
  const [clientDiag, setClientDiag] = useState<ClientDiagnosticsSnapshot | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState<'clear' | 'profile' | 'integrity' | 'copy' | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');

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
    if (inflightRuntimeRef.current) return;
    inflightRuntimeRef.current = true;
    // Short deadline so a hung server doesn't stall the polling loop
    // forever — the inflight guard would otherwise lock subsequent ticks
    // out. AbortController + a timer keeps the failure visible.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      const r = await fetch('/api/diagnostics/runtime', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as RuntimeMetrics;
      setMetrics(body);
      setError(null);
      setLastRuntimeAt(Date.now());
      setServerStallMs(0);

      // Append to sparkline history. Cap to HISTORY_CAP so the buffer
      // doesn't grow without bound during long sessions.
      const cpuPct = body.uptimeSeconds > 0
        ? Math.min(100, ((body.resourceUsage.userCpuSeconds + body.resourceUsage.systemCpuSeconds) / body.uptimeSeconds) * 100)
        : 0;
      setHistory(prev => ({
        p99: [...prev.p99, body.eventLoop?.p99Ms ?? 0].slice(-HISTORY_CAP),
        rssMb: [...prev.rssMb, body.memory.rssMb].slice(-HISTORY_CAP),
        heapPct: [...prev.heapPct, Math.round(body.v8Heap.heapFractionUsed * 100)].slice(-HISTORY_CAP),
        cpuPct: [...prev.cpuPct, cpuPct].slice(-HISTORY_CAP),
      }));
    } catch (e) {
      const msg = e instanceof Error
        ? (e.name === 'AbortError' ? 'runtime poll timed out after 10s' : e.message)
        : 'fetch failed';
      setError(msg);
      if (lastRuntimeAt) setServerStallMs(Date.now() - lastRuntimeAt);
    } finally {
      clearTimeout(deadline);
      inflightRuntimeRef.current = false;
    }
  }, [lastRuntimeAt]);

  /** Fetch every "auxiliary" (slower-cadence) endpoint in parallel. We
   *  catch each independently so a single broken subsystem doesn't blank
   *  the rest of the dashboard. */
  const fetchAuxiliary = useCallback(async () => {
    if (inflightAuxRef.current) return;
    inflightAuxRef.current = true;
    try {
      const settled = await Promise.allSettled([
        fetch('/api/diagnostics/database', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<DatabaseHealth> : Promise.reject(new Error(`db HTTP ${r.status}`))),
        fetch('/api/diagnostics/disk', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<DiskSnapshot> : Promise.reject(new Error(`disk HTTP ${r.status}`))),
        fetch('/api/diagnostics/errors?limit=50', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<{ entries: ErrorLogEntry[]; capacity: number }> : Promise.reject(new Error(`errors HTTP ${r.status}`))),
        fetch('/api/tasks/active', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<ActiveJobs> : Promise.reject(new Error(`jobs HTTP ${r.status}`))),
        fetch('/api/rate-limit/status', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<RateLimits> : Promise.reject(new Error(`rate HTTP ${r.status}`))),
        fetch('/api/feature-flags', { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<{ flags: FlagRow[] }> : Promise.reject(new Error(`flags HTTP ${r.status}`))),
      ]);
      if (settled[0].status === 'fulfilled') setDatabase(settled[0].value);
      if (settled[1].status === 'fulfilled') setDisk(settled[1].value);
      if (settled[2].status === 'fulfilled') setErrors(settled[2].value.entries);
      if (settled[3].status === 'fulfilled') setJobs(settled[3].value);
      if (settled[4].status === 'fulfilled') setRateLimits(settled[4].value);
      if (settled[5].status === 'fulfilled') {
        // Only surface flags whose current value differs from the
        // hard default — the full list is long and the diff is what
        // matters for "why is feature X behaving oddly".
        const diffs = settled[5].value.flags.filter(
          (f) => f.currentValue !== f.hardDefault || f.override !== null,
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
    if (paused) return;
    const id = setInterval(() => {
      setClientDiag(snapshotClientDiagnostics());
    }, RUNTIME_POLL_MS);
    return () => clearInterval(id);
  }, [paused]);

  // Runtime poll
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => { void fetchRuntime(); }, RUNTIME_POLL_MS);
    return () => window.clearInterval(id);
  }, [paused, fetchRuntime]);

  // Auxiliary poll
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => { void fetchAuxiliary(); }, AUX_POLL_MS);
    return () => window.clearInterval(id);
  }, [paused, fetchAuxiliary]);

  // ── Actions ─────────────────────────────────────────────────────────

  const handleClear = useCallback(async () => {
    setBusy('clear');
    try {
      const [runtimeRes, errorsRes] = await Promise.all([
        fetch('/api/diagnostics/runtime', { method: 'DELETE' }),
        fetch('/api/diagnostics/errors', { method: 'DELETE' }),
      ]);
      if (runtimeRes.ok) {
        const body = (await runtimeRes.json()) as RuntimeMetrics;
        setMetrics(body);
        // Also reset client-side sparkline history so the line restarts
        // from the moment the user clicked Clear.
        setHistory({ p99: [], rssMb: [], heapPct: [], cpuPct: [] });
        setError(null);
      } else {
        setError(`Clear failed: HTTP ${runtimeRes.status}`);
      }
      if (errorsRes.ok) {
        const body = (await errorsRes.json()) as { entries: ErrorLogEntry[] };
        setErrors(body.entries);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear failed');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleToggleProfiling = useCallback(async () => {
    if (!metrics) return;
    setBusy('profile');
    try {
      const r = await fetch('/api/diagnostics/runtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profilingEnabled: !metrics.slowQueries.profilingEnabled }),
      });
      if (r.ok) {
        const body = (await r.json()) as RuntimeMetrics;
        setMetrics(body);
      } else {
        setError(`Toggle failed: HTTP ${r.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'toggle failed');
    } finally {
      setBusy(null);
    }
  }, [metrics]);

  const handleIntegrityCheck = useCallback(async () => {
    setBusy('integrity');
    try {
      const r = await fetch('/api/diagnostics/database', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runIntegrityCheck: true }),
      });
      if (r.ok) {
        const body = (await r.json()) as DatabaseHealth;
        setDatabase(body);
      } else {
        setError(`Integrity check failed: HTTP ${r.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'integrity check failed');
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
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `privacytracker-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a short delay so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'download failed');
    }
  }, []);

  const handleCopyBundle = useCallback(async () => {
    setBusy('copy');
    setCopyState('idle');
    try {
      const json = await fetchMergedDiagnosticsBundle();
      setClientDiag(snapshotClientDiagnostics());
      // navigator.clipboard requires HTTPS or localhost; both apply here.
      // Fallback to a hidden textarea + execCommand only if the API is
      // missing — Safari < 13 / very old browsers.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      } else {
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyState('ok');
      window.setTimeout(() => setCopyState('idle'), 2500);
    } catch (e) {
      setCopyState('err');
      setError(e instanceof Error ? e.message : 'copy failed');
      window.setTimeout(() => setCopyState('idle'), 2500);
    } finally {
      setBusy(null);
    }
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────

  const slowSorted = useMemo(() => {
    if (!metrics) return [];
    return [...metrics.slowQueries.recent].sort((a, b) => b.at - a.at);
  }, [metrics]);

  const status = useMemo(
    () => rollupStatus({ runtime: metrics, database, disk, errors, jobs, rateLimits }),
    [metrics, database, disk, errors, jobs, rateLimits],
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="page-container diagnostics-page">
      <div className="page-header diagnostics-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
          <p className="page-subtitle">
            {t('subtitle', { seconds: Math.round(RUNTIME_POLL_MS / 1000) })}
          </p>
        </div>
        <div className="diagnostics-toolbar">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { void handleCopyBundle(); }}
            disabled={busy === 'copy'}
            title={tToolbar('copy_title')}
          >
            {copyState === 'ok'
              ? tToolbar('copied')
              : copyState === 'err'
                ? tToolbar('copy_failed')
                : busy === 'copy'
                  ? tToolbar('copying')
                  : tToolbar('copy')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { void handleDownloadBundle(); }}
            title={tToolbar('download_title')}
          >
            {tToolbar('download')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPaused(p => !p)}
            title={paused ? tToolbar('resume_title') : tToolbar('pause_title')}
          >
            {paused ? tToolbar('resume') : tToolbar('pause')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { void handleClear(); }}
            disabled={busy === 'clear'}
            title={tToolbar('clear_title')}
          >
            {busy === 'clear' ? tToolbar('clearing') : tToolbar('clear')}
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
          className="diagnostics-error"
          role="status"
          aria-live="polite"
          style={{ background: 'var(--orange-dim, color-mix(in srgb, var(--orange) 18%, transparent))', color: 'var(--orange)' }}
        >
          Server hasn&apos;t responded for {Math.round(serverStallMs / 1000)}s.
          Below is the last snapshot from{' '}
          {lastRuntimeAt ? formatRelative(lastRuntimeAt) : 'an earlier poll'}.
          Client-side panels (long tasks, fetch activity) are still live.
        </div>
      )}

      {error && (
        <div className="diagnostics-error" role="alert">
          {error}
        </div>
      )}

      {!metrics ? (
        <div className="empty-state" style={{ padding: 32 }}>
          {t('loading_runtime')}
        </div>
      ) : (
        <div className="diagnostics-grid">
          <EventLoopCard eventLoop={metrics.eventLoop} uptimeSeconds={metrics.uptimeSeconds} history={history.p99} />
          <MemoryCard memory={metrics.memory} v8Heap={metrics.v8Heap} historyRss={history.rssMb} historyHeap={history.heapPct} />
          <ResourceCard resourceUsage={metrics.resourceUsage} uptimeSeconds={metrics.uptimeSeconds} historyCpu={history.cpuPct} />
          <DatabaseCard
            database={database}
            busy={busy === 'integrity'}
            onRunIntegrityCheck={() => { void handleIntegrityCheck(); }}
          />
          <DiskCard disk={disk} />
          <BackgroundJobsCard jobs={jobs} />
          <RateLimitsCard rateLimits={rateLimits} />
          <SlowQueryCard
            slowQueries={metrics.slowQueries}
            recent={slowSorted}
            busy={busy === 'profile'}
            onToggleProfiling={() => { void handleToggleProfiling(); }}
          />
          {metrics.scrapeActivity && (
            <ScrapeActivityCard activity={metrics.scrapeActivity} />
          )}
          {metrics.apiTimings && (
            <ApiTimingsCard timings={metrics.apiTimings} />
          )}
          {metrics.dbWorker && (
            <DbWorkerCard timings={metrics.dbWorker} />
          )}
          {clientDiag && (
            <ClientActivityCard
              snapshot={clientDiag}
              onClear={() => {
                clearClientDiagnostics();
                setClientDiag(snapshotClientDiagnostics());
              }}
            />
          )}
          <ErrorLogCard entries={errors} />
          <FlagsCard rows={flagOverrides} />
        </div>
      )}
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────

function StatusBanner({ summary }: { summary: StatusSummary }) {
  const t = useTranslations('diagnostics_page.banner');
  const heading =
    summary.overall === 'danger' ? t('issues_detected') :
    summary.overall === 'warn' ? t('some_warnings') : t('healthy');
  return (
    <section className={`diagnostics-status diagnostics-status--${summary.overall}`} role="status" aria-live="polite">
      <div className="diagnostics-status-head">
        <span className="diagnostics-status-dot" aria-hidden="true" />
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
  eventLoop: RuntimeMetrics['eventLoop'];
  uptimeSeconds: number;
  history: number[];
}) {
  const t = useTranslations('diagnostics_page.card_event_loop');
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      {!eventLoop ? (
        <div className="diagnostics-empty">{t('no_samples')}</div>
      ) : (
        <>
          <div className="diagnostics-metric-row diagnostics-metric-row--hero">
            <div className="diagnostics-metric">
              <span className="diagnostics-metric-label">{t('p99')}</span>
              <span className={`diagnostics-metric-value diagnostics-severity-${eventLoop.severity}`}>
                {formatMs(eventLoop.p99Ms)}<small>ms</small>
              </span>
              <Sparkline
                values={history}
                severity={eventLoop.severity}
                ariaLabel={t('spark_label', { seconds: HISTORY_CAP * RUNTIME_POLL_MS / 1000 })}
              />
            </div>
            <SeverityBadge severity={eventLoop.severity} />
          </div>
          <dl className="diagnostics-kvs">
            <KV label={t('p50')} value={`${formatMs(eventLoop.p50Ms)} ms`} />
            <KV label={t('p95')} value={`${formatMs(eventLoop.p95Ms)} ms`} />
            <KV label={t('mean')} value={`${formatMs(eventLoop.meanMs)} ms`} />
            <KV label={t('max')} value={`${formatMs(eventLoop.maxMs)} ms`} />
            <KV label={t('stddev')} value={`${formatMs(eventLoop.stddevMs)} ms`} />
            <KV label={t('window')} value={`${formatUptime(eventLoop.windowSeconds)}`} />
            <KV label={t('samples')} value={eventLoop.samples.toLocaleString()} />
            <KV label={t('uptime')} value={formatUptime(uptimeSeconds)} />
          </dl>
        </>
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
  memory: RuntimeMetrics['memory'];
  v8Heap: RuntimeMetrics['v8Heap'];
  historyRss: number[];
  historyHeap: number[];
}) {
  const t = useTranslations('diagnostics_page.card_memory');
  const heapPct = Math.round(v8Heap.heapFractionUsed * 100);
  const heapSeverity: Severity =
    v8Heap.heapFractionUsed >= 0.85 ? 'danger' :
    v8Heap.heapFractionUsed >= 0.7 ? 'warn' : 'ok';
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('rss')}</span>
          <span className="diagnostics-metric-value">{memory.rssMb}<small>MB</small></span>
          <Sparkline values={historyRss} ariaLabel={t('spark_rss')} />
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('v8_heap')}</span>
          <span className={`diagnostics-metric-value diagnostics-severity-${heapSeverity}`}>
            {heapPct}<small>%</small>
          </span>
          <Sparkline values={historyHeap} severity={heapSeverity} ariaLabel={t('spark_heap')} />
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t('heap_used')} value={`${memory.heapUsedMb} MB`} />
        <KV label={t('heap_total')} value={`${memory.heapTotalMb} MB`} />
        <KV label={t('heap_limit')} value={`${v8Heap.heapSizeLimitMb} MB`} />
        <KV label={t('external')} value={`${memory.externalMb} MB`} />
        <KV label={t('array_buffers')} value={`${memory.arrayBuffersMb} MB`} />
        <KV label={t('malloced')} value={`${v8Heap.mallocedMemoryMb} MB`} />
      </dl>
    </section>
  );
}

function ResourceCard({
  resourceUsage,
  uptimeSeconds,
  historyCpu,
}: {
  resourceUsage: RuntimeMetrics['resourceUsage'];
  uptimeSeconds: number;
  historyCpu: number[];
}) {
  const t = useTranslations('diagnostics_page.card_resource');
  const cpuPct = uptimeSeconds > 0
    ? Math.round(((resourceUsage.userCpuSeconds + resourceUsage.systemCpuSeconds) / uptimeSeconds) * 100)
    : 0;
  const majorFaultsSeverity: Severity =
    resourceUsage.majorPageFaults >= 1000 ? 'danger' :
    resourceUsage.majorPageFaults >= 100 ? 'warn' : 'ok';
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('avg_cpu')}</span>
          <span className="diagnostics-metric-value">{cpuPct}<small>%</small></span>
          <Sparkline values={historyCpu} ariaLabel={t('spark_cpu')} />
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('major_faults')}</span>
          <span className={`diagnostics-metric-value diagnostics-severity-${majorFaultsSeverity}`}>
            {resourceUsage.majorPageFaults.toLocaleString()}
          </span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t('user_cpu')} value={`${resourceUsage.userCpuSeconds.toFixed(1)} s`} />
        <KV label={t('system_cpu')} value={`${resourceUsage.systemCpuSeconds.toFixed(1)} s`} />
        <KV label={t('peak_rss')} value={`${resourceUsage.maxRssMb} MB`} />
        <KV label={t('minor_faults')} value={resourceUsage.minorPageFaults.toLocaleString()} />
        <KV label={t('vol_ctx_sw')} value={resourceUsage.voluntaryContextSwitches.toLocaleString()} />
        <KV label={t('invol_ctx_sw')} value={resourceUsage.involuntaryContextSwitches.toLocaleString()} />
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
  const t = useTranslations('diagnostics_page.card_database');
  const tLoad = useTranslations('diagnostics_page');
  if (!database) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t('title')}</h2>
          <p className="diagnostics-card-help">{t('subtitle_loading')}</p>
        </header>
        <div className="diagnostics-empty">{tLoad('loading')}</div>
      </section>
    );
  }
  const fragSeverity: Severity =
    database.utilisationPct < 60 ? 'warn' : 'ok';
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('file_size')}</span>
          <span className="diagnostics-metric-value">{formatBytes(database.fileBytes)}</span>
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('utilisation')}</span>
          <span className={`diagnostics-metric-value diagnostics-severity-${fragSeverity}`}>
            {database.utilisationPct}<small>%</small>
          </span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t('wal')} value={formatBytes(database.walBytes)} />
        <KV label={t('shm')} value={formatBytes(database.shmBytes)} />
        <KV label={t('pages')} value={database.pageCount.toLocaleString()} />
        <KV label={t('page_size')} value={formatBytes(database.pageSize)} />
        <KV label={t('free_pages')} value={database.freelistCount.toLocaleString()} />
        <KV label={t('journal')} value={database.journalMode} />
        <KV label={t('busy_timeout')} value={`${database.busyTimeoutMs} ms`} />
        <KV label={t('fk_enforcement')} value={database.foreignKeysEnabled ? t('fk_on') : t('fk_off')} />
      </dl>
      <div className="diagnostics-card-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onRunIntegrityCheck}
          disabled={busy}
          title={t('integrity_check_title')}
        >
          {busy ? t('running') : t('run_integrity_check')}
        </button>
        {database.integrityCheck && (
          <span
            className={`diagnostics-pill diagnostics-severity-${database.integrityCheck.status === 'ok' ? 'ok' : 'danger'}`}
            title={database.integrityCheck.detail ?? ''}
          >
            {database.integrityCheck.status === 'ok' ? '✓' : '✗'} {database.integrityCheck.status}
            {' · '}{formatRelative(database.integrityCheck.checkedAt)}
            {' · '}{formatDuration(database.integrityCheck.durationMs)}
          </span>
        )}
      </div>
    </section>
  );
}

function DiskCard({ disk }: { disk: DiskSnapshot | null }) {
  const t = useTranslations('diagnostics_page.card_disk');
  const tLoad = useTranslations('diagnostics_page');
  if (!disk) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t('title')}</h2>
          <p className="diagnostics-card-help">{t('subtitle_loading')}</p>
        </header>
        <div className="diagnostics-empty">{tLoad('loading')}</div>
      </section>
    );
  }
  const freeSeverity: Severity =
    disk.totalBytes === 0 ? 'ok' :
    disk.freePct < 5 ? 'danger' :
    disk.freePct < 10 ? 'warn' : 'ok';
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-metric-row diagnostics-metric-row--hero">
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('free')}</span>
          <span className={`diagnostics-metric-value diagnostics-severity-${freeSeverity}`}>
            {disk.totalBytes > 0 ? `${disk.freePct}%` : tLoad('em_dash')}
          </span>
        </div>
        <div className="diagnostics-metric">
          <span className="diagnostics-metric-label">{t('data_dir')}</span>
          <span className="diagnostics-metric-value">{formatBytes(disk.dataDirBytes)}</span>
        </div>
      </div>
      <dl className="diagnostics-kvs">
        <KV label={t('free_space')} value={formatBytes(disk.freeBytes)} />
        <KV label={t('volume_total')} value={formatBytes(disk.totalBytes)} />
        <KV label={t('db')} value={formatBytes(disk.files.db)} />
        <KV label={t('wal')} value={formatBytes(disk.files.wal)} />
        <KV label={t('shm')} value={formatBytes(disk.files.shm)} />
        <KV label={t('backups_dir')} value={formatBytes(disk.files.backups)} />
        <KV label={t('snapshots')} value={disk.backupSnapshotCount.toString()} />
        <KV
          label={t('last_backup')}
          value={disk.lastBackupSnapshotAt ? formatRelative(disk.lastBackupSnapshotAt) : t('last_backup_none')}
        />
      </dl>
    </section>
  );
}

function BackgroundJobsCard({ jobs }: { jobs: ActiveJobs | null }) {
  const t = useTranslations('diagnostics_page.card_jobs');
  const tLoad = useTranslations('diagnostics_page');
  if (!jobs) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t('title')}</h2>
          <p className="diagnostics-card-help">{t('subtitle_loading')}</p>
        </header>
        <div className="diagnostics-empty">{tLoad('loading')}</div>
      </section>
    );
  }
  const dash = tLoad('em_dash');
  const rows: Array<{ name: string; view: ActiveJobView }> = [
    { name: t('row_sync'), view: jobs.sync },
    { name: t('row_wayback'), view: jobs.wayback },
    { name: t('row_policy'), view: jobs.policy },
  ];
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>{t('col_job')}</th>
              <th>{t('col_state')}</th>
              <th>{t('col_initiator')}</th>
              <th>{t('col_current')}</th>
              <th>{t('col_progress')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ name, view }) => {
              const stateLabel = view.running
                ? t('state_running')
                : view.stale
                  ? t('state_stale')
                  : t('state_idle');
              const sevCls =
                view.stale ? 'diagnostics-severity-danger' :
                view.running ? 'diagnostics-severity-warn' : '';
              const progress = view.summary
                ? t('progress_format', {
                    done: view.summary.done,
                    total: view.summary.total,
                    failed: view.summary.failed,
                  })
                : dash;
              return (
                <tr key={name}>
                  <td>{name}</td>
                  <td className={sevCls}><code>{stateLabel}</code></td>
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
  const t = useTranslations('diagnostics_page.card_rate_limits');
  const tLoad = useTranslations('diagnostics_page');
  if (!rateLimits) {
    return (
      <section className="diagnostics-card">
        <header className="diagnostics-card-header">
          <h2 className="diagnostics-card-title">{t('title')}</h2>
          <p className="diagnostics-card-help">{t('subtitle_loading')}</p>
        </header>
        <div className="diagnostics-empty">{tLoad('loading')}</div>
      </section>
    );
  }
  const dash = tLoad('em_dash');
  const cats: Array<{ label: string; v: RateLimitCategoryState }> = [
    { label: t('row_search'), v: rateLimits.search },
    { label: t('row_scrape'), v: rateLimits.scrape },
  ];
  return (
    <section className="diagnostics-card">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>{t('col_category')}</th>
              <th>{t('col_cooldown')}</th>
              <th>{t('col_remaining')}</th>
              <th>{t('col_bucket')}</th>
              <th>{t('col_reason')}</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(({ label, v }) => (
              <tr key={v.category}>
                <td>{label}</td>
                <td>
                  <code className={v.cooldownActive ? 'diagnostics-severity-danger' : ''}>
                    {v.cooldownActive ? t('cooldown_active') : t('cooldown_idle')}
                  </code>
                </td>
                <td>{v.cooldownActive ? formatDuration(v.cooldownRemainingMs) : dash}</td>
                <td>
                  {typeof v.bucketTokens === 'number' && typeof v.bucketCapacity === 'number'
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
  slowQueries: RuntimeMetrics['slowQueries'];
  recent: SlowQueryRecord[];
  busy: boolean;
  onToggleProfiling: () => void;
}) {
  const t = useTranslations('diagnostics_page.card_slow_query');
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="diagnostics-card-title">
              {t('title')}
              <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
                {t('threshold_pill', { ms: slowQueries.thresholdMs })}
              </span>
            </h2>
            <p className="diagnostics-card-help">
              {t('help', { total: slowQueries.totalSinceStart, recent: recent.length })}
            </p>
          </div>
          <label className="diagnostics-toggle">
            <input
              type="checkbox"
              checked={slowQueries.profilingEnabled}
              onChange={onToggleProfiling}
              disabled={busy}
            />
            <span>{t('toggle_label')}</span>
          </label>
        </div>
      </header>
      {recent.length === 0 ? (
        <div className="diagnostics-empty">
          {slowQueries.profilingEnabled ? t('no_slow') : t('profiling_off')}
        </div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t('col_time')}</th>
                <th style={{ width: 90 }}>{t('col_duration')}</th>
                <th style={{ width: 70 }}>{t('col_method')}</th>
                <th style={{ width: 70 }}>{t('col_params')}</th>
                <th>{t('col_sql')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((q, i) => {
                const sevCls = q.durationMs >= 1000
                  ? 'diagnostics-severity-danger'
                  : q.durationMs >= 250
                    ? 'diagnostics-severity-warn'
                    : '';
                return (
                  <tr key={`${q.at}-${i}`}>
                    <td title={new Date(q.at).toISOString()}>{formatRelative(q.at)}</td>
                    <td className={sevCls}>{formatMs(q.durationMs)} ms</td>
                    <td><code>{q.method}</code></td>
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
  const t = useTranslations('diagnostics_page.card_error_log');
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help', { count: entries.length })}</p>
      </header>
      {entries.length === 0 ? (
        <div className="diagnostics-empty">{t('no_errors')}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t('col_time')}</th>
                <th style={{ width: 70 }}>{t('col_level')}</th>
                <th>{t('col_message')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td title={new Date(e.at).toISOString()}>{formatRelative(e.at)}</td>
                  <td>
                    <code className={`diagnostics-severity-${e.level === 'error' ? 'danger' : 'warn'}`}>
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
  activity: NonNullable<RuntimeMetrics['scrapeActivity']>;
}) {
  const { inProgress, recent } = activity;
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          Scrape activity
          {inProgress.length > 0 && (
            <span className="diagnostics-pill diagnostics-severity-warn" style={{ marginLeft: 8 }}>
              {inProgress.length} in flight
            </span>
          )}
        </h2>
        <p className="diagnostics-card-help">
          {activity.totalSinceStart.toLocaleString()} scrapes since start.
          Phases: apple_fetched → parsed → committed → policy_done. If a
          scrape sits on a single phase for many seconds, that&apos;s the
          bottleneck.
        </p>
      </header>

      {inProgress.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-2)' }}>
            In progress
          </h3>
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Running</th>
                  <th>URL</th>
                  <th>Last phase</th>
                  <th style={{ width: 100 }}>Phase age</th>
                  <th style={{ width: 70 }}>Resync</th>
                </tr>
              </thead>
              <tbody>
                {inProgress.map(p => {
                  const lastPhase = p.phases[p.phases.length - 1];
                  const phaseAge = lastPhase
                    ? p.runningMs - lastPhase.atOffsetMs
                    : p.runningMs;
                  const stuck = phaseAge >= 2000;
                  return (
                    <tr key={p.id}>
                      <td>
                        <code className={p.runningMs >= 5000 ? 'diagnostics-severity-danger' : p.runningMs >= 2000 ? 'diagnostics-severity-warn' : ''}>
                          {formatMs(p.runningMs)} ms
                        </code>
                      </td>
                      <td className="diagnostics-sql"><code>{p.url}</code></td>
                      <td><code>{lastPhase?.phase ?? '(no marks yet)'}</code></td>
                      <td><code className={stuck ? 'diagnostics-severity-warn' : ''}>{formatMs(phaseAge)} ms</code></td>
                      <td>{p.resync ? 'yes' : 'no'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-2)' }}>
        Recent scrapes
      </h3>
      {recent.length === 0 ? (
        <div className="diagnostics-empty">
          No scrapes captured yet. Start an import or hit Re-sync on an app.
        </div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Time</th>
                <th>App</th>
                <th style={{ width: 80 }}>Outcome</th>
                <th style={{ width: 90 }}>Total</th>
                <th>Per-phase ms</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(s => {
                const outcomeCls = s.outcome === 'success'
                  ? ''
                  : s.outcome === 'rate_limited'
                    ? 'diagnostics-severity-warn'
                    : 'diagnostics-severity-danger';
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
                if (tail > 0) phaseDeltas.push(`tail=${formatMs(tail)}`);
                return (
                  <tr key={s.id}>
                    <td title={new Date(s.startedAt).toISOString()}>{formatRelative(s.startedAt)}</td>
                    <td className="diagnostics-sql">
                      <code>{s.appName ?? s.url}</code>
                      {s.error && <div style={{ marginTop: 2, fontSize: 11, color: 'var(--rose)' }}>{s.error}</div>}
                    </td>
                    <td><code className={outcomeCls}>{s.outcome}</code></td>
                    <td><code className={s.totalMs >= 3000 ? 'diagnostics-severity-warn' : ''}>{formatMs(s.totalMs)} ms</code></td>
                    <td className="diagnostics-sql"><code>{phaseDeltas.join(' · ') || '—'}</code></td>
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
  timings: NonNullable<RuntimeMetrics['apiTimings']>;
}) {
  const sorted = useMemo(
    () => [...timings.recent].sort((a, b) => b.at - a.at),
    [timings.recent],
  );
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          Recent API calls
          <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
            slow ≥ {timings.thresholdMs}ms
          </span>
        </h2>
        <p className="diagnostics-card-help">
          {timings.totalSinceStart.toLocaleString()} requests since start ·{' '}
          {timings.slowSinceStart.toLocaleString()} slow or errored ·{' '}
          showing latest {sorted.length}.
        </p>
      </header>
      {sorted.length === 0 ? (
        <div className="diagnostics-empty">
          No API calls captured yet. Slow + errored requests are always recorded;
          fast ones are 1-in-5 sampled.
        </div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Time</th>
                <th style={{ width: 60 }}>Method</th>
                <th>Route</th>
                <th style={{ width: 80 }}>Status</th>
                <th style={{ width: 90 }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const erroring = t.status === 0 || t.status >= 400;
                const slow = t.durationMs >= timings.thresholdMs;
                const cls = erroring
                  ? 'diagnostics-severity-danger'
                  : slow
                    ? 'diagnostics-severity-warn'
                    : '';
                return (
                  <tr key={`${t.at}-${i}`}>
                    <td title={new Date(t.at).toISOString()}>{formatRelative(t.at)}</td>
                    <td><code>{t.method}</code></td>
                    <td className="diagnostics-sql"><code>{t.route}</code></td>
                    <td><code className={erroring ? 'diagnostics-severity-danger' : ''}>{t.status || (t.error ? 'ERR' : '—')}</code></td>
                    <td><code className={cls}>{formatMs(t.durationMs)} ms</code></td>
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

function DbWorkerCard({
  timings,
}: {
  timings: DbWorkerTimings;
}) {
  const sorted = useMemo(
    () => [...timings.recent].sort((a, b) => b.at - a.at),
    [timings.recent],
  );
  const inlinePct = timings.totalSinceStart > 0
    ? Math.round((timings.inlineSinceStart / timings.totalSinceStart) * 100)
    : 0;
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">
          DB worker batches
          {!timings.workerEnabled && (
            <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
              inline fallback
            </span>
          )}
          {timings.pendingRequests > 0 && (
            <span className="diagnostics-pill" style={{ marginLeft: 6 }}>
              {timings.pendingRequests} pending
            </span>
          )}
        </h2>
        <p className="diagnostics-card-help">
          {timings.totalSinceStart.toLocaleString()} batches since start ·{' '}
          {timings.failedSinceStart.toLocaleString()} failed ·{' '}
          {timings.inlineSinceStart.toLocaleString()} inline ({inlinePct}%) ·{' '}
          showing latest {sorted.length}.
        </p>
      </header>
      {sorted.length === 0 ? (
        <div className="diagnostics-empty">
          No DB worker batches captured yet. Bulk onboarding writes will appear here.
        </div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Time</th>
                <th style={{ width: 80 }}>Mode</th>
                <th style={{ width: 90 }}>Outcome</th>
                <th style={{ width: 90 }}>Statements</th>
                <th style={{ width: 80 }}>Changes</th>
                <th style={{ width: 90 }}>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((batch, i) => {
                const erroring = batch.outcome === 'error';
                const slow = batch.durationMs >= 1000;
                return (
                  <tr key={`${batch.at}-${i}`}>
                    <td title={new Date(batch.at).toISOString()}>{formatRelative(batch.at)}</td>
                    <td>
                      <code className={batch.inline ? 'diagnostics-severity-warn' : ''}>
                        {batch.inline ? 'inline' : 'worker'}
                      </code>
                    </td>
                    <td>
                      <code className={erroring ? 'diagnostics-severity-danger' : ''}>
                        {batch.outcome}
                      </code>
                    </td>
                    <td>
                      <code>
                        {batch.statementCount.toLocaleString()} / {batch.chunkSize}
                      </code>
                    </td>
                    <td><code>{batch.totalChanges.toLocaleString()}</code></td>
                    <td>
                      <code className={erroring ? 'diagnostics-severity-danger' : slow ? 'diagnostics-severity-warn' : ''}>
                        {formatMs(batch.durationMs)} ms
                      </code>
                    </td>
                    <td className="diagnostics-sql">
                      <code>
                        {batch.error
                          ? `${batch.error}${batch.failedAtIndex !== undefined ? ` @${batch.failedAtIndex}` : ''}`
                          : batch.workerDurationMs !== undefined
                            ? `worker ${formatMs(batch.workerDurationMs)} ms`
                            : '—'}
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
  const longTasksSorted = useMemo(
    () => [...snapshot.longTasks.recent].sort((a, b) => b.at - a.at).slice(0, 30),
    [snapshot.longTasks.recent],
  );
  const importEventsSorted = useMemo(
    () => [...snapshot.importEvents].sort((a, b) => b.at - a.at).slice(0, 40),
    [snapshot.importEvents],
  );
  const inflight = snapshot.fetches.inflight;
  const recentFetches = useMemo(
    () => [...snapshot.fetches.recent].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20),
    [snapshot.fetches.recent],
  );
  const longestInflight = inflight[0]?.durationMs ?? 0;
  const installedAgo = snapshot.installedAt
    ? Math.max(0, snapshot.generatedAt - snapshot.installedAt)
    : 0;

  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="diagnostics-card-title">
              Client activity (renderer)
              <span className="diagnostics-pill" style={{ marginLeft: 8 }}>
                long task ≥ {snapshot.longTasks.thresholdMs}ms
              </span>
              {!snapshot.longTaskObserverActive && (
                <span className="diagnostics-pill" style={{ marginLeft: 6 }}>
                  rAF fallback
                </span>
              )}
            </h2>
            <p className="diagnostics-card-help">
              {snapshot.longTasks.totalSinceStart.toLocaleString()} long tasks ·{' '}
              {snapshot.fetches.slowCount.toLocaleString()} slow fetches ·{' '}
              {snapshot.fetches.failedCount.toLocaleString()} failed ·{' '}
              {inflight.length} in flight
              {inflight.length > 0 && longestInflight > 1000 && (
                <> · oldest pending {Math.round(longestInflight / 100) / 10}s</>
              )}
              {installedAgo > 0 && (
                <> · capturing for {formatDuration(installedAgo)}</>
              )}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClear}
          >
            Clear client rings
          </button>
        </div>
      </header>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {/* Long tasks */}
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-2)' }}>
            Long tasks {longTasksSorted.length > 0 && `(${longTasksSorted.length} most recent)`}
          </h3>
          {longTasksSorted.length === 0 ? (
            <div className="diagnostics-empty" style={{ padding: 12, fontSize: 12 }}>
              No long tasks captured. {snapshot.longTaskObserverActive
                ? 'The main thread has been responsive.'
                : 'On WebKit the PerformanceObserver fallback uses rAF gaps; only large stalls show up here.'}
            </div>
          ) : (
            <div className="diagnostics-table-wrap">
              <table className="diagnostics-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Time</th>
                    <th style={{ width: 100 }}>Duration</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {longTasksSorted.map((lt, i) => (
                    <tr key={`${lt.at}-${i}`}>
                      <td title={new Date(lt.at).toISOString()}>{formatRelative(lt.at)}</td>
                      <td>
                        <code className={lt.durationMs >= 200 ? 'diagnostics-severity-danger' : 'diagnostics-severity-warn'}>
                          {formatMs(lt.durationMs)} ms
                        </code>
                      </td>
                      <td><code>{lt.source}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Fetch activity */}
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-2)' }}>
            Fetch activity (slow ≥ {snapshot.fetches.slowThresholdMs}ms)
          </h3>
          {inflight.length === 0 && recentFetches.length === 0 ? (
            <div className="diagnostics-empty" style={{ padding: 12, fontSize: 12 }}>
              No slow or in-flight fetches.
            </div>
          ) : (
            <div className="diagnostics-table-wrap">
              <table className="diagnostics-table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>Phase</th>
                    <th style={{ width: 60 }}>Method</th>
                    <th>URL</th>
                    <th style={{ width: 80 }}>Status</th>
                    <th style={{ width: 90 }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {inflight.map((f, i) => (
                    <tr key={`if-${i}`}>
                      <td><code className="diagnostics-severity-warn">inflight</code></td>
                      <td><code>{f.method}</code></td>
                      <td className="diagnostics-sql"><code>{f.url}</code></td>
                      <td>—</td>
                      <td><code>{formatMs(f.durationMs)} ms</code></td>
                    </tr>
                  ))}
                  {recentFetches.map((f, i) => {
                    const erroring = f.phase === 'failed' || (f.status !== undefined && f.status >= 400);
                    return (
                      <tr key={`f-${f.startedAt}-${i}`}>
                        <td>
                          <code className={erroring ? 'diagnostics-severity-danger' : ''}>
                            {f.phase}
                          </code>
                        </td>
                        <td><code>{f.method}</code></td>
                        <td className="diagnostics-sql" title={f.error || undefined}>
                          <code>{f.url}</code>
                        </td>
                        <td><code className={erroring ? 'diagnostics-severity-danger' : ''}>{f.status ?? '—'}</code></td>
                        <td><code>{formatMs(f.durationMs)} ms</code></td>
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
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-2)' }}>
            Import events (latest {importEventsSorted.length})
          </h3>
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Time</th>
                  <th style={{ width: 200 }}>Event</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {importEventsSorted.map((ev, i) => (
                  <tr key={`${ev.at}-${i}`}>
                    <td title={new Date(ev.at).toISOString()}>{formatRelative(ev.at)}</td>
                    <td><code>{ev.name}</code></td>
                    <td className="diagnostics-sql"><code>{ev.detail ?? '—'}</code></td>
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
  const t = useTranslations('diagnostics_page.card_flags');
  const tLoad = useTranslations('diagnostics_page');
  return (
    <section className="diagnostics-card diagnostics-card--wide">
      <header className="diagnostics-card-header">
        <h2 className="diagnostics-card-title">{t('title')}</h2>
        <p className="diagnostics-card-help">{t('help')}</p>
      </header>
      {rows.length === 0 ? (
        <div className="diagnostics-empty">{t('no_overrides')}</div>
      ) : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th>{t('col_key')}</th>
                <th>{t('col_default')}</th>
                <th>{t('col_current')}</th>
                <th>{t('col_override')}</th>
                <th>{t('col_wired')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key}>
                  <td><code>{r.key}</code></td>
                  <td><code>{r.hardDefault}</code></td>
                  <td><code>{r.currentValue}</code></td>
                  <td>{r.override === null ? tLoad('em_dash') : <code>{r.override}</code>}</td>
                  <td>{r.wired ? t('wired_yes') : t('wired_no')}</td>
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
  const t = useTranslations('diagnostics_page.severity_pill');
  const label =
    severity === 'danger' ? t('beach_balling') :
    severity === 'warn' ? t('jank') : t('healthy');
  return (
    <span className={`diagnostics-severity-pill diagnostics-severity-${severity}`}>
      {label}
    </span>
  );
}
