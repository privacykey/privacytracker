/**
 * Activity log — user-facing timeline of what the system has been doing.
 *
 * Distinct from two other logs already in the DB:
 *
 *   - `audit_log`      — privileged / destructive requests (reset, backup
 *                        restore) with actor IP + UA. Stays terse because
 *                        it's a forensic trail, not a UX surface.
 *   - `ai_debug_log`   — full prompt/response dumps, only populated when the
 *                        user has opted into developer logging.
 *
 * `activity_log` sits between those two: it's always on, captures the
 * high-signal boundary events that touch user data (scrapes, re-syncs,
 * AI summaries, scheduled runs, backup/restore) and can be displayed
 * without revealing any sensitive payloads.
 *
 * The API is deliberately boring — a single `recordActivity` helper that
 * returns after inserting, and a `getRecentActivity` reader with a cursor.
 * Callers should call `recordActivity` exactly once per operation, at the
 * outermost boundary, so we don't double-count nested work (e.g. a
 * scheduled sync calling resync-app in a loop records one row per app and
 * one summary row for the scheduled run itself, not a cascade).
 */

import db from "./db";

/**
 * Maximum rows we keep in `activity_log` at rest. Older rows are dropped on
 * insert. Tuned high enough that a daily sync across 200 apps + summaries
 * can still show ~two weeks of history, but low enough that the DB doesn't
 * grow unbounded on pathological churn.
 */
const ACTIVITY_RETENTION = 2000;

export type ActivityType =
  | "scrape"
  | "resync"
  | "policy_summary"
  | "scheduled_sync"
  | "manual_sync"
  | "import"
  | "wayback_import"
  | "backup_export"
  | "backup_restore"
  | "reset"
  // Round 3 PR 1: migration step events. Per-step + summary rows so the
  // Dev Options activity-log accordion can show "what the migration did" at
  // boot-time. Annotation events use this type too — create/edit/delete of
  // user annotations on App Detail surfaces here for the same audit-log reasons.
  | "migration"
  | "annotation_created"
  | "annotation_edited"
  | "annotation_deleted"
  // Per-app verdict events. Verdicts ('safe' | 'replace' | 'uninstall')
  // are categorical decisions distinct from freeform annotations — they
  // surface here so the dashboard activity feed and the Dev Options
  // audit log can show "marked X as uninstall on Y" alongside note
  // edits and syncs.
  | "verdict_set"
  | "verdict_cleared"
  // Bulk verdict apply (Select mode in AppGrid). One row per bulk apply,
  // with `detail.count` + `detail.verdict` + `detail.appIds`. Per-app
  // `verdict_set` rows are *not* written for bulk applies — the single
  // summary row covers the audit trail without flooding the feed.
  | "bulk_verdict_set"
  // Queue session completion. One row at session end with totals
  // (kept/replace/uninstall/notes) and the preflight choices used.
  | "queue_session_completed"
  // Phase 3 device-action events. Backups + uninstalls land here so
  // the Dev Options activity log retains a forensic trail of every
  // destructive cfgutil call. `cfgutil_uninstall` rows include the
  // bundle ID + ecid + per-row outcome in the detail blob; the
  // dashboard activity feed just shows the summary string.
  | "cfgutil_backup"
  | "cfgutil_uninstall"
  | "flag_quarantined_purged"
  // Round 3 v1 final: audit-bundle imports — counterpart to backup_export
  // but for the recommender → loved-one workflow. One row per accepted
  // import; the detail blob carries the summary numbers + recommender
  // name for the dashboard provenance banner.
  | "bundle_imported"
  // Privacy-profile preset boundary transitions — rows surface when the
  // user picks a preset, switches between presets, or clears a profile.
  // Custom-to-custom edits inside a non-preset state don't fire (the
  // activity log is for noteworthy transitions, not keystroke-level
  // edits). The describePresetTransition helper in lib/privacy-profile.ts
  // is the single source of truth for when to write one of these.
  | "profile_preset_applied"
  // Dashboard layout preset boundary transitions — mirrors
  // `profile_preset_applied`. Surfaces only when the change crosses a
  // named preset (default/minimal/caretaker/watchdog/at_a_glance). The
  // editor saves at every keystroke, so custom-to-custom edits never
  // fire — `describeLayoutTransition` in lib/dashboard-layout.ts is the
  // gate.
  | "dashboard_layout_applied";

export type ActivityStatus = "ok" | "error" | "partial" | "cancelled";

export interface ActivityRow {
  appId: string | null;
  appName: string | null;
  /** Parsed JSON if the stored blob is valid JSON; otherwise null. */
  detail: Record<string, unknown> | null;
  durationMs: number | null;
  endedAt: number | null;
  id: string;
  startedAt: number;
  status: ActivityStatus;
  summary: string | null;
  type: ActivityType;
}

interface RecordActivityInput {
  appId?: string | null;
  appName?: string | null;
  detail?: Record<string, unknown> | null;
  endedAt?: number | null;
  startedAt: number;
  status: ActivityStatus;
  summary?: string | null;
  type: ActivityType;
}

/**
 * Insert an activity row. Fire-and-forget: we swallow errors and log to
 * console because the caller's work has already succeeded/failed by the
 * time this runs — we don't want the logger to break a user-facing
 * operation.
 */
export function recordActivity(input: RecordActivityInput): void {
  const id = globalThis.crypto?.randomUUID?.() ?? fallbackId();
  const endedAt = input.endedAt ?? Date.now();
  const durationMs = Math.max(0, endedAt - input.startedAt);

  try {
    db.prepare(
      `INSERT INTO activity_log
         (id, type, status, app_id, app_name, summary, detail,
          started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.type,
      input.status,
      input.appId ?? null,
      input.appName ?? null,
      input.summary ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      input.startedAt,
      endedAt,
      durationMs
    );

    // Enforce retention cap — delete oldest rows beyond ACTIVITY_RETENTION.
    // SQLite's LIMIT-in-DELETE isn't universally available in every build,
    // so we do it in two steps: count, then delete oldest if over.
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM activity_log")
      .get() as { n: number };
    if (count.n > ACTIVITY_RETENTION) {
      const overflow = count.n - ACTIVITY_RETENTION;
      db.prepare(
        `DELETE FROM activity_log
          WHERE id IN (
            SELECT id FROM activity_log
            ORDER BY started_at ASC
            LIMIT ?
          )`
      ).run(overflow);
    }
  } catch (error) {
    console.warn("[activity] recordActivity failed:", error);
  }
}

export type ActivitySortField = "started_at" | "ended_at" | "duration_ms";
export type ActivitySortDir = "asc" | "desc";

export interface ActivityFilterOptions {
  /**
   * Lower-bound inclusive epoch-ms on `started_at`. Used by the UI
   * "last X minutes / hours / days" filter — computed on the client and
   * passed in as an absolute timestamp so the server stays stateless.
   */
  since?: number;
  /** Filter to a specific status, or omit to return all. */
  status?: ActivityStatus;
  /** Filter to a specific type, or omit to return all. */
  type?: ActivityType;
  /** Upper-bound inclusive epoch-ms on `started_at`. Usually unused. */
  until?: number;
}

export interface GetActivityOptions extends ActivityFilterOptions {
  limit?: number;
  offset?: number;
  sortBy?: ActivitySortField;
  sortDir?: ActivitySortDir;
}

/**
 * Compose a parameterised WHERE clause from the filter options. Returns
 * the SQL fragment (including the leading "WHERE" if any filters apply)
 * plus the ordered positional bind values. Keeping this in one place so
 * the reader and counter stay in lockstep.
 */
function buildFilterClause(opts: ActivityFilterOptions): {
  sql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.type) {
    clauses.push("type = ?");
    params.push(opts.type);
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (typeof opts.since === "number" && Number.isFinite(opts.since)) {
    clauses.push("started_at >= ?");
    params.push(opts.since);
  }
  if (typeof opts.until === "number" && Number.isFinite(opts.until)) {
    clauses.push("started_at <= ?");
    params.push(opts.until);
  }
  if (clauses.length === 0) {
    return { sql: "", params };
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function buildOrderClause(
  sortBy: ActivitySortField | undefined,
  sortDir: ActivitySortDir | undefined
): string {
  const field: ActivitySortField = sortBy ?? "started_at";
  const dir: ActivitySortDir = sortDir ?? "desc";
  // `duration_ms` and `ended_at` can be NULL for still-running rows — we
  // want those sorted last regardless of direction so the listing reads
  // "newest completed first, in-flight below". SQLite treats NULL as
  // smaller than anything else by default, so we coalesce for asc.
  if (field === "duration_ms") {
    return dir === "asc"
      ? "ORDER BY COALESCE(duration_ms, 9223372036854775807) ASC, started_at DESC"
      : "ORDER BY COALESCE(duration_ms, -1) DESC, started_at DESC";
  }
  if (field === "ended_at") {
    return dir === "asc"
      ? "ORDER BY COALESCE(ended_at, 9223372036854775807) ASC, started_at DESC"
      : "ORDER BY COALESCE(ended_at, 0) DESC, started_at DESC";
  }
  return dir === "asc" ? "ORDER BY started_at ASC" : "ORDER BY started_at DESC";
}

export function getRecentActivity(
  opts: GetActivityOptions = {}
): ActivityRow[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const offset = Math.max(0, opts.offset ?? 0);

  const { sql: whereSql, params: whereParams } = buildFilterClause(opts);
  const orderSql = buildOrderClause(opts.sortBy, opts.sortDir);

  const rows = db
    .prepare(
      `SELECT id, type, status, app_id, app_name, summary, detail,
              started_at, ended_at, duration_ms
         FROM activity_log
         ${whereSql}
         ${orderSql}
         LIMIT ? OFFSET ?`
    )
    .all(...whereParams, limit, offset);

  return (rows as unknown[]).map((row) => {
    const r = row as {
      id: string;
      type: string;
      status: string;
      app_id: string | null;
      app_name: string | null;
      summary: string | null;
      detail: string | null;
      started_at: number;
      ended_at: number | null;
      duration_ms: number | null;
    };
    let detail: Record<string, unknown> | null = null;
    if (r.detail) {
      try {
        detail = JSON.parse(r.detail);
      } catch {
        detail = null;
      }
    }
    return {
      id: r.id,
      type: r.type as ActivityType,
      status: r.status as ActivityStatus,
      appId: r.app_id,
      appName: r.app_name,
      summary: r.summary,
      detail,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
    };
  });
}

export function countRecentActivity(opts: ActivityFilterOptions = {}): number {
  const { sql: whereSql, params } = buildFilterClause(opts);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM activity_log ${whereSql}`)
    .get(...params) as { n: number };
  return row.n;
}

/**
 * Fallback id generator for runtimes without `crypto.randomUUID`. We pin
 * Node 24 LTS everywhere (Docker, Tauri sidecar, `engines` in package.json),
 * all of which have it, so this is purely a safety net.
 */
function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
