/**
 * Policy rows for the live gate (Rust core Phase 5, batch 2), applied to
 * the Node database before it is copied for the core, so both servers
 * answer the four policy reads from identical rows under fixed ids:
 *
 * - two analyses: one idle after a run whose log mixes well-formed and
 *   malformed phases, one ready with no run recorded;
 * - three versions of one app's policy, the second with an archive link,
 *   so the diff reads cover a one-word edit with an appended line, a
 *   changed last line, and the first version's "nothing to compare";
 * - three manual apps, two with a captured version each and one with no
 *   policy URL, for the manual version read and the scrape probe's
 *   refusals.
 *
 * No analysis here is running. Both backends flip every running analysis
 * to idle when they open the database, and Node opened its database
 * before this fixture was written while the core opens the copy after,
 * so a running row written here reads running on Node and idle on the
 * core. The operations fixture primes its running analyses on both sides
 * after boot, and the status read of its app covers the running state.
 *
 * The ids are this fixture's own: 89995xxx to 89999xxx belong to the
 * discovery, operations, content, devices and stats fixtures, and a
 * collision replaces the other fixture's row.
 */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const POLICY_APP = "89994001";
export const POLICY_APP_IDLE = "89994002";
export const POLICY_APP_NONE = "89994009";
export const POLICY_MANUAL = "pt-policy-manual";
export const POLICY_MANUAL_OTHER = "pt-policy-manual-2";
export const POLICY_MANUAL_NO_URL = "pt-policy-manual-nourl";

const TEXT_V1 = [
  "Privacy Policy",
  "We collect your email address and device identifiers.",
  "We share information with the service providers who host the app.",
  "Contact privacy@example.test with questions.",
].join("\n");
const TEXT_V2 = [
  "Privacy Policy",
  "We collect your email address and precise device identifiers.",
  "We share information with the service providers who host the app.",
  "Contact privacy@example.test with questions.",
  "We may update this policy from time to time.",
].join("\n");
const TEXT_V3 = [
  "Privacy Policy",
  "We collect your email address and precise device identifiers.",
  "We share information with the service providers who host the app.",
  "Contact privacy@example.test with questions.",
  "We will notify you before this policy changes.",
].join("\r\n");

export function policyStatements(now) {
  const statements = [];
  const add = (sql, ...params) => statements.push({ sql, params });
  add("DELETE FROM privacy_policy_versions WHERE id LIKE 'pt-policy-%'");
  add("DELETE FROM manual_app_policy_versions WHERE id LIKE 'pt-policy-%'");
  add("DELETE FROM manual_apps WHERE id LIKE 'pt-policy-%'");
  for (const id of [POLICY_APP, POLICY_APP_IDLE]) {
    add("DELETE FROM privacy_policy_analyses WHERE app_id = ?", id);
    add("DELETE FROM apps WHERE id = ?", id);
    add(
      "INSERT INTO apps (id,name,url,developer,iconUrl,firstSeen,lastSynced) VALUES (?,?,?,?,?,?,?)",
      id,
      id === POLICY_APP ? "Policy Parity" : "Policy Parity Idle",
      `https://apps.apple.com/us/app/id${id}`,
      "Policy dev",
      null,
      now - 86_400_000,
      now - 86_400_000
    );
  }
  const log = JSON.stringify([
    { phase: "fetching", at: now - 5000, note: "Requesting example.test" },
    { phase: "no-at" },
    "not an object",
    { phase: "fetch:direct", at: now - 4000, ms: 1000, error: "x" },
  ]);
  const analysis = (appId, over) => {
    const row = {
      app_id: appId,
      policy_url: "https://example.test/privacy",
      status: "ready",
      source_title: "example.test",
      source_content_type: "text/plain; charset=utf-8",
      source_text: TEXT_V3,
      source_word_count: 40,
      source_origin: "direct",
      source_final_url: "https://example.test/privacy",
      content_hash: "pt-policy-hash-v3",
      analysis_mode: "direct",
      summary_json: JSON.stringify({ overview: "Parity summary." }),
      updated_at: now - 60_000,
      source_fetched_at: now - 60_000,
      ...over,
    };
    const cols = Object.keys(row);
    add(
      `INSERT INTO privacy_policy_analyses (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      ...cols.map((c) => row[c])
    );
  };
  analysis(POLICY_APP, {
    run_status: "idle",
    run_started_at: now - 6000,
    last_run_log: log,
  });
  analysis(POLICY_APP_IDLE, { run_status: null, last_run_log: null });

  const version = (id, text, at, archive) =>
    add(
      "INSERT INTO privacy_policy_versions (id,app_id,content_hash,first_fetched_at,last_fetched_at,policy_url,source_final_url,source_title,source_content_type,source_origin,source_word_count,source_text,archive_url,archive_submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      POLICY_APP,
      `pt-policy-hash-${id.slice(-2)}`,
      at,
      at,
      "https://example.test/privacy",
      "https://example.test/privacy",
      "example.test",
      "text/plain; charset=utf-8",
      "direct",
      text.split(/\s+/).filter(Boolean).length,
      text,
      archive ?? null,
      archive ? at : null
    );
  version("pt-policy-v1", TEXT_V1, now - 3 * 86_400_000);
  version(
    "pt-policy-v2",
    TEXT_V2,
    now - 2 * 86_400_000,
    "http://web.archive.org/web/20260901000000/https://example.test/privacy"
  );
  version("pt-policy-v3", TEXT_V3, now - 86_400_000);

  const manual = (id, url) =>
    add(
      "INSERT INTO manual_apps (id,name,source,developer,privacy_policy_url,source_url,notes,first_seen,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      `Manual ${id}`,
      "web_clip",
      null,
      url,
      null,
      null,
      now - 86_400_000,
      now - 86_400_000
    );
  manual(POLICY_MANUAL, "https://example.test/privacy");
  manual(POLICY_MANUAL_OTHER, "https://example.test/privacy");
  manual(POLICY_MANUAL_NO_URL, null);
  const manualVersion = (id, manualId, text) =>
    add(
      "INSERT INTO manual_app_policy_versions (id,manual_app_id,content_hash,first_fetched_at,last_fetched_at,policy_url,source_final_url,source_title,source_content_type,source_origin,source_word_count,source_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      manualId,
      `pt-policy-manual-hash-${id.slice(-1)}`,
      now - 86_400_000,
      now - 86_400_000,
      "https://example.test/privacy",
      "https://example.test/privacy",
      "example.test",
      "text/plain; charset=utf-8",
      "direct",
      text.split(/\s+/).filter(Boolean).length,
      text
    );
  manualVersion("pt-policy-mv1", POLICY_MANUAL, TEXT_V1);
  manualVersion("pt-policy-mv2", POLICY_MANUAL_OTHER, TEXT_V2);
  return statements;
}

export function applyPolicyFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  try {
    db.transaction(() => {
      for (const { sql, params } of policyStatements(Date.now())) {
        db.prepare(sql).run(...params);
      }
    })();
  } finally {
    db.close();
  }
}
