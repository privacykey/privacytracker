/**
 * Starting-point databases for the schema-parity harness.
 *
 * The parity claim is Rust(X) == TS(X) for any starting DB X, so what
 * matters about a fixture is that it is a valid earlier state that forces
 * migrations to fire — historical accuracy is a bonus, not a requirement.
 *
 * buildLegacy() writes a deliberately OLD-shaped database: the
 * ALTER-bearing tables are created with their columns MINUS everything the
 * migrations later add, and no devices/app_devices tables at all. Opening it
 * with either migrator must therefore run ~all the ALTERs, create the
 * unknown-device placeholder, heal the URL-less queued import row, and seed
 * privacy_policy_versions — the full upgrade path.
 *
 * buildCurrentWithLiveState() takes an already-current schema (produced by
 * pt-core) and injects rows that exercise the two data backfills a
 * current-schema re-open still runs: the stuck run_status='running' reset
 * and the pending_search heal.
 */
import BetterSqlite3 from "better-sqlite3";

/** A legacy-shaped DB: old columns, missing tables, rows that trip backfills. */
export function buildLegacy(path) {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF"); // starting-state blob; don't fight FK order
  db.exec(`
    /* apps: only the original core columns — every apps ALTER must fire. */
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      iconUrl TEXT,
      lastSynced INTEGER NOT NULL
    );

    /* privacy_categories WITH type_id. db.ts's schema block creates
       idx_privacy_categories_type ON (type_id) before the type_id ALTER
       runs, so db.ts cannot open a categories table missing this column —
       any db.ts-openable install already has it. The single-column ALTER
       path is instead exercised by change_review_actions / imports /
       shortlist_entries below. */
    CREATE TABLE privacy_categories (
      id TEXT PRIMARY KEY,
      purpose_id TEXT,
      type_id TEXT,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL
    );

    /* privacy_snapshots without source/wayback/triggered_by/app_version*. */
    CREATE TABLE privacy_snapshots (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      scraped_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      changes_detected INTEGER NOT NULL DEFAULT 0,
      changes_summary TEXT
    );

    /* change_review_actions without covered_snapshot_ids. */
    CREATE TABLE change_review_actions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      action TEXT NOT NULL,
      acted_at INTEGER NOT NULL,
      covered_count INTEGER NOT NULL DEFAULT 0,
      snooze_until INTEGER,
      note TEXT
    );

    /* imports without device_id. */
    CREATE TABLE imports (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      source TEXT NOT NULL,
      source_label TEXT,
      total INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0,
      unmatched INTEGER NOT NULL DEFAULT 0,
      imported INTEGER NOT NULL DEFAULT 0
    );

    /* import_items without the queue-retry columns. Has url so the
       pending_search heal can test it. */
    CREATE TABLE import_items (
      id TEXT PRIMARY KEY,
      import_id TEXT NOT NULL,
      query TEXT NOT NULL,
      edited_query TEXT,
      status TEXT NOT NULL,
      app_id TEXT,
      app_name TEXT,
      developer TEXT,
      url TEXT,
      scrape_error TEXT
    );

    /* notifications without stale/not_before. */
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      app_name TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );

    /* privacy_policy_analyses without all the later columns. Has content_hash
       + source_text so the privacy_policy_versions seed fires. */
    CREATE TABLE privacy_policy_analyses (
      app_id TEXT PRIMARY KEY,
      policy_url TEXT NOT NULL,
      status TEXT NOT NULL,
      source_title TEXT,
      source_content_type TEXT,
      source_text TEXT,
      source_word_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      analysis_mode TEXT,
      summary_json TEXT,
      model TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL
    );

    /* privacy_policy_versions without archive_url/archive_submitted_at. */
    CREATE TABLE privacy_policy_versions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_fetched_at INTEGER NOT NULL,
      last_fetched_at INTEGER NOT NULL,
      policy_url TEXT,
      source_final_url TEXT,
      source_title TEXT,
      source_content_type TEXT,
      source_origin TEXT,
      source_word_count INTEGER NOT NULL DEFAULT 0,
      source_text TEXT NOT NULL
    );

    /* shortlist_entries without mode. */
    CREATE TABLE shortlist_entries (
      id TEXT PRIMARY KEY,
      source_app_id TEXT NOT NULL,
      candidate_apple_id TEXT NOT NULL,
      candidate_name TEXT NOT NULL,
      candidate_developer TEXT,
      candidate_icon_url TEXT,
      candidate_store_url TEXT NOT NULL,
      candidate_bundle_id TEXT,
      note TEXT,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // Rows that make the backfills observable.
  db.prepare(
    "INSERT INTO apps (id, name, url, iconUrl, lastSynced) VALUES (?,?,?,?,?)"
  ).run(
    "111",
    "Alpha",
    "https://apps.apple.com/us/app/id111",
    "",
    1_700_000_000_000
  );
  db.prepare(
    "INSERT INTO apps (id, name, url, iconUrl, lastSynced) VALUES (?,?,?,?,?)"
  ).run(
    "222",
    "Beta",
    "https://apps.apple.com/us/app/id222",
    "",
    1_700_000_001_000
  );
  db.prepare(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected) VALUES (?,?,?,?,0)"
  ).run("snap-1", "111", 1_700_000_000_000, "[]");
  db.prepare(
    "INSERT INTO change_review_actions (id, app_id, action, acted_at, covered_count) VALUES (?,?,?,?,1)"
  ).run("cra-1", "111", "reviewed", 1_700_000_002_000);
  db.prepare("INSERT INTO imports (id, created_at, source) VALUES (?,?,?)").run(
    "imp-1",
    1_700_000_000_000,
    "manual"
  );
  // A URL-less 'queued' row → must be healed to 'pending_search'.
  db.prepare(
    "INSERT INTO import_items (id, import_id, query, status, url) VALUES (?,?,?,?,NULL)"
  ).run("iti-1", "imp-1", "Gamma", "queued");
  db.prepare(
    "INSERT INTO privacy_policy_analyses (app_id, policy_url, status, source_text, source_word_count, content_hash, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(
    "111",
    "https://example.com/privacy",
    "ok",
    "Some policy text that is non-empty.",
    6,
    "hash-abc",
    1_700_000_003_000
  );
  // A legacy setting + old goal keys (harmless to the db.ts contract; the
  // feature-flag migration that would rename these is a later phase and is
  // NOT run by either side of this harness).
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('user_intent','curious')"
  ).run();

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

/** Inject live-ish state into an already-current-schema DB at `path`. */
export function injectLiveState(path) {
  const db = new BetterSqlite3(path);
  db.pragma("foreign_keys = OFF");
  db.prepare(
    "INSERT INTO apps (id, name, url, lastSynced) VALUES ('900','Live','',0)"
  ).run();
  // A stuck 'running' row → both migrators must reset it to 'idle'.
  db.prepare(
    "INSERT INTO privacy_policy_analyses (app_id, policy_url, status, updated_at, run_status) VALUES ('900','u','ok',0,'running')"
  ).run();
  db.prepare(
    "INSERT INTO imports (id, created_at, source) VALUES ('imp-9',0,'manual')"
  ).run();
  // URL-less queued row → pending_search heal.
  db.prepare(
    "INSERT INTO import_items (id, import_id, query, status, url) VALUES ('iti-9','imp-9','q','queued',NULL)"
  ).run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

/** Aggregate post-conditions the backfills should produce — compared between
 * the two migrated DBs (counts only, so random backfill ids don't matter). */
export function backfillAggregates(path) {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    const n = (sql) => db.prepare(sql).get().n;
    return {
      devices: n("SELECT COUNT(*) n FROM devices"),
      unknownDevices: n(
        "SELECT COUNT(*) n FROM devices WHERE is_unknown_placeholder = 1"
      ),
      appDevices: n("SELECT COUNT(*) n FROM app_devices"),
      apps: n("SELECT COUNT(*) n FROM apps"),
      importQueued: n(
        "SELECT COUNT(*) n FROM import_items WHERE status = 'queued'"
      ),
      importPendingSearch: n(
        "SELECT COUNT(*) n FROM import_items WHERE status = 'pending_search'"
      ),
      policyRunning: n(
        "SELECT COUNT(*) n FROM privacy_policy_analyses WHERE run_status = 'running'"
      ),
      policyIdle: n(
        "SELECT COUNT(*) n FROM privacy_policy_analyses WHERE run_status = 'idle'"
      ),
      policyVersions: n("SELECT COUNT(*) n FROM privacy_policy_versions"),
    };
  } finally {
    db.close();
  }
}
