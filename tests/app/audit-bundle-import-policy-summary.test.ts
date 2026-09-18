import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditBundle } from "../../lib/audit-bundle";
import {
  importAuditBundle,
  validateBundle,
} from "../../lib/audit-bundle-import";
import db from "../../lib/db";
import {
  getPolicyAnalysis,
  syncPrivacyPolicyAnalysis,
} from "../../lib/privacy-policy";

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
    status: "ready",
    source_text: "three little words",
    source_word_count: 3,
    analysis_mode: "imported",
    summary_json: '{"overview":"ok"}',
    model: "imported",
    source_fetched_at: 1_700_000_000_000,
  });
});

// The importer used to store status 'ok', which is not an analysis status,
// so the row read back as 'analysis_error' and the AI Policy tab showed the
// imported summary under "The latest AI refresh failed, so this summary may
// be out of date." No refresh had run on this install at all.
test("an imported summary reads back as a ready analysis, not a failed one", () => {
  importAuditBundle(
    bundleWith(
      {
        summary_json: '{"overview":"Collects contact info."}',
        source_text_excerpt: "three little words",
        fetched_at: 1_700_000_000_000,
        generated_at: null,
      },
      "pt-policy-5"
    )
  );

  const analysis = getPolicyAnalysis(APP_ID);
  assert.equal(analysis?.status, "ready");
  assert.equal(analysis?.summary?.overview, "Collects contact info.");
  assert.equal(analysis?.error, undefined);
  assert.equal(analysis?.model, "imported");
  assert.equal(analysis?.sourcePreview, "three little words");
  assert.equal(analysis?.sourceFetchedAt, 1_700_000_000_000);
});

// A recommender with AI summaries off, the default, exports the policy text
// and no summary. That is fetched text waiting for a summary, the state
// this install would reach with its own first fetch. It read back as
// 'analysis_error' too: "the AI summary could not be generated".
test("an excerpt with no summary reads back as text waiting for a summary", () => {
  importAuditBundle(
    bundleWith(
      {
        summary_json: null,
        source_text_excerpt: "only the text",
        fetched_at: 1_700_000_000_000,
        generated_at: null,
      },
      "pt-policy-6"
    )
  );

  const row = db
    .prepare(
      "SELECT status, source_text, summary_json FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(APP_ID);
  assert.deepEqual(row, {
    status: "source_ready",
    source_text: "only the text",
    summary_json: null,
  });

  const analysis = getPolicyAnalysis(APP_ID);
  assert.equal(analysis?.status, "source_ready");
  assert.equal(analysis?.summary, null);
  assert.equal(analysis?.sourcePreview, "only the text");
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
  // is present this time, and COALESCE must keep the earlier summary. The
  // status follows the summary the row keeps, not the bundle's lack of one.
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
      "SELECT status, source_text, source_word_count, summary_json FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(APP_ID);
  assert.deepEqual(row, {
    status: "ready",
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
     VALUES (?, ?, 'ready', ?, ?, ?, ?)`
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
      "SELECT status, analysis_mode, summary_json FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(OTHER_ID);
  assert.deepEqual(row, {
    status: "ready",
    analysis_mode: "imported",
    summary_json: '{"overview":"rt"}',
  });
});

// A bundle carries the first 4 KB of the policy, not the policy. Once the
// row reads as 'ready' or 'source_ready', Summarise would hand that excerpt
// to the AI and store a summary of the opening paragraphs as the policy's.
// It has to fetch the full text first.
for (const [label, policySummary, status] of [
  [
    "an imported summary",
    { summary_json: '{"overview":"kept"}', source_text_excerpt: "excerpt" },
    "ready",
  ],
  [
    "an imported excerpt",
    { summary_json: null, source_text_excerpt: "excerpt" },
    "source_ready",
  ],
] as const) {
  test(`Summarise does not summarise ${label} from the excerpt`, async () => {
    importAuditBundle(
      bundleWith(
        { ...policySummary, fetched_at: 1_700_000_000_000, generated_at: null },
        `pt-policy-summarise-${status}`
      )
    );
    const before = db
      .prepare("SELECT * FROM privacy_policy_analyses WHERE app_id = ?")
      .get(APP_ID) as Record<string, unknown>;

    const originalFetch = global.fetch;
    let fetches = 0;
    global.fetch = (async () => {
      fetches++;
      throw new Error("no network in this test");
    }) as typeof fetch;
    try {
      // Exactly what the Summarise button sends: the route forces a fresh
      // summary for every phase.
      const result = await syncPrivacyPolicyAnalysis(
        {
          appId: APP_ID,
          appName: "Policy App",
          policyUrl: "https://example.com/privacy",
        },
        { phase: "summarise", forceResummarise: true }
      );
      assert.equal(result?.status, status);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(fetches, 0);
    // The run log says why nothing happened. It is read back from the row:
    // like every skip, the returned analysis predates its own log line.
    assert.match(
      getPolicyAnalysis(APP_ID)?.lastRunLog?.at(-1)?.note ?? "",
      /imported audit bundle/
    );

    const after = db
      .prepare("SELECT * FROM privacy_policy_analyses WHERE app_id = ?")
      .get(APP_ID) as Record<string, unknown>;
    for (const column of [
      "status",
      "source_text",
      "summary_json",
      "model",
      "analysis_mode",
    ]) {
      assert.equal(after[column], before[column], column);
    }
  });
}
