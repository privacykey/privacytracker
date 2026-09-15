/** Durable operational state, shared by the live gate and Node oracle. */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const OPS_APP = "89996001";
export const OPS_MANUAL = "pt-ops-manual";
export const statement = (sql, ...params) => ({ sql, params });
export const setting = (key, value) =>
  statement(
    "INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)",
    key,
    typeof value === "string" ? value : JSON.stringify(value)
  );
export function jobState(now, extra = {}) {
  return {
    version: 1,
    runId: "pt-ops-run",
    startedAt: now - 6000,
    updatedAt: now - 1000,
    initiator: "resume",
    currentAppId: "b",
    phase: "all",
    force: false,
    totals: { attempted: 4, succeeded: 2, failed: 1, skipped: 0, throttled: 1 },
    queue: [
      { appId: "a", appName: "First", status: "pending" },
      { appId: "b", appName: "Current λ", status: "in_progress" },
      { appId: "c", appName: "Done", status: "done" },
      { appId: "d", appName: "Failed", status: "failed" },
      { appId: "future", appName: "Unknown status", status: "future" },
    ],
    ...extra,
  };
}
export const OPS_FILES = [
  {
    name: "privacytracker-snapshot-2026-09-15T03-04-05-006Z.json",
    text: "snapshot one",
    mtime: 1700000000.125,
  },
  {
    name: "privacytracker-snapshot-2026-09-15T03-04-05-006Z-2.json",
    text: "collision fallback",
    mtime: 1700000001.25,
  },
  {
    name: "privacytracker-snapshot-invalid.json",
    text: "invalid name fallback",
    mtime: 1700000002.5,
  },
  {
    name: "privacytracker-snapshot-2024-02-30.json",
    text: "normalized day",
    mtime: 1700000000,
  },
  { name: "ignored.json", text: "not a snapshot", mtime: 1700000000 },
  {
    name: "privacytracker-snapshot-2020-01-01.json.tmp",
    text: "unfinished",
    mtime: 1700000000,
  },
];
export function writeOperationsFiles(dataDir, files = OPS_FILES) {
  const dir = path.join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const target = path.join(dir, f.name);
    writeFileSync(target, f.text);
    utimesSync(target, f.mtime, f.mtime);
  }
}
export function operationsStatements(now) {
  const sql = [];
  const add = (s, ...p) => sql.push(statement(s, ...p));
  for (const table of [
    "manual_app_events",
    "manual_app_policy_versions",
    "manual_apps",
    "ai_debug_log",
    "privacy_categories",
    "privacy_types",
  ]) {
    add(`DELETE FROM ${table} WHERE id LIKE 'pt-ops-%'`);
  }
  add(
    "DELETE FROM privacy_policy_analyses WHERE app_id LIKE 'pt-ops-%' OR app_id=?",
    OPS_APP
  );
  add("DELETE FROM apps WHERE id=?", OPS_APP);
  add("DELETE FROM apps WHERE id LIKE 'pt-ops-policy-%'");
  add(
    "INSERT INTO apps (id,name,developer,url,firstSeen,lastSynced) VALUES (?,?,?,?,?,?)",
    OPS_APP,
    '  =SUM(1,2) "App"\nλ',
    "+Developer",
    "https://example.test/export",
    now - 100000,
    now
  );
  add(
    "INSERT INTO privacy_types (id,app_id,identifier,title) VALUES (?,?,?,?)",
    "pt-ops-type",
    OPS_APP,
    "DATA_USED_TO_TRACK_YOU",
    "@Tracking"
  );
  add(
    "INSERT INTO privacy_categories (id,type_id,identifier,title) VALUES (?,?,?,?)",
    "pt-ops-cat",
    "pt-ops-type",
    "OTHER",
    "＝Other"
  );
  add(
    "INSERT INTO manual_apps (id,name,source,developer,privacy_policy_url,source_url,notes,first_seen,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    OPS_MANUAL,
    "Manual operations",
    "future-source",
    "",
    null,
    "https://example.test/source",
    "Private local notes\nλ",
    now - 12345,
    now
  );
  for (const [i, detail] of [
    null,
    "broken",
    '{"10":"ten","2":"two","n":9007199254740993}',
    '"text"',
  ].entries()) {
    add(
      "INSERT INTO manual_app_events (id,manual_app_id,event_type,occurred_at,detail) VALUES (?,?,?,?,?)",
      `pt-ops-event-${i}`,
      OPS_MANUAL,
      i === 3 ? "future" : "scrape",
      now - (i < 2 ? 1000 : 0),
      detail
    );
  }
  for (let i = 0; i < 2; i++) {
    add(
      "INSERT INTO manual_app_policy_versions (id,manual_app_id,content_hash,first_fetched_at,last_fetched_at,policy_url,source_final_url,source_title,source_content_type,source_origin,source_word_count,source_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      `pt-ops-version-${i}`,
      OPS_MANUAL,
      `hash-${i}`,
      now - 5000,
      now - i * 1000,
      null,
      "https://example.test/policy",
      "Policy λ",
      "text/html",
      "live",
      3,
      "policy text\nline 2"
    );
  }
  for (let i = 0; i < 55; i++) {
    const optional = i % 2 === 0;
    add(
      "INSERT INTO ai_debug_log (id,created_at,app_id,app_name,provider,model,phase,prompt,response,duration_ms,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      `pt-ops-debug-${i}`,
      now - i * 1000,
      optional ? OPS_APP : null,
      optional ? "" : null,
      optional ? "custom" : null,
      optional ? "model" : null,
      optional ? "summarise" : null,
      optional ? "prompt\nλ" : null,
      optional ? "response" : null,
      optional ? 0 : null,
      optional ? "" : null
    );
  }
  for (let i = 0; i < 12; i++) {
    if (i > 0) {
      add(
        "INSERT INTO apps (id,name,url,firstSeen,lastSynced) VALUES (?,?,'',?,?)",
        `pt-ops-policy-${i}`,
        `Operations run ${i}`,
        now,
        now
      );
    }
    const log = [
      "broken",
      "{}",
      "[]",
      "[null]",
      '[{"phase":3,"note":true}]',
      '[{"phase":"fetch","note":"first"},{"phase":"ai","note":"last"}]',
    ][i % 6];
    add(
      "INSERT INTO privacy_policy_analyses (app_id,policy_url,status,updated_at,run_status,run_started_at,last_run_log) VALUES (?,?,?,?,?,?,?)",
      i === 0 ? OPS_APP : `pt-ops-policy-${i}`,
      "https://example.test/policy",
      "pending",
      now - (12 - i) * 1000,
      "running",
      i % 2 ? null : now - (12 - i) * 1000,
      log
    );
  }
  sql.push(
    setting(
      "wayback_bulk_state",
      jobState(now, {
        version: 2,
        status: "paused",
        pausedAt: now - 500,
        pauseCause: "manual",
      })
    ),
    setting("wayback_import_running", "true"),
    setting("sync_bulk_state", jobState(now)),
    setting("sync_running", "false"),
    setting("policy_bulk_state", jobState(now)),
    setting("policy_sync_running", "true"),
    setting("rate_limit_search_until", `${now + 3600000}tail`),
    setting("rate_limit_search_reason", "Search 429"),
    setting("rate_limit_scrape_until", `${now - 1}`),
    setting("rate_limit_scrape_reason", "Stale reason"),
    setting("backup_snapshot_enabled", "true"),
    setting("backup_snapshot_interval_hours", "48tail"),
    setting("backup_snapshot_retention_count", "999"),
    setting("backup_snapshot_last_run_at", `${now - 100000}`)
  );
  return sql;
}
export function applyOperationsFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  // The existing disk probe owns its backup count and last-run fixture.
  // Operational backup settings/files are applied later by our raw probe.
  try {
    db.transaction(() => {
      for (const s of operationsStatements(Date.now())) {
        if (
          typeof s.params[0] === "string" &&
          s.params[0].startsWith("backup_snapshot_")
        ) {
          continue;
        }
        db.prepare(s.sql).run(...s.params);
      }
    })();
  } finally {
    db.close();
  }
}

/** Both backends clear per-app running markers during database startup.
 * Seed these live facts only after both databases have finished opening. */
export function primeOperationsAfterBoot(...dataDirs) {
  for (const dir of dataDirs) {
    const db = new BetterSqlite3(path.join(dir, "privacy.db"));
    try {
      db.prepare(
        "UPDATE privacy_policy_analyses SET run_status='running' WHERE app_id=? OR app_id LIKE 'pt-ops-policy-%'"
      ).run(OPS_APP);
    } finally {
      db.close();
    }
  }
}
