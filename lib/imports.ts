import crypto from 'crypto';
import db from './db';
import { recordActivity, type ActivityStatus } from './activity';
import { schedulePostAppUpdatePolicyFetch } from './post-app-update-policy-fetch';
import {
  createImportCompletionNotification,
  markNotificationsStaleForApp,
} from './notifications';

// ── Types ──────────────────────────────────────────────────────────────

export const IMPORT_SOURCES = ['screenshots', 'file', 'manual'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_ITEM_STATUSES = [
  'matched',
  'unmatched',
  'skipped',
  'imported',
  'error',
  // Name-only row: the iTunes Search API rate-limited the wizard before we
  // could resolve this query into a URL. The client-side QueuedSearchProvider
  // owns retries — when the search eventually lands, the row is upserted to
  // 'matched' with `url` filled in. The server-side import-queue worker
  // explicitly does NOT claim 'pending_search' rows (no URL to scrape), so
  // these two retry paths don't compete.
  'pending_search',
  // Matched row whose App Store scrape Apple 429'd partway through. Has a
  // URL; the server-side import-queue worker drains these on a backoff. The
  // user sees a "Queued" pill in Import History until each row flips to
  // 'imported' or 'error'.
  'queued',
  // User imported the app, then later removed it from the dashboard. We keep
  // the import_item row for audit + display but refuse to re-add the app on a
  // scheduled sync or naive retry. Set via `markImportItemsRemovedForApp`.
  'removed',
] as const;
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUSES)[number];

export interface ImportRow {
  id: string;
  createdAt: number;
  completedAt: number | null;
  source: ImportSource;
  sourceLabel: string | null;
  total: number;
  matched: number;
  unmatched: number;
  imported: number;
  /**
   * Live counters computed by joining `import_items`, not stored on the
   * `imports` table. The history UI needs these on the collapsed summary
   * row so it can decide whether to surface "Resume matching" or a
   * "problems" badge without having to expand the row first.
   *
   *   queued:   rows parked on the retry queue (Apple rate-limited us).
   *   errored:  rows whose scrape finally failed — a hard fail, no retry.
   *   removed:  imported, then later untracked by the user.
   *   itemCount: total rows actually persisted. Diverges from `total`
   *              for legacy imports that predate the items write path.
   */
  queued: number;
  errored: number;
  removed: number;
  itemCount: number;
}

export interface ImportItemRow {
  id: string;
  importId: string;
  query: string;
  editedQuery: string | null;
  status: ImportItemStatus;
  appId: string | null;
  appName: string | null;
  developer: string | null;
  url: string | null;
  /**
   * Icon captured at the moment we matched the app in the iTunes search.
   * Persisted so the "Queued" row in Import History can show the user's
   * app without waiting for the scrape to succeed.
   */
  iconUrl: string | null;
  /**
   * ISO country code the search was performed against. Gives retries a
   * hint so we scrape the same storefront the user originally saw.
   */
  country: string | null;
  scrapeError: string | null;
  /**
   * Sticky pointer to the original app id. When a tracked app is deleted the
   * FK `SET NULL` wipes `app_id`; we preserve the old id here so the import
   * history UI can still describe which app was removed.
   */
  removedAppId: string | null;
  /**
   * Background queue bookkeeping. `nextAttemptAt` is the epoch-ms threshold
   * at/after which the worker may retry a `'queued'` row; `attemptCount` is
   * the number of times this row has been tried so backoff can grow.
   */
  nextAttemptAt: number | null;
  attemptCount: number;
}

// ── Create / update ────────────────────────────────────────────────────

/**
 * Guard against `FOREIGN KEY (app_id) REFERENCES apps(id)` failures.
 *
 * The onboarding wizard writes a batch of `import_items` right after the
 * iTunes *search* — long before any App Store scrape has populated `apps`.
 * Each matched row carries `appId = <iTunes trackId>`, which is the same
 * identifier we eventually key `apps.id` on, but the `apps` row for that id
 * doesn't exist yet. Inserting with a non-null `app_id` therefore trips
 * SQLITE_CONSTRAINT_FOREIGNKEY and rolls back the whole batch — which is
 * exactly the "first import shows 0 items" symptom.
 *
 * Fix: if the caller hands us an app_id that isn't in `apps` yet, null it
 * out before the write. The rest of the match metadata (name, developer,
 * url, icon_url) still persists, so Import History can render the row, and
 * `markItemImported` / `recordItemSuccess` re-sets `app_id` properly once
 * the scrape has created the `apps` row.
 */
function resolveSafeAppId(appId: string | null | undefined): string | null {
  if (!appId) return null;
  const exists = db.prepare('SELECT 1 FROM apps WHERE id = ?').get(appId);
  return exists ? appId : null;
}

export function createImport(input: {
  source: ImportSource;
  sourceLabel?: string;
  total?: number;
}): ImportRow {
  const id = newId('imp');
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO imports (id, created_at, source, source_label, total)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, createdAt, input.source, input.sourceLabel ?? null, input.total ?? 0);

  return getImportRowOrThrow(id);
}

interface AddImportItemInput {
  query: string;
  editedQuery?: string | null;
  status: ImportItemStatus;
  appId?: string | null;
  appName?: string | null;
  developer?: string | null;
  url?: string | null;
  iconUrl?: string | null;
  country?: string | null;
  scrapeError?: string | null;
  removedAppId?: string | null;
  nextAttemptAt?: number | null;
  attemptCount?: number;
}

/**
 * Upsert a batch of import items by `(import_id, query)`.
 *
 * Originally a plain INSERT, but the onboarding flow needs to write every
 * name in the batch up front — including names the iTunes search couldn't
 * process yet because Apple 429'd us. Those rows go in as `status = 'queued'`
 * so the Settings → Import History view can show the full batch
 * immediately. When the queued retry finally lands later, the same endpoint
 * gets called again with `status = 'matched'` and must update the existing
 * row instead of inserting a duplicate.
 *
 * Rules:
 *   - Match is by `(import_id, query)` — queries are the user's typed name
 *     and are unique inside a single batch for our purposes. (The UI de-dupes
 *     names before submission; a rare collision just collapses safely here.)
 *   - An existing row with `status = 'removed'` is never overwritten — that
 *     tombstone is how we remember the user deleted the app, and a naive
 *     upsert would let a retry silently re-add it. Retries that hit a
 *     tombstone leave the row alone and skip the update.
 *   - The returned list contains one row per input item, in the same order
 *     the caller supplied — either the freshly inserted row or the row
 *     after update.
 */
/**
 * Async sibling of `addImportItems` that routes DB writes through the
 * write worker instead of running them inline on the main thread.
 *
 * Why this exists: a 200-row import landing on the synchronous
 * `addImportItems` blocks the event loop for hundreds of milliseconds
 * inside its single `db.transaction(...)`. While blocked, the Node
 * sidecar can't respond to any other HTTP request, which makes the
 * Tauri webview appear frozen. This async variant moves the writes
 * off the main thread (see lib/db-worker-client.ts), keeping the
 * event loop free to serve other requests during the import.
 *
 * Behaviour parity with `addImportItems`:
 *   - Same upsert-by-(import_id, query) semantics
 *   - Same "removed" tombstone handling — never overwrites
 *   - Same return shape: one row per input item, in input order
 *   - Same recomputeImportCounters call after the writes land
 *
 * The read-side (existing-row lookups, FK validation) still runs
 * synchronously on the main thread because reads are fast (indexed,
 * no lock contention) and the cost of marshalling them through the
 * worker outweighs the wins. Only the *write* phase moves.
 *
 * Tests should keep using the synchronous `addImportItems` — spawning
 * a worker per test is overhead, and the sync variant exercises the
 * same SQL paths.
 */
export async function addImportItemsAsync(
  importId: string,
  items: AddImportItemInput[],
): Promise<ImportItemRow[]> {
  if (!getImportRow(importId)) {
    throw new Error(`Unknown import ${importId}`);
  }
  if (items.length === 0) return [];

  // Lazy-load the worker client. Top-level import would pull it into
  // every module that touches imports.ts, including the test bundle.
  // Keeping it dynamic also defers worker spawn until something
  // actually wants the async path.
  const { runBulkWrite } = require('./db-worker-client') as typeof import('./db-worker-client');

  const findExisting = db.prepare(
    `SELECT * FROM import_items
       WHERE import_id = ? AND query = ?
       ORDER BY rowid LIMIT 1`,
  );

  // Phase 1 (sync, on main thread): build the statement plan + the
  // result rows. This phase does N small reads + N pushes to
  // arrays — fast enough that it doesn't visibly block the UI even
  // for a 200-row batch.
  type Statement = { sql: string; params: unknown[] };
  const statements: Statement[] = [];
  const results: ImportItemRow[] = [];
  const safeAppIdCache = new Map<string, string | null>();
  const cachedResolveSafeAppId = (appId: string | null | undefined): string | null => {
    if (!appId) return null;
    const cached = safeAppIdCache.get(appId);
    if (cached !== undefined) return cached;
    const safeAppId = resolveSafeAppId(appId);
    safeAppIdCache.set(appId, safeAppId);
    return safeAppId;
  };

  const INSERT_SQL = `INSERT INTO import_items (
    id, import_id, query, edited_query, status, app_id, app_name, developer, url,
    icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (const item of items) {
    const existing = findExisting.get(importId, item.query) as
      | ImportItemRecord
      | undefined;

    if (existing) {
      if (existing.status === 'removed') {
        // Tombstone — keep the existing row, no write needed.
        results.push(hydrateImportItem(existing));
        continue;
      }

      // Build an UPDATE patch. Mirrors the field list from
      // updateImportItem so behaviour stays in lockstep.
      const fields: string[] = [];
      const values: unknown[] = [];
      const push = (col: string, val: unknown) => {
        fields.push(`${col} = ?`);
        values.push(val ?? null);
      };
      // Status is always part of an upsert (the whole point of
      // re-running the call is to flip status forward, e.g.
      // queued → matched).
      push('status', item.status);
      const safeAppId = item.appId !== undefined
        ? cachedResolveSafeAppId(item.appId)
        : existing.app_id;
      if (item.editedQuery !== undefined) push('edited_query', item.editedQuery);
      if (item.appId !== undefined) push('app_id', safeAppId);
      if (item.appName !== undefined) push('app_name', item.appName);
      if (item.developer !== undefined) push('developer', item.developer);
      if (item.url !== undefined) push('url', item.url);
      if (item.iconUrl !== undefined) push('icon_url', item.iconUrl);
      if (item.country !== undefined) push('country', item.country);
      if (item.scrapeError !== undefined) push('scrape_error', item.scrapeError);
      if (item.removedAppId !== undefined) push('removed_app_id', item.removedAppId);
      if (item.nextAttemptAt !== undefined) push('next_attempt_at', item.nextAttemptAt);
      if (item.attemptCount !== undefined) {
        // attempt_count is NOT NULL DEFAULT 0 — bypass the `?? null`
        // coercion in `push` to avoid a NULL constraint violation.
        fields.push('attempt_count = ?');
        values.push(item.attemptCount);
      }
      values.push(existing.id);
      statements.push({
        sql: `UPDATE import_items SET ${fields.join(', ')} WHERE id = ?`,
        params: values,
      });

      // Build the result row optimistically — we know what the row
      // will look like after the UPDATE lands (we built the patch).
      // Caller gets the same shape it would from the sync function.
      const updated: ImportItemRow = {
        id: existing.id,
        importId,
        query: existing.query,
        editedQuery: item.editedQuery !== undefined ? item.editedQuery : existing.edited_query,
        status: item.status,
        appId: safeAppId,
        appName: item.appName !== undefined ? item.appName : existing.app_name,
        developer: item.developer !== undefined ? item.developer : existing.developer,
        url: item.url !== undefined ? item.url : existing.url,
        iconUrl: item.iconUrl !== undefined ? item.iconUrl : existing.icon_url,
        country: item.country !== undefined ? item.country : existing.country,
        scrapeError: item.scrapeError !== undefined ? item.scrapeError : existing.scrape_error,
        removedAppId: item.removedAppId !== undefined ? item.removedAppId : existing.removed_app_id,
        nextAttemptAt: item.nextAttemptAt !== undefined ? item.nextAttemptAt : existing.next_attempt_at,
        attemptCount: item.attemptCount !== undefined ? item.attemptCount : (existing.attempt_count ?? 0),
      };
      results.push(updated);
      continue;
    }

    // Fresh INSERT path.
    const id = newId('iti');
    const attemptCount = item.attemptCount ?? 0;
    const safeAppId = cachedResolveSafeAppId(item.appId);
    statements.push({
      sql: INSERT_SQL,
      params: [
        id,
        importId,
        item.query,
        item.editedQuery ?? null,
        item.status,
        safeAppId,
        item.appName ?? null,
        item.developer ?? null,
        item.url ?? null,
        item.iconUrl ?? null,
        item.country ?? null,
        item.scrapeError ?? null,
        item.removedAppId ?? null,
        item.nextAttemptAt ?? null,
        attemptCount,
      ],
    });
    results.push({
      id,
      importId,
      query: item.query,
      editedQuery: item.editedQuery ?? null,
      status: item.status,
      appId: safeAppId,
      appName: item.appName ?? null,
      developer: item.developer ?? null,
      url: item.url ?? null,
      iconUrl: item.iconUrl ?? null,
      country: item.country ?? null,
      scrapeError: item.scrapeError ?? null,
      removedAppId: item.removedAppId ?? null,
      nextAttemptAt: item.nextAttemptAt ?? null,
      attemptCount,
    });
  }

  // Phase 2 (worker thread): execute the planned writes. This is the
  // slow part — N inserts + updates with FK checks and WAL fsync —
  // and it runs OFF the main event loop so the Node sidecar stays
  // responsive to webview polls during the import.
  if (statements.length > 0) {
    await runBulkWrite(statements);
  }

  // Phase 3 (sync, on main thread): recompute aggregate counters on
  // the imports row. This is a single UPDATE; doing it inline keeps
  // counter correctness on the same path the sync `addImportItems`
  // uses, and avoids a second round-trip to the worker for one row.
  recomputeImportCounters(importId);

  return results;
}

export function addImportItems(importId: string, items: AddImportItemInput[]): ImportItemRow[] {
  if (!getImportRow(importId)) {
    throw new Error(`Unknown import ${importId}`);
  }

  const findExisting = db.prepare(
    `SELECT * FROM import_items
       WHERE import_id = ? AND query = ?
       ORDER BY rowid LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO import_items (
      id, import_id, query, edited_query, status, app_id, app_name, developer, url,
      icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const results: ImportItemRow[] = [];

  const tx = db.transaction(() => {
    for (const item of items) {
      const existing = findExisting.get(importId, item.query) as
        | ImportItemRecord
        | undefined;

      if (existing) {
        // Respect the "removed" tombstone: a retry landing on a row the user
        // has already deleted from the dashboard must not flip the status
        // back. We hand the caller the existing row unchanged.
        if (existing.status === 'removed') {
          results.push(hydrateImportItem(existing));
          continue;
        }

        // Build an update patch that only touches fields the caller actually
        // supplied, keeping the prior values intact otherwise. Status is
        // always updated — that's the whole point of an upsert.
        const patch: Parameters<typeof updateImportItem>[1] = {
          status: item.status,
        };
        if (item.editedQuery !== undefined) patch.editedQuery = item.editedQuery;
        if (item.appId !== undefined) patch.appId = item.appId;
        if (item.appName !== undefined) patch.appName = item.appName;
        if (item.developer !== undefined) patch.developer = item.developer;
        if (item.url !== undefined) patch.url = item.url;
        if (item.iconUrl !== undefined) patch.iconUrl = item.iconUrl;
        if (item.country !== undefined) patch.country = item.country;
        if (item.scrapeError !== undefined) patch.scrapeError = item.scrapeError;
        if (item.removedAppId !== undefined) patch.removedAppId = item.removedAppId;
        if (item.nextAttemptAt !== undefined) patch.nextAttemptAt = item.nextAttemptAt;
        if (item.attemptCount !== undefined) patch.attemptCount = item.attemptCount;

        const updated = updateImportItem(existing.id, patch);
        if (updated) results.push(updated);
        continue;
      }

      const id = newId('iti');
      const attemptCount = item.attemptCount ?? 0;
      // See resolveSafeAppId above — at match time the apps row hasn't
      // been scraped yet, so the FK would blow up if we passed appId
      // straight through.
      const safeAppId = resolveSafeAppId(item.appId);
      insert.run(
        id,
        importId,
        item.query,
        item.editedQuery ?? null,
        item.status,
        safeAppId,
        item.appName ?? null,
        item.developer ?? null,
        item.url ?? null,
        item.iconUrl ?? null,
        item.country ?? null,
        item.scrapeError ?? null,
        item.removedAppId ?? null,
        item.nextAttemptAt ?? null,
        attemptCount,
      );
      results.push({
        id,
        importId,
        query: item.query,
        editedQuery: item.editedQuery ?? null,
        status: item.status,
        appId: safeAppId,
        appName: item.appName ?? null,
        developer: item.developer ?? null,
        url: item.url ?? null,
        iconUrl: item.iconUrl ?? null,
        country: item.country ?? null,
        scrapeError: item.scrapeError ?? null,
        removedAppId: item.removedAppId ?? null,
        nextAttemptAt: item.nextAttemptAt ?? null,
        attemptCount,
      });
    }
    recomputeImportCounters(importId);
  });

  tx();
  return results;
}

export function updateImportItem(
  itemId: string,
  patch: Partial<Omit<AddImportItemInput, 'query'>> & { query?: string },
): ImportItemRow | null {
  const existing = db
    .prepare('SELECT import_id FROM import_items WHERE id = ?')
    .get(itemId) as { import_id: string } | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  const pushField = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    values.push(value ?? null);
  };

  if (patch.query !== undefined) pushField('query', patch.query);
  if (patch.editedQuery !== undefined) pushField('edited_query', patch.editedQuery);
  if (patch.status !== undefined) pushField('status', patch.status);
  // Coerce app_id to NULL if the referenced apps row doesn't exist — see
  // resolveSafeAppId. Once the scrape populates apps, a later
  // markItemImported / recordItemSuccess re-writes this with a valid FK.
  if (patch.appId !== undefined) pushField('app_id', resolveSafeAppId(patch.appId));
  if (patch.appName !== undefined) pushField('app_name', patch.appName);
  if (patch.developer !== undefined) pushField('developer', patch.developer);
  if (patch.url !== undefined) pushField('url', patch.url);
  if (patch.iconUrl !== undefined) pushField('icon_url', patch.iconUrl);
  if (patch.country !== undefined) pushField('country', patch.country);
  if (patch.scrapeError !== undefined) pushField('scrape_error', patch.scrapeError);
  if (patch.removedAppId !== undefined) pushField('removed_app_id', patch.removedAppId);
  if (patch.nextAttemptAt !== undefined) pushField('next_attempt_at', patch.nextAttemptAt);
  if (patch.attemptCount !== undefined) {
    // attempt_count is NOT NULL DEFAULT 0 — coerce so pushField's ?? null
    // doesn't violate the column constraint.
    fields.push('attempt_count = ?');
    values.push(patch.attemptCount);
  }

  if (fields.length === 0) return getImportItemById(itemId);

  values.push(itemId);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE import_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    recomputeImportCounters(existing.import_id);
  });
  tx();

  return getImportItemById(itemId);
}

export function findImportItem(
  importId: string,
  query: string,
): ImportItemRow | null {
  const row = db
    .prepare(
      `SELECT * FROM import_items WHERE import_id = ?
       AND (query = ? OR edited_query = ?) ORDER BY rowid LIMIT 1`,
    )
    .get(importId, query, query) as ImportItemRecord | undefined;
  return row ? hydrateImportItem(row) : null;
}

export function markItemImported(
  importId: string,
  query: string,
  app: { id: string; name: string; developer?: string | null; url: string },
): ImportItemRow | null {
  const item = findImportItem(importId, query);
  if (!item) return null;
  return updateImportItem(item.id, {
    status: 'imported',
    appId: app.id,
    appName: app.name,
    developer: app.developer ?? null,
    url: app.url,
    scrapeError: null,
  });
}

export function markItemError(
  importId: string,
  query: string,
  error: string,
): ImportItemRow | null {
  const item = findImportItem(importId, query);
  if (!item) return null;
  return updateImportItem(item.id, {
    status: 'error',
    scrapeError: error,
  });
}

// ── Background queue helpers ───────────────────────────────────────────

/**
 * Flip an import item to `'queued'` so the background worker picks it up.
 *
 * Called when Apple returns a 429 partway through Step 4. We keep the row's
 * name/url/icon (so Import History can still render the app) and set a
 * `next_attempt_at` so the worker waits out the Retry-After window before
 * retrying. `attemptCount` is left alone here — the worker increments it
 * when it actually claims the item.
 */
export function enqueueItem(
  itemId: string,
  opts: { retryAfterMs?: number; scrapeError?: string | null } = {},
): ImportItemRow | null {
  const retryAfter = typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > 0
    ? opts.retryAfterMs
    : DEFAULT_QUEUE_BACKOFF_MS;
  return updateImportItem(itemId, {
    status: 'queued',
    nextAttemptAt: Date.now() + retryAfter,
    // Keep any existing scrape_error visible unless the caller overrode it.
    ...(opts.scrapeError !== undefined ? { scrapeError: opts.scrapeError } : {}),
  });
}

/**
 * Atomically claim up to `limit` queued rows that are due to retry. Each
 * claimed row gets its `attempt_count` incremented so the backoff can grow
 * if the next fetch also fails, and its `next_attempt_at` is pushed out to
 * a long "in flight" fence so no other worker picks it up while we're
 * scraping it.
 *
 * Caller is expected to call `recordItemSuccess` / `recordItemError` /
 * `recordItemRetry` on every claimed row.
 */
export function claimQueuedBatch(limit = 5): ImportItemRow[] {
  const claimed: ImportItemRow[] = [];
  const now = Date.now();
  // Fence the claimed row ~10 minutes into the future. Any in-flight scrape
  // that takes longer than that will be re-claimed by a later tick — that's
  // acceptable because Apple scrapes are idempotent on our side.
  const inFlightFence = now + 10 * 60 * 1000;

  const tx = db.transaction(() => {
    // Order: untracked apps (app_id IS NULL) before already-tracked
    // rescrapes (app_id NOT NULL). When a bulk import mixes new apps
    // with apps the user is already tracking, the user wants the new
    // ones to appear in the dashboard first — they're the reason they
    // ran the import. The already-tracked rows are effectively just a
    // sync; pushing them to the tail of every claim batch means a tick
    // that hits Apple's rate limit gives up its budget on net-new
    // apps, not on refreshing data that's already on screen.
    //
    // `app_id` is set by resolveSafeAppId at insert time: it's the
    // candidate's appleId when the apps row already exists, NULL
    // otherwise. So the SQL signal here is exactly the "already
    // tracked vs. not" question without an extra join.
    const rows = db
      .prepare(
        `SELECT * FROM import_items
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY
           CASE WHEN app_id IS NULL THEN 0 ELSE 1 END,
           next_attempt_at ASC,
           rowid ASC
         LIMIT ?`,
      )
      .all(now, limit) as ImportItemRecord[];

    const bump = db.prepare(
      `UPDATE import_items
         SET attempt_count = attempt_count + 1,
             next_attempt_at = ?
       WHERE id = ? AND status = 'queued'`,
    );

    for (const row of rows) {
      const result = bump.run(inFlightFence, row.id);
      if (result.changes === 1) {
        const refreshed = db
          .prepare('SELECT * FROM import_items WHERE id = ?')
          .get(row.id) as ImportItemRecord | undefined;
        if (refreshed) claimed.push(hydrateImportItem(refreshed));
      }
    }
  });

  tx();
  return claimed;
}

/**
 * Called by the worker when a queued item's scrape finally succeeds.
 * Clears the retry bookkeeping and marks the row as `'imported'`.
 */
export function recordItemSuccess(
  itemId: string,
  app: { id: string; name: string; developer?: string | null; url: string; iconUrl?: string | null },
): ImportItemRow | null {
  return updateImportItem(itemId, {
    status: 'imported',
    appId: app.id,
    appName: app.name,
    developer: app.developer ?? null,
    url: app.url,
    iconUrl: app.iconUrl ?? null,
    scrapeError: null,
    nextAttemptAt: null,
  });
}

/**
 * Called by the worker when a queued item's scrape fails with a permanent
 * error (404, malformed HTML, etc.) that we shouldn't keep retrying.
 * Flips the row to `'error'` and clears the retry fence so the UI can
 * render it under the "needs attention" bucket.
 */
export function recordItemError(itemId: string, error: string): ImportItemRow | null {
  return updateImportItem(itemId, {
    status: 'error',
    scrapeError: error,
    nextAttemptAt: null,
  });
}

/**
 * Called by the worker when a queued item's scrape fails with a transient
 * error (another 429, network blip, etc.). The row stays `'queued'` with
 * a fresh `next_attempt_at` so a later tick picks it up.
 */
export function recordItemRetry(
  itemId: string,
  opts: { retryAfterMs?: number; scrapeError?: string | null } = {},
): ImportItemRow | null {
  const existing = getImportItemById(itemId);
  if (!existing) return null;
  // Grow backoff with each attempt: Retry-After header wins if present,
  // otherwise 2^attemptCount minutes capped at the ceiling.
  const fallback = Math.min(
    DEFAULT_QUEUE_BACKOFF_MS * Math.pow(2, Math.max(0, existing.attemptCount - 1)),
    MAX_QUEUE_BACKOFF_MS,
  );
  const wait = typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > 0
    ? opts.retryAfterMs
    : fallback;
  return updateImportItem(itemId, {
    status: 'queued',
    nextAttemptAt: Date.now() + wait,
    scrapeError: opts.scrapeError ?? existing.scrapeError,
  });
}

/**
 * Cross-import snapshot of queued + in-flight rows for Task Center + the
 * `/api/imports/queue/status` route. Kept small on purpose — this is called
 * on a poll from the client.
 */
export function getQueueStatus(): {
  queued: number;
  oldestNextAttemptAt: number | null;
  soonestNextAttemptAt: number | null;
  items: ImportItemRow[];
} {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS queued,
         MIN(next_attempt_at) AS soonest,
         MAX(next_attempt_at) AS oldest
       FROM import_items WHERE status = 'queued'`,
    )
    .get() as { queued: number; soonest: number | null; oldest: number | null };

  const items = db
    .prepare(
      `SELECT * FROM import_items
       WHERE status = 'queued'
       ORDER BY next_attempt_at ASC, rowid ASC
       LIMIT 25`,
    )
    .all() as ImportItemRecord[];

  return {
    queued: counts.queued ?? 0,
    soonestNextAttemptAt: counts.soonest ?? null,
    oldestNextAttemptAt: counts.oldest ?? null,
    items: items.map(hydrateImportItem),
  };
}

// Backoff constants the worker + UI share. Kept in this module so there's a
// single source of truth for queue timing.
const DEFAULT_QUEUE_BACKOFF_MS = 60 * 1000;            // 1 minute
const MAX_QUEUE_BACKOFF_MS = 30 * 60 * 1000;           // 30 minutes

export function completeImport(importId: string): ImportRow | null {
  const before = getImportRow(importId);
  if (!before) return null;

  const tx = db.transaction(() => {
    recomputeImportCounters(importId);
    db.prepare('UPDATE imports SET completed_at = ? WHERE id = ?').run(Date.now(), importId);
  });
  tx();

  const after = getImportRow(importId);

  // Activity log — record a single summary row per onboarding import batch,
  // with the success/failure counts the user will want to eyeball. We use
  // `created_at` as the activity start so the duration on the row reflects
  // how long the import actually took (screenshot OCR → scrape → persist).
  if (after) {
    try {
      const imported = after.imported ?? 0;
      const errored = after.errored ?? 0;
      const queued = after.queued ?? 0;
      const unmatched = after.unmatched ?? 0;
      const itemCount = after.itemCount ?? 0;
      const total = after.total ?? itemCount;

      // Status derivation — ordered from "worst" to "best":
      //   • total > 0 && itemCount === 0    → error (items never persisted;
      //     we created the import row but the follow-up /api/imports/items
      //     POST never landed. Was previously falling through to 'ok' and
      //     showing the import as successful even though no apps imported.)
      //   • total > 0 && imported === 0     → error (everything failed or
      //     is still queued; nothing actually succeeded yet).
      //   • errored/queued/unmatched > 0 OR imported < total → partial.
      //   • else                             → ok.
      let status: ActivityStatus;
      if (total > 0 && itemCount === 0) {
        status = 'error';
      } else if (total > 0 && imported === 0) {
        status = 'error';
      } else if (errored > 0 || queued > 0 || unmatched > 0 || imported < total) {
        status = 'partial';
      } else {
        status = 'ok';
      }

      // Short-form summary the user sees in the activity row without
      // expanding it. Tries to include both the "good" and "bad" numbers
      // in one pass so scanning the log for problem imports is quick.
      const sourceHint = after.sourceLabel
        ? ` (${after.sourceLabel})`
        : after.source
          ? ` (${after.source})`
          : '';
      const parts: string[] = [];
      parts.push(`Imported ${imported}/${total}${sourceHint}`);
      if (errored > 0) parts.push(`${errored} failed`);
      if (queued > 0) parts.push(`${queued} queued`);
      if (unmatched > 0) parts.push(`${unmatched} unmatched`);
      // Diagnostic: itemCount diverging from total means some rows never
      // persisted (typical symptom: /api/search returned 500 or the
      // follow-up /api/imports/items POST never landed). Surface it on
      // the activity row so the root-cause is visible without expanding.
      if (itemCount === 0 && total > 0) {
        parts.push('no item rows persisted (search likely failed)');
      } else if (itemCount > 0 && itemCount < total) {
        parts.push(`${total - itemCount} rows missing from history`);
      }

      recordActivity({
        type: 'import',
        status,
        summary: parts.join(' · ').slice(0, 200),
        detail: {
          importId: after.id,
          source: after.source,
          sourceLabel: after.sourceLabel,
          total,
          imported,
          matched: after.matched ?? 0,
          unmatched,
          errored,
          queued,
          itemCount,
        },
        startedAt: after.createdAt,
        endedAt: after.completedAt ?? Date.now(),
      });

      // Bell notification — fires on every import completion regardless of
      // status so the user always gets a post-import signal, not just the
      // unmatched-manual-apps nudge.
      try {
        createImportCompletionNotification({
          importId: after.id,
          sourceLabel: after.sourceLabel,
          total,
          imported,
          errored,
          queued,
          unmatched,
          itemCount,
          status,
        });
      } catch (notifyError) {
        console.warn('[imports] completion notification failed:', notifyError);
      }

      if (imported > 0) {
        schedulePostAppUpdatePolicyFetch('import');
      }
    } catch (error) {
      console.warn('[imports] recordActivity (import) failed:', error);
    }
  }

  return after;
}

/**
 * Complete an import once no rows are still waiting to be scraped.
 *
 * The onboarding wizard now hands selected matches to the background queue
 * immediately, so the browser might be long gone by the time the last queued
 * row settles. This helper lets the server worker close out the batch, write
 * the activity row, and raise the completion notification without depending
 * on a still-mounted wizard.
 */
export function completeImportIfSettled(importId: string): ImportRow | null {
  const row = getImportRow(importId);
  if (!row || row.completedAt) return row;

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM import_items
        WHERE import_id = ?
          AND status IN ('matched', 'queued')`,
    )
    .get(importId) as { count: number } | undefined;

  if ((pending?.count ?? 0) > 0) return row;
  return completeImport(importId);
}

// ── Queries ────────────────────────────────────────────────────────────

export function listImports(): ImportRow[] {
  // Left-join an aggregate sub-select so each row carries live counters
  // for queued / errored / removed / total-items in a single query — no
  // N+1 follow-ups from the settings page. `queued_count` powers the
  // "Resume matching" button on the collapsed summary row. It folds
  // 'pending_search' rows in too: from the user's POV both statuses mean
  // "still in flight, waiting on Apple".
  const rows = db
    .prepare(
      `SELECT i.*,
              COALESCE(s.queued_count, 0)   AS queued_count,
              COALESCE(s.errored_count, 0)  AS errored_count,
              COALESCE(s.removed_count, 0)  AS removed_count,
              COALESCE(s.item_count, 0)     AS item_count
         FROM imports i
         LEFT JOIN (
           SELECT import_id,
                  SUM(CASE WHEN status IN ('queued', 'pending_search') THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errored_count,
                  SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed_count,
                  COUNT(*)                                            AS item_count
             FROM import_items
            GROUP BY import_id
         ) s ON s.import_id = i.id
         ORDER BY i.created_at DESC`,
    )
    .all() as (ImportRecord & {
      queued_count: number;
      errored_count: number;
      removed_count: number;
      item_count: number;
    })[];
  return rows.map(hydrateImport);
}

export function getImport(importId: string): { import: ImportRow; items: ImportItemRow[] } | null {
  const row = getImportRow(importId);
  if (!row) return null;

  const items = db
    .prepare('SELECT * FROM import_items WHERE import_id = ? ORDER BY rowid ASC')
    .all(importId) as ImportItemRecord[];

  return {
    import: row,
    items: items.map(hydrateImportItem),
  };
}

export function getImportItemById(itemId: string): ImportItemRow | null {
  const row = db
    .prepare('SELECT * FROM import_items WHERE id = ?')
    .get(itemId) as ImportItemRecord | undefined;
  return row ? hydrateImportItem(row) : null;
}

// ── Provenance lookups ─────────────────────────────────────────────────

export interface AppImportProvenance {
  item: ImportItemRow;
  /**
   * The batch this item belonged to. Captured separately so the per-app
   * detail footer can show "imported on <date>" without a second DB trip —
   * the `items.import_id` FK already uniquely determines the row, and we
   * expose the createdAt / source / source label for render.
   */
  importId: string;
  importedAt: number;
  source: ImportSource;
  sourceLabel: string | null;
}

/**
 * Look up the "where did this app come from" record for the app detail
 * footer. Prefers the canonical `imported` row (the one the dashboard was
 * actually fed from); if somehow the app got into the dashboard through a
 * row still at `matched` / `queued` we fall back to the most recent of
 * those so the user still gets a link they can open to fix the match.
 *
 * Returns `null` when no import_item is on file — legacy apps imported
 * before the onboarding wizard persisted items, or apps added through a
 * code path that bypasses the import batch, won't have a row to link to
 * and the footer should simply render "imported" without the fix-match CTA.
 */
export function getAppImportProvenance(
  appId: string,
): AppImportProvenance | null {
  if (!appId) return null;
  // CASE-ordering: 'imported' wins over matched/queued. Everything else is
  // last-resort so a user can still find *some* history row to fix from.
  // Ordering inside each bucket is by the parent import's created_at DESC
  // so the most recent batch surfaces first when an app was re-imported.
  const row = db
    .prepare(
      `SELECT ii.*, i.created_at AS i_created_at,
              i.source AS i_source, i.source_label AS i_source_label
         FROM import_items ii
         JOIN imports i ON i.id = ii.import_id
        WHERE ii.app_id = ? OR ii.removed_app_id = ?
        ORDER BY
          CASE ii.status
            WHEN 'imported' THEN 0
            WHEN 'matched'  THEN 1
            WHEN 'queued'   THEN 2
            ELSE 3
          END,
          i.created_at DESC
        LIMIT 1`,
    )
    .get(appId, appId) as
    | (ImportItemRecord & {
        i_created_at: number;
        i_source: string;
        i_source_label: string | null;
      })
    | undefined;

  if (!row) return null;

  return {
    item: hydrateImportItem(row),
    importId: row.import_id,
    importedAt: row.i_created_at,
    source: normalizeSource(row.i_source),
    sourceLabel: row.i_source_label,
  };
}

// ── Removed-app bookkeeping ────────────────────────────────────────────

/**
 * Called just before `DELETE FROM apps WHERE id = ?` so every import item
 * that pointed at the dying app is flipped to `status = 'removed'`. The
 * original app id is preserved in `removed_app_id` — the FK `ON DELETE
 * SET NULL` will wipe `app_id` once the cascade fires, but this sticky
 * pointer lets the import-history UI keep showing which app was removed
 * and gives retry flows the information they need to refuse re-adding it.
 *
 * Re-marking an already-removed row is a no-op (the `removed_app_id` stays
 * as originally captured — we never want to overwrite it).
 *
 * Returns the list of distinct import ids that had at least one row flip so
 * the caller can recompute their counters.
 */
export function markImportItemsRemovedForApp(appId: string): string[] {
  const affected = db
    .prepare(
      `SELECT DISTINCT import_id FROM import_items
       WHERE app_id = ? AND status != 'removed'`,
    )
    .all(appId) as { import_id: string }[];

  if (affected.length === 0) return [];

  db.prepare(
    `UPDATE import_items
       SET status = 'removed',
           removed_app_id = COALESCE(removed_app_id, app_id)
     WHERE app_id = ? AND status != 'removed'`,
  ).run(appId);

  const importIds = affected.map(row => row.import_id);
  for (const importId of importIds) recomputeImportCounters(importId);
  return importIds;
}

/**
 * Overwrite an import item's match with a freshly scraped app. Intended for
 * the "Change match" / "Re-add" flows in the import-history UI.
 *
 * The caller is expected to have already scraped the new URL (so the
 * corresponding `apps` row exists); this function just mutates the import
 * item. When the item previously pointed at a different app, we also clean
 * up that old app row if no *other* import item still references it.
 */
export function replaceImportItemMatch(
  itemId: string,
  newApp: {
    id: string;
    name: string;
    developer?: string | null;
    url: string;
    /**
     * App Store icon URL for the new match. Optional for back-compat with
     * callers that only pass id/name/url, but the current "Change match" /
     * "Re-add" flows always supply it so the import-history row stops
     * showing the *previous* match's icon after the user fixes a mismatch.
     */
    iconUrl?: string | null;
  },
): { item: ImportItemRow | null; previousAppRemoved: string | null } {
  const existing = db
    .prepare('SELECT * FROM import_items WHERE id = ?')
    .get(itemId) as ImportItemRecord | undefined;
  if (!existing) return { item: null, previousAppRemoved: null };

  // The "previous" app is whichever id we last pointed at — either the live
  // FK (`app_id`) or the tombstone we stashed on a prior removal.
  const previousAppId = existing.app_id ?? existing.removed_app_id ?? null;

  let previousAppRemoved: string | null = null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE import_items
         SET status = 'imported',
             app_id = ?,
             app_name = ?,
             developer = ?,
             url = ?,
             icon_url = ?,
             scrape_error = NULL,
             removed_app_id = NULL
       WHERE id = ?`,
    ).run(
      newApp.id,
      newApp.name,
      newApp.developer ?? null,
      newApp.url,
      newApp.iconUrl ?? null,
      itemId,
    );

    // Garbage-collect the previous app if no other import row still points
    // at it. Safe: the ON DELETE SET NULL cascade won't touch our just-set
    // `app_id` because that one now equals `newApp.id`, not the old id.
    if (previousAppId && previousAppId !== newApp.id) {
      const stillReferenced = db
        .prepare(
          `SELECT 1 FROM import_items
           WHERE id != ?
             AND (app_id = ? OR removed_app_id = ?)
           LIMIT 1`,
        )
        .get(itemId, previousAppId, previousAppId);
      if (!stillReferenced) {
        db.prepare('DELETE FROM apps WHERE id = ?').run(previousAppId);
        previousAppRemoved = previousAppId;
      }
    }

    recomputeImportCounters(existing.import_id);
  });

  tx();

  // Mark any notifications that were raised against the previous app as
  // stale, so the bell shows them in a faded state rather than silently
  // continuing to look like live entries for an app the user no longer
  // tracks through this import row. Runs outside the transaction so a
  // notification-write failure can't roll back the match change.
  if (previousAppId && previousAppId !== newApp.id) {
    try {
      markNotificationsStaleForApp(previousAppId);
    } catch (error) {
      console.warn('[imports] markNotificationsStaleForApp failed:', error);
    }
  }

  return { item: getImportItemById(itemId), previousAppRemoved };
}

// ── Deletion / revert ──────────────────────────────────────────────────

export function deleteImport(
  importId: string,
  opts: { removeApps: boolean },
): { deletedApps: number } {
  const existing = getImport(importId);
  if (!existing) return { deletedApps: 0 };

  const appIds = opts.removeApps
    ? existing.items
        .map(item => item.appId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  const tx = db.transaction(() => {
    if (appIds.length > 0) {
      const deleteApp = db.prepare('DELETE FROM apps WHERE id = ?');
      for (const appId of appIds) deleteApp.run(appId);
    }
    // Cascades remove import_items automatically.
    db.prepare('DELETE FROM imports WHERE id = ?').run(importId);
  });
  tx();

  return { deletedApps: appIds.length };
}

// ── Internal helpers ───────────────────────────────────────────────────

interface ImportRecord {
  id: string;
  created_at: number;
  completed_at: number | null;
  source: string;
  source_label: string | null;
  total: number;
  matched: number;
  unmatched: number;
  imported: number;
}

interface ImportItemRecord {
  id: string;
  import_id: string;
  query: string;
  edited_query: string | null;
  status: string;
  app_id: string | null;
  app_name: string | null;
  developer: string | null;
  url: string | null;
  icon_url: string | null;
  country: string | null;
  scrape_error: string | null;
  removed_app_id: string | null;
  next_attempt_at: number | null;
  attempt_count: number | null;
}

function getImportRow(importId: string): ImportRow | null {
  // Same live-counter join as `listImports` — keeps the single-row read
  // surface-compatible with the list payload so the UI can use one shape.
  // See listImports for why 'pending_search' folds into queued_count.
  const row = db
    .prepare(
      `SELECT i.*,
              COALESCE(s.queued_count, 0)   AS queued_count,
              COALESCE(s.errored_count, 0)  AS errored_count,
              COALESCE(s.removed_count, 0)  AS removed_count,
              COALESCE(s.item_count, 0)     AS item_count
         FROM imports i
         LEFT JOIN (
           SELECT import_id,
                  SUM(CASE WHEN status IN ('queued', 'pending_search') THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errored_count,
                  SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed_count,
                  COUNT(*)                                            AS item_count
             FROM import_items
            WHERE import_id = ?
            GROUP BY import_id
         ) s ON s.import_id = i.id
        WHERE i.id = ?`,
    )
    .get(importId, importId) as
    | (ImportRecord & {
        queued_count: number;
        errored_count: number;
        removed_count: number;
        item_count: number;
      })
    | undefined;
  return row ? hydrateImport(row) : null;
}

function getImportRowOrThrow(importId: string): ImportRow {
  const row = getImportRow(importId);
  if (!row) throw new Error(`Import ${importId} not found immediately after insert`);
  return row;
}

function recomputeImportCounters(importId: string): void {
  // `removed` items are no longer tracked in the dashboard, so they don't
  // count toward `matched` or `imported`. They do still count toward the
  // `unmatched` bucket the UI uses for the "needs attention" badge so the
  // user can see at a glance that something changed since the import ran.
  //
  // `queued` items have a confirmed candidate and will be scraped by the
  // background worker, so they DO count as matched (the UI shows them
  // pending). They don't count as `imported` until the worker actually
  // brings them in, and they're not "unmatched" because we already know
  // which app they refer to.
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('matched', 'imported', 'queued') THEN 1 ELSE 0 END) AS matched,
         SUM(CASE WHEN status IN ('unmatched', 'skipped', 'error', 'removed') THEN 1 ELSE 0 END) AS unmatched,
         SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) AS imported
       FROM import_items WHERE import_id = ?`,
    )
    .get(importId) as {
    total: number;
    matched: number | null;
    unmatched: number | null;
    imported: number | null;
  };

  // `total` on the imports row is what the user originally submitted; keep it
  // at max(existing, current rows) so it never shrinks if a row is removed later.
  const current = db
    .prepare('SELECT total FROM imports WHERE id = ?')
    .get(importId) as { total: number } | undefined;
  const existingTotal = current?.total ?? 0;

  db.prepare(
    `UPDATE imports
     SET total = ?, matched = ?, unmatched = ?, imported = ?
     WHERE id = ?`,
  ).run(
    Math.max(existingTotal, counts.total ?? 0),
    counts.matched ?? 0,
    counts.unmatched ?? 0,
    counts.imported ?? 0,
    importId,
  );
}

function hydrateImport(
  row: ImportRecord & {
    queued_count?: number;
    errored_count?: number;
    removed_count?: number;
    item_count?: number;
  },
): ImportRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    source: normalizeSource(row.source),
    sourceLabel: row.source_label,
    total: row.total,
    matched: row.matched,
    unmatched: row.unmatched,
    imported: row.imported,
    // Defaults handle the rare callers that still go through plain
    // `SELECT * FROM imports` — older helpers that don't need the live
    // counters. The user-facing history paths always go through the
    // joined queries above and get real numbers.
    queued: row.queued_count ?? 0,
    errored: row.errored_count ?? 0,
    removed: row.removed_count ?? 0,
    itemCount: row.item_count ?? 0,
  };
}

function hydrateImportItem(row: ImportItemRecord): ImportItemRow {
  return {
    id: row.id,
    importId: row.import_id,
    query: row.query,
    editedQuery: row.edited_query,
    status: normalizeItemStatus(row.status),
    appId: row.app_id,
    appName: row.app_name,
    developer: row.developer,
    url: row.url,
    iconUrl: row.icon_url,
    country: row.country,
    scrapeError: row.scrape_error,
    removedAppId: row.removed_app_id,
    nextAttemptAt: row.next_attempt_at,
    attemptCount: row.attempt_count ?? 0,
  };
}

function normalizeSource(value: string): ImportSource {
  return IMPORT_SOURCES.find(source => source === value) ?? 'manual';
}

function normalizeItemStatus(value: string): ImportItemStatus {
  return IMPORT_ITEM_STATUSES.find(status => status === value) ?? 'unmatched';
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}
