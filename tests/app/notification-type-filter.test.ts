/**
 * `classifyChange` in lib/notifications.ts maps each `change_summary`
 * entry onto one of the four `flag.notifications.types.*` flags, and
 * `getNotifications` / `getUnreadCount` drop a row whose entries are all
 * filtered out. Two contracts are pinned here:
 *
 * 1. Which of the two `type: 'added'` shapes `diffSnapshots` emits is a
 *    NEW PRIVACY TYPE and which is a new category on an existing type.
 *    The fixtures are built by calling `diffSnapshots` rather than by
 *    hand, so the test fails if the producer's shape ever moves.
 * 2. System notices (the synthetic writers in lib/notifications.ts) are
 *    not privacy-label diffs at all, so none of the four flags governs
 *    them and all four being off must not remove them from the bell.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshots } from "../../lib/changelog";
import type { PrivacyTypeSnapshot } from "../../lib/changelog-types";
import db from "../../lib/db";
import type { FlagKey } from "../../lib/feature-flag-rules";
import { setOverride } from "../../lib/feature-flag-storage";
import {
  createAiTimeoutNotification,
  createImportCompletionNotification,
  createManualAppsPromptNotification,
  createParserFallthroughNotification,
  createPolicyResumeNotification,
  createProfileMismatchNotification,
  createSyncResumeNotification,
  createVersionUpdateNotification,
  createWaybackResumeNotification,
  getNotifications,
  getUnreadCount,
} from "../../lib/notifications";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

test.beforeEach(resetTestDb);

const TYPE_FLAGS = {
  label_changes: "flag.notifications.types.label_changes",
  policy_updates: "flag.notifications.types.policy_updates",
  accessibility_changes: "flag.notifications.types.accessibility_changes",
  new_privacy_types: "flag.notifications.types.new_privacy_types",
} as const satisfies Record<string, FlagKey>;

type TypeKey = keyof typeof TYPE_FLAGS;

/** Set all four type flags, then turn the named ones back on. */
function onlyTypesEnabled(...enabled: TypeKey[]): void {
  for (const [key, flag] of Object.entries(TYPE_FLAGS) as [
    TypeKey,
    FlagKey,
  ][]) {
    setOverride(flag, enabled.includes(key) ? "on" : "off");
  }
}

function seedNotification(changes: unknown[], id = "n1"): void {
  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, '123', 'Fixture App', ?, ?, 0)
  `).run(id, JSON.stringify(changes), Date.now());
}

const snapshot = (
  identifier: string,
  title: string,
  categories: [string, string][]
): PrivacyTypeSnapshot => ({
  identifier,
  title,
  categories: categories.map(([id, catTitle]) => ({
    identifier: id,
    title: catTitle,
  })),
});

const TRACK_YOU = snapshot("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
  ["LOCATION", "Location"],
]);
const LINKED_EMPTY = snapshot("DATA_LINKED_TO_YOU", "Data Linked to You", []);
const LINKED_ONE = snapshot("DATA_LINKED_TO_YOU", "Data Linked to You", [
  ["LOCATION", "Location"],
]);

/** `diffSnapshots` output for a privacy type that did not exist before. */
const WHOLE_NEW_TYPE = diffSnapshots([], [TRACK_YOU]);
/** `diffSnapshots` output for a category added to a type already present. */
const NEW_CATEGORY_ON_EXISTING_TYPE = diffSnapshots(
  [LINKED_EMPTY],
  [LINKED_ONE]
);
/** A new privacy type that arrives carrying no categories yet. */
const WHOLE_NEW_EMPTY_TYPE = diffSnapshots([], [LINKED_EMPTY]);

test("the two `added` shapes under test are the ones diffSnapshots emits", () => {
  // Guards the rest of the file: if these shapes move, the classification
  // tests below are asserting against something the app never produces.
  assert.deepEqual(WHOLE_NEW_TYPE, [
    {
      type: "added",
      description: 'New privacy label: "Data Used to Track You"',
      details: ["Location"],
    },
  ]);
  assert.deepEqual(NEW_CATEGORY_ON_EXISTING_TYPE, [
    {
      type: "added",
      description: '"Data Linked to You" now collects: Location',
    },
  ]);
  assert.equal(WHOLE_NEW_EMPTY_TYPE[0]?.details?.length, 0);
});

test("a whole-new privacy type is governed by new_privacy_types", () => {
  seedNotification(WHOLE_NEW_TYPE);

  onlyTypesEnabled("new_privacy_types");
  assert.equal(getNotifications().length, 1, "kept when new_privacy_types on");
  assert.equal(getUnreadCount(), 1);

  onlyTypesEnabled("label_changes", "policy_updates", "accessibility_changes");
  assert.equal(
    getNotifications().length,
    0,
    "dropped when new_privacy_types off"
  );
  assert.equal(getUnreadCount(), 0);
});

test("a new privacy type carrying no categories is also new_privacy_types", () => {
  seedNotification(WHOLE_NEW_EMPTY_TYPE);

  onlyTypesEnabled("new_privacy_types");
  assert.equal(getNotifications().length, 1);

  onlyTypesEnabled("label_changes");
  assert.equal(getNotifications().length, 0);
});

test("a category added to an existing type is governed by label_changes", () => {
  seedNotification(NEW_CATEGORY_ON_EXISTING_TYPE);

  onlyTypesEnabled("label_changes");
  assert.equal(getNotifications().length, 1, "kept when label_changes on");
  assert.equal(getUnreadCount(), 1);

  onlyTypesEnabled("new_privacy_types");
  assert.equal(getNotifications().length, 0, "dropped when label_changes off");
  assert.equal(getUnreadCount(), 0);
});

test("a mixed row keeps only the entries whose flag is on", () => {
  seedNotification([...WHOLE_NEW_TYPE, ...NEW_CATEGORY_ON_EXISTING_TYPE]);

  onlyTypesEnabled("new_privacy_types");
  const [row] = getNotifications();
  assert.deepEqual(row.change_summary, WHOLE_NEW_TYPE);

  onlyTypesEnabled("label_changes");
  const [labelRow] = getNotifications();
  assert.deepEqual(labelRow.change_summary, NEW_CATEGORY_ON_EXISTING_TYPE);
});

test("removed and modified entries stay label changes", () => {
  seedNotification(diffSnapshots([TRACK_YOU], []), "removed");
  seedNotification(
    [
      {
        type: "modified",
        description: "Age rating changed",
        category: "age-rating",
      },
    ],
    "modified"
  );

  onlyTypesEnabled("label_changes");
  assert.equal(getNotifications().length, 2);

  onlyTypesEnabled("new_privacy_types");
  assert.equal(getNotifications().length, 0);
});

test("policy and accessibility entries keep their own flags", () => {
  seedNotification(
    [
      {
        type: "policy",
        category: "privacy-policy",
        description: "Policy changed",
      },
    ],
    "policy"
  );
  seedNotification(
    [
      {
        type: "added",
        category: "accessibility",
        description: "VoiceOver added",
      },
    ],
    "a11y"
  );

  onlyTypesEnabled("policy_updates");
  assert.deepEqual(
    getNotifications().map((n) => n.id),
    ["policy"]
  );

  onlyTypesEnabled("accessibility_changes");
  assert.deepEqual(
    getNotifications().map((n) => n.id),
    ["a11y"]
  );
});

/**
 * Every synthetic writer, driven through its real entry point so the
 * stored `type` tag is whatever the writer actually emits rather than a
 * transcription of it. None of these is a privacy-label diff, so all
 * four type flags being off must leave every one of them in the bell.
 */
function writeEverySystemNotice(): number {
  seedTrackedApp({ id: "123", name: "Fixture App" });

  createAiTimeoutNotification({
    appId: "123",
    phase: "direct",
    timeoutMs: 60_000,
    observedMs: 61_000,
    appName: "Fixture App",
  });
  createManualAppsPromptNotification({
    unmatchedCount: 3,
    sourceLabel: "ios.csv",
  });
  createImportCompletionNotification({
    importId: "imp-1",
    itemCount: 5,
    imported: 4,
    errored: 1,
    queued: 0,
    unmatched: 0,
    total: 5,
    status: "partial",
    sourceLabel: "ios.csv",
  });
  createProfileMismatchNotification({
    appId: "123",
    appName: "Fixture App",
    newMismatches: [
      {
        category: "LOCATION",
        observed: "tracking",
        allowed: "not_collected",
        severityGap: 3,
      },
    ],
  });
  createVersionUpdateNotification({
    appId: "123",
    appName: "Fixture App",
    previousVersion: "1.0",
    currentVersion: "2.0",
    previousVersionUpdatedAt: null,
    currentVersionUpdatedAt: null,
  });
  createWaybackResumeNotification({ appsRemaining: 2, totalApps: 5 });
  createWaybackResumeNotification({
    appsRemaining: 0,
    totalApps: 0,
    staleHealed: true,
  });
  createSyncResumeNotification({ appsRemaining: 2, totalApps: 5 });
  createSyncResumeNotification({
    appsRemaining: 0,
    totalApps: 0,
    staleHealed: true,
  });
  createPolicyResumeNotification({ appsRemaining: 2, totalApps: 5 });
  createPolicyResumeNotification({
    appsRemaining: 0,
    totalApps: 0,
    staleHealed: true,
  });
  createParserFallthroughNotification({
    appsAffected: 2,
    appName: "Fixture App",
  });

  return (
    db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }
  ).n;
}

test("system notices survive with every type flag off", () => {
  const written = writeEverySystemNotice();
  assert.ok(
    written >= 12,
    `expected every synthetic writer to insert, got ${written}`
  );

  onlyTypesEnabled();
  assert.equal(
    getNotifications(50).length,
    written,
    "no system notice may be filtered by the privacy-label type flags"
  );
  assert.equal(getUnreadCount(), written);
});

test("system notices keep their entries intact when filtered", () => {
  createParserFallthroughNotification({ appsAffected: 1, appName: null });

  onlyTypesEnabled();
  const [row] = getNotifications();
  assert.equal(row.change_summary.length, 1);
  assert.equal(
    (row.change_summary[0] as { type: string }).type,
    "parser_fallthrough"
  );
});

test("a genuinely empty change_summary still passes through", () => {
  seedNotification([]);

  onlyTypesEnabled();
  assert.equal(getNotifications().length, 1);
  assert.equal(getUnreadCount(), 1);
});
