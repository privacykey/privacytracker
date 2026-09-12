#!/usr/bin/env node
/**
 * Write the per-app read-route fixture rows into a data directory's
 * `privacy.db`. Backs both `/api/apps/{id}/since-install` and
 * `/api/apps/{id}/history-stats`; the filename predates the second.
 *
 * Why this exists: the canned seed is useless for this route. It gives every
 * app a baseline and a latest snapshot whose types and categories have
 * identical MEMBERSHIP — the arrays are reordered between them, but nothing
 * is added or removed — so all ten seeded apps answer `"changes": []`. A
 * Rust port that never diffed anything would pass the read gate on real
 * data. Worse, none of the interesting branches (`baselineIsApprox`,
 * `isSingleSnapshot`, the null response, the empty-string `snapshot_json`
 * trap) is reachable from the seed at all.
 *
 * `read-parity.mjs` applies this to the NODE data directory BEFORE it
 * checkpoints and copies, so the Rust server starts on a byte copy holding
 * the same rows. Both backends then compute their own answer from identical
 * input and the probe byte-compares the two.
 *
 * These rows deliberately do NOT go through the shipped seed endpoint. They
 * are harness scaffolding for one route, several of them describe states the
 * app itself would never write (a snapshot blob that is the empty string),
 * and putting them in `/api/dev/seed-sample-data` would leak them into
 * everything else that seeds — including the screenshot script.
 *
 *   node scripts/parity/since-install-fixture.mjs <dataDir>
 */
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

/** A fixed epoch so the fixture is reproducible across runs and machines. */
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * What goes in `changes_summary`. `rawChanges` stores the string verbatim so
 * a case can hold something `JSON.parse` rejects; `changes` is the normal
 * path; absent means the empty array.
 */
const rawChangesFor = (snap) => {
  if (snap.rawChanges !== undefined) {
    return snap.rawChanges;
  }
  return snap.changes === undefined ? "[]" : JSON.stringify(snap.changes);
};

const type_ = (identifier, title, categories) => ({
  identifier,
  title,
  categories: categories.map(([id, t]) => ({ identifier: id, title: t })),
});

/**
 * Every scenario the route has a branch for. `apps` carries the id and
 * firstSeen; `snapshots` are written in the order given.
 *
 * The ids are deliberately not Apple track ids — nothing else in the fixture
 * or the app can collide with them, and they read as harness rows in a
 * database dump.
 */
export const FIXTURES = [
  {
    id: "pt-fixture-diff",
    why: "the only case that produces a NON-EMPTY changes array — added type, removed type, added category, removed category, all in one response",
    firstSeen: T0,
    snapshots: [
      {
        // Baseline: at-or-before firstSeen, so baselineIsApprox stays false.
        scrapedAt: T0 - DAY,
        source: "live",
        appVersion: "1.0.0",
        types: [
          type_("KEEP", "Kept Label", [
            ["C_OLD", "Old Category"],
            ["C_BOTH", "Shared Category"],
          ]),
          type_("DROP", "Dropped Label", [["C_X", "Ex"]]),
        ],
      },
      {
        // A middle row that must be IGNORED — only the two endpoints count.
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: "1.5.0",
        types: [type_("NOISE", "Should Not Appear", [["C_N", "Noise"]])],
      },
      {
        scrapedAt: T0 + 2 * DAY,
        source: "live",
        appVersion: "2.0.0",
        types: [
          type_("KEEP", "Kept Label", [
            ["C_BOTH", "Shared Category"],
            ["C_NEW", "New Category"],
          ]),
          type_("ADD", "Added Label", [["C_A", "Ay"]]),
        ],
      },
    ],
  },
  {
    id: "pt-fixture-approx",
    why: "nothing at-or-before firstSeen, so the earliest snapshot stands in and baselineIsApprox is true",
    firstSeen: T0 - 365 * DAY,
    snapshots: [
      {
        scrapedAt: T0,
        source: "wayback",
        appVersion: "0.9.0",
        types: [type_("A", "Alpha", [["C1", "One"]])],
      },
      {
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: null,
        types: [type_("A", "Alpha", [["C2", "Two"]])],
      },
    ],
  },
  {
    id: "pt-fixture-wayback",
    why: "baselineSource comes from a strict === against the literal 'wayback', and baselineVersion is a present string while latestVersion is a present null",
    firstSeen: T0,
    snapshots: [
      {
        scrapedAt: T0 - DAY,
        source: "wayback",
        appVersion: "3.1.4",
        types: [type_("A", "Alpha", [])],
      },
      {
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: null,
        types: [type_("A", "Alpha", [["C", "Cat"]])],
      },
    ],
  },
  {
    id: "pt-fixture-single",
    why: "one snapshot: baseline and latest are the same row, isSingleSnapshot is true and changes must be [] without the diff even running",
    firstSeen: T0,
    snapshots: [
      {
        scrapedAt: T0 - DAY,
        source: "live",
        appVersion: "1.0.0",
        types: [type_("A", "Alpha", [["C", "Cat"]])],
      },
    ],
  },
  {
    id: "pt-fixture-tie",
    why: "two DISTINCT rows sharing one scraped_at — isSingleSnapshot compares the timestamp, not the row, so this reads as a single snapshot and diffs to nothing even though the blobs differ",
    firstSeen: T0 + 10 * DAY,
    snapshots: [
      {
        scrapedAt: T0,
        source: "live",
        appVersion: "1.0.0",
        types: [type_("A", "Alpha", [["C1", "One"]])],
      },
      {
        scrapedAt: T0,
        source: "live",
        appVersion: "1.0.1",
        types: [type_("B", "Beta", [["C2", "Two"]])],
      },
    ],
  },
  {
    id: "pt-fixture-nosnap",
    why: "the app row exists but has no snapshots — 200 with sinceInstall null, NOT a 404",
    firstSeen: T0,
    snapshots: [],
  },
  {
    id: "pt-fixture-empty-json",
    why: "snapshot_json is the EMPTY STRING. The column is NOT NULL so `IS NOT NULL` cannot filter it; only the JS truthiness check does, and it makes the whole response null",
    firstSeen: T0,
    snapshots: [
      { scrapedAt: T0 - DAY, source: "live", appVersion: "1.0.0", raw: "" },
      { scrapedAt: T0 + DAY, source: "live", appVersion: "2.0.0", raw: "" },
    ],
  },
  {
    id: "pt-fixture-empty-baseline",
    why: "an empty-string row is the newest at-or-before firstSeen, so the truthiness check rejects it and the ASC fallback picks the older USABLE row instead — baselineIsApprox true even though a snapshot did predate install. Needs three rows: with only the empty one and a later real one, the fallback re-picks the same empty row and the whole response is null (that is pt-fixture-empty-json's job, not this one)",
    firstSeen: T0,
    snapshots: [
      {
        scrapedAt: T0 - 2 * DAY,
        source: "wayback",
        appVersion: "0.0.1",
        types: [type_("A", "Alpha", [["C_OLD", "Old Cat"]])],
      },
      { scrapedAt: T0 - DAY, source: "live", appVersion: "0.1.0", raw: "" },
      {
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: "2.0.0",
        types: [type_("A", "Alpha", [["C_NEW", "New Cat"]])],
      },
    ],
  },
  {
    id: "pt-fixture-empty-latest",
    why: "the NEWEST row is an empty string, which the SQL cannot filter (the column is NOT NULL) — the truthiness check rejects it and the whole response is null, even though a perfectly good older snapshot exists",
    firstSeen: T0,
    snapshots: [
      {
        scrapedAt: T0 - DAY,
        source: "live",
        appVersion: "1.0.0",
        types: [type_("A", "Alpha", [["C", "Cat"]])],
      },
      { scrapedAt: T0 + DAY, source: "live", appVersion: "2.0.0", raw: "" },
    ],
  },
  {
    id: "pt-fixture-unicode",
    why: "non-ASCII and embedded double quotes in the composed descriptions — Node emits UTF-8 unescaped and does not escape the inner quotes",
    firstSeen: T0,
    snapshots: [
      {
        scrapedAt: T0 - DAY,
        source: "live",
        appVersion: "1.0.0",
        types: [type_("T", 'He said "hi" ☕', [["C_OLD", "Café"]])],
      },
      {
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: "2.0.0",
        types: [type_("T", 'He said "hi" ☕', [["C_NEW", "日本語 🇯🇵"]])],
      },
    ],
  },
];

/**
 * history-stats only. The canned seed reaches its `added` arm and nothing
 * else: across all ten seeded apps `totalRemoved` is 0, every entry is an
 * untagged privacy-label one, and `changes_detected` is only ever 0 or 1.
 * So a port that dropped the removal arm, ignored the category filter, or
 * relaxed the strict `!== 1` would pass the gate on real data.
 *
 * Rows are dated inside Q4 2023 and Q1 2024 so two ADJACENT buckets carry
 * different numbers — a port with the boundaries a quarter out would merge
 * them and the counts would move.
 */
const TREND_FIXTURE = {
  id: "pt-fixture-trend",
  firstSeen: T0,
  snapshots: [
    {
      // Q4 2023. Mixed adds and removes, plus a tagged entry that must NOT
      // count towards either total.
      scrapedAt: T0,
      source: "live",
      appVersion: "1.0.0",
      changesDetected: 1,
      changes: [
        { type: "added", description: "a1" },
        { type: "added", description: "a2" },
        { type: "removed", description: "r1" },
        { type: "added", description: "policy", category: "privacy-policy" },
        { type: "removed", description: "a11y", category: "accessibility" },
        // An explicit null category is UNTAGGED — `??`, not `||` — so this
        // one counts.
        { type: "removed", description: "r2", category: null },
      ],
      types: [type_("A", "Alpha", [["C", "Cat"]])],
    },
    {
      // Same quarter, but changes_detected = 2. computeCategoryTrend ignores
      // the column and counts these; computeQuarterlyChanges tests `!== 1`
      // and skips the row entirely. The two aggregates disagree on purpose.
      scrapedAt: T0 + DAY,
      source: "live",
      appVersion: "1.1.0",
      changesDetected: 2,
      changes: [{ type: "added", description: "counted-by-trend-only" }],
      types: [type_("A", "Alpha", [["C", "Cat"]])],
    },
    {
      // changes_detected = 1 but every entry is tagged, so there are zero
      // label entries and this is not an EVENT — the count must stay 0
      // rather than becoming 1.
      scrapedAt: T0 + 2 * DAY,
      source: "live",
      appVersion: "1.2.0",
      changesDetected: 1,
      changes: [
        {
          type: "added",
          description: "policy only",
          category: "privacy-policy",
        },
      ],
      types: [type_("A", "Alpha", [["C", "Cat"]])],
    },
    {
      // Q1 2024 — the next bucket, with different numbers from the first.
      scrapedAt: Date.UTC(2024, 0, 15),
      source: "live",
      appVersion: "2.0.0",
      changesDetected: 1,
      changes: [{ type: "removed", description: "r3" }],
      types: [type_("A", "Alpha", [])],
    },
    {
      // Predates Q1 2021, so `Array.prototype.find` matches no bucket and
      // the row is dropped rather than clamped into the first one.
      scrapedAt: Date.UTC(2019, 5, 1),
      source: "live",
      appVersion: "0.0.1",
      changesDetected: 1,
      changes: [{ type: "added", description: "before the floor" }],
      types: [type_("A", "Alpha", [])],
    },
    {
      // Unparseable changes_summary: both functions swallow the error and
      // treat it as no entries rather than failing the request.
      scrapedAt: T0 + 3 * DAY,
      source: "live",
      appVersion: "1.3.0",
      changesDetected: 1,
      rawChanges: "not json",
      types: [type_("A", "Alpha", [])],
    },
  ],
};

// Written alongside the since-install scenarios. Declared separately
// because it is the only entry whose point is `changes_summary`, which the
// since-install route never reads.

/**
 * changelog only. The manifest hits this route on Instagram alone, where
 * neither of its two read-time mutations fires — so `matches_live_sync` and
 * the `kind: "review"` row shape are completely uncompared today.
 * (`archive_bridge` is already reachable, by accident, through
 * `pt-fixture-wayback` and `pt-fixture-approx`.)
 *
 * The wayback row here is written with a snapshot_json BYTE-IDENTICAL to the
 * live row beside it, which is the whole condition for `matches_live_sync` —
 * the comparison is on the raw string, not on parsed content.
 */
const TIMELINE_FIXTURE = {
  id: "pt-fixture-timeline",
  firstSeen: T0,
  snapshots: [
    {
      scrapedAt: T0 - DAY,
      source: "wayback",
      appVersion: "1.0.0",
      changesDetected: 0,
      types: [type_("A", "Alpha", [["C", "Cat"]])],
    },
    {
      // Same types in the same order → identical JSON.stringify output → the
      // neighbour scan tags the wayback row above.
      scrapedAt: T0,
      source: "live",
      appVersion: "1.0.1",
      changesDetected: 0,
      types: [type_("A", "Alpha", [["C", "Cat"]])],
    },
  ],
  /**
   * Review rows interleave with snapshots on one `scraped_at` axis
   * (`acted_at` is read into that field). This one is deliberately dated to
   * the SAME instant as the live snapshot above, because the merge's
   * tie-break — snapshot before review — is otherwise unobservable.
   */
  reviews: [
    {
      id: "rev-1",
      action: "reviewed",
      actedAt: T0,
      coveredCount: 2,
      coveredSnapshotIds: '["pt-fixture-timeline-snap-0", "", null, 7]',
      snoozeUntil: null,
      note: "acknowledged by the parity fixture",
    },
    {
      // A legacy row: covered_snapshot_ids NULL, which must read as [].
      id: "rev-2",
      action: "snoozed",
      actedAt: T0 + DAY,
      coveredCount: 0,
      coveredSnapshotIds: null,
      snoozeUntil: T0 + 7 * DAY,
      note: null,
    },
  ],
};

// Registered after both declarations, because `const` is not hoisted.
FIXTURES.push(TREND_FIXTURE, TIMELINE_FIXTURE);

/** The fixture app whose numbers the history-stats probe checks. */
export const TREND_ID = TREND_FIXTURE.id;

/** The fixture app whose timeline the changelog probe checks. */
export const TIMELINE_ID = TIMELINE_FIXTURE.id;

/** Apps whose changelog trips `archive_bridge` — verified on the wire. */
export const BRIDGED_IDS = ["pt-fixture-wayback", "pt-fixture-approx"];

/** Ids the probe should see refused rather than answered. */
export const MISSING_ID = "pt-fixture-does-not-exist";

/**
 * A stored privacy profile, so `/api/apps?meta=grid` populates
 * `profileBadges`. Without one the canned seed leaves that map — and the
 * whole profile-matching engine behind it — at `{}`, so a port that skipped
 * `computeProfileMismatch` entirely would pass.
 *
 * `CONTACT_INFO` and `CONTACTS` are both set, at the SAME tier, on purpose:
 * `computeProfileMismatch` breaks equal-gap ties with `localeCompare`, and
 * ICU order puts `CONTACT_INFO` first where byte order puts `CONTACTS`.
 * Several seeded apps track both, so the tie-break is observed on the wire.
 */
export const PROFILE_FIXTURE = {
  LOCATION: "not_linked",
  CONTACT_INFO: "not_linked",
  CONTACTS: "not_linked",
  IDENTIFIERS: "not_collected",
  USAGE_DATA: "not_linked",
};

/**
 * The one app on which `computeProfileMismatch`'s tie-break is decisive.
 * No canned app collects `CONTACTS` at all, so nothing in the seed can tie
 * it against `CONTACT_INFO`. This app tracks BOTH under
 * `DATA_USED_TO_TRACK_YOU`; with the fixture profile allowing `not_linked`
 * for each, both mismatch with an equal gap of 2 and `worstCategory` is
 * decided purely by `localeCompare` — ICU says `CONTACT_INFO`. The rows are
 * inserted `CONTACTS` first so that insertion order gives the wrong answer
 * too, not just byte order.
 */
export const COLLATION_FIXTURE = {
  id: "pt-fixture-collation",
  typeId: "pt-fixture-collation-type",
  categories: ["CONTACTS", "CONTACT_INFO"],
};

/**
 * The canned Instagram app. `/api/apps/{id}/detail` rejects non-numeric ids
 * with a 400 before it looks anything up, so the three detail fields the
 * seed leaves null have to be populated on a SEEDED app, and this is the one
 * the manifest already compares.
 */
export const INSTAGRAM_ID = "94961186";

/**
 * Rows that make three otherwise-null detail fields real:
 *   - an import batch + item for Instagram → `importProvenance`
 *   - an accessibility profile → `a11yProfile`
 *   - a guardian age band → `childAgeBand`
 * Without these all three were only ever compared as null against null.
 */
export const DETAIL_FIXTURE = {
  importId: "pt-fixture-import-1",
  itemId: "pt-fixture-import-item-1",
  a11yProfile: { voiceover: "required", captions: "nice" },
  childAgeBand: "13_15",
};

/** A user verdict, so `userVerdicts` is non-empty for the same reason. */
export const VERDICT_FIXTURE = {
  id: "pt-fixture-verdict-1",
  appId: "pt-fixture-diff",
  verdict: "replace",
};

export function applySinceInstallFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  const insertApp = db.prepare(
    `INSERT OR REPLACE INTO apps (id, name, url, firstSeen, lastSynced)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertSnapshot = db.prepare(
    `INSERT OR REPLACE INTO privacy_snapshots
       (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
        source, triggered_by, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sample', ?)`
  );

  const insertReview = db.prepare(
    `INSERT OR REPLACE INTO change_review_actions
       (id, app_id, action, acted_at, covered_count, covered_snapshot_ids,
        snooze_until, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertVerdict = db.prepare(
    `INSERT OR REPLACE INTO app_verdicts
       (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)
     VALUES (?, ?, ?, NULL, 'user', NULL, ?, ?)`
  );
  const upsertSetting = db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    // Clear first, so re-running against a dirty directory is idempotent
    // rather than additive.
    db.prepare("DELETE FROM privacy_categories WHERE type_id = ?").run(
      COLLATION_FIXTURE.typeId
    );
    db.prepare("DELETE FROM privacy_types WHERE app_id = ?").run(
      COLLATION_FIXTURE.id
    );
    db.prepare("DELETE FROM apps WHERE id = ?").run(COLLATION_FIXTURE.id);
    db.prepare("DELETE FROM import_items WHERE import_id = ?").run(
      DETAIL_FIXTURE.importId
    );
    db.prepare("DELETE FROM imports WHERE id = ?").run(DETAIL_FIXTURE.importId);
    for (const fx of FIXTURES) {
      db.prepare("DELETE FROM change_review_actions WHERE app_id = ?").run(
        fx.id
      );
      db.prepare("DELETE FROM privacy_snapshots WHERE app_id = ?").run(fx.id);
      db.prepare("DELETE FROM apps WHERE id = ?").run(fx.id);
    }
    for (const fx of FIXTURES) {
      insertApp.run(
        fx.id,
        `Parity fixture — ${fx.id}`,
        `https://example.com/${fx.id}`,
        fx.firstSeen,
        T0
      );
      fx.snapshots.forEach((snap, i) => {
        insertSnapshot.run(
          `${fx.id}-snap-${i}`,
          fx.id,
          snap.scrapedAt,
          // `raw` lets a case store something the app would never write.
          snap.raw === undefined ? JSON.stringify(snap.types) : snap.raw,
          // These two are read by history-stats and ignored by since-install.
          snap.changesDetected ?? 0,
          rawChangesFor(snap),
          snap.source,
          snap.appVersion
        );
      });
      for (const rev of fx.reviews ?? []) {
        insertReview.run(
          `${fx.id}-${rev.id}`,
          fx.id,
          rev.action,
          rev.actedAt,
          rev.coveredCount,
          rev.coveredSnapshotIds,
          rev.snoozeUntil,
          rev.note
        );
      }
    }
    insertApp.run(
      COLLATION_FIXTURE.id,
      `Parity fixture — ${COLLATION_FIXTURE.id}`,
      `https://example.com/${COLLATION_FIXTURE.id}`,
      T0,
      T0
    );
    db.prepare(
      "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, 'DATA_USED_TO_TRACK_YOU', 'Data Used to Track You')"
    ).run(COLLATION_FIXTURE.typeId, COLLATION_FIXTURE.id);
    for (const cat of COLLATION_FIXTURE.categories) {
      db.prepare(
        "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)"
      ).run(
        `${COLLATION_FIXTURE.typeId}-${cat}`,
        COLLATION_FIXTURE.typeId,
        cat,
        cat
      );
    }
    // Detail coverage on the seeded Instagram app (see DETAIL_FIXTURE).
    db.prepare(
      `INSERT INTO imports (id, created_at, completed_at, source, source_label, total, matched, unmatched, imported)
       VALUES (?, ?, ?, 'file', 'parity fixture', 1, 1, 0, 1)`
    ).run(DETAIL_FIXTURE.importId, T0, T0);
    db.prepare(
      `INSERT INTO import_items (id, import_id, query, status, app_id, app_name, attempt_count)
       VALUES (?, ?, 'Instagram', 'imported', ?, 'Instagram', 1)`
    ).run(DETAIL_FIXTURE.itemId, DETAIL_FIXTURE.importId, INSTAGRAM_ID);
    upsertSetting.run(
      "accessibility_profile",
      JSON.stringify(DETAIL_FIXTURE.a11yProfile)
    );
    upsertSetting.run("guardian_child_age_band", DETAIL_FIXTURE.childAgeBand);
    upsertSetting.run("privacy_profile", JSON.stringify(PROFILE_FIXTURE));
    insertVerdict.run(
      VERDICT_FIXTURE.id,
      VERDICT_FIXTURE.appId,
      VERDICT_FIXTURE.verdict,
      T0,
      T0
    );
  });
  tx();
  db.close();

  const rows = FIXTURES.reduce((n, f) => n + f.snapshots.length, 0);
  const reviews = FIXTURES.reduce((n, f) => n + (f.reviews?.length ?? 0), 0);
  return { apps: FIXTURES.length, snapshots: rows, reviews };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: since-install-fixture.mjs <dataDir>");
    process.exit(2);
  }
  const { apps, snapshots, reviews } = applySinceInstallFixture(
    path.resolve(dir)
  );
  console.log(
    `since-install-fixture: wrote ${apps} apps / ${snapshots} snapshots / ${reviews} reviews into ${dir}`
  );
}
