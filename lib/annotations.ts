/**
 * Per-app freeform notes (round 3 PR 4).
 *
 * Server-side CRUD over the `annotations` table created in lib/db.ts.
 * Soft-delete is built in: `DELETE` sets `deleted_at`, and a 30-second
 * undo window is enforced at the route layer. After the window, a sweep
 * job (or on-demand purge) hard-deletes rows whose deleted_at is older
 * than the threshold.
 *
 * Each create/edit/delete writes to activity_log via recordActivity so
 * the operation appears in the dashboard feed and in Dev Options.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

import db from './db';
import { recordActivity } from './activity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnnotationSource = 'user' | 'imported';
export type AnnotationVisibility = 'export' | 'private';
export type AnnotationTag = 'concern' | 'positive' | 'follow_up' | 'other';

export interface Annotation {
  id: string;
  appId: string;
  content: string;
  source: AnnotationSource;
  /** Recommender display name, present when source === 'imported'. */
  sourceName: string | null;
  visibility: AnnotationVisibility;
  tag: AnnotationTag | null;
  createdAt: number;
  updatedAt: number;
  /** Non-null while soft-deleted; null when active. */
  deletedAt: number | null;
}

interface DbRow {
  id: string;
  app_id: string;
  content: string;
  source: string;
  source_name: string | null;
  visibility: string;
  tag: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const VALID_TAGS: readonly AnnotationTag[] = ['concern', 'positive', 'follow_up', 'other'];
const VALID_VISIBILITIES: readonly AnnotationVisibility[] = ['export', 'private'];

/** Soft-delete grace window — past this, a row is purged on the next read sweep. */
export const SOFT_DELETE_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function rowToAnnotation(row: DbRow): Annotation {
  return {
    id: row.id,
    appId: row.app_id,
    content: row.content,
    source: row.source as AnnotationSource,
    sourceName: row.source_name,
    visibility: row.visibility as AnnotationVisibility,
    tag: row.tag as AnnotationTag | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function generateId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `ann_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List active annotations for an app, newest first. Drops any rows whose
 * soft-delete window has elapsed (30s past `deleted_at`) — those rows are
 * effectively gone from the user's perspective and we sweep them here on
 * read so the data layer stays self-cleaning without a background job.
 */
export function listAnnotations(appId: string): Annotation[] {
  const cutoff = Date.now() - SOFT_DELETE_WINDOW_MS;

  // Hard-delete any rows past the soft-delete window in the same transaction.
  const sweep = db.transaction(() => {
    db.prepare(
      `DELETE FROM annotations
       WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    ).run(cutoff);
  });
  try {
    sweep();
  } catch (e) {
    // Sweep failure is non-fatal — log and continue with the read.
    console.warn('[annotations] sweep failed:', e);
  }

  const rows = db.prepare(
    `SELECT id, app_id, content, source, source_name, visibility, tag,
            created_at, updated_at, deleted_at
     FROM annotations
     WHERE app_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
  ).all(appId) as DbRow[];

  return rows.map(rowToAnnotation);
}

/** Read a single annotation by id (including soft-deleted rows; callers filter). */
export function getAnnotation(id: string): Annotation | null {
  const row = db.prepare(
    `SELECT id, app_id, content, source, source_name, visibility, tag,
            created_at, updated_at, deleted_at
     FROM annotations WHERE id = ?`,
  ).get(id) as DbRow | undefined;
  return row ? rowToAnnotation(row) : null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

interface CreateInput {
  appId: string;
  content: string;
  source?: AnnotationSource;
  sourceName?: string | null;
  visibility?: AnnotationVisibility;
  tag?: AnnotationTag | null;
}

/**
 * Create an annotation. `source` defaults to 'user' for self-authored notes;
 * audit-bundle imports pass 'imported' + sourceName.
 */
export function createAnnotation(input: CreateInput): Annotation {
  const id = generateId();
  const now = Date.now();
  const source = input.source ?? 'user';
  const sourceName = input.sourceName ?? null;
  const visibility = input.visibility ?? 'export';
  const tag = input.tag && VALID_TAGS.includes(input.tag) ? input.tag : null;

  db.prepare(
    `INSERT INTO annotations
       (id, app_id, content, source, source_name, visibility, tag,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, input.appId, input.content, source, sourceName, visibility, tag, now, now);

  // Activity log — only for user-authored notes; imported notes log under
  // the bundle-import event instead so we don't double-count.
  if (source === 'user') {
    try {
      recordActivity({
        type: 'annotation_created',
        status: 'ok',
        appId: input.appId,
        summary: 'Note created',
        detail: { annotationId: id, tag, visibility },
        startedAt: now,
      });
    } catch (e) {
      console.warn('[annotations] activity log failed:', e);
    }
  }

  return getAnnotation(id)!;
}

interface UpdateInput {
  content?: string;
  visibility?: AnnotationVisibility;
  tag?: AnnotationTag | null;
}

/**
 * Update an existing annotation. Only fields present in `input` are touched.
 * Touches updated_at on every call regardless of whether content changed —
 * that's how the auto-save indicator knows when to flash "Saved".
 */
export function updateAnnotation(id: string, input: UpdateInput): Annotation | null {
  const existing = getAnnotation(id);
  if (!existing || existing.deletedAt !== null) return null;

  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (input.content !== undefined) {
    sets.push('content = ?');
    params.push(input.content);
  }
  if (input.visibility !== undefined) {
    if (!VALID_VISIBILITIES.includes(input.visibility)) {
      throw new Error(`invalid visibility: ${input.visibility}`);
    }
    sets.push('visibility = ?');
    params.push(input.visibility);
  }
  if (input.tag !== undefined) {
    const next = input.tag && VALID_TAGS.includes(input.tag) ? input.tag : null;
    sets.push('tag = ?');
    params.push(next);
  }

  params.push(id);
  db.prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  try {
    recordActivity({
      type: 'annotation_edited',
      status: 'ok',
      appId: existing.appId,
      summary: 'Note edited',
      detail: { annotationId: id },
      startedAt: now,
    });
  } catch (e) {
    console.warn('[annotations] activity log failed:', e);
  }

  return getAnnotation(id);
}

/**
 * Soft-delete an annotation. Sets `deleted_at = now`. The row stays in the
 * DB for {@link SOFT_DELETE_WINDOW_MS} so the user can undo, then gets
 * purged by the sweep on the next list read.
 */
export function softDeleteAnnotation(id: string): Annotation | null {
  const existing = getAnnotation(id);
  if (!existing) return null;
  if (existing.deletedAt !== null) return existing;

  const now = Date.now();
  db.prepare('UPDATE annotations SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id);

  try {
    recordActivity({
      type: 'annotation_deleted',
      status: 'ok',
      appId: existing.appId,
      summary: 'Note deleted',
      detail: { annotationId: id },
      startedAt: now,
    });
  } catch (e) {
    console.warn('[annotations] activity log failed:', e);
  }

  return getAnnotation(id);
}

/**
 * Restore a soft-deleted annotation. Only succeeds if the row is still
 * within the soft-delete window — past 30s the row may have been purged.
 */
export function restoreAnnotation(id: string): Annotation | null {
  const existing = getAnnotation(id);
  if (!existing || existing.deletedAt === null) return existing;

  const elapsed = Date.now() - existing.deletedAt;
  if (elapsed > SOFT_DELETE_WINDOW_MS) {
    // Past the undo window — purge handled this; nothing to restore.
    return null;
  }

  db.prepare('UPDATE annotations SET deleted_at = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);

  return getAnnotation(id);
}

/** Hard-delete an annotation immediately. Used by Dev Options "purge" button. */
export function purgeAnnotation(id: string): boolean {
  const result = db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Count active annotations across all apps — used by the "{N} apps with notes" focus-card line. */
export function countAnnotatedApps(): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT app_id) AS count
    FROM annotations
    WHERE deleted_at IS NULL
  `).get() as { count: number } | undefined;
  return row?.count ?? 0;
}
