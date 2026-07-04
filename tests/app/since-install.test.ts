import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getSinceInstallDiff, saveSnapshot } from "../../lib/changelog";
import type { PrivacyTypeSnapshot } from "../../lib/changelog-types";
import db from "../../lib/db";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const APP_ID = "555000111";

/** Helper: pin apps.firstSeen so baseline resolution is deterministic. */
function setFirstSeen(ms: number): void {
  db.prepare("UPDATE apps SET firstSeen = ? WHERE id = ?").run(ms, APP_ID);
}

function snap(
  types: Array<{ id: string; title: string; cats: string[] }>
): PrivacyTypeSnapshot[] {
  return types.map((t) => ({
    identifier: t.id,
    title: t.title,
    categories: t.cats.map((c) => ({ identifier: c, title: c })),
  }));
}

const INSTALL = Date.UTC(2021, 5, 1); // 1 Jun 2021
const LATER = Date.UTC(2025, 5, 1); // 1 Jun 2025

beforeEach(() => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Fixture" });
});

test("diffs the install-era baseline against the latest snapshot", () => {
  setFirstSeen(INSTALL);

  // Baseline at install: only "Data Linked to You → Location".
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location"],
      },
    ]),
    [],
    { scrapedAt: INSTALL, source: "wayback", appVersion: "1.0.0" }
  );

  // Latest: Location kept, Contacts added, plus a whole new tracking type.
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location", "Contacts"],
      },
      {
        id: "DATA_USED_TO_TRACK_YOU",
        title: "Data Used to Track You",
        cats: ["Identifiers"],
      },
    ]),
    [],
    { scrapedAt: LATER, source: "live", appVersion: "3.4.1" }
  );

  const result = getSinceInstallDiff(APP_ID);
  assert.ok(result, "expected a diff");
  assert.equal(result.baselineDate, INSTALL);
  assert.equal(result.latestDate, LATER);
  assert.equal(result.baselineIsApprox, false);
  assert.equal(result.baselineSource, "wayback");
  assert.equal(result.baselineVersion, "1.0.0");
  assert.equal(result.latestVersion, "3.4.1");
  assert.equal(result.isSingleSnapshot, false);
  // Added: new tracking label (1) + Contacts category (1) = 2 added, 0 removed.
  assert.equal(result.addedCount, 2);
  assert.equal(result.removedCount, 0);
});

test("falls back to the earliest snapshot and flags it approximate when none predates install", () => {
  // firstSeen is BEFORE any snapshot we have — common when an old app is
  // added but the backfill hasn't reconstructed the install era yet.
  setFirstSeen(Date.UTC(2020, 0, 1));

  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location"],
      },
    ]),
    [],
    { scrapedAt: INSTALL, source: "wayback" }
  );
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location", "Contacts"],
      },
    ]),
    [],
    { scrapedAt: LATER, source: "live" }
  );

  const result = getSinceInstallDiff(APP_ID);
  assert.ok(result);
  assert.equal(result.baselineIsApprox, true);
  assert.equal(result.baselineDate, INSTALL); // earliest stands in
  assert.equal(result.addedCount, 1); // Contacts added
  assert.equal(result.removedCount, 0);
});

test("reports removals from baseline → latest", () => {
  setFirstSeen(INSTALL);
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location", "Contacts"],
      },
    ]),
    [],
    { scrapedAt: INSTALL, source: "wayback" }
  );
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location"],
      },
    ]),
    [],
    { scrapedAt: LATER, source: "live" }
  );

  const result = getSinceInstallDiff(APP_ID);
  assert.ok(result);
  assert.equal(result.addedCount, 0);
  assert.equal(result.removedCount, 1);
});

test("single snapshot yields no diff", () => {
  setFirstSeen(INSTALL);
  saveSnapshot(
    APP_ID,
    snap([
      {
        id: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        cats: ["Location"],
      },
    ]),
    [],
    { scrapedAt: INSTALL, source: "live" }
  );

  const result = getSinceInstallDiff(APP_ID);
  assert.ok(result);
  assert.equal(result.isSingleSnapshot, true);
  assert.equal(result.changes.length, 0);
  assert.equal(result.addedCount, 0);
  assert.equal(result.removedCount, 0);
});

test("returns null for an app with no snapshots", () => {
  setFirstSeen(INSTALL);
  assert.equal(getSinceInstallDiff(APP_ID), null);
});

test("returns null for an unknown app", () => {
  assert.equal(getSinceInstallDiff("does-not-exist"), null);
});
