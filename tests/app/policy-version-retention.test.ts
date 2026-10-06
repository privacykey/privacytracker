import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import {
  getCurrentPolicyVersion,
  POLICY_VERSION_KEEP_CHARS,
  POLICY_VERSION_KEEP_COUNT,
  upsertPolicyVersion,
} from "../../lib/policy-versions";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

test.beforeEach(() => {
  resetTestDb();
});

function storeVersion(appId: string, index: number, text: string): string {
  return upsertPolicyVersion({
    appId,
    contentHash: `hash-${appId}-${index}`,
    fetchedAt: 1_700_000_000_000 + index * 60_000,
    policyUrl: "https://example.com/privacy",
    sourceFinalUrl: null,
    sourceTitle: null,
    sourceContentType: "text/plain",
    sourceOrigin: "direct",
    sourceWordCount: 3,
    sourceText: text,
  });
}

function versionIds(appId: string): string[] {
  return (
    db
      .prepare(
        "SELECT id FROM privacy_policy_versions WHERE app_id = ? ORDER BY first_fetched_at ASC"
      )
      .all(appId) as Array<{ id: string }>
  ).map((row) => row.id);
}

test("an app keeps its newest versions by count", () => {
  seedTrackedApp({ id: "count-app" });
  const ids: string[] = [];
  for (let i = 0; i < POLICY_VERSION_KEEP_COUNT + 5; i += 1) {
    ids.push(storeVersion("count-app", i, `policy text ${i}`));
  }
  const kept = versionIds("count-app");
  assert.equal(kept.length, POLICY_VERSION_KEEP_COUNT);
  assert.deepEqual(kept, ids.slice(5));
  assert.equal(getCurrentPolicyVersion("count-app")?.id, ids.at(-1));
});

test("an app keeps its newest versions by size, and the newest whatever its size", () => {
  seedTrackedApp({ id: "size-app" });
  const third = Math.ceil(POLICY_VERSION_KEEP_CHARS / 3) + 1;
  const first = storeVersion("size-app", 0, "a".repeat(third));
  const second = storeVersion("size-app", 1, "b".repeat(third));
  assert.deepEqual(versionIds("size-app"), [first, second]);
  // Three thirds and a little over the bound: the oldest goes.
  const newest = storeVersion("size-app", 2, "c".repeat(third));
  assert.deepEqual(versionIds("size-app"), [second, newest]);
  // A single version past the bound on its own is still kept.
  const huge = storeVersion(
    "size-app",
    3,
    "d".repeat(POLICY_VERSION_KEEP_CHARS + 10)
  );
  assert.deepEqual(versionIds("size-app"), [huge]);
});

test("a rescrape of the same text touches its row and prunes nothing", () => {
  seedTrackedApp({ id: "same-app" });
  const id = storeVersion("same-app", 0, "the same text");
  const again = upsertPolicyVersion({
    appId: "same-app",
    contentHash: "hash-same-app-0",
    fetchedAt: 1_700_000_900_000,
    policyUrl: "https://example.com/privacy",
    sourceFinalUrl: null,
    sourceTitle: null,
    sourceContentType: "text/plain",
    sourceOrigin: "direct",
    sourceWordCount: 3,
    sourceText: "the same text",
  });
  assert.equal(again, id);
  assert.deepEqual(versionIds("same-app"), [id]);
  assert.equal(
    getCurrentPolicyVersion("same-app")?.last_fetched_at,
    1_700_000_900_000
  );
});

test("retention is per app", () => {
  seedTrackedApp({ id: "app-a" });
  seedTrackedApp({ id: "app-b" });
  for (let i = 0; i < POLICY_VERSION_KEEP_COUNT; i += 1) {
    storeVersion("app-a", i, `a ${i}`);
  }
  storeVersion("app-b", 0, "b 0");
  storeVersion("app-a", POLICY_VERSION_KEEP_COUNT, "a newest");
  assert.equal(versionIds("app-a").length, POLICY_VERSION_KEEP_COUNT);
  assert.equal(versionIds("app-b").length, 1);
});
