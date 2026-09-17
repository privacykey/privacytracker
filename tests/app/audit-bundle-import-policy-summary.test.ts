import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditBundle } from "../../lib/audit-bundle";
import {
  importAuditBundle,
  validateBundle,
} from "../../lib/audit-bundle-import";
import db from "../../lib/db";

const APP_ID = "pt-bundle-policy-1";
const OTHER_ID = "pt-bundle-policy-2";

function wipe() {
  for (const id of [APP_ID, OTHER_ID]) {
    db.prepare("DELETE FROM privacy_policy_analyses WHERE app_id = ?").run(id);
    db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }
  db.prepare(
    "DELETE FROM audit_bundle_imports WHERE exported_at LIKE 'pt-policy-%'"
  ).run();
}

test.beforeEach(wipe);
test.after(wipe);

function bundleWith(policySummary: unknown, exportedAt: string) {
  const result = validateBundle({
    version: 2,
    app_version: "0.0.0",
    exported_at: exportedAt,
    exported_by_audience: "self",
    recommender_name: "Sam",
    recommender_profile: null,
    annotations: [],
    verdicts: [],
    apps: [
      {
        id: APP_ID,
        name: "Policy App",
        developer: null,
        bundle_id: null,
        url: "https://apps.apple.com/us/app/policy-app/id1001",
        icon_url: null,
        current_version: null,
        privacy_policy_url: "https://example.com/privacy",
        has_privacy_details: 1,
        has_accessibility_labels: 0,
        privacy_types: [],
        accessibility_features: [],
        policy_summary: policySummary,
      },
    ],
  });
  assert.equal(result.ok, true);
  return (result as Extract<typeof result, { ok: true }>).bundle;
}

// The statement used to name a `generated_at` column the table has never
// had, so `prepare` threw and the whole import rolled back — for every
// bundle whose apps carried a policy summary, which is every bundle from a
// recommender who has fetched a privacy policy.
test("an app's policy summary imports instead of aborting the bundle", () => {
  const summary = importAuditBundle(
    bundleWith(
      {
        summary_json: '{"overview":"ok"}',
        source_text_excerpt: "three little words",
        fetched_at: 1_700_000_000_000,
        generated_at: 1_700_000_100_000,
      },
      "pt-policy-1"
    )
  );
  assert.equal(summary.appsAdded, 1);

  const row = db
    .prepare(
      `SELECT policy_url, status, source_text, source_word_count,
              analysis_mode, summary_json, model, source_fetched_at
         FROM privacy_policy_analyses WHERE app_id = ?`
    )
    .get(APP_ID);
  assert.deepEqual(row, {
    policy_url: "https://example.com/privacy",
    status: "ok",
    source_text: "three little words",
    source_word_count: 3,
    analysis_mode: "imported",
    summary_json: '{"overview":"ok"}',
    model: "imported",
    source_fetched_at: 1_700_000_000_000,
  });
});

test("a re-import keeps the stored summary when the newer bundle has none", () => {
  importAuditBundle(
    bundleWith(
      {
        summary_json: '{"overview":"first"}',
        source_text_excerpt: "first text",
        fetched_at: 1_700_000_000_000,
        generated_at: null,
      },
      "pt-policy-2"
    )
  );
  // Newer fetch time, so the per-app merge runs again; only the excerpt
  // is present this time, and COALESCE must keep the earlier summary.
  importAuditBundle(
    bundleWith(
      {
        summary_json: null,
        source_text_excerpt: "second text here",
        fetched_at: 1_700_000_500_000,
        generated_at: null,
      },
      "pt-policy-3"
    )
  );
  const row = db
    .prepare(
      "SELECT source_text, source_word_count, summary_json FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(APP_ID);
  assert.deepEqual(row, {
    source_text: "second text here",
    source_word_count: 3,
    summary_json: '{"overview":"first"}',
  });
});

test("what this install exports, it can import", () => {
  const now = Date.now();
  // The policy URL matters: without one the importer skips the summary
  // before it ever reaches the statement under test.
  db.prepare(
    "INSERT INTO apps (id, name, url, privacyPolicyUrl, firstSeen, lastSynced) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    OTHER_ID,
    "Round Trip",
    "https://apps.apple.com/us/app/rt/id1002",
    "https://example.com/rt/privacy",
    now,
    0
  );
  db.prepare(
    `INSERT INTO privacy_policy_analyses
       (app_id, policy_url, status, source_text, summary_json, updated_at, source_fetched_at)
     VALUES (?, ?, 'ok', ?, ?, ?, ?)`
  ).run(
    OTHER_ID,
    "https://example.com/rt/privacy",
    "policy text",
    '{"overview":"rt"}',
    now,
    now
  );

  const exported = buildAuditBundle({ recommenderName: "Sam" });
  const exportedApp = exported.apps.find((a) => a.id === OTHER_ID);
  assert.ok(exportedApp?.policy_summary?.summary_json);

  const result = validateBundle(JSON.parse(JSON.stringify(exported)));
  assert.equal(result.ok, true);
  const bundle = (result as Extract<typeof result, { ok: true }>).bundle;
  bundle.exported_at = "pt-policy-4";
  // Only this test's app: the suite's files share one database, and
  // re-importing everyone else's rows is not this test's business.
  bundle.apps = bundle.apps.filter((a) => a.id === OTHER_ID);
  bundle.annotations = [];
  bundle.verdicts = [];
  const summary = importAuditBundle(bundle);
  assert.equal(summary.appsUpdated, 1);
  const row = db
    .prepare(
      "SELECT analysis_mode, summary_json FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(OTHER_ID);
  assert.deepEqual(row, {
    analysis_mode: "imported",
    summary_json: '{"overview":"rt"}',
  });
});
