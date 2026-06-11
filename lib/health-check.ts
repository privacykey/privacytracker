/**
 * Periodic server health check + non-destructive self-heal.
 *
 * Several self-healing routines today only run **at boot**
 * (`instrumentation.ts` clears stale bulk-job mutexes; `lib/db.ts` resets
 * stuck `run_status='running'` rows). A process that survives for days
 * (Docker `next start`, or the Tauri sidecar that can run for weeks) never
 * re-applies that hygiene. This module re-applies the safe heals at runtime
 * on a 24h cadence, checkpoints the WAL, and records a structured health
 * report to the activity log.
 *
 * SCOPE (deliberately conservative — see CLAUDE.md "Health check + self-heal"):
 *   - **Non-destructive heals only.** We checkpoint the WAL, clear
 *     provably-dead job locks, and reset stuck job status. We NEVER delete
 *     content rows (no VACUUM, no pruning of notifications/snapshots, no
 *     orphan-row deletion) — anything that would delete data is report-only.
 *   - **Activity log only.** One `health_check` activity row per run + a
 *     persisted result blob. No bell notification, no webhook.
 *
 * SAFETY (the load-bearing parts):
 *   - WAL checkpoint uses PASSIVE (never TRUNCATE) and is skipped when any
 *     bulk job is active — the db-worker holds a separate writer connection
 *     on the same WAL, and TRUNCATE could block / throw SQLITE_BUSY.
 *   - A job lock is cleared ONLY when it is provably dead:
 *       held AND (no state OR no pending work OR no progress in > stale margin)
 *       AND not paused AND not cancel-requested.
 *     The runner rewrites its state blob (bumping `updatedAt`) at every app
 *     boundary, so a slow-but-live run is never mistaken for dead. Predicate
 *     evaluation and lock release happen in one synchronous slice (no `await`
 *     between) so check-and-act is atomic on the event loop.
 */

import { recordActivity } from "./activity";
import db from "./db";
import { runIntegrityCheck, snapshotDatabaseHealth } from "./db-health";
import {
  clearPolicyBulkState,
  hasPolicyPendingWork,
  isPolicyBulkMutexHeld,
  readPolicyBulkState,
  releasePolicyBulkMutex,
} from "./policy-bulk-state";
import { snapshotRuntimeMetrics } from "./runtime-diagnostics";
import { getSetting, setSetting } from "./scheduler";
import {
  clearSyncBulkState,
  hasSyncPendingWork,
  isSyncBulkMutexHeld,
  readSyncBulkState,
  releaseSyncBulkMutex,
} from "./sync-bulk-state";
import {
  clearBulkState,
  hasPendingWork,
  isBulkMutexHeld,
  isBulkStateCancellationRequested,
  isBulkStatePaused,
  readBulkState,
  releaseBulkMutex,
} from "./wayback-bulk-state";

// ── Constants ────────────────────────────────────────────────────────

/** Bump when the persisted result JSON shape changes incompatibly. */
const RESULT_VERSION = 1;

const HEALTH_RUNNING_KEY = "health_check_running";
const HEALTH_RUNNING_SINCE_KEY = "health_check_running_since";
const HEALTH_LAST_RESULT_KEY = "health_check_last_result";
const HEALTH_LAST_RUN_AT_KEY = "health_check_last_run_at";

/** Self-heal the health lock if a prior run wedged it (should never happen). */
const HEALTH_LOCK_STALE_MS = 5 * 60_000;

const BYTES_PER_MB = 1024 * 1024;
const HOUR_MS = 60 * 60_000;

/** heapUsed/heapLimit above this is a memory-pressure warning. */
const HEAP_FRACTION_WARN = 0.85;
/** Below this data-page utilisation %, the file is considered fragmented. */
const FRAGMENTATION_UTIL_WARN = 50;
/** Above this freelist page count, the file is considered fragmented. */
const FREELIST_WARN = 1000;

// ── Config ───────────────────────────────────────────────────────────

export interface HealthCheckConfig {
  /** Gates the SCHEDULED ticker only — a manual POST always runs. */
  enabled: boolean;
  /** Run PRAGMA integrity_check (slow). Default off. */
  integrityEnabled: boolean;
  /** Skip integrity check above this file size even when enabled. */
  integrityMaxBytes: number;
  /** rssMb above this is a memory warning. */
  rssWarnMb: number;
  /** Clear a held job lock whose state hasn't progressed in this long. */
  staleLockMs: number;
  /** Reset `run_status='running'` rows older than this. */
  stuckRunMs: number;
  /** Checkpoint the WAL when it exceeds this many bytes. */
  walCheckpointBytes: number;
}

function readNum(key: string, def: number): number {
  const raw = getSetting(key, "");
  if (!raw) {
    return def;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function readHealthCheckConfig(): HealthCheckConfig {
  return {
    enabled: getSetting("health_check_enabled", "true") !== "false",
    walCheckpointBytes:
      readNum("health_check_wal_checkpoint_mb", 64) * BYTES_PER_MB,
    stuckRunMs: readNum("health_check_stuck_run_hours", 6) * HOUR_MS,
    staleLockMs: readNum("health_check_stale_lock_hours", 6) * HOUR_MS,
    integrityEnabled:
      getSetting("health_check_integrity_enabled", "false") === "true",
    integrityMaxBytes:
      readNum("health_check_integrity_max_mb", 256) * BYTES_PER_MB,
    rssWarnMb: readNum("health_check_rss_warn_mb", 2048),
  };
}

// ── Result type ──────────────────────────────────────────────────────

export type HealthCheckTrigger = "scheduled" | "manual";

export type HealStatus = "ok" | "partial" | "error";

export type HealKind =
  | "wal_checkpoint"
  | "stale_lock_sync"
  | "stale_lock_wayback"
  | "stale_lock_policy"
  | "stale_lock_import_queue"
  | "policy_run_status_reset";

export type SkipReason =
  | "bulk-active"
  | "not-needed"
  | "busy"
  | "too-large"
  | "disabled";

export interface HealthIntegrityResult {
  checkedAt: number;
  detail?: string;
  durationMs: number;
  /** True when this run scanned the DB; false when a cached value is shown. */
  fresh: boolean;
  status: "ok" | "error";
}

export interface HealthCheckResult {
  checks: {
    database: {
      utilisationPct: number;
      freelistCount: number;
      walBytes: number;
      fileBytes: number;
      foreignKeysEnabled: 0 | 1;
      fragmented: boolean;
      integrity: HealthIntegrityResult | { skipped: SkipReason } | null;
    };
    runtime: {
      rssMb: number;
      heapFractionUsed: number;
      heapBreach: boolean;
      eventLoopP99Ms: number;
      eventLoopSeverity: "ok" | "warn" | "danger";
    };
    counts: {
      notifications: number;
      privacySnapshots: number;
      activityLog: number;
      aiDebugLog: number;
    };
    /** Orphan rows in FK-less tables — REPORTED, never deleted. */
    orphans: {
      manualAppEvents: number;
      manualAppPolicyVersions: number;
    };
    /** Human-readable abnormality strings for the activity summary. */
    warnings: string[];
  };
  durationMs: number;
  error?: string;
  finishedAt: number;
  /** Heals actually performed (non-destructive only). */
  heals: Array<{ kind: HealKind; affected?: number; detail?: string }>;
  /** True ⟺ no warnings AND no heals AND no error. Drives quiet logging. */
  healthy: boolean;
  /** Set when the whole run was skipped (another run held the lock). */
  skipped?: "busy";
  /** Heals intentionally NOT run, with reason (observability). */
  skippedHeals: Array<{ kind: HealKind; reason: SkipReason }>;
  startedAt: number;
  status: HealStatus;
  trigger: HealthCheckTrigger;
  version: number;
}

// ── Lock ─────────────────────────────────────────────────────────────

function acquireHealthLock(): boolean {
  if (getSetting(HEALTH_RUNNING_KEY, "false") === "true") {
    const since =
      Number.parseInt(getSetting(HEALTH_RUNNING_SINCE_KEY, "0"), 10) || 0;
    const stale = since > 0 && Date.now() - since > HEALTH_LOCK_STALE_MS;
    if (!stale) {
      return false;
    }
    console.warn("[HealthCheck] Clearing stale health-check lock");
  }
  setSetting(HEALTH_RUNNING_KEY, "true");
  setSetting(HEALTH_RUNNING_SINCE_KEY, String(Date.now()));
  return true;
}

function releaseHealthLock(): void {
  setSetting(HEALTH_RUNNING_KEY, "false");
}

/** Any bulk writer that we must not contend with on the WAL write lock. */
function anyBulkActive(): boolean {
  return (
    isSyncBulkMutexHeld() ||
    isBulkMutexHeld() ||
    isPolicyBulkMutexHeld() ||
    getSetting("import_queue_running", "false") === "true"
  );
}

// ── Stale-lock heals (predicate-gated; safe regardless of bulk activity) ──

interface BulkLockProbe {
  clear(): void;
  hasPending(state: unknown): boolean;
  isCancel?(state: unknown): boolean;
  isHeld(): boolean;
  isPaused?(state: unknown): boolean;
  kind: HealKind;
  read(): { updatedAt: number } | null;
  release(): void;
}

/**
 * A held lock is "dead" — and therefore safe to clear — only when there is
 * provably no live runner behind it. See the module-header safety note.
 */
function bulkLockIsDead(probe: BulkLockProbe, staleLockMs: number): boolean {
  if (!probe.isHeld()) {
    return false;
  }
  const state = probe.read();
  // Never touch a user-paused or cancel-requested queue — the boot path and
  // the Settings UI own those transitions.
  if (probe.isPaused?.(state) || probe.isCancel?.(state)) {
    return false;
  }
  if (state === null) {
    return true; // mutex held but no state blob → orphaned lock
  }
  if (!probe.hasPending(state)) {
    return true; // completed run that never released its lock
  }
  // Pending work remains, but the runner hasn't advanced an app boundary in a
  // very long time → the owning process is gone. Negative age (clock skew)
  // is treated as "recent" so we never clear on a backwards clock.
  const age = Date.now() - state.updatedAt;
  return age > staleLockMs;
}

function healBulkLocks(
  staleLockMs: number,
  heals: HealthCheckResult["heals"]
): void {
  const probes: BulkLockProbe[] = [
    {
      kind: "stale_lock_sync",
      isHeld: isSyncBulkMutexHeld,
      read: readSyncBulkState,
      hasPending: (s) => hasSyncPendingWork(s as never),
      release: releaseSyncBulkMutex,
      clear: clearSyncBulkState,
    },
    {
      kind: "stale_lock_wayback",
      isHeld: isBulkMutexHeld,
      read: readBulkState,
      hasPending: (s) => hasPendingWork(s as never),
      isPaused: (s) => isBulkStatePaused(s as never),
      isCancel: (s) => isBulkStateCancellationRequested(s as never),
      release: releaseBulkMutex,
      clear: clearBulkState,
    },
    {
      kind: "stale_lock_policy",
      isHeld: isPolicyBulkMutexHeld,
      read: readPolicyBulkState,
      hasPending: (s) => hasPolicyPendingWork(s as never),
      release: releasePolicyBulkMutex,
      clear: clearPolicyBulkState,
    },
  ];

  for (const probe of probes) {
    try {
      if (!bulkLockIsDead(probe, staleLockMs)) {
        continue;
      }
      // Atomic check-and-act: no `await` between predicate and release.
      db.transaction(() => {
        probe.release();
        probe.clear();
      })();
      heals.push({ kind: probe.kind, detail: "cleared dead job lock" });
      console.warn(`[HealthCheck] Cleared dead lock: ${probe.kind}`);
    } catch (e) {
      console.error(`[HealthCheck] Failed clearing ${probe.kind}:`, e);
    }
  }

  // Import-queue lock: its own 60s ticker clears a 90s-stale lock, so this is
  // only a deep backstop for when that ticker itself has stopped.
  try {
    if (getSetting("import_queue_running", "false") === "true") {
      const since =
        Number.parseInt(getSetting("import_queue_running_since", "0"), 10) || 0;
      const age = since > 0 ? Date.now() - since : 0;
      if (since > 0 && age > staleLockMs) {
        setSetting("import_queue_running", "false");
        heals.push({
          kind: "stale_lock_import_queue",
          detail: `lock ${Math.round(age / HOUR_MS)}h old`,
        });
        console.warn("[HealthCheck] Cleared dead import-queue lock");
      }
    }
  } catch (e) {
    console.error("[HealthCheck] Failed clearing import-queue lock:", e);
  }
}

// ── Counts (read-only) ───────────────────────────────────────────────

function countRows(sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// ── Main entry ───────────────────────────────────────────────────────

function blankChecks(): HealthCheckResult["checks"] {
  return {
    database: {
      utilisationPct: 0,
      freelistCount: 0,
      walBytes: 0,
      fileBytes: 0,
      foreignKeysEnabled: 1,
      fragmented: false,
      integrity: null,
    },
    runtime: {
      rssMb: 0,
      heapFractionUsed: 0,
      heapBreach: false,
      eventLoopP99Ms: 0,
      eventLoopSeverity: "ok",
    },
    counts: {
      notifications: 0,
      privacySnapshots: 0,
      activityLog: 0,
      aiDebugLog: 0,
    },
    orphans: { manualAppEvents: 0, manualAppPolicyVersions: 0 },
    warnings: [],
  };
}

/**
 * Run the full health check + safe heals. Synchronous (better-sqlite3 is
 * sync, matching every sibling lib). Never throws — failures are folded into
 * the returned result with `status: 'error'`.
 */
export function runHealthCheck(opts: {
  trigger: HealthCheckTrigger;
}): HealthCheckResult {
  const startedAt = Date.now();

  if (!acquireHealthLock()) {
    return {
      version: RESULT_VERSION,
      trigger: opts.trigger,
      startedAt,
      finishedAt: Date.now(),
      durationMs: 0,
      healthy: true,
      status: "ok",
      skipped: "busy",
      checks: blankChecks(),
      heals: [],
      skippedHeals: [],
    };
  }

  const heals: HealthCheckResult["heals"] = [];
  const skippedHeals: HealthCheckResult["skippedHeals"] = [];
  const checks = blankChecks();
  let topLevelError: string | undefined;
  const cfg = readHealthCheckConfig();

  try {
    // 1. Clear provably-dead job locks FIRST so the bulk-active probe below
    //    reflects reality (a just-cleared lock no longer counts as active).
    healBulkLocks(cfg.staleLockMs, heals);

    const bulkActive = anyBulkActive();

    // 2. WAL checkpoint (PASSIVE, skip-if-bulk-active) — non-destructive.
    const preSnap = snapshotDatabaseHealth();
    if (preSnap.walBytes > cfg.walCheckpointBytes) {
      if (bulkActive) {
        skippedHeals.push({ kind: "wal_checkpoint", reason: "bulk-active" });
      } else {
        try {
          const res = db.pragma("wal_checkpoint(PASSIVE)") as
            | Array<{ checkpointed?: number }>
            | undefined;
          const checkpointed = Array.isArray(res)
            ? res[0]?.checkpointed
            : undefined;
          heals.push({
            kind: "wal_checkpoint",
            affected: checkpointed,
            detail: `wal was ${Math.round(preSnap.walBytes / BYTES_PER_MB)}MB`,
          });
        } catch (e) {
          console.warn("[HealthCheck] WAL checkpoint failed (busy):", e);
        }
      }
    }

    // 3. Reset stuck policy run_status (age-gated; skip if bulk active).
    if (bulkActive) {
      skippedHeals.push({
        kind: "policy_run_status_reset",
        reason: "bulk-active",
      });
    } else {
      try {
        const cutoff = Date.now() - cfg.stuckRunMs;
        const res = db
          .prepare(
            `UPDATE privacy_policy_analyses SET run_status = 'idle'
              WHERE run_status = 'running'
                AND run_started_at IS NOT NULL
                AND run_started_at < ?`
          )
          .run(cutoff);
        if (res.changes > 0) {
          heals.push({
            kind: "policy_run_status_reset",
            affected: res.changes,
          });
        }
      } catch (e) {
        console.error("[HealthCheck] policy run_status reset failed:", e);
      }
    }

    // ── Read-only checks (always run) ──────────────────────────────────
    const snap = snapshotDatabaseHealth();
    const fragmented =
      snap.utilisationPct < FRAGMENTATION_UTIL_WARN ||
      snap.freelistCount > FREELIST_WARN;

    // Integrity: opt-in + size-gated + skip-if-bulk-active.
    let integrity: HealthCheckResult["checks"]["database"]["integrity"];
    if (!cfg.integrityEnabled) {
      integrity = { skipped: "disabled" };
    } else if (bulkActive) {
      integrity = { skipped: "bulk-active" };
    } else if (snap.fileBytes >= cfg.integrityMaxBytes) {
      integrity = { skipped: "too-large" };
    } else {
      const r = runIntegrityCheck();
      integrity = { ...r, fresh: true };
    }

    checks.database = {
      utilisationPct: snap.utilisationPct,
      freelistCount: snap.freelistCount,
      walBytes: snap.walBytes,
      fileBytes: snap.fileBytes,
      foreignKeysEnabled: snap.foreignKeysEnabled,
      fragmented,
      integrity,
    };

    const metrics = snapshotRuntimeMetrics(0);
    const heapBreach = metrics.v8Heap.heapFractionUsed > HEAP_FRACTION_WARN;
    checks.runtime = {
      rssMb: metrics.memory.rssMb,
      heapFractionUsed: metrics.v8Heap.heapFractionUsed,
      heapBreach,
      eventLoopP99Ms: metrics.eventLoop?.p99Ms ?? 0,
      eventLoopSeverity: metrics.eventLoop?.severity ?? "ok",
    };

    checks.counts = {
      notifications: countRows("SELECT COUNT(*) AS n FROM notifications"),
      privacySnapshots: countRows(
        "SELECT COUNT(*) AS n FROM privacy_snapshots"
      ),
      activityLog: countRows("SELECT COUNT(*) AS n FROM activity_log"),
      aiDebugLog: countRows("SELECT COUNT(*) AS n FROM ai_debug_log"),
    };

    checks.orphans = {
      manualAppEvents: countRows(
        "SELECT COUNT(*) AS n FROM manual_app_events WHERE manual_app_id NOT IN (SELECT id FROM manual_apps)"
      ),
      manualAppPolicyVersions: countRows(
        "SELECT COUNT(*) AS n FROM manual_app_policy_versions WHERE manual_app_id NOT IN (SELECT id FROM manual_apps)"
      ),
    };

    // ── Derive warnings ────────────────────────────────────────────────
    const warnings: string[] = [];
    if (snap.foreignKeysEnabled !== 1) {
      warnings.push("foreign_keys disabled");
    }
    if (integrity && "status" in integrity && integrity.status === "error") {
      warnings.push(`integrity check failed: ${integrity.detail ?? "unknown"}`);
    }
    if (heapBreach) {
      warnings.push(
        `heap ${Math.round(metrics.v8Heap.heapFractionUsed * 100)}% of limit`
      );
    }
    if (metrics.memory.rssMb > cfg.rssWarnMb) {
      warnings.push(`RSS ${Math.round(metrics.memory.rssMb)}MB`);
    }
    if (checks.runtime.eventLoopSeverity !== "ok") {
      warnings.push(
        `event-loop p99 ${Math.round(checks.runtime.eventLoopP99Ms)}ms`
      );
    }
    // NOTE: `fragmented` is reported in checks.database but deliberately NOT a
    // warning — without VACUUM (excluded by scope) it isn't actionable, and a
    // freshly-reset DB legitimately carries freelist pages.
    const orphanTotal =
      checks.orphans.manualAppEvents + checks.orphans.manualAppPolicyVersions;
    if (orphanTotal > 0) {
      warnings.push(`${orphanTotal} orphan manual-app rows (not auto-deleted)`);
    }
    if (checks.counts.activityLog > 2000) {
      warnings.push(`activity_log over cap (${checks.counts.activityLog})`);
    }
    if (checks.counts.aiDebugLog > 50) {
      warnings.push(`ai_debug_log over cap (${checks.counts.aiDebugLog})`);
    }
    checks.warnings = warnings;

    // ── Status ─────────────────────────────────────────────────────────
    const hardError =
      snap.foreignKeysEnabled !== 1 ||
      Boolean(
        integrity && "status" in integrity && integrity.status === "error"
      );
    let status: HealStatus = "ok";
    if (hardError) {
      status = "error";
    } else if (warnings.length > 0 || heals.length > 0) {
      status = "partial";
    }
    const healthy = status === "ok";

    const finishedAt = Date.now();
    const result: HealthCheckResult = {
      version: RESULT_VERSION,
      trigger: opts.trigger,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      healthy,
      status,
      checks,
      heals,
      skippedHeals,
    };

    persistAndRecord(result);
    return result;
  } catch (e) {
    topLevelError = e instanceof Error ? e.message : String(e);
    console.error("[HealthCheck] run failed:", e);
    const finishedAt = Date.now();
    const result: HealthCheckResult = {
      version: RESULT_VERSION,
      trigger: opts.trigger,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      healthy: false,
      status: "error",
      error: topLevelError,
      checks,
      heals,
      skippedHeals,
    };
    try {
      persistAndRecord(result);
    } catch {
      // best-effort
    }
    return result;
  } finally {
    releaseHealthLock();
  }
}

function persistAndRecord(result: HealthCheckResult): void {
  try {
    setSetting(HEALTH_LAST_RESULT_KEY, JSON.stringify(result));
    setSetting(HEALTH_LAST_RUN_AT_KEY, String(result.finishedAt));
  } catch (e) {
    console.warn("[HealthCheck] persist failed:", e);
  }
  // Write the activity row LAST so the activity_log count above doesn't
  // include this run's own row.
  const healSummary =
    result.heals.length > 0
      ? ` — healed ${result.heals.map((h) => h.kind).join(", ")}`
      : "";
  const warnSummary =
    result.checks.warnings.length > 0
      ? ` — ${result.checks.warnings.join("; ")}`
      : "";
  recordActivity({
    type: "health_check",
    status: result.status,
    summary: `Health check ${result.status}${healSummary}${warnSummary}`,
    detail: result as unknown as Record<string, unknown>,
    startedAt: result.startedAt,
    endedAt: result.finishedAt,
  });
}

/**
 * Read the last persisted result. Returns null on absent / invalid / version
 * mismatch (mirrors the `read*BulkState` defensive parse).
 */
export function readLastHealthCheck(): HealthCheckResult | null {
  const raw = getSetting(HEALTH_LAST_RESULT_KEY, "");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== RESULT_VERSION
    ) {
      return null;
    }
    return parsed as HealthCheckResult;
  } catch {
    return null;
  }
}
