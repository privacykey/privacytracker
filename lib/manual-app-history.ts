/**
 * Server-only helpers for the manual-app changelog and privacy-policy
 * version store. Pairs with `manual-apps-server.ts` but lives here so the
 * CRUD module stays focused and the detail-view features (scrape history,
 * field-change timeline) have a single home.
 *
 * Never imported from client components — `db` and Node crypto are Node-only.
 */

import crypto from "node:crypto";
import db from "./db";

// ── Event types ────────────────────────────────────────────────────────
// Kept as a loose string union so future event flavours (e.g. 'note_added'
// vs 'note_edited') can ship without a migration. The TypeScript union is
// the source of truth; the DB stores whatever string we write.
export type ManualAppEventType = "scrape" | "field_change";

export type ManualAppPolicyEvent = "first" | "same" | "changed" | "error";

export interface ManualAppScrapeDetail {
  contentHash?: string;
  /** Human-readable error string for `policy_event='error'` rows. */
  error?: string;
  finalUrl?: string;
  policy_event: ManualAppPolicyEvent;
  policyUrl?: string;
  title?: string;
  /** Row id in manual_app_policy_versions, when the fetch succeeded. */
  versionId?: string;
  wordCount?: number;
}

export interface ManualAppFieldChangeDetail {
  field:
    | "name"
    | "source"
    | "developer"
    | "privacyPolicyUrl"
    | "sourceUrl"
    | "notes";
  from: string | null;
  to: string | null;
}

export type ManualAppEventDetail =
  | ({ kind: "scrape" } & ManualAppScrapeDetail)
  | ({ kind: "field_change" } & ManualAppFieldChangeDetail);

export interface ManualAppEvent {
  detail: ManualAppEventDetail | null;
  id: string;
  manualAppId: string;
  occurredAt: number;
  type: ManualAppEventType;
}

interface ManualAppEventRow {
  detail: string | null;
  event_type: string;
  id: string;
  manual_app_id: string;
  occurred_at: number;
}

function hydrateEvent(row: ManualAppEventRow): ManualAppEvent {
  let detail: ManualAppEventDetail | null = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as ManualAppEventDetail;
    } catch {
      // Legacy or corrupted rows still render as "unknown event" instead of
      // crashing the whole timeline. Empty detail is meaningful.
      detail = null;
    }
  }
  return {
    id: row.id,
    manualAppId: row.manual_app_id,
    type: (row.event_type as ManualAppEventType) ?? "scrape",
    occurredAt: row.occurred_at,
    detail,
  };
}

/**
 * Append a single changelog row. Safe to call outside a transaction; the
 * caller decides whether to wrap multiple writes.
 */
export function appendManualAppEvent(input: {
  manualAppId: string;
  type: ManualAppEventType;
  detail: ManualAppEventDetail;
  occurredAt?: number;
}): ManualAppEvent {
  const id = crypto.randomUUID();
  const occurredAt = input.occurredAt ?? Date.now();
  const detailJson = JSON.stringify(input.detail);

  db.prepare(
    `INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.manualAppId, input.type, occurredAt, detailJson);

  return {
    id,
    manualAppId: input.manualAppId,
    type: input.type,
    occurredAt,
    detail: input.detail,
  };
}

export function listManualAppEvents(
  manualAppId: string,
  limit = 200
): ManualAppEvent[] {
  const rows = db
    .prepare(
      `SELECT id, manual_app_id, event_type, occurred_at, detail
         FROM manual_app_events
        WHERE manual_app_id = ?
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(manualAppId, limit) as ManualAppEventRow[];
  return rows.map(hydrateEvent);
}

/**
 * Drop all events + version rows for a manual app. Called from
 * `deleteManualApp` so removing the parent row leaves no orphans.
 */
export function deleteManualAppHistory(manualAppId: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM manual_app_events WHERE manual_app_id = ?").run(
      manualAppId
    );
    db.prepare(
      "DELETE FROM manual_app_policy_versions WHERE manual_app_id = ?"
    ).run(manualAppId);
  });
  tx();
}

// ── Policy versions ────────────────────────────────────────────────────

export interface ManualAppPolicyVersion {
  contentHash: string;
  firstFetchedAt: number;
  id: string;
  lastFetchedAt: number;
  manualAppId: string;
  policyUrl: string | null;
  sourceContentType: string | null;
  sourceFinalUrl: string | null;
  sourceOrigin: string | null;
  sourceText: string;
  sourceTitle: string | null;
  sourceWordCount: number;
}

interface ManualAppPolicyVersionRow {
  content_hash: string;
  first_fetched_at: number;
  id: string;
  last_fetched_at: number;
  manual_app_id: string;
  policy_url: string | null;
  source_content_type: string | null;
  source_final_url: string | null;
  source_origin: string | null;
  source_text: string;
  source_title: string | null;
  source_word_count: number;
}

function hydrateVersion(
  row: ManualAppPolicyVersionRow
): ManualAppPolicyVersion {
  return {
    id: row.id,
    manualAppId: row.manual_app_id,
    contentHash: row.content_hash,
    firstFetchedAt: row.first_fetched_at,
    lastFetchedAt: row.last_fetched_at,
    policyUrl: row.policy_url,
    sourceFinalUrl: row.source_final_url,
    sourceTitle: row.source_title,
    sourceContentType: row.source_content_type,
    sourceOrigin: row.source_origin,
    sourceWordCount: row.source_word_count,
    sourceText: row.source_text,
  };
}

/**
 * Insert a version or touch `last_fetched_at` if (app, hash) already
 * exists. Mirrors `upsertPolicyVersion` in lib/policy-versions.ts but
 * keyed off the manual-apps id space.
 */
export function upsertManualAppPolicyVersion(input: {
  manualAppId: string;
  contentHash: string;
  fetchedAt: number;
  policyUrl: string | null;
  sourceFinalUrl: string | null;
  sourceTitle: string | null;
  sourceContentType: string | null;
  sourceOrigin: string | null;
  sourceWordCount: number;
  sourceText: string;
}): { id: string; isNew: boolean } {
  const existing = db
    .prepare(
      "SELECT id FROM manual_app_policy_versions WHERE manual_app_id = ? AND content_hash = ?"
    )
    .get(input.manualAppId, input.contentHash) as { id?: string } | undefined;

  if (existing?.id) {
    db.prepare(
      "UPDATE manual_app_policy_versions SET last_fetched_at = ? WHERE id = ?"
    ).run(input.fetchedAt, existing.id);
    return { id: existing.id, isNew: false };
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO manual_app_policy_versions (
       id, manual_app_id, content_hash, first_fetched_at, last_fetched_at,
       policy_url, source_final_url, source_title, source_content_type,
       source_origin, source_word_count, source_text
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.manualAppId,
    input.contentHash,
    input.fetchedAt,
    input.fetchedAt,
    input.policyUrl,
    input.sourceFinalUrl,
    input.sourceTitle,
    input.sourceContentType,
    input.sourceOrigin,
    input.sourceWordCount,
    input.sourceText
  );
  return { id, isNew: true };
}

export function getManualAppPolicyVersion(
  id: string
): ManualAppPolicyVersion | null {
  const row = db
    .prepare(
      `SELECT id, manual_app_id, content_hash, first_fetched_at, last_fetched_at,
              policy_url, source_final_url, source_title, source_content_type,
              source_origin, source_word_count, source_text
         FROM manual_app_policy_versions WHERE id = ?`
    )
    .get(id) as ManualAppPolicyVersionRow | undefined;
  return row ? hydrateVersion(row) : null;
}

export function getCurrentManualAppPolicyVersion(
  manualAppId: string
): ManualAppPolicyVersion | null {
  const row = db
    .prepare(
      `SELECT id, manual_app_id, content_hash, first_fetched_at, last_fetched_at,
              policy_url, source_final_url, source_title, source_content_type,
              source_origin, source_word_count, source_text
         FROM manual_app_policy_versions
        WHERE manual_app_id = ?
        ORDER BY last_fetched_at DESC
        LIMIT 1`
    )
    .get(manualAppId) as ManualAppPolicyVersionRow | undefined;
  return row ? hydrateVersion(row) : null;
}

export function hasAnyManualAppPolicyVersion(manualAppId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM manual_app_policy_versions WHERE manual_app_id = ? LIMIT 1"
    )
    .get(manualAppId) as { present?: number } | undefined;
  return Boolean(row?.present);
}
