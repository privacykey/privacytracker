#!/usr/bin/env node
/**
 * Write the `/api/apps/{id}/since-install` fixture rows into a data
 * directory's `privacy.db`.
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
    why: "a usable latest but an empty-string row at-or-before firstSeen — the empty one is skipped AND baselineIsApprox is set, because Node re-queries after the truthiness check fails",
    firstSeen: T0,
    snapshots: [
      { scrapedAt: T0 - DAY, source: "live", appVersion: "0.1.0", raw: "" },
      {
        scrapedAt: T0 + DAY,
        source: "live",
        appVersion: "2.0.0",
        types: [type_("A", "Alpha", [["C", "Cat"]])],
      },
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

/** Ids the probe should see refused rather than answered. */
export const MISSING_ID = "pt-fixture-does-not-exist";

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
     VALUES (?, ?, ?, ?, 0, '[]', ?, 'sample', ?)`
  );

  const tx = db.transaction(() => {
    // Clear first, so re-running against a dirty directory is idempotent
    // rather than additive.
    for (const fx of FIXTURES) {
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
          snap.source,
          snap.appVersion
        );
      });
    }
  });
  tx();
  db.close();

  const rows = FIXTURES.reduce((n, f) => n + f.snapshots.length, 0);
  return { apps: FIXTURES.length, snapshots: rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: since-install-fixture.mjs <dataDir>");
    process.exit(2);
  }
  const { apps, snapshots } = applySinceInstallFixture(path.resolve(dir));
  console.log(
    `since-install-fixture: wrote ${apps} apps / ${snapshots} snapshots into ${dir}`
  );
}
