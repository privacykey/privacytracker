import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/*
 * Build-phase detection. `next build` runs page-data collection in parallel
 * worker subprocesses, all of which would race to open + migrate the same
 * on-disk SQLite file (SQLITE_BUSY despite `busy_timeout = 5000`). Build
 * doesn't actually use the DB — only needs modules to evaluate cleanly —
 * so we open an in-memory database per worker. NEXT_PHASE is set by Next;
 * BUILD_STANDALONE is set by package.json's build:standalone script.
 */
export const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.BUILD_STANDALONE === "1";

/*
 * Resolve the data directory.
 *   1. PRIVACYTRACKER_DATA_DIR env — honoured unconditionally (Tauri injects
 *      this; also an escape hatch for custom Docker mounts).
 *   2. <cwd>/data — the default for Docker Compose and `npm run dev`/`start`.
 * Created on demand. Skipped during build phase (in-memory DB).
 */
export const dataDir = process.env.PRIVACYTRACKER_DATA_DIR
  ? path.resolve(process.env.PRIVACYTRACKER_DATA_DIR)
  : path.join(process.cwd(), "data");
if (!(isBuildPhase || fs.existsSync(dataDir))) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
if (!(isBuildPhase || process.platform === "win32")) {
  // Existing installs may predate the private-mode default. Tighten the
  // directory on every open so upgrades repair it without a separate migration.
  fs.chmodSync(dataDir, 0o700);
}

export const dbPath = isBuildPhase
  ? ":memory:"
  : path.join(dataDir, "privacy.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

if (!(isBuildPhase || process.platform === "win32")) {
  // SQLite creates WAL/SHM siblings lazily. The private directory is the
  // primary boundary; chmod any files already present as defence in depth.
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    iconUrl TEXT,
    bundleId TEXT,
    developer TEXT,
    firstSeen INTEGER NOT NULL DEFAULT 0,
    lastSynced INTEGER NOT NULL,
    changeCount INTEGER NOT NULL DEFAULT 0,
    changes_acknowledged_at INTEGER NOT NULL DEFAULT 0,
    /* Epoch ms until which the "What's changed" review panel is suppressed.
       0/NULL means not snoozed. Rolls off automatically (any past value is
       treated as 0). Cleared by Mark-reviewed / Dismiss. */
    changes_snoozed_until INTEGER NOT NULL DEFAULT 0,
    currentVersion TEXT,
    versionUpdatedAt INTEGER,
    whatsNew TEXT,
    /* NULL = unknown / parser could not decide; 1 = developer declared
       privacy labels; 0 = "No Details Provided" on Apple's page. */
    hasPrivacyDetails INTEGER,
    /* Mirror of hasPrivacyDetails for Apple's accessibility nutrition labels.
       NULL = unknown; 1 = at least one feature declared; 0 = shelf absent.
       Kept hot on the apps row so dashboard/grid/stats don't need to JOIN
       into accessibility_features for every query. */
    hasAccessibilityLabels INTEGER,
    /* Pricing snapshot from the iTunes Lookup endpoint, captured on every
       sync. priceAmount is the raw decimal (0 for "Free"); priceCurrency
       is the ISO code; priceFormatted is Apple's localised display string
       which we render directly. NULL across all three = "price unknown". */
    priceAmount REAL,
    priceCurrency TEXT,
    priceFormatted TEXT,
    /* In-app purchases boolean. 1 = IAP shelf with at least one item;
       0 = scraped, no IAP shelf; NULL = unknown. */
    hasIap INTEGER,
    /* Apple App Store genre/category from iTunes Lookup. Powers the
       Compare page's "Top in same category" quick-pick. NULL on existing
       rows until the next sync fills them in. */
    genreId INTEGER,
    genreName TEXT,
    /* App Store age rating from iTunes Lookup, raw string ("4+", "13+").
       Legacy 12+/17+ strings may persist on old rows; comparisons parse
       the number rather than matching the enum. NULL = unknown. */
    ageRating TEXT
  );

  CREATE TABLE IF NOT EXISTS privacy_types (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_privacy_types_app
    ON privacy_types(app_id);

  CREATE INDEX IF NOT EXISTS idx_privacy_types_app_identifier
    ON privacy_types(app_id, identifier);

  /* Legacy table — kept for migration safety, no longer populated */
  CREATE TABLE IF NOT EXISTS privacy_purposes (
    id TEXT PRIMARY KEY,
    type_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (type_id) REFERENCES privacy_types(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS privacy_categories (
    id TEXT PRIMARY KEY,
    purpose_id TEXT,
    type_id TEXT,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (purpose_id) REFERENCES privacy_purposes(id) ON DELETE CASCADE,
    FOREIGN KEY (type_id) REFERENCES privacy_types(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_privacy_categories_type
    ON privacy_categories(type_id);

  CREATE TABLE IF NOT EXISTS privacy_data_types (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES privacy_categories(id) ON DELETE CASCADE
  );

  /* Apple's accessibility nutrition labels. Flat shape: one row per feature
     the developer claims to support (VoiceOver, Voice Control, etc.).
     Features not listed = not claimed.

     identifier is our own slug derived from the feature title (Apple doesn't
     expose a stable machine id). Slug is stable in en-US for diff/matching.
     icon_template holds the systemimage:// URI for UI glyphs.

     Rows are wiped + re-inserted on each scrape (same pattern as
     privacy_types). Change detection diffs DB state before/after the
     rewrite and emits ChangeEntry rows with category:'accessibility' into
     privacy_snapshots.changes_summary. */
  CREATE TABLE IF NOT EXISTS accessibility_features (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    icon_template TEXT,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_accessibility_features_app
    ON accessibility_features(app_id);

  CREATE TABLE IF NOT EXISTS privacy_snapshots (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    scraped_at INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    changes_detected INTEGER NOT NULL DEFAULT 0,
    changes_summary TEXT,
    /* 'live' = online App Store scrape; 'wayback' = backfill from Internet
       Archive (lib/historical-import.ts). Wayback rows never produce
       notifications or bump apps.changeCount. */
    source TEXT NOT NULL DEFAULT 'live',
    /* Wayback rows: raw web.archive.org URL the snapshot was scraped from.
       NULL for live rows. */
    wayback_snapshot_url TEXT,
    /* One of: 'scheduled' | 'manual' | 'import' | 'wayback'. NULL on legacy
       rows; UI falls back to inferring from source='wayback'. */
    triggered_by TEXT,
    /* App Store version metadata at the moment this snapshot was written,
       so the History timeline can tag each row with the user's version.
       Both NULL on legacy rows and on wayback imports without version metadata. */
    app_version TEXT,
    app_version_updated_at INTEGER,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_privacy_snapshots_app_time
    ON privacy_snapshots(app_id, scraped_at DESC);

  CREATE INDEX IF NOT EXISTS idx_privacy_snapshots_changes_app_time
    ON privacy_snapshots(changes_detected, app_id, scraped_at);

  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id             TEXT    PRIMARY KEY,
    app_id         TEXT,
    app_name       TEXT    NOT NULL,
    change_summary TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    read           INTEGER NOT NULL DEFAULT 0,
    /* 1 when the app the notification points at is no longer the match for
       the import item that produced it (user clicked "Change match"). The
       bell UI renders stale rows with a faded strikethrough. */
    stale          INTEGER NOT NULL DEFAULT 0,
    /* Quiet-hours deferral. NULL = show now; non-null = epoch ms before
       which the bell must not surface the row. Old installs gain this via
       the ALTER TABLE migration below. */
    not_before     INTEGER
  );

  /* Bell list query: ORDER BY created_at DESC LIMIT n (polled every 30s by
     every open session). The companion unread-count index lives next to the
     notifications column migrations below because it references not_before,
     which old installs only gain via ALTER TABLE. */
  CREATE INDEX IF NOT EXISTS idx_notifications_created
    ON notifications(created_at DESC);

  CREATE TABLE IF NOT EXISTS privacy_policy_analyses (
    app_id              TEXT PRIMARY KEY,
    policy_url          TEXT NOT NULL,
    status              TEXT NOT NULL,
    source_title        TEXT,
    source_content_type TEXT,
    source_text         TEXT,
    source_word_count   INTEGER NOT NULL DEFAULT 0,
    source_origin       TEXT,
    source_final_url    TEXT,
    content_hash        TEXT,
    analysis_mode       TEXT,
    summary_json        TEXT,
    previous_summary_json TEXT,
    previous_summary_at INTEGER,
    model               TEXT,
    error               TEXT,
    updated_at          INTEGER NOT NULL,
    /* JSON array of phase log records from the most recent regenerate run.
       Each record: { phase, note?, error?, ms, at }. Surfaced in the UI. */
    last_run_log        TEXT,
    /* Epoch ms of the most recent source-page fetch. Distinct from
       updated_at (which also moves when a summary refreshes). */
    source_fetched_at   INTEGER,
    /* JSON array of { summary, highlights[] } per-chunk notes from chunked
       summarisation. Persisted after each chunk so a failed final merge can
       skip straight to merge on retry. Keyed by content_hash — discarded if
       source text changes. */
    chunk_notes_json    TEXT,
    chunk_notes_hash    TEXT,
    /* Live-run bookkeeping. run_status is 'running' between mark-start and
       mark-end, 'idle' (or NULL) otherwise. Lets the AI Policy tab rehydrate
       the in-progress spinner after navigating away and back. */
    run_status          TEXT,
    run_started_at      INTEGER,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  /* Historical policy text snapshots. privacy_policy_analyses keeps only
     the current text; this table preserves every distinct version so the
     History timeline can preview prior captures.

     Deduped by (app_id, content_hash): re-fetching identical text reuses
     the row; each rescrape still produces its own changelog entry. */
  CREATE TABLE IF NOT EXISTS privacy_policy_versions (
    id                  TEXT PRIMARY KEY,
    app_id              TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    first_fetched_at    INTEGER NOT NULL,
    last_fetched_at     INTEGER NOT NULL,
    policy_url          TEXT,
    source_final_url    TEXT,
    source_title        TEXT,
    source_content_type TEXT,
    source_origin       TEXT,
    source_word_count   INTEGER NOT NULL DEFAULT 0,
    source_text         TEXT NOT NULL,
    /* Internet Archive backup for this version, populated best-effort after
       a successful scrape (Wayback availability API or Save Page Now).
       NULL until we land a snapshot URL. */
    archive_url          TEXT,
    archive_submitted_at INTEGER,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_versions_app_hash
    ON privacy_policy_versions(app_id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_policy_versions_app
    ON privacy_policy_versions(app_id);

  /* Developer-options AI audit trail. When dev logging is enabled, every
     AI call persists its prompt + response here. Capped at AI_DEBUG_LOG_MAX
     on insert. */
  CREATE TABLE IF NOT EXISTS ai_debug_log (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    app_id      TEXT,
    app_name    TEXT,
    provider    TEXT,
    model       TEXT,
    phase       TEXT,
    prompt      TEXT,
    response    TEXT,
    duration_ms INTEGER,
    error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ai_debug_log_created ON ai_debug_log(created_at);

  /* Onboarding / import history — one row per batch the user kicked off in the wizard. */
  CREATE TABLE IF NOT EXISTS imports (
    id            TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    completed_at  INTEGER,
    source        TEXT NOT NULL,
    source_label  TEXT,
    total         INTEGER NOT NULL DEFAULT 0,
    matched       INTEGER NOT NULL DEFAULT 0,
    unmatched     INTEGER NOT NULL DEFAULT 0,
    imported      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS import_items (
    id              TEXT PRIMARY KEY,
    import_id       TEXT NOT NULL,
    query           TEXT NOT NULL,
    edited_query    TEXT,
    status          TEXT NOT NULL,
    app_id          TEXT,
    app_name        TEXT,
    developer       TEXT,
    url             TEXT,
    icon_url        TEXT,
    country         TEXT,
    scrape_error    TEXT,
    /* Background-queue bookkeeping for rate-limit retries. next_attempt_at
       is the epoch-ms threshold for retry; attempt_count grows the backoff. */
    next_attempt_at INTEGER,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_import_items_import ON import_items(import_id);
  /* The "queued" partial index on (status, next_attempt_at) must be created
     AFTER the migration loop below — older DBs may be missing
     next_attempt_at here, which would blow up the index creation before
     the ALTER TABLE migration runs. */

  /* Security audit trail — every destructive/privileged request is recorded
     here. Rolling cap enforced at write time. */
  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT    PRIMARY KEY,
    created_at INTEGER NOT NULL,
    action     TEXT    NOT NULL,
    actor_ip   TEXT,
    user_agent TEXT,
    detail     TEXT,
    success    INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

  /* Manual apps — user-entered records for apps that aren't on the App
     Store (Safari web clips, TestFlight betas, personal Xcode builds,
     sideloaded). These don't participate in scraping or the privacy
     tree; the only visibility is whatever policy URL the user pasted.

     Kept separate from apps so dashboard/changelog/snapshot pipelines
     don't have to special-case "no Apple data" rows. */
  CREATE TABLE IF NOT EXISTS manual_apps (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    /* One of: 'web_clip' | 'testflight' | 'own_build' | 'sideloaded'.
       No CHECK constraint — TypeScript enum is the source of truth. */
    source              TEXT NOT NULL,
    developer           TEXT,
    privacy_policy_url  TEXT,
    /* Secondary link for the source (TestFlight invite, GitHub repo).
       Nullable for web clips / sideloaded. */
    source_url          TEXT,
    notes               TEXT,
    first_seen          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_manual_apps_source ON manual_apps(source);

  /* Append-only changelog for manual apps. Two event families:
       - 'scrape': policy fetch attempt. detail = { policy_event, versionId,
         wordCount, contentHash, finalUrl, title, error }. policy_event is
         'first' | 'same' | 'changed' | 'error'.
       - 'field_change': updateManualApp edits. detail = { field, from, to }.
     No ON DELETE CASCADE — rows are pruned by deleteManualApp explicitly. */
  CREATE TABLE IF NOT EXISTS manual_app_events (
    id             TEXT PRIMARY KEY,
    manual_app_id  TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    occurred_at    INTEGER NOT NULL,
    detail         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_manual_app_events_app_time
    ON manual_app_events(manual_app_id, occurred_at DESC);

  /* Privacy-policy snapshots for manual apps. Deduped by
     (manual_app_id, content_hash). Decoupled from privacy_policy_versions
     because manual-app ids are UUIDs, not Apple trackIds. */
  CREATE TABLE IF NOT EXISTS manual_app_policy_versions (
    id                     TEXT PRIMARY KEY,
    manual_app_id          TEXT NOT NULL,
    content_hash           TEXT NOT NULL,
    first_fetched_at       INTEGER NOT NULL,
    last_fetched_at        INTEGER NOT NULL,
    policy_url             TEXT,
    source_final_url       TEXT,
    source_title           TEXT,
    source_content_type    TEXT,
    source_origin          TEXT,
    source_word_count      INTEGER NOT NULL DEFAULT 0,
    source_text            TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_app_policy_versions_hash
    ON manual_app_policy_versions(manual_app_id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_manual_app_policy_versions_app
    ON manual_app_policy_versions(manual_app_id);

  /* Activity log — operational timeline (scrapes, re-syncs, summaries,
     scheduled runs, backup/restore). Distinct from audit_log (privileged
     requests) and ai_debug_log. Capped by retention at write time.

     type: 'scrape' | 'resync' | 'policy_summary' | 'scheduled_sync' |
       'backup_export' | 'backup_restore' | 'reset' | 'manual_sync'.
     status: 'ok' | 'error' | 'partial' | 'cancelled'.
     detail is a loose JSON blob (e.g. { changes: 3, errorMessage: "..." }). */
  CREATE TABLE IF NOT EXISTS activity_log (
    id           TEXT    PRIMARY KEY,
    type         TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    app_id       TEXT,
    app_name     TEXT,
    summary      TEXT,
    detail       TEXT,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    duration_ms  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_activity_log_started
    ON activity_log(started_at);
  CREATE INDEX IF NOT EXISTS idx_activity_log_type_started
    ON activity_log(type, started_at);

  /* Acknowledgement trail for the "What's changed" review panel. One row
     per user action; surfaced in the History timeline.

     action: 'reviewed' | 'dismissed' | 'snoozed' | 'unsnoozed'.
     covered_count = unacknowledged entries rolled up at the moment of the
     action (snapshot-of-the-time, no re-query needed later).
     snooze_until is only meaningful for 'snoozed'. */
  CREATE TABLE IF NOT EXISTS change_review_actions (
    id            TEXT PRIMARY KEY,
    app_id        TEXT NOT NULL,
    action        TEXT NOT NULL,
    acted_at      INTEGER NOT NULL,
    covered_count INTEGER NOT NULL DEFAULT 0,
    /* JSON array of privacy_snapshots.id values pending at action time.
       Lets the History timeline render the review row as a clickable list
       of the specific syncs covered. NULL on legacy rows. */
    covered_snapshot_ids TEXT,
    snooze_until  INTEGER,
    note          TEXT,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_change_review_actions_app_time
    ON change_review_actions(app_id, acted_at DESC);

  /* Shortlist of "candidate alternatives" to a tracked app. Scoped per
     source app — same candidate under two different sources = two rows.
     Deduped within (source_app_id, candidate_apple_id) by UNIQUE index.

     candidate_apple_id is an Apple track ID but intentionally NOT a foreign
     key into apps(id) — candidates are typically not tracked apps. If the
     user later imports the candidate, the ids align and UI can plain-SELECT
     join on candidate_apple_id = apps.id.

     candidate_icon_url/developer/store_url are captured at shortlist time
     so the list renders cleanly even offline. */
  CREATE TABLE IF NOT EXISTS shortlist_entries (
    id                      TEXT PRIMARY KEY,
    source_app_id           TEXT NOT NULL,
    candidate_apple_id      TEXT NOT NULL,
    candidate_name          TEXT NOT NULL,
    candidate_developer     TEXT,
    candidate_icon_url      TEXT,
    candidate_store_url     TEXT NOT NULL,
    candidate_bundle_id     TEXT,
    note                    TEXT,
    added_at                INTEGER NOT NULL,
    /* Comma-separated compare-view modes this entry was saved from
       ('privacy' and/or 'accessibility'). Defaults to 'privacy'. */
    mode                    TEXT NOT NULL DEFAULT 'privacy',
    FOREIGN KEY (source_app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_shortlist_entries_source_candidate
    ON shortlist_entries(source_app_id, candidate_apple_id);
  CREATE INDEX IF NOT EXISTS idx_shortlist_entries_source
    ON shortlist_entries(source_app_id);
  CREATE INDEX IF NOT EXISTS idx_shortlist_entries_added
    ON shortlist_entries(added_at DESC);

  /* Feature-flag override layer. One row per explicitly overridden flag.
     Resolution order in lib/feature-flags.ts: HARD_DEFAULTS → audience →
     goal → accessibility → runtime-env → dependency → override.
     Quarantined rows (flag_key not in current registry) persist but don't
     participate in resolution.
     https://privacytracker-docs.privacykey.org/develop/feature-flags */
  CREATE TABLE IF NOT EXISTS feature_flag_overrides (
    flag_key        TEXT    PRIMARY KEY,
    override_value  TEXT    NOT NULL,
    set_at          INTEGER NOT NULL,
    set_by          TEXT    NOT NULL DEFAULT 'user',
    previous_focus  TEXT,
    quarantined     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_quarantined
    ON feature_flag_overrides(quarantined);

  /* Per-app freeform notes. Multi-source: source = 'user' for self-authored
     notes, 'imported' for notes from audit-bundle imports (source_name is
     the recommender's display name).
     visibility = 'private' excludes the note from every export.
     tag is one of 'concern', 'positive', 'follow_up', 'other', or NULL.
     deleted_at non-null = soft-deleted (30s undo window). */
  CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'user',
    source_name TEXT,
    visibility  TEXT NOT NULL DEFAULT 'export',
    tag         TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_app_id ON annotations(app_id);
  CREATE INDEX IF NOT EXISTS idx_annotations_active
    ON annotations(app_id, deleted_at) WHERE deleted_at IS NULL;

  /* Per-app verdicts — one opinionated decision per (app, source).
     Coexists with annotations: a verdict answers "uninstall it?", an
     annotation explains "why".

     Sources:
       - 'user'     : local user's own decision (at most one per app).
       - 'imported' : from an audit-bundle import. One row per
                      (app, source, source_name) so multiple recommenders
                      can stack ("Mum says uninstall, Dad says safe").

     Verdicts:
       - 'safe' : keep, no action.
       - 'replace' : usually paired with a shortlist entry.
       - 'uninstall' : remove. Imported = a recommendation; only the
                       local user's own 'uninstall' verdict authorises
                       a cfgutil remove-app action.

     Absence of any row = "undecided". Picker's "Clear" deletes the row
     rather than storing a fourth literal value.

     UNIQUE(app_id, source, source_name) enforces one verdict per
     recommender (UPSERT replaces). source_name is NULL for user rows
     (SQLite treats NULLs as distinct in UNIQUE — fine because there's
     only ever one user row per app). */
  CREATE TABLE IF NOT EXISTS app_verdicts (
    id           TEXT PRIMARY KEY,
    app_id       TEXT NOT NULL,
    verdict      TEXT NOT NULL CHECK (verdict IN ('safe', 'replace', 'uninstall')),
    rationale    TEXT,
    source       TEXT NOT NULL CHECK (source IN ('user', 'imported')),
    source_name  TEXT,
    set_at       INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
    UNIQUE (app_id, source, source_name)
  );
  CREATE INDEX IF NOT EXISTS idx_app_verdicts_app_id ON app_verdicts(app_id);
  CREATE INDEX IF NOT EXISTS idx_app_verdicts_user
    ON app_verdicts(app_id, verdict) WHERE source = 'user';

  /* Audit-bundle imports the user has accepted on this device. Dedup key
     is exported_at from the bundle envelope. On re-import the API prompts
     "you already imported this on (date)" — re-running is idempotent for
     app data and only adds annotations that have changed.

     recommender_name = free-text name from export (NULL if skipped). Used
     for the dashboard provenance banner. The summary counters mirror the
     import-summary toast. bundle_app_version is the app_version from the
     bundle envelope. */
  CREATE TABLE IF NOT EXISTS audit_bundle_imports (
    id                  TEXT PRIMARY KEY,
    exported_at         TEXT NOT NULL UNIQUE,
    imported_at         INTEGER NOT NULL,
    recommender_name    TEXT,
    bundle_app_version  TEXT,
    apps_total          INTEGER NOT NULL DEFAULT 0,
    apps_added          INTEGER NOT NULL DEFAULT 0,
    apps_updated        INTEGER NOT NULL DEFAULT 0,
    apps_skipped        INTEGER NOT NULL DEFAULT 0,
    annotations_added   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_audit_bundle_imports_imported_at
    ON audit_bundle_imports(imported_at DESC);

  /* App Store "Customers Also Bought" / "More By This Developer" shelves
     captured during a normal product-page scrape. Each row is one
     related-app candidate observed in the source app's shoebox JSON.
     Replace-on-write semantics: when the source app is rescraped we
     wipe the existing rows for (source_app_id, shelf_type) and reinsert,
     so a single source app never has stale shelf entries.

     shelf_type:
       'may_also_like'      — Apple's "You Might Also Like" shelf
       'more_by_developer'  — same developer's other apps

     Foreign key cascades on apps deletion so when the user stops
     tracking an app, its related-app records disappear too. */
  CREATE TABLE IF NOT EXISTS related_apps_observed (
    source_app_id      TEXT NOT NULL,
    related_apple_id   TEXT NOT NULL,
    related_name       TEXT NOT NULL,
    related_developer  TEXT,
    related_icon_url   TEXT,
    related_store_url  TEXT NOT NULL,
    shelf_type         TEXT NOT NULL CHECK (shelf_type IN ('may_also_like', 'more_by_developer')),
    observed_at        INTEGER NOT NULL,
    PRIMARY KEY (source_app_id, related_apple_id, shelf_type),
    FOREIGN KEY (source_app_id) REFERENCES apps(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_related_apps_source
    ON related_apps_observed(source_app_id, shelf_type);

  /* Devices — one row per "the user said this is My iPhone" import source.
     Created at import time (every method gets a device row; cfgutil pre-fills
     name + ecid + model from Apple Configurator's device probe, CSV/manual
     ask the user). ECID is the stable per-device id from Apple Configurator;
     CSV/manual have NULL ECID. is_unknown_placeholder is set on the one
     migration row that retro-links pre-existing apps. */
  CREATE TABLE IF NOT EXISTS devices (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    ecid                     TEXT,
    model                    TEXT,
    ios_version              TEXT,
    device_class             TEXT,
    created_at               INTEGER NOT NULL,
    last_synced_at           INTEGER NOT NULL,
    is_unknown_placeholder   INTEGER NOT NULL DEFAULT 0
  );
  /* Unique partial index — multiple devices can have NULL ECID (CSV/manual);
     at most one device can claim a specific cfgutil ECID. */
  CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_ecid ON devices(ecid) WHERE ecid IS NOT NULL;

  /* App ↔ device junction. An app like Instagram tracked from both an
     iPhone and an iPad has two rows here — one per device. Cascades both
     ways: deleting an app or a device cleans up its links automatically. */
  CREATE TABLE IF NOT EXISTS app_devices (
    app_id          TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    first_seen_at   INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    PRIMARY KEY (app_id, device_id),
    FOREIGN KEY (app_id)    REFERENCES apps(id)    ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_app_devices_device ON app_devices(device_id);
`);

// Run safe migrations for existing databases.
//
// Build-time race: `next build` runs page-data collection in parallel
// workers. They snapshot the column list before any ALTER runs, so all
// workers race to add it — first wins, others get SQLITE_ERROR "duplicate
// column name". applyColumnMigrations swallows that specific failure only.
function applyColumnMigrations(
  existingCols: string[],
  migrationsList: readonly [string, string][]
): void {
  for (const [col, sql] of migrationsList) {
    if (existingCols.includes(col)) {
      continue;
    }
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate column name/i.test(msg)) {
        continue;
      }
      throw e;
    }
  }
}

/** Single-column variant — same race-safe ALTER guarded by a column-check. */
function applySingleColumnMigration(
  existingCols: string[],
  col: string,
  sql: string
): void {
  if (existingCols.includes(col)) {
    return;
  }
  try {
    db.exec(sql);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column name/i.test(msg)) {
      return;
    }
    throw e;
  }
}

const appCols = (
  db.prepare("PRAGMA table_info(apps)").all() as { name: string }[]
).map((c) => c.name);
const migrations: [string, string][] = [
  [
    "firstSeen",
    "ALTER TABLE apps ADD COLUMN firstSeen INTEGER NOT NULL DEFAULT 0",
  ],
  [
    "changeCount",
    "ALTER TABLE apps ADD COLUMN changeCount INTEGER NOT NULL DEFAULT 0",
  ],
  ["bundleId", "ALTER TABLE apps ADD COLUMN bundleId TEXT"],
  ["developer", "ALTER TABLE apps ADD COLUMN developer TEXT"],
  ["privacyPolicyUrl", "ALTER TABLE apps ADD COLUMN privacyPolicyUrl TEXT"],
  [
    "changes_acknowledged_at",
    "ALTER TABLE apps ADD COLUMN changes_acknowledged_at INTEGER NOT NULL DEFAULT 0",
  ],
  [
    "changes_snoozed_until",
    "ALTER TABLE apps ADD COLUMN changes_snoozed_until INTEGER NOT NULL DEFAULT 0",
  ],
  ["currentVersion", "ALTER TABLE apps ADD COLUMN currentVersion TEXT"],
  ["versionUpdatedAt", "ALTER TABLE apps ADD COLUMN versionUpdatedAt INTEGER"],
  ["whatsNew", "ALTER TABLE apps ADD COLUMN whatsNew TEXT"],
  [
    "hasPrivacyDetails",
    "ALTER TABLE apps ADD COLUMN hasPrivacyDetails INTEGER",
  ],
  // Accessibility nutrition labels. NULL until next scrape.
  [
    "hasAccessibilityLabels",
    "ALTER TABLE apps ADD COLUMN hasAccessibilityLabels INTEGER",
  ],
  // Pricing + IAP snapshot. NULL = unknown (UI hides the price chip).
  ["priceAmount", "ALTER TABLE apps ADD COLUMN priceAmount REAL"],
  ["priceCurrency", "ALTER TABLE apps ADD COLUMN priceCurrency TEXT"],
  ["priceFormatted", "ALTER TABLE apps ADD COLUMN priceFormatted TEXT"],
  ["hasIap", "ALTER TABLE apps ADD COLUMN hasIap INTEGER"],
  // Apple genre/category. NULL until next sync.
  ["genreId", "ALTER TABLE apps ADD COLUMN genreId INTEGER"],
  ["genreName", "ALTER TABLE apps ADD COLUMN genreName TEXT"],
  // App Store age rating ("4+", "13+"). NULL until next sync.
  ["ageRating", "ALTER TABLE apps ADD COLUMN ageRating TEXT"],
];
applyColumnMigrations(appCols, migrations);

// Migration: add type_id column to privacy_categories if missing
const catCols = (
  db.prepare("PRAGMA table_info(privacy_categories)").all() as {
    name: string;
  }[]
).map((c) => c.name);
applySingleColumnMigration(
  catCols,
  "type_id",
  "ALTER TABLE privacy_categories ADD COLUMN type_id TEXT REFERENCES privacy_types(id) ON DELETE CASCADE"
);

// Migration: privacy_snapshots.source + wayback_snapshot_url for the
// historical-import flow. app_version / app_version_updated_at stamp each
// snapshot with the App Store version current at scrape time.
const snapshotCols = (
  db.prepare("PRAGMA table_info(privacy_snapshots)").all() as { name: string }[]
).map((c) => c.name);
const snapshotMigrations: [string, string][] = [
  [
    "source",
    "ALTER TABLE privacy_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'live'",
  ],
  [
    "wayback_snapshot_url",
    "ALTER TABLE privacy_snapshots ADD COLUMN wayback_snapshot_url TEXT",
  ],
  [
    "triggered_by",
    "ALTER TABLE privacy_snapshots ADD COLUMN triggered_by TEXT",
  ],
  ["app_version", "ALTER TABLE privacy_snapshots ADD COLUMN app_version TEXT"],
  [
    "app_version_updated_at",
    "ALTER TABLE privacy_snapshots ADD COLUMN app_version_updated_at INTEGER",
  ],
];
applyColumnMigrations(snapshotCols, snapshotMigrations);

// Migration: change_review_actions.covered_snapshot_ids — JSON array of
// snapshot ids pending at action time, so the History timeline can link
// each review row to the specific syncs it acknowledged.
const reviewActionCols = (
  db.prepare("PRAGMA table_info(change_review_actions)").all() as {
    name: string;
  }[]
).map((c) => c.name);
applySingleColumnMigration(
  reviewActionCols,
  "covered_snapshot_ids",
  "ALTER TABLE change_review_actions ADD COLUMN covered_snapshot_ids TEXT"
);

// Migration: `removed_app_id` on import_items. When the user deletes a tracked
// app that was originally added through an import, the FK `ON DELETE SET NULL`
// wipes `app_id`. This column preserves the old pointer so the import history
// can still show which app was removed, and so retries can be refused.
const importItemCols = (
  db.prepare("PRAGMA table_info(import_items)").all() as { name: string }[]
).map((c) => c.name);
const importItemMigrations: [string, string][] = [
  ["removed_app_id", "ALTER TABLE import_items ADD COLUMN removed_app_id TEXT"],
  // Background queue bookkeeping for the per-item retry loop. See CREATE TABLE.
  ["icon_url", "ALTER TABLE import_items ADD COLUMN icon_url TEXT"],
  ["country", "ALTER TABLE import_items ADD COLUMN country TEXT"],
  [
    "next_attempt_at",
    "ALTER TABLE import_items ADD COLUMN next_attempt_at INTEGER",
  ],
  [
    "attempt_count",
    "ALTER TABLE import_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
  ],
];
applyColumnMigrations(importItemCols, importItemMigrations);
// Partial index on the queue hot-path; old DBs need this added by hand.
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_import_items_queue ON import_items(status, next_attempt_at) WHERE status = 'queued'"
);

// Migration: imports.device_id — links an import session to a device row.
// Nullable: existing imports from before the devices feature stay legible
// in import history with a NULL pointer. New imports populate this from
// the OnboardWizard's device-naming step.
const importsCols = (
  db.prepare("PRAGMA table_info(imports)").all() as { name: string }[]
).map((c) => c.name);
applySingleColumnMigration(
  importsCols,
  "device_id",
  "ALTER TABLE imports ADD COLUMN device_id TEXT"
);

// One-time backfill: if any apps exist but no devices have been created,
// create a single "Unknown device" placeholder and link every existing
// app to it. Subsequent boots are no-ops because at least one device row
// exists. Users can rename "Unknown device" or split apps off it onto
// correctly-named devices via Settings → Devices.
try {
  const deviceCount = (
    db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }
  ).n;
  const appCount = (
    db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }
  ).n;
  if (deviceCount === 0 && appCount > 0) {
    const now = Date.now();
    const placeholderId = (
      db.prepare("SELECT lower(hex(randomblob(16))) AS id").get() as {
        id: string;
      }
    ).id;
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO devices (id, name, ecid, model, ios_version, device_class,
                             created_at, last_synced_at, is_unknown_placeholder)
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 1)
      `).run(placeholderId, "Unknown device", now, now);
      db.prepare(`
        INSERT OR IGNORE INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)
        SELECT id, ?, COALESCE(firstSeen, lastSynced, ?), ?
        FROM apps
      `).run(placeholderId, now, now);
    });
    tx();
    console.info(
      `[db] devices backfill: linked ${appCount} existing apps to "Unknown device"`
    );
  }
} catch (error) {
  // Belt-and-braces — don't block boot on the backfill.
  console.warn("[db] unknown-device backfill failed:", error);
}

// Migration: split URL-less 'queued' rows out into 'pending_search'. Two
// different retry mechanisms used to compete for the same `'queued'`
// status: the server-side import-queue worker (for scrape retries, which
// always have a URL) and the client-side QueuedSearchProvider (for
// iTunes-search retries, which by definition don't have a URL yet). The
// worker would claim a URL-less row, see no URL, and mass-error every
// row in the batch — symptom: "Cannot find module 'react'"-like floods
// of `[ImportQueue] item error […] — no URL on row` lines. Splitting
// the status lets each retry path own a disjoint set of rows. This
// migration heals any rows that pre-date the split.
//
// Idempotent: rows already at 'pending_search' aren't touched; on a
// fresh DB the WHERE filter matches nothing.
try {
  const healed = db
    .prepare(
      "UPDATE import_items SET status = 'pending_search' " +
        "WHERE status = 'queued' AND (url IS NULL OR url = '')"
    )
    .run();
  if (healed.changes > 0) {
    console.info(
      `[db] migrated ${healed.changes} URL-less 'queued' import_items → 'pending_search'`
    );
  }
} catch (error) {
  console.warn("[db] pending_search backfill failed:", error);
}

// Migration: shortlist_entries.mode — backfill 'privacy' on existing rows
// (the only mode that existed before this column).
const shortlistCols = (
  db.prepare("PRAGMA table_info(shortlist_entries)").all() as { name: string }[]
).map((c) => c.name);
applySingleColumnMigration(
  shortlistCols,
  "mode",
  "ALTER TABLE shortlist_entries ADD COLUMN mode TEXT NOT NULL DEFAULT 'privacy'"
);

// Migration: notifications.stale (defaults to 0).
// notifications.not_before — quiet-hours deferral. NULL = show now;
// non-null = don't surface in the bell until after this time. Bell UI
// filters by `not_before IS NULL OR not_before <= unixepoch() * 1000`.
const notifCols = (
  db.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]
).map((c) => c.name);
const notifMigrations: [string, string][] = [
  [
    "stale",
    "ALTER TABLE notifications ADD COLUMN stale INTEGER NOT NULL DEFAULT 0",
  ],
  ["not_before", "ALTER TABLE notifications ADD COLUMN not_before INTEGER"],
];
applyColumnMigrations(notifCols, notifMigrations);
// Bell unread-count hot path: COUNT WHERE read = 0 AND (not_before IS NULL
// OR not_before <= now), polled every 30s. Created here rather than in the
// schema block because it references not_before, which old installs only
// gain via the ALTER TABLE above.
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read, not_before)"
);

// Migrations for privacy_policy_analyses
const policyCols = (
  db.prepare("PRAGMA table_info(privacy_policy_analyses)").all() as {
    name: string;
  }[]
).map((c) => c.name);
const policyMigrations: [string, string][] = [
  [
    "source_origin",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN source_origin TEXT",
  ],
  [
    "source_final_url",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN source_final_url TEXT",
  ],
  // Previous AI summary captured when replaced, for diff rendering.
  [
    "previous_summary_json",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN previous_summary_json TEXT",
  ],
  [
    "previous_summary_at",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN previous_summary_at INTEGER",
  ],
  // Phase log for the most recent regenerate run.
  [
    "last_run_log",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN last_run_log TEXT",
  ],
  [
    "source_fetched_at",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN source_fetched_at INTEGER",
  ],
  // Chunk-note persistence for reusing computed per-chunk summaries on retry.
  [
    "chunk_notes_json",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN chunk_notes_json TEXT",
  ],
  [
    "chunk_notes_hash",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN chunk_notes_hash TEXT",
  ],
  // Live-run bookkeeping. NULL run_status treated as 'idle'.
  [
    "run_status",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN run_status TEXT",
  ],
  [
    "run_started_at",
    "ALTER TABLE privacy_policy_analyses ADD COLUMN run_started_at INTEGER",
  ],
];
applyColumnMigrations(policyCols, policyMigrations);

// Crash recovery: if the process died mid-run the analyses row is stuck
// at run_status='running'. Flip it back to 'idle' on boot so the UI
// doesn't show a phantom spinner forever.
try {
  db.exec(
    `UPDATE privacy_policy_analyses SET run_status = 'idle' WHERE run_status = 'running'`
  );
} catch (error) {
  // Belt+braces — don't block boot on this UPDATE.
  console.warn("[db] clearing stale policy run_status failed:", error);
}

// Migrations for privacy_policy_versions Internet-Archive columns.
const versionCols = (
  db.prepare("PRAGMA table_info(privacy_policy_versions)").all() as {
    name: string;
  }[]
).map((c) => c.name);
const versionMigrations: [string, string][] = [
  [
    "archive_url",
    "ALTER TABLE privacy_policy_versions ADD COLUMN archive_url TEXT",
  ],
  [
    "archive_submitted_at",
    "ALTER TABLE privacy_policy_versions ADD COLUMN archive_submitted_at INTEGER",
  ],
];
applyColumnMigrations(versionCols, versionMigrations);

/*
 * One-time data backfill: seed privacy_policy_versions from existing
 * privacy_policy_analyses rows whose (app_id, content_hash) pair isn't
 * already present. Without this, the History tab's diff-from-previous
 * returns 404 the first time the policy changes for installs that
 * scraped before the versions table existed.
 *
 * INSERT ... SELECT with NOT EXISTS is idempotent — cheap to run on
 * every DB open. The synthesised id is a randomblob-derived UUID-shaped
 * string; real UUIDs come from crypto.randomUUID() at scrape time.
 */
try {
  db.exec(`
    INSERT INTO privacy_policy_versions (
      id, app_id, content_hash, first_fetched_at, last_fetched_at,
      policy_url, source_final_url, source_title, source_content_type,
      source_origin, source_word_count, source_text
    )
    SELECT
      substr(lower(hex(randomblob(16))), 1, 8) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 4) || '-'
        || substr(lower(hex(randomblob(16))), 1, 12),
      a.app_id,
      a.content_hash,
      COALESCE(a.source_fetched_at, a.updated_at),
      COALESCE(a.source_fetched_at, a.updated_at),
      a.policy_url,
      a.source_final_url,
      a.source_title,
      a.source_content_type,
      a.source_origin,
      a.source_word_count,
      a.source_text
    FROM privacy_policy_analyses a
    WHERE a.content_hash IS NOT NULL
      AND a.source_text IS NOT NULL
      AND length(a.source_text) > 0
      AND NOT EXISTS (
        SELECT 1 FROM privacy_policy_versions v
        WHERE v.app_id = a.app_id
          AND v.content_hash = a.content_hash
      );
  `);
} catch (error) {
  // Never fatal — prefer booting the app over blowing up on an optional backfill.
  console.warn("[db] privacy_policy_versions backfill failed:", error);
}

export default db;
