/**
 * Per-app verdicts (Phase 1 of the audit-bundle action flow).
 *
 * A verdict is a categorical decision about an app — "I'm keeping it"
 * (safe), "I want a replacement" (replace), or "I want this gone"
 * (uninstall). Distinct from {@link Annotation} on purpose: an
 * annotation is freeform commentary (0..N per app), a verdict is one
 * opinionated answer per (app, source).
 *
 * Sources:
 *   - 'user'     — the local user's own decision. Authoritative for any
 *                  device-side action (Phase 3 cfgutil uninstall).
 *   - 'imported' — came from an audit-bundle import. Always advisory;
 *                  the recipient's user-source verdict is what gates
 *                  any actual action.
 *
 * One verdict per (app, source, source_name). The local user gets a
 * single row per app under the 'user' source (source_name NULL); each
 * recommender's bundle adds an 'imported' row under their name. So a
 * recipient can see "Mum says uninstall, Dad says safe" stacked.
 *
 * The data layer never collapses imported recommendations into the
 * user's verdict — it's the UI's job to present them, and the user
 * still has to make their own decision.
 */

import { recordActivity } from "./activity";
import db from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerdictValue = "safe" | "replace" | "uninstall";
export type VerdictSource = "user" | "imported";

export interface AppVerdict {
  appId: string;
  id: string;
  rationale: string | null;
  setAt: number;
  source: VerdictSource;
  /** Recommender display name when source === 'imported'; null for 'user'. */
  sourceName: string | null;
  updatedAt: number;
  verdict: VerdictValue;
}

interface DbRow {
  app_id: string;
  id: string;
  rationale: string | null;
  set_at: number;
  source: string;
  source_name: string | null;
  updated_at: number;
  verdict: string;
}

const VALID_VERDICTS: readonly VerdictValue[] = [
  "safe",
  "replace",
  "uninstall",
];

export function isValidVerdict(v: unknown): v is VerdictValue {
  return (
    typeof v === "string" && (VALID_VERDICTS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Mappers + helpers
// ---------------------------------------------------------------------------

function rowToVerdict(row: DbRow): AppVerdict {
  return {
    id: row.id,
    appId: row.app_id,
    verdict: row.verdict as VerdictValue,
    rationale: row.rationale,
    source: row.source as VerdictSource,
    sourceName: row.source_name,
    setAt: row.set_at,
    updatedAt: row.updated_at,
  };
}

function generateId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `vrd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every verdict (user + imported) attached to an app, freshest first. */
export function listVerdicts(appId: string): AppVerdict[] {
  const rows = db
    .prepare(
      `SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at
     FROM app_verdicts
     WHERE app_id = ?
     ORDER BY set_at DESC`
    )
    .all(appId) as DbRow[];
  return rows.map(rowToVerdict);
}

/** The local user's own verdict for an app, or null if undecided. */
export function getUserVerdict(appId: string): AppVerdict | null {
  const row = db
    .prepare(
      `SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at
     FROM app_verdicts
     WHERE app_id = ? AND source = 'user'
     LIMIT 1`
    )
    .get(appId) as DbRow | undefined;
  return row ? rowToVerdict(row) : null;
}

/** Imported recommendations for an app, freshest first. */
export function listImportedVerdicts(appId: string): AppVerdict[] {
  const rows = db
    .prepare(
      `SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at
     FROM app_verdicts
     WHERE app_id = ? AND source = 'imported'
     ORDER BY set_at DESC`
    )
    .all(appId) as DbRow[];
  return rows.map(rowToVerdict);
}

/**
 * Counts of *user* verdicts grouped by value, across every tracked app.
 * Drives the filter chip row on the Apps grid ("Safe (3) · Uninstall (5)…").
 * Imported recommendations don't count here — those are advisory and don't
 * belong in a "what have I decided?" tally.
 */
export function countUserVerdicts(): Record<VerdictValue, number> {
  const rows = db
    .prepare(
      `SELECT verdict, COUNT(*) AS n
     FROM app_verdicts
     WHERE source = 'user'
     GROUP BY verdict`
    )
    .all() as { verdict: string; n: number }[];

  const out: Record<VerdictValue, number> = {
    safe: 0,
    replace: 0,
    uninstall: 0,
  };
  for (const r of rows) {
    if (isValidVerdict(r.verdict)) {
      out[r.verdict] = r.n;
    }
  }
  return out;
}

/**
 * Bulk lookup so the Apps grid can render verdict pills without N+1
 * queries — one prepared SQL call per render. Returns a map of
 * `appId → user verdict`. Apps that haven't been decided yet are
 * absent from the map (callers should treat that as "undecided").
 */
export function getUserVerdictsByAppId(): Map<string, AppVerdict> {
  const rows = db
    .prepare(
      `SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at
     FROM app_verdicts
     WHERE source = 'user'`
    )
    .all() as DbRow[];
  const out = new Map<string, AppVerdict>();
  for (const r of rows) {
    out.set(r.app_id, rowToVerdict(r));
  }
  return out;
}

/**
 * Bulk lookup for imported recommendations — `appId → AppVerdict[]`.
 * Used by the review-and-act wizard to render "Mum says X" alongside
 * the recipient's own picker on every app. Apps with no imported
 * recommendations are absent from the map.
 */
export function getImportedVerdictsByAppId(): Map<string, AppVerdict[]> {
  const rows = db
    .prepare(
      `SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at
     FROM app_verdicts
     WHERE source = 'imported'
     ORDER BY set_at DESC`
    )
    .all() as DbRow[];
  const out = new Map<string, AppVerdict[]>();
  for (const r of rows) {
    const v = rowToVerdict(r);
    const list = out.get(r.app_id) ?? [];
    list.push(v);
    out.set(r.app_id, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

interface SetVerdictInput {
  appId: string;
  rationale?: string | null;
  /** Defaults to 'user'. Bundle-import path passes 'imported' + sourceName. */
  source?: VerdictSource;
  sourceName?: string | null;
  verdict: VerdictValue;
}

/**
 * UPSERT a verdict. The unique index on (app_id, source, source_name)
 * gives us natural idempotency — re-marking with the same source
 * replaces the existing row and bumps `updated_at` while keeping the
 * original `set_at` for "first decided" timestamps.
 *
 * Returns the resulting AppVerdict.
 */
export function setVerdict(input: SetVerdictInput): AppVerdict {
  if (!isValidVerdict(input.verdict)) {
    throw new Error(`invalid verdict: ${input.verdict}`);
  }
  const source = input.source ?? "user";
  const sourceName =
    source === "imported" ? input.sourceName?.trim() || null : null;
  if (source === "imported" && !sourceName) {
    throw new Error("imported verdicts require a sourceName");
  }

  const now = Date.now();

  // Look for an existing row for the (appId, source, source_name) tuple.
  // SQLite's NULL-distinct semantics on UNIQUE means we can't rely on
  // INSERT OR REPLACE for the user case (where source_name IS NULL),
  // so we hand-roll the upsert with an IS-NULL match.
  const existing = db
    .prepare(
      `SELECT id, set_at FROM app_verdicts
     WHERE app_id = ? AND source = ?
       AND ((source_name IS NULL AND ? IS NULL) OR source_name = ?)`
    )
    .get(input.appId, source, sourceName, sourceName) as
    | { id: string; set_at: number }
    | undefined;

  let id: string;
  let firstSet: number;
  const rationale = input.rationale?.trim() || null;

  if (existing) {
    id = existing.id;
    firstSet = existing.set_at;
    db.prepare(
      `UPDATE app_verdicts
       SET verdict = ?, rationale = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.verdict, rationale, now, id);
  } else {
    id = generateId();
    firstSet = now;
    db.prepare(
      `INSERT INTO app_verdicts
         (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.appId,
      input.verdict,
      rationale,
      source,
      sourceName,
      now,
      now
    );
  }

  // Activity log — only user verdicts. Imported verdicts get logged
  // under the bundle-import event so we don't double-count.
  if (source === "user") {
    try {
      recordActivity({
        type: "verdict_set",
        status: "ok",
        appId: input.appId,
        summary: `Marked ${input.verdict}`,
        detail: {
          verdictId: id,
          verdict: input.verdict,
          hasRationale: !!rationale,
        },
        startedAt: now,
      });
    } catch (e) {
      console.warn("[verdicts] activity log failed:", e);
    }
  }

  return {
    id,
    appId: input.appId,
    verdict: input.verdict,
    rationale,
    source,
    sourceName,
    setAt: firstSet,
    updatedAt: now,
  };
}

/**
 * Bulk-set the local user's verdict on many apps in a single transaction.
 * Used by the AppGrid bulk-select mode — applying "Mark Safe" to 47 apps
 * should be one DB call, one activity row, and one Undo target rather
 * than 47 separate writes.
 *
 * - Per-app rows go through the same UPSERT semantics as `setVerdict`
 *   so existing verdicts are replaced, fresh ones inserted, `set_at`
 *   preserved on overwrite, `updated_at` bumped.
 * - Imported recommendations are NOT touched. This only writes the
 *   user-source verdict.
 * - Activity log: ONE `bulk_verdict_set` row with the count + verdict +
 *   appIds in `detail`. Per-app `verdict_set` rows are intentionally
 *   skipped (the summary row is the audit trail).
 * - Returns the list of resulting AppVerdicts (existing or new), in the
 *   same order as the input ids.
 */
export function setVerdicts(
  appIds: string[],
  verdict: VerdictValue,
  options: { rationale?: string | null } = {}
): AppVerdict[] {
  if (!isValidVerdict(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  if (appIds.length === 0) {
    return [];
  }

  const rationale = options.rationale?.trim() || null;
  const now = Date.now();
  const out: AppVerdict[] = [];

  const findExisting = db.prepare(
    `SELECT id, set_at FROM app_verdicts
     WHERE app_id = ? AND source = 'user' AND source_name IS NULL`
  );
  const update = db.prepare(
    `UPDATE app_verdicts
     SET verdict = ?, rationale = ?, updated_at = ?
     WHERE id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO app_verdicts
       (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', NULL, ?, ?)`
  );

  db.transaction(() => {
    for (const appId of appIds) {
      const existing = findExisting.get(appId) as
        | { id: string; set_at: number }
        | undefined;
      let id: string;
      let firstSet: number;
      if (existing) {
        id = existing.id;
        firstSet = existing.set_at;
        update.run(verdict, rationale, now, id);
      } else {
        id = generateId();
        firstSet = now;
        insert.run(id, appId, verdict, rationale, now, now);
      }
      out.push({
        id,
        appId,
        verdict,
        rationale,
        source: "user",
        sourceName: null,
        setAt: firstSet,
        updatedAt: now,
      });
    }
  })();

  try {
    recordActivity({
      type: "bulk_verdict_set",
      status: "ok",
      appId: null,
      summary: `Marked ${appIds.length} ${appIds.length === 1 ? "app" : "apps"} ${verdict}`,
      detail: {
        verdict,
        count: appIds.length,
        appIds,
        hasRationale: !!rationale,
      },
      startedAt: now,
    });
  } catch (e) {
    console.warn("[verdicts] bulk activity log failed:", e);
  }

  return out;
}

/**
 * Delete a verdict row. Used by the picker's "Clear verdict" action and
 * by the Dev Options "purge" tools. Imported rows can be cleared too —
 * useful if the recipient wants to dismiss a recommendation entirely.
 *
 * Returns true if a row was actually deleted.
 */
export function clearVerdict(
  appId: string,
  source: VerdictSource = "user",
  sourceName: string | null = null
): boolean {
  const result = db
    .prepare(
      `DELETE FROM app_verdicts
     WHERE app_id = ? AND source = ?
       AND ((source_name IS NULL AND ? IS NULL) OR source_name = ?)`
    )
    .run(appId, source, sourceName, sourceName);

  if (result.changes > 0 && source === "user") {
    try {
      recordActivity({
        type: "verdict_cleared",
        status: "ok",
        appId,
        summary: "Verdict cleared",
        detail: {},
        startedAt: Date.now(),
      });
    } catch (e) {
      console.warn("[verdicts] activity log failed:", e);
    }
  }

  return result.changes > 0;
}

/** Hard-delete every verdict for an app (any source). Used by app deletion + Dev Options. */
export function purgeVerdictsForApp(appId: string): number {
  const result = db
    .prepare("DELETE FROM app_verdicts WHERE app_id = ?")
    .run(appId);
  return result.changes;
}
