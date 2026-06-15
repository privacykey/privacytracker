/**
 * Feature flag storage — SQLite-backed override persistence. Wraps queries
 * against the `feature_flag_overrides` table and the focus keys in
 * `app_settings`. The resolver in `lib/feature-flags.ts` imports from here.
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags
 */

import db from "./db";
import {
  type Audience,
  activeGoalsFrom,
  type FlagKey,
  type FlagValue,
  type FocusState,
  HARD_DEFAULTS,
} from "./feature-flag-rules";
import {
  type FocusWorkflow,
  inferFocusWorkflow,
  isFocusWorkflow,
} from "./focus-workflow";
import { getSetting, setSetting } from "./scheduler";

// ============================================================================
// Override read/write
// ============================================================================

/**
 * Read all non-quarantined overrides as a Map. Quarantined rows (keys not
 * in the current FlagKey union) are excluded but persist in the DB.
 */
export function getAllOverrides(): Map<FlagKey, FlagValue> {
  const rows = db
    .prepare(
      `SELECT flag_key, override_value
       FROM feature_flag_overrides
       WHERE quarantined = 0`
    )
    .all() as Array<{ flag_key: string; override_value: string }>;

  const map = new Map<FlagKey, FlagValue>();
  for (const row of rows) {
    // Defensive: confirm the flag is in the current registry.
    if (row.flag_key in HARD_DEFAULTS) {
      map.set(row.flag_key as FlagKey, row.override_value as FlagValue);
    }
  }
  return map;
}

/** UPSERT a single override row. Synchronous, single-transaction. */
export function setOverride(key: FlagKey, value: FlagValue): void {
  const now = Date.now();
  const previousFocus = JSON.stringify(getActiveFocus());

  db.prepare(
    `INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined)
     VALUES (?, ?, ?, 'user', ?, 0)
     ON CONFLICT(flag_key) DO UPDATE SET
       override_value = excluded.override_value,
       set_at = excluded.set_at,
       set_by = excluded.set_by,
       previous_focus = excluded.previous_focus,
       quarantined = 0`
  ).run(key, value, now, previousFocus);
}

/** DELETE a single override row. */
export function clearOverride(key: FlagKey): void {
  db.prepare("DELETE FROM feature_flag_overrides WHERE flag_key = ?").run(key);
}

/** DELETE all non-quarantined overrides ("Reset all to defaults"). */
export function clearAllOverrides(): void {
  db.prepare("DELETE FROM feature_flag_overrides WHERE quarantined = 0").run();
}

/** DELETE overrides whose key starts with `flag.{surfacePrefix}.`. */
export function clearSurfaceOverrides(surfacePrefix: string): void {
  db.prepare(
    `DELETE FROM feature_flag_overrides
     WHERE quarantined = 0
       AND flag_key LIKE ?`
  ).run(`flag.${surfacePrefix}.%`);
}

// ============================================================================
// Active focus read/write
// ============================================================================

/** Read the active focus from `app_settings`. Defaults to `audience = 'self'`
 *  with no goals when nothing is stored. */
export function getActiveFocus(): FocusState {
  const audience = (getSetting("flag.focus.audience", "") ||
    "self") as Audience;
  const goals = activeGoalsFrom({
    monitor: getSetting("flag.focus.goal.monitor") === "true",
    cleanup: getSetting("flag.focus.goal.cleanup") === "true",
    minimal: getSetting("flag.focus.goal.minimal") === "true",
    accessibility: getSetting("flag.focus.goal.accessibility") === "true",
  });
  const aiProvider = getSetting("ai_provider", "");
  const aiConfigured = aiProvider !== "" && aiProvider !== "disabled";
  return { audience, goals, aiConfigured };
}

export function getActiveFocusWorkflow(
  focus: FocusState = getActiveFocus()
): FocusWorkflow {
  const raw = getSetting("flag.focus.workflow", "");
  if (isFocusWorkflow(raw)) {
    return raw;
  }
  return inferFocusWorkflow({
    audience: focus.audience,
    monitor: focus.goals.has("monitor"),
    cleanup: focus.goals.has("cleanup"),
    minimal: focus.goals.has("minimal"),
  });
}

/** Write the active focus atomically (single transaction). */
export function setActiveFocus(
  focus: Pick<FocusState, "audience"> & {
    monitor: boolean;
    cleanup: boolean;
    minimal: boolean;
    accessibility: boolean;
    workflow?: FocusWorkflow;
  }
): void {
  const transaction = db.transaction(() => {
    const workflow =
      focus.workflow ??
      inferFocusWorkflow({
        audience: focus.audience,
        monitor: focus.monitor,
        cleanup: focus.cleanup,
        minimal: focus.minimal,
      });
    setSetting("flag.focus.audience", focus.audience);
    setSetting("flag.focus.goal.monitor", String(focus.monitor));
    setSetting("flag.focus.goal.cleanup", String(focus.cleanup));
    setSetting("flag.focus.goal.minimal", String(focus.minimal));
    setSetting("flag.focus.goal.accessibility", String(focus.accessibility));
    setSetting("flag.focus.workflow", workflow);
    // Stamp the change so YourFocusCard can render "Focus updated {date}".
    setSetting("flag.focus.updated_at", String(Date.now()));
  });
  transaction();
}

/**
 * Most-recent epoch ms when `setActiveFocus` was called, or `null` when the
 * user has never adjusted focus. YourFocusCard suppresses the "Focus
 * updated …" line on null.
 */
export function getFocusUpdatedAt(): number | null {
  const raw = getSetting("flag.focus.updated_at", "");
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================================
// Quarantine management — backup-restored rows for unknown flag keys persist
// with `quarantined = 1` and rejoin resolution if the app catches up.
// ============================================================================

/** Mark a row as quarantined (called during restore for unknown keys). */
export function quarantineOverride(key: string, value: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, quarantined)
     VALUES (?, ?, ?, 'restore', 1)
     ON CONFLICT(flag_key) DO UPDATE SET
       override_value = excluded.override_value,
       set_at = excluded.set_at,
       set_by = excluded.set_by,
       quarantined = 1`
  ).run(key, value, now);
}

/**
 * Clear the quarantine flag on rows whose keys are now in the registry.
 * Run as part of the migration's quarantine-check step on startup.
 * Returns the number of rows un-quarantined.
 */
export function unquarantineKnownOverrides(): number {
  const knownKeys = Object.keys(HARD_DEFAULTS);
  const result = db
    .prepare(
      `UPDATE feature_flag_overrides
     SET quarantined = 0
     WHERE quarantined = 1
       AND flag_key IN (${knownKeys.map(() => "?").join(", ")})`
    )
    .run(...knownKeys);
  return result.changes;
}

/** Quarantine rows whose keys are NOT in the registry (returns count). */
export function quarantineUnknownOverrides(): number {
  const knownKeys = Object.keys(HARD_DEFAULTS);
  const placeholders = knownKeys.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE feature_flag_overrides
     SET quarantined = 1
     WHERE quarantined = 0
       AND flag_key NOT IN (${placeholders})`
    )
    .run(...knownKeys);
  return result.changes;
}

/** List all quarantined rows for the Dev Options "Quarantined overrides" card. */
export function listQuarantinedOverrides(): Array<{
  flag_key: string;
  override_value: string;
  set_at: number;
  set_by: string;
}> {
  return db
    .prepare(
      `SELECT flag_key, override_value, set_at, set_by
     FROM feature_flag_overrides
     WHERE quarantined = 1
     ORDER BY set_at DESC`
    )
    .all() as Array<{
    flag_key: string;
    override_value: string;
    set_at: number;
    set_by: string;
  }>;
}

/** DELETE a quarantined row entirely. */
export function purgeQuarantinedOverride(key: string): void {
  db.prepare(
    "DELETE FROM feature_flag_overrides WHERE flag_key = ? AND quarantined = 1"
  ).run(key);
}

// ============================================================================
// Welcomed-at — onboarding completion marker. Written when the wizard
// completes (after at least one app imports or the user skips import).
// ============================================================================

export function getWelcomedAt(): number | null {
  const value = getSetting("welcomed_at", "");
  return value ? Number.parseInt(value, 10) : null;
}

export function setWelcomedAt(timestamp: number = Date.now()): void {
  setSetting("welcomed_at", String(timestamp));
}

// ============================================================================
// Preview state — sessionStorage-backed (not DB-backed). Browser-only.
// Co-located here so all flag-related state shares one import path.
// ============================================================================

const PREVIEW_KEY = "feature_flag_preview_state";

export interface PreviewState {
  accessibility: boolean;
  audience: Audience;
  declutter: boolean;
  minimal: boolean;
  /** Override staging during preview — uncommitted */
  stagedOverrides: Record<FlagKey, FlagValue>;
  /** When the preview started (for the persistent banner copy) */
  startedAt: number;
  /** Tour pause state — populated when tour is mid-run during preview */
  tourPaused?: { stepIndex: number; tourId: string };
  understand: boolean;
}

export function getPreviewState(): PreviewState | null {
  if (typeof window === "undefined") {
    return null; // server-safe no-op
  }
  const raw = window.sessionStorage.getItem(PREVIEW_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as PreviewState;
  } catch {
    window.sessionStorage.removeItem(PREVIEW_KEY); // corrupt — reset
    return null;
  }
}

export function setPreviewState(state: PreviewState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(state));
}

export function clearPreviewState(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(PREVIEW_KEY);
}
