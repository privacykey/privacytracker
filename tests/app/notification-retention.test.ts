import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeEntry } from "../../lib/changelog-types";
import db from "../../lib/db";
import {
  createNotification,
  getNotifications,
  getUnreadCount,
  NOTIFICATION_RETENTION,
} from "../../lib/notifications";
import { resetTestDb } from "../helpers/test-db";

test.beforeEach(resetTestDb);

const FIXTURE_CHANGE: ChangeEntry = {
  type: "modified",
  description: "Data Used to Track You changed",
  details: ["Identifiers"],
};

function seedNotifications(input: {
  count: number;
  idPrefix: string;
  read: 0 | 1;
  startAt: number;
}): void {
  const insert = db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, '123', 'Fixture App', ?, ?, ?)
  `);
  const summary = JSON.stringify([FIXTURE_CHANGE]);
  db.transaction(() => {
    for (let i = 0; i < input.count; i++) {
      insert.run(
        `${input.idPrefix}-${i}`,
        summary,
        input.startAt + i,
        input.read
      );
    }
  })();
}

function countRows(where = "1=1"): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`)
      .get() as { n: number }
  ).n;
}

test("bell-query indexes exist and the planner uses them", () => {
  const indexNames = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notifications'"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(indexNames.includes("idx_notifications_created"));
  assert.ok(indexNames.includes("idx_notifications_unread"));

  seedNotifications({ count: 50, idPrefix: "plan", read: 1, startAt: 1000 });

  // Mirrors the getNotifications query — the ORDER BY must walk the
  // created_at index instead of full-scanning and sorting.
  const listPlan = (
    db
      .prepare(`
    EXPLAIN QUERY PLAN
    SELECT n.id, n.app_id, n.app_name, n.change_summary, n.created_at, n.read,
           n.stale, a.iconUrl
    FROM notifications n
    LEFT JOIN apps a ON a.id = n.app_id
    WHERE n.not_before IS NULL OR n.not_before <= ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `)
      .all(Date.now(), 30) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(" | ");
  assert.match(listPlan, /idx_notifications_created/);

  // Mirrors the getUnreadCount fast path — must be answered from the
  // (read, not_before) index without touching the table.
  const countPlan = (
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) as c FROM notifications WHERE read = 0 AND (not_before IS NULL OR not_before <= ?)"
      )
      .all(Date.now()) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(" | ");
  assert.match(countPlan, /COVERING INDEX idx_notifications_unread/);
});

test("insert past the cap prunes the oldest read rows", () => {
  seedNotifications({
    count: NOTIFICATION_RETENTION,
    idPrefix: "read",
    read: 1,
    startAt: 1_000_000,
  });

  createNotification("123", "Fixture App", [FIXTURE_CHANGE]);

  assert.equal(countRows(), NOTIFICATION_RETENTION);
  // Oldest read row was pruned; the fresh unread row survived.
  assert.equal(countRows("id = 'read-0'"), 0);
  assert.equal(countRows("id = 'read-1'"), 1);
  assert.equal(getUnreadCount(), 1);
  assert.equal(getNotifications(5)[0].app_name, "Fixture App");
});

test("unread rows are never pruned, even over the cap", () => {
  seedNotifications({
    count: NOTIFICATION_RETENTION + 50,
    idPrefix: "unread",
    read: 0,
    startAt: 1_000_000,
  });

  createNotification("123", "Fixture App", [FIXTURE_CHANGE]);

  assert.equal(countRows(), NOTIFICATION_RETENTION + 51);
  assert.equal(countRows("id = 'unread-0'"), 1);
});

test("prune takes only read rows when overflow exceeds the read count", () => {
  // 100 old read rows + a full cap of newer unread rows. The insert puts
  // the table 101 over, but only the 100 read rows are eligible.
  seedNotifications({ count: 100, idPrefix: "read", read: 1, startAt: 0 });
  seedNotifications({
    count: NOTIFICATION_RETENTION,
    idPrefix: "unread",
    read: 0,
    startAt: 1_000_000,
  });

  createNotification("123", "Fixture App", [FIXTURE_CHANGE]);

  assert.equal(countRows("read = 1"), 0);
  assert.equal(countRows(), NOTIFICATION_RETENTION + 1);
  assert.equal(countRows("id LIKE 'unread-%'"), NOTIFICATION_RETENTION);
});
