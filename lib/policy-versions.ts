import crypto from 'crypto';
import db from './db';

/**
 * One row per *distinct* privacy-policy text we have ever successfully
 * scraped for an app. Keyed by (app_id, content_hash) so a rescrape that
 * lands on identical text reuses the existing row — the caller still
 * updates `last_fetched_at` to reflect "seen again at this time".
 *
 * Every changelog entry with category `privacy-policy` carries this row's
 * `id`, so a user clicking a changelog point can fetch the exact text
 * captured at that time via GET /api/policy/version/[id].
 */
export interface PolicyVersionRow {
  id: string;
  app_id: string;
  content_hash: string;
  first_fetched_at: number;
  last_fetched_at: number;
  policy_url: string | null;
  source_final_url: string | null;
  source_title: string | null;
  source_content_type: string | null;
  source_origin: string | null;
  source_word_count: number;
  source_text: string;
  /**
   * Internet Archive snapshot URL for this exact version, populated
   * best-effort after a successful scrape (see lib/wayback.ts). Null while
   * we haven't landed a snapshot yet, or on installs where archive.org was
   * unreachable at scrape time.
   */
  archive_url: string | null;
  /** Epoch ms of the most recent time we recorded an archive URL. */
  archive_submitted_at: number | null;
}

interface UpsertInput {
  appId: string;
  contentHash: string;
  fetchedAt: number;
  policyUrl: string | null;
  sourceFinalUrl: string | null;
  sourceTitle: string | null;
  sourceContentType: string | null;
  sourceOrigin: string | null;
  sourceWordCount: number;
  sourceText: string;
}

/**
 * Insert a new version, or touch `last_fetched_at` if the (app_id, hash)
 * pair already exists. Returns the row id in both cases so the caller can
 * stamp it onto the changelog entry it's about to write.
 */
export function upsertPolicyVersion(input: UpsertInput): string {
  const existing = db
    .prepare(
      'SELECT id FROM privacy_policy_versions WHERE app_id = ? AND content_hash = ?',
    )
    .get(input.appId, input.contentHash) as { id?: string } | undefined;

  if (existing?.id) {
    db.prepare(
      'UPDATE privacy_policy_versions SET last_fetched_at = ? WHERE id = ?',
    ).run(input.fetchedAt, existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO privacy_policy_versions (
       id, app_id, content_hash, first_fetched_at, last_fetched_at,
       policy_url, source_final_url, source_title, source_content_type,
       source_origin, source_word_count, source_text
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.appId,
    input.contentHash,
    input.fetchedAt,
    input.fetchedAt,
    input.policyUrl,
    input.sourceFinalUrl,
    input.sourceTitle,
    input.sourceContentType,
    input.sourceOrigin,
    input.sourceWordCount,
    input.sourceText,
  );
  return id;
}

/** Fetch a single version row by id. */
export function getPolicyVersion(id: string): PolicyVersionRow | null {
  const row = db
    .prepare(
      `SELECT id, app_id, content_hash, first_fetched_at, last_fetched_at,
              policy_url, source_final_url, source_title, source_content_type,
              source_origin, source_word_count, source_text,
              archive_url, archive_submitted_at
         FROM privacy_policy_versions
        WHERE id = ?`,
    )
    .get(id) as PolicyVersionRow | undefined;
  return row ?? null;
}

/**
 * Lookup helper used by the change-detection branch to decide whether a
 * prior version exists at all (i.e. is this a first-ever scrape or not).
 */
export function hasAnyPolicyVersion(appId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM privacy_policy_versions WHERE app_id = ? LIMIT 1')
    .get(appId) as { present?: number } | undefined;
  return Boolean(row?.present);
}

/**
 * Stamp a version row with the Internet Archive snapshot URL. Called
 * best-effort after a successful scrape - either synchronously when the
 * Wayback availability API already knows about this URL, or asynchronously
 * from the fire-and-forget Save Page Now submission. Safe to call multiple
 * times on the same row; the last writer wins.
 */
export function setPolicyVersionArchiveUrl(
  id: string,
  archiveUrl: string,
  submittedAt: number,
): void {
  db.prepare(
    'UPDATE privacy_policy_versions SET archive_url = ?, archive_submitted_at = ? WHERE id = ?',
  ).run(archiveUrl, submittedAt, id);
}

/**
 * Resolve the *current* policy version row for an app: the row with the
 * greatest `last_fetched_at`, which is always the text the AI Policy tab
 * is summarising. Returns null when no scrape has ever succeeded for the
 * app (e.g. the developer link has been unreachable since onboarding).
 */
export function getCurrentPolicyVersion(appId: string): PolicyVersionRow | null {
  const row = db
    .prepare(
      `SELECT id, app_id, content_hash, first_fetched_at, last_fetched_at,
              policy_url, source_final_url, source_title, source_content_type,
              source_origin, source_word_count, source_text,
              archive_url, archive_submitted_at
         FROM privacy_policy_versions
        WHERE app_id = ?
        ORDER BY last_fetched_at DESC
        LIMIT 1`,
    )
    .get(appId) as PolicyVersionRow | undefined;
  return row ?? null;
}

/**
 * Compact descriptor used by the AI Policy tab's "policy changed
 * recently" banner. Returned only when *all* of the following hold:
 *   - `windowDays` is positive (0 disables the banner entirely);
 *   - the app has a current version (i.e. at least one successful scrape);
 *   - that version has an earlier predecessor (i.e. this is a real change,
 *     not the first-ever capture);
 *   - the current version's `first_fetched_at` falls within the window.
 *
 * The versionId lets the UI deep-link to the diff endpoint directly, and
 * the timestamp drives the "changed N days ago" copy.
 */
export interface RecentPolicyChange {
  currentVersionId: string;
  previousVersionId: string;
  changedAt: number;
}

export function getRecentPolicyChange(
  appId: string,
  windowDays: number,
): RecentPolicyChange | null {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

  const current = getCurrentPolicyVersion(appId);
  if (!current) return null;

  const previous = getPreviousPolicyVersion(current.id);
  if (!previous) return null;

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  if (current.first_fetched_at + windowMs <= Date.now()) return null;

  return {
    currentVersionId: current.id,
    previousVersionId: previous.id,
    changedAt: current.first_fetched_at,
  };
}

/**
 * Fetch the version row that immediately precedes `id` for the same app,
 * defined as the most recent other row with `first_fetched_at <` the
 * given row's timestamp. Returns null if `id` is unknown or if the app
 * has no earlier version (i.e. this is the first-ever scrape).
 *
 * Only rows with a *different* content_hash count — if by some path a
 * stale duplicate slipped in, we skip past it so the diff always shows
 * something that genuinely changed.
 */
export function getPreviousPolicyVersion(id: string): PolicyVersionRow | null {
  const current = getPolicyVersion(id);
  if (!current) return null;

  const row = db
    .prepare(
      `SELECT id, app_id, content_hash, first_fetched_at, last_fetched_at,
              policy_url, source_final_url, source_title, source_content_type,
              source_origin, source_word_count, source_text,
              archive_url, archive_submitted_at
         FROM privacy_policy_versions
        WHERE app_id = ?
          AND content_hash != ?
          AND first_fetched_at < ?
        ORDER BY first_fetched_at DESC
        LIMIT 1`,
    )
    .get(current.app_id, current.content_hash, current.first_fetched_at) as
    | PolicyVersionRow
    | undefined;

  return row ?? null;
}

/**
 * Resolve the most recent archive URL captured for a given app + content
 * hash. Used by the AI Policy tab to surface the snapshot that belongs to
 * whatever text the analysis is currently summarising, without having to
 * know the version id.
 */
export function getArchiveUrlForHash(
  appId: string,
  contentHash: string | null,
): string | null {
  if (!contentHash) return null;
  const row = db
    .prepare(
      `SELECT archive_url FROM privacy_policy_versions
        WHERE app_id = ? AND content_hash = ?
        LIMIT 1`,
    )
    .get(appId, contentHash) as { archive_url?: string | null } | undefined;
  return row?.archive_url ?? null;
}
