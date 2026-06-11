import assert from "node:assert/strict";
import test from "node:test";
import {
  getMayAlsoLike,
  getMoreByDeveloper,
  getRelatedAppsForSource,
  purgeAllRelatedApps,
  type RelatedAppInput,
  replaceRelatedAppsForSource,
} from "../../lib/related-apps-observed";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

test.beforeEach(resetTestDb);

// Small helper so each test reads as "given these inputs → expect this read".
function input(
  relatedAppleId: string,
  shelfType: "may_also_like" | "more_by_developer",
  overrides: Partial<RelatedAppInput> = {}
): RelatedAppInput {
  return {
    relatedAppleId,
    relatedName: `App ${relatedAppleId}`,
    relatedDeveloper: "Acme Co",
    relatedIconUrl: `https://example.test/${relatedAppleId}.png`,
    relatedStoreUrl: `https://apps.apple.com/us/app/id${relatedAppleId}`,
    shelfType,
    ...overrides,
  };
}

test("replaceRelatedAppsForSource writes both shelf types and reads them back per shelf", () => {
  seedTrackedApp({ id: "source-1" });

  replaceRelatedAppsForSource("source-1", [
    input("11", "may_also_like"),
    input("22", "may_also_like"),
    input("33", "more_by_developer"),
  ]);

  const mal = getMayAlsoLike("source-1");
  assert.equal(mal.length, 2);
  assert.deepEqual(mal.map((r) => r.relatedAppleId).sort(), ["11", "22"]);
  assert.ok(mal.every((r) => r.shelfType === "may_also_like"));
  assert.ok(mal.every((r) => r.sourceAppId === "source-1"));

  const mbd = getMoreByDeveloper("source-1");
  assert.equal(mbd.length, 1);
  assert.equal(mbd[0].relatedAppleId, "33");
  assert.equal(mbd[0].shelfType, "more_by_developer");
});

test("replaceRelatedAppsForSource wipes existing rows on rewrite", () => {
  seedTrackedApp({ id: "source-1" });

  replaceRelatedAppsForSource("source-1", [
    input("11", "may_also_like"),
    input("22", "may_also_like"),
    input("33", "more_by_developer"),
  ]);

  // Second write — fresh set, no overlap with the first.
  replaceRelatedAppsForSource("source-1", [input("99", "may_also_like")]);

  const all = getRelatedAppsForSource("source-1");
  assert.deepEqual(
    all.may_also_like.map((r) => r.relatedAppleId),
    ["99"]
  );
  // More-by-developer entries from the first write are wiped — the
  // helper is "atomic replace for everything tied to this source", not
  // "merge per shelf". Confirms the semantics documented in the module.
  assert.equal(all.more_by_developer.length, 0);
});

test("replaceRelatedAppsForSource with empty array clears existing rows", () => {
  seedTrackedApp({ id: "source-1" });
  replaceRelatedAppsForSource("source-1", [input("11", "may_also_like")]);
  assert.equal(getMayAlsoLike("source-1").length, 1);

  replaceRelatedAppsForSource("source-1", []);
  assert.equal(getMayAlsoLike("source-1").length, 0);
});

test("reads scope to the requested source app", () => {
  seedTrackedApp({ id: "source-a" });
  seedTrackedApp({ id: "source-b" });

  replaceRelatedAppsForSource("source-a", [input("11", "may_also_like")]);
  replaceRelatedAppsForSource("source-b", [input("22", "may_also_like")]);

  const aRows = getMayAlsoLike("source-a");
  const bRows = getMayAlsoLike("source-b");
  assert.deepEqual(
    aRows.map((r) => r.relatedAppleId),
    ["11"]
  );
  assert.deepEqual(
    bRows.map((r) => r.relatedAppleId),
    ["22"]
  );
});

test("null developer / icon survive round-trip", () => {
  seedTrackedApp({ id: "source-1" });
  replaceRelatedAppsForSource("source-1", [
    input("11", "may_also_like", {
      relatedDeveloper: null,
      relatedIconUrl: null,
    }),
  ]);

  const [row] = getMayAlsoLike("source-1");
  assert.equal(row.relatedDeveloper, null);
  assert.equal(row.relatedIconUrl, null);
  // Required fields stay populated.
  assert.equal(row.relatedAppleId, "11");
  assert.ok(row.relatedStoreUrl.includes("id11"));
});

test("deleting the source app cascades — related rows go too", async () => {
  seedTrackedApp({ id: "source-1" });
  replaceRelatedAppsForSource("source-1", [
    input("11", "may_also_like"),
    input("22", "more_by_developer"),
  ]);
  assert.equal(getMayAlsoLike("source-1").length, 1);

  // Untrack the source app — FK ON DELETE CASCADE should wipe the
  // related rows. Lazy import so test-db's reset doesn't import the
  // related module before db.ts is initialised.
  const db = (await import("../../lib/db")).default;
  db.prepare("DELETE FROM apps WHERE id = ?").run("source-1");

  assert.equal(getMayAlsoLike("source-1").length, 0);
  assert.equal(getMoreByDeveloper("source-1").length, 0);
});

test("purgeAllRelatedApps wipes every row", () => {
  seedTrackedApp({ id: "source-1" });
  seedTrackedApp({ id: "source-2" });
  replaceRelatedAppsForSource("source-1", [input("11", "may_also_like")]);
  replaceRelatedAppsForSource("source-2", [input("22", "may_also_like")]);

  const changes = purgeAllRelatedApps();
  assert.equal(changes, 2);
  assert.equal(getMayAlsoLike("source-1").length, 0);
  assert.equal(getMayAlsoLike("source-2").length, 0);
});
