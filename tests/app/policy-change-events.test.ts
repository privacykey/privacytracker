/**
 * Pin what a privacy-policy fetch may and may not count as a change.
 *
 * Every fetch leaves a row on the app's History timeline, but only a real
 * change to the policy text may be flagged for review
 * (`privacy_snapshots.changes_detected = 1`, which drives the grid's
 * pending dot, the review panel, triage and the universal changelog) or
 * raise a bell notification (which is also what the webhooks read), and
 * only while `flag.notifications.types.policy_updates` is on. The flag is
 * off by default, so a fresh install notifies on label changes only.
 *
 * Also pins the hash rule an unusable scrape must respect: the rejected
 * body's hash must not replace the last good one, or the next good scrape
 * of identical text reads as "changed", and the rejected body must never
 * be seeded into the version history.
 *
 * The pipeline is driven end to end through `syncPrivacyPolicyAnalysis`
 * with `global.fetch` stubbed, the same way
 * tests/app/policy-scrape-disabled.test.ts does.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeEntry } from "../../lib/changelog";
import db from "../../lib/db";
import { HARD_DEFAULTS } from "../../lib/feature-flag-rules";
import { clearOverride, setOverride } from "../../lib/feature-flag-storage";
import { getUnreadCount } from "../../lib/notifications";
import { syncPrivacyPolicyAnalysis } from "../../lib/privacy-policy";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const APP_ID = "policy-events-app";
const APP_NAME = "Policy Events Fixture";
const POLICY_URL = "https://example.com/privacy-events-test";
const POLICY_FLAG = "flag.notifications.types.policy_updates";

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

/**
 * A body long enough to pass the too-short gate (400 words, 2,000 chars,
 * one topic-keyword group) whose text differs per `version`.
 */
function policyText(version: string): string {
  return Array.from(
    { length: 60 },
    (_, i) =>
      `Section ${i + 1} (${version}). We collect personal data such as your email address and device identifiers, share it with third parties for advertising and marketing, retain it for as long as your account exists, and you may request deletion at any time.`
  ).join(" ");
}

type Reply = { kind: "text"; body: string } | { kind: "throw" };

/**
 * Serve `reply` for the policy URL. Anything else (the Wayback lookups the
 * fetch path makes best-effort after a good scrape) gets a 404 so the run
 * neither hits the network nor fails on it.
 */
function stubFetch(reply: Reply): void {
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === POLICY_URL) {
      if (reply.kind === "throw") {
        throw new Error("ECONNRESET while fetching privacy policy");
      }
      return new Response(reply.body, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

async function sync(): Promise<void> {
  await syncPrivacyPolicyAnalysis({
    appId: APP_ID,
    appName: APP_NAME,
    policyUrl: POLICY_URL,
  });
}

interface TimelineRow {
  changesDetected: number;
  entry: ChangeEntry;
}

/** Policy rows on the timeline in write order. */
function timeline(): TimelineRow[] {
  const rows = db
    .prepare(
      "SELECT changes_detected, changes_summary FROM privacy_snapshots WHERE app_id = ? ORDER BY rowid"
    )
    .all(APP_ID) as Array<{
    changes_detected: number;
    changes_summary: string;
  }>;
  return rows.map((row) => {
    const entries = JSON.parse(row.changes_summary) as ChangeEntry[];
    assert.equal(entries.length, 1);
    return { changesDetected: row.changes_detected, entry: entries[0] };
  });
}

function notifications(): Array<{ app_name: string; entries: ChangeEntry[] }> {
  return (
    db
      .prepare("SELECT app_name, change_summary FROM notifications")
      .all() as Array<{ app_name: string; change_summary: string }>
  ).map((row) => ({
    app_name: row.app_name,
    entries: JSON.parse(row.change_summary) as ChangeEntry[],
  }));
}

function analysisRow(): {
  content_hash: string | null;
  source_text: string | null;
  status: string;
} {
  const row = db
    .prepare(
      "SELECT content_hash, source_text, status FROM privacy_policy_analyses WHERE app_id = ?"
    )
    .get(APP_ID) as
    | {
        content_hash: string | null;
        source_text: string | null;
        status: string;
      }
    | undefined;
  assert.ok(row, "analysis row exists");
  return row;
}

function versionHashes(): string[] {
  return (
    db
      .prepare(
        "SELECT content_hash FROM privacy_policy_versions WHERE app_id = ? ORDER BY first_fetched_at"
      )
      .all(APP_ID) as Array<{ content_hash: string }>
  ).map((row) => row.content_hash);
}

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  seedTrackedApp({ id: APP_ID, name: APP_NAME, privacyPolicyUrl: POLICY_URL });
  setSetting("ai_provider", "disabled");
  setSetting("policy_scrape_throttle_enabled", "false");
});

test.afterEach(() => {
  clearOverride(POLICY_FLAG);
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

test("policy updates are off by default on the flag side too", () => {
  assert.equal(HARD_DEFAULTS[POLICY_FLAG], "off");
  assert.equal(HARD_DEFAULTS["flag.notifications.types.label_changes"], "on");
});

test("the first capture and an unchanged rescrape are timeline rows, not changes", async () => {
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  await sync();

  const rows = timeline();
  assert.deepEqual(
    rows.map((r) => [r.entry.policy_event, r.changesDetected]),
    [
      ["first", 0],
      ["same", 0],
    ]
  );
  assert.deepEqual(notifications(), []);
  assert.equal(getUnreadCount(), 0);
});

test("a text change with the toggle off is recorded with its diff but neither flagged nor notified", async () => {
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  stubFetch({ kind: "text", body: policyText("v2") });
  await sync();

  const rows = timeline();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].entry.policy_event, "changed");
  assert.equal(rows[1].changesDetected, 0);
  // Still diffable from the History timeline: both versions are stored and
  // the row points at the new one.
  assert.equal(versionHashes().length, 2);
  assert.ok(rows[1].entry.policy_version_id);
  assert.deepEqual(notifications(), []);
});

test("a text change with the toggle on is flagged for review and raises one bell notification", async () => {
  setOverride(POLICY_FLAG, "on");
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  // The toggle does not make the first capture a change.
  assert.deepEqual(
    timeline().map((r) => [r.entry.policy_event, r.changesDetected]),
    [["first", 0]]
  );
  assert.deepEqual(notifications(), []);

  stubFetch({ kind: "text", body: policyText("v2") });
  await sync();

  const rows = timeline();
  assert.deepEqual(
    rows.map((r) => [r.entry.policy_event, r.changesDetected]),
    [
      ["first", 0],
      ["changed", 1],
    ]
  );
  const rowsNotified = notifications();
  assert.equal(rowsNotified.length, 1);
  assert.equal(rowsNotified[0].app_name, APP_NAME);
  assert.equal(rowsNotified[0].entries.length, 1);
  assert.equal(rowsNotified[0].entries[0].category, "privacy-policy");
  assert.equal(rowsNotified[0].entries[0].policy_event, "changed");
  assert.equal(getUnreadCount(), 1);

  // Turning the toggle off afterwards hides the row from the bell too: the
  // read-side type filter and the write-side gate agree.
  clearOverride(POLICY_FLAG);
  assert.equal(getUnreadCount(), 0);
});

test("an unusable scrape is not a change and keeps the last good hash, text and versions", async () => {
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  const good = analysisRow();
  assert.equal(good.status, "needs_ai_config");
  assert.ok(good.content_hash);

  stubFetch({ kind: "text", body: "Loading your privacy policy..." });
  await sync();

  const rows = timeline();
  assert.deepEqual(
    rows.map((r) => [r.entry.policy_event, r.changesDetected]),
    [
      ["first", 0],
      ["error", 0],
    ]
  );
  const rejected = analysisRow();
  assert.equal(rejected.status, "too_short");
  assert.equal(rejected.content_hash, good.content_hash);
  assert.equal(rejected.source_text, good.source_text);
  assert.deepEqual(versionHashes(), [good.content_hash]);

  // The next good scrape of the same text is a rescrape, not a change.
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  const after = timeline();
  assert.equal(after.length, 3);
  assert.equal(after[2].entry.policy_event, "same");
  assert.equal(after[2].changesDetected, 0);
  assert.deepEqual(versionHashes(), [good.content_hash]);
  assert.deepEqual(notifications(), []);
});

test("a failed fetch is not a change even with the toggle on", async () => {
  setOverride(POLICY_FLAG, "on");
  stubFetch({ kind: "text", body: policyText("v1") });
  await sync();
  const good = analysisRow();

  stubFetch({ kind: "throw" });
  await sync();

  const rows = timeline();
  assert.deepEqual(
    rows.map((r) => [r.entry.policy_event, r.changesDetected]),
    [
      ["first", 0],
      ["error", 0],
    ]
  );
  const failed = analysisRow();
  assert.equal(failed.status, "fetch_error");
  assert.equal(failed.content_hash, good.content_hash);
  assert.deepEqual(notifications(), []);
});
