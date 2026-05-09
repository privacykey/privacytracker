/**
 * Server-only CRUD for the `manual_apps` table. Keeps `better-sqlite3` and
 * friends out of the client bundle. API routes and server components import
 * from here; UI components import the client-safe types from
 * `lib/manual-apps.ts`.
 */

import crypto from 'crypto';
import db from './db';
import {
  isManualAppSource,
  MANUAL_APP_SOURCES,
  type ManualApp,
  type ManualAppInput,
  type ManualAppSource,
} from './manual-apps';
import {
  appendManualAppEvent,
  deleteManualAppHistory,
  type ManualAppFieldChangeDetail,
} from './manual-app-history';

interface ManualAppRow {
  id: string;
  name: string;
  source: string;
  developer: string | null;
  privacy_policy_url: string | null;
  source_url: string | null;
  notes: string | null;
  first_seen: number;
  updated_at: number;
}

function hydrate(row: ManualAppRow): ManualApp {
  // If an unknown source ever slips into the DB (e.g. a future version added
  // a new flavour and the user downgraded) we fall back to 'sideloaded'
  // — the most generic catch-all. The UI still renders the row; it just
  // loses its specific icon/copy.
  const source: ManualAppSource = isManualAppSource(row.source) ? row.source : 'sideloaded';
  return {
    id: row.id,
    name: row.name,
    source,
    developer: row.developer,
    privacyPolicyUrl: row.privacy_policy_url,
    sourceUrl: row.source_url,
    notes: row.notes,
    firstSeen: row.first_seen,
    updatedAt: row.updated_at,
  };
}

function normaliseString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Lightweight URL sanity check. We only accept http(s) to avoid persisting
 * things like `javascript:` or `file:` into a UI that renders user-provided
 * links. Throws on anything else — callers should catch and map to a 400.
 */
function normaliseUrl(value: unknown, field: string): string | null {
  const str = normaliseString(value);
  if (str === null) return null;
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${field} must be http(s)`);
    }
    return parsed.toString();
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
}

export function listManualApps(): ManualApp[] {
  const rows = db
    .prepare(
      `SELECT id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at
       FROM manual_apps
       ORDER BY updated_at DESC, name COLLATE NOCASE ASC`,
    )
    .all() as ManualAppRow[];
  return rows.map(hydrate);
}

export function getManualApp(id: string): ManualApp | null {
  const row = db
    .prepare(
      `SELECT id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at
       FROM manual_apps WHERE id = ?`,
    )
    .get(id) as ManualAppRow | undefined;
  return row ? hydrate(row) : null;
}

export function countManualApps(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM manual_apps').get() as { n: number };
  return row?.n ?? 0;
}

export function createManualApp(input: ManualAppInput): ManualApp {
  const name = normaliseString(input.name);
  if (!name) throw new Error('Name is required');
  if (!isManualAppSource(input.source)) {
    throw new Error(`source must be one of: ${MANUAL_APP_SOURCES.join(', ')}`);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const developer = normaliseString(input.developer);
  const privacyPolicyUrl = normaliseUrl(input.privacyPolicyUrl, 'privacyPolicyUrl');
  const sourceUrl = normaliseUrl(input.sourceUrl, 'sourceUrl');
  const notes = normaliseString(input.notes);

  db.prepare(
    `INSERT INTO manual_apps
       (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, input.source, developer, privacyPolicyUrl, sourceUrl, notes, now, now);

  return {
    id,
    name,
    source: input.source,
    developer,
    privacyPolicyUrl,
    sourceUrl,
    notes,
    firstSeen: now,
    updatedAt: now,
  };
}

/**
 * Partial update. Fields not present on the patch object are left alone;
 * fields set to `null` are cleared. Mirrors what a sensible PATCH expects.
 */
export function updateManualApp(
  id: string,
  patch: Partial<ManualAppInput>,
): ManualApp | null {
  const existing = getManualApp(id);
  if (!existing) return null;

  const next: ManualApp = {
    ...existing,
    updatedAt: Date.now(),
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const name = normaliseString(patch.name);
    if (!name) throw new Error('Name is required');
    next.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'source')) {
    if (!isManualAppSource(patch.source)) {
      throw new Error(`source must be one of: ${MANUAL_APP_SOURCES.join(', ')}`);
    }
    next.source = patch.source;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'developer')) {
    next.developer = normaliseString(patch.developer);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'privacyPolicyUrl')) {
    next.privacyPolicyUrl = normaliseUrl(patch.privacyPolicyUrl, 'privacyPolicyUrl');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceUrl')) {
    next.sourceUrl = normaliseUrl(patch.sourceUrl, 'sourceUrl');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    next.notes = normaliseString(patch.notes);
  }

  // Diff the patched row against what's on disk so the changelog records
  // which fields the user actually touched. Done BEFORE the UPDATE so a
  // failed write doesn't leave orphan events. Identical values are skipped
  // — the dashboard should only surface genuine edits.
  const fieldDiffs: ManualAppFieldChangeDetail[] = [];
  const pushDiff = (
    field: ManualAppFieldChangeDetail['field'],
    from: string | null,
    to: string | null,
  ) => {
    if ((from ?? null) === (to ?? null)) return;
    fieldDiffs.push({ field, from: from ?? null, to: to ?? null });
  };
  pushDiff('name', existing.name, next.name);
  pushDiff('source', existing.source, next.source);
  pushDiff('developer', existing.developer, next.developer);
  pushDiff('privacyPolicyUrl', existing.privacyPolicyUrl, next.privacyPolicyUrl);
  pushDiff('sourceUrl', existing.sourceUrl, next.sourceUrl);
  pushDiff('notes', existing.notes, next.notes);

  // Wrap the UPDATE and the event inserts in a single transaction so a crash
  // mid-write can't leave the changelog referring to a state the row never
  // actually reached.
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE manual_apps
         SET name = ?, source = ?, developer = ?, privacy_policy_url = ?, source_url = ?,
             notes = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.source,
      next.developer,
      next.privacyPolicyUrl,
      next.sourceUrl,
      next.notes,
      next.updatedAt,
      id,
    );

    for (const diff of fieldDiffs) {
      appendManualAppEvent({
        manualAppId: id,
        type: 'field_change',
        detail: { kind: 'field_change', ...diff },
        occurredAt: next.updatedAt,
      });
    }
  });
  tx();

  return next;
}

export function deleteManualApp(id: string): boolean {
  // Wipe history first so we never end up with orphan rows if the delete
  // loses a race with another writer. better-sqlite3 is synchronous so the
  // ordering inside one tick is enough — no need for a transaction here.
  deleteManualAppHistory(id);
  const res = db.prepare('DELETE FROM manual_apps WHERE id = ?').run(id);
  return res.changes > 0;
}

/**
 * Re-create a manual app row using the EXACT same `id` as the snapshot.
 * The Cmd-Z undo path on `ManualAppsView` calls this after a delete: the
 * client stashes the full {@link ManualApp} object before issuing
 * `DELETE /api/manual-apps/<id>` and posts it back to /restore on undo.
 *
 * Why "same id" instead of plain `createManualApp`:
 *   - Any external reference held by the user (browser bookmark, copied
 *     URL of /apps/manual/<id>, audit-bundle import recipient) keeps
 *     working.
 *   - Subsequent edits / policy scrapes for the restored row re-use the
 *     event-history table whose key is `manual_app_id` — we'd be creating
 *     orphans relative to the user's mental model of "the same app I
 *     just typed in" if a fresh UUID were minted.
 *
 * Returns the restored row, or null if a row with that id already exists
 * (which would happen if the user double-pressed Cmd+Z, or restored from
 * a sibling tab — same shape as ShortlistView's idempotent re-add path).
 *
 * Note: this restores the `manual_apps` row only. The
 * `manual_app_events` and `manual_app_policy_versions` rows that were
 * pruned by `deleteManualAppHistory` are NOT brought back; the user-
 * facing change-history will read as fresh once restored. That's the
 * accepted trade-off for keeping the undo payload small (history can be
 * megabytes) and matches the documented behaviour for tracked-app
 * delete undo if that ever lands. The undo toast wording reflects this:
 * "Restored <name>. History will rebuild on the next edit."
 */
export function restoreManualApp(snapshot: ManualApp): ManualApp | null {
  // Validate the snapshot shape conservatively — the client can call us
  // with whatever's in its undo stack, including stale or partially-
  // typed data after a hot-reload. Source must match the enum, name
  // must be non-empty, id must be a plausible UUID-shaped string.
  if (!isManualAppSource(snapshot.source)) return null;
  if (typeof snapshot.id !== 'string' || snapshot.id.length === 0 || snapshot.id.length > 128) return null;
  if (typeof snapshot.name !== 'string' || snapshot.name.trim().length === 0) return null;

  const existing = getManualApp(snapshot.id);
  if (existing) return null; // idempotent: already restored / never deleted

  const firstSeen = Number.isFinite(snapshot.firstSeen) && snapshot.firstSeen > 0
    ? Math.floor(snapshot.firstSeen)
    : Date.now();
  // updated_at can stay at the original value — undo is conceptually a
  // restoration, not a fresh edit. If the snapshot is malformed we fall
  // back to firstSeen so the row's monotonic invariant (updated >= first)
  // holds.
  const updatedAt = Number.isFinite(snapshot.updatedAt) && snapshot.updatedAt >= firstSeen
    ? Math.floor(snapshot.updatedAt)
    : firstSeen;

  db.prepare(
    `INSERT INTO manual_apps
       (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.id,
    snapshot.name.trim(),
    snapshot.source,
    snapshot.developer ?? null,
    snapshot.privacyPolicyUrl ?? null,
    snapshot.sourceUrl ?? null,
    snapshot.notes ?? null,
    firstSeen,
    updatedAt,
  );

  return {
    id: snapshot.id,
    name: snapshot.name.trim(),
    source: snapshot.source as ManualAppSource,
    developer: snapshot.developer ?? null,
    privacyPolicyUrl: snapshot.privacyPolicyUrl ?? null,
    sourceUrl: snapshot.sourceUrl ?? null,
    notes: snapshot.notes ?? null,
    firstSeen,
    updatedAt,
  };
}
