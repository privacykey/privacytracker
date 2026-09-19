/**
 * Pin how /api/notification-prefs maps its two clients onto the four
 * `flag.notifications.types.*` flags.
 *
 * The route stores four notification types as flag overrides, keyed
 * `label_changes`, `policy_updates`, `accessibility_changes` and
 * `new_privacy_types`. Its two clients, the Settings "Notifications"
 * section and the bell, speak the seven camelCase `NotificationTypeKey`s
 * from lib/notification-prefs.ts and read the response through
 * `resolvePrefs`, which only looks at camelCase keys.
 *
 * When the route spoke only snake_case, both clients always saw the
 * defaults: the "Privacy policy updates" checkbox read unticked however the
 * flag was set, the bell hid policy notifications even with the flag on,
 * and every Settings save cleared all four overrides because none of its
 * keys matched. Once it read the camelCase keys, a save still cleared the
 * two flags Settings has no checkbox for, and pinned the other two even at
 * their defaults.
 *
 * The contract now: a body changes only the flags whose value it changes.
 * A flag it leaves out, or sends at the value the flag already has, is not
 * written. A change that lands on the flag's focus default clears its
 * override, and any other change sets one. These cases drive the real
 * handlers the way those two clients do.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { GET, PUT } from "../../app/api/notification-prefs/route";
import { GET as listNotifications } from "../../app/api/notifications/route";
import type { ChangeEntry } from "../../lib/changelog-types";
import db from "../../lib/db";
import type { FlagKey } from "../../lib/feature-flag-rules";
import { setOverride } from "../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../lib/feature-flags-server";
import {
  classifyNotificationType,
  DEFAULT_NOTIFICATION_PREFS,
  filterNotificationsByPrefs,
  NOTIFICATION_TYPE_KEYS,
  type NotificationPrefs,
  type NotificationTypeKey,
  resolvePrefs,
} from "../../lib/notification-prefs";
import { createNotification } from "../../lib/notifications";
import { getSetting, setSetting } from "../../lib/scheduler";

const FLAGS = {
  label_changes: "flag.notifications.types.label_changes",
  policy_updates: "flag.notifications.types.policy_updates",
  accessibility_changes: "flag.notifications.types.accessibility_changes",
  new_privacy_types: "flag.notifications.types.new_privacy_types",
} as const satisfies Record<string, FlagKey>;

interface PrefsBody {
  defaults: Record<string, boolean>;
  prefs: Record<string, boolean>;
  stored: Record<string, boolean>;
}

function overrideOf(flag: FlagKey): string | null {
  const row = db
    .prepare(
      "SELECT override_value FROM feature_flag_overrides WHERE flag_key = ?"
    )
    .get(flag) as { override_value: string } | undefined;
  return row?.override_value ?? null;
}

async function put(prefs: unknown): Promise<PrefsBody> {
  const res = await PUT(
    new Request("http://127.0.0.1/api/notification-prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefs }),
    })
  );
  assert.equal(res.status, 200);
  return (await res.json()) as PrefsBody;
}

async function get(): Promise<PrefsBody> {
  const res = await GET();
  assert.equal(res.status, 200);
  return (await res.json()) as PrefsBody;
}

/**
 * Save the way SettingsView does: load the prefs, resolve them to the seven
 * checkboxes, apply what the user clicked and PUT the whole map.
 */
async function settingsSave(
  clicked: Partial<Record<NotificationTypeKey, boolean>>
): Promise<PrefsBody> {
  const shown = resolvePrefs((await get()).prefs as NotificationPrefs);
  return put({ ...shown, ...clicked });
}

beforeEach(() => {
  // A plain `self` focus with no goals, so every notification flag
  // resolves to its hard default unless a case sets an override.
  setSetting("flag.focus.audience", "self");
  for (const goal of ["monitor", "cleanup", "minimal", "accessibility"]) {
    setSetting(`flag.focus.goal.${goal}`, "false");
  }
  db.prepare(
    "DELETE FROM feature_flag_overrides WHERE flag_key LIKE 'flag.notifications.types.%'"
  ).run();
  setSetting("notification_prefs", "");
  db.prepare("DELETE FROM notifications").run();
});

test("GET speaks both key sets, flag keys first, in a fixed order", async () => {
  const body = await get();
  assert.deepEqual(Object.keys(body.prefs), [
    ...Object.keys(FLAGS),
    ...NOTIFICATION_TYPE_KEYS,
  ]);
  assert.deepEqual(body.stored, body.prefs);
  assert.deepEqual(body.defaults, DEFAULT_NOTIFICATION_PREFS);
  // Nothing set: the camelCase half is exactly the defaults, and the two
  // aliased types agree with their flags.
  assert.deepEqual(resolvePrefs(body.prefs), DEFAULT_NOTIFICATION_PREFS);
  assert.equal(body.prefs.policyUpdates, false);
  assert.equal(body.prefs.policy_updates, false);
  assert.equal(body.prefs.labelChanges, body.prefs.label_changes);
});

test("a camelCase PUT turns policy updates on and GET reads it back", async () => {
  const saved = await put({ policyUpdates: true });
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(saved.prefs.policyUpdates, true);
  assert.equal(saved.prefs.policy_updates, true);

  const body = await get();
  assert.equal(body.prefs.policyUpdates, true);
  assert.equal(body.prefs.policy_updates, true);
  assert.equal(resolvePrefs(body.prefs).policyUpdates, true);
});

test("a Settings save that ticks policy updates turns the flag on, and the checkbox stays ticked", async () => {
  const clicked = {
    policyUpdates: true,
    versionUpdates: false,
    aiTimeout: false,
  };
  const saved = await settingsSave(clicked);
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(resolveFlagFromDb(FLAGS.policy_updates), "on");
  // Label changes rode along at the value it already had: not pinned.
  assert.equal(overrideOf(FLAGS.label_changes), null);
  // What Settings renders after the save response, and on the next load.
  const expected = { ...DEFAULT_NOTIFICATION_PREFS, ...clicked };
  assert.deepEqual(resolvePrefs(saved.prefs), expected);
  assert.deepEqual(resolvePrefs((await get()).prefs), expected);

  // Unticking label changes in the same section turns that flag off and
  // leaves the policy flag as the first save set it.
  const second = await settingsSave({ labelChanges: false });
  assert.equal(overrideOf(FLAGS.label_changes), "off");
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(second.prefs.label_changes, false);
  assert.deepEqual(resolvePrefs((await get()).prefs), {
    ...expected,
    labelChanges: false,
  });
});

test("a Settings save leaves every override it did not change", async () => {
  // Set elsewhere (Developer Options, the v1 migration). Settings has no
  // checkbox for the first two, and the third pins label changes at the
  // value it has by default.
  setOverride(FLAGS.accessibility_changes, "on");
  setOverride(FLAGS.new_privacy_types, "off");
  setOverride(FLAGS.label_changes, "on");

  // The user unticks "App version updates".
  const saved = await settingsSave({ versionUpdates: false });
  assert.equal(overrideOf(FLAGS.accessibility_changes), "on");
  assert.equal(overrideOf(FLAGS.new_privacy_types), "off");
  assert.equal(overrideOf(FLAGS.label_changes), "on");
  assert.equal(overrideOf(FLAGS.policy_updates), null);
  assert.equal(saved.prefs.accessibility_changes, true);
  assert.equal(saved.prefs.new_privacy_types, false);
  assert.equal(resolvePrefs(saved.prefs).versionUpdates, false);
});

test("a change back to the focus default clears the override instead of pinning it", async () => {
  await settingsSave({ policyUpdates: true, labelChanges: false });
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(overrideOf(FLAGS.label_changes), "off");

  // What "Reset defaults" sends.
  const reset = await put({ ...DEFAULT_NOTIFICATION_PREFS });
  assert.equal(overrideOf(FLAGS.policy_updates), null);
  assert.equal(overrideOf(FLAGS.label_changes), null);
  assert.deepEqual(resolvePrefs(reset.prefs), DEFAULT_NOTIFICATION_PREFS);
});

test("the default a change is compared with comes from the focus, not the hard default", async () => {
  // The accessibility goal turns accessibility change notifications on,
  // over a hard default of off.
  setSetting("flag.focus.goal.accessibility", "true");
  await put({ accessibility_changes: false });
  assert.equal(overrideOf(FLAGS.accessibility_changes), "off");
  await put({ accessibility_changes: true });
  assert.equal(overrideOf(FLAGS.accessibility_changes), null);
  assert.equal(resolveFlagFromDb(FLAGS.accessibility_changes), "on");

  // Without the goal the same value is off the default, so it is pinned.
  setSetting("flag.focus.goal.accessibility", "false");
  await put({ accessibility_changes: true });
  assert.equal(overrideOf(FLAGS.accessibility_changes), "on");
});

test("snake_case wins over camelCase when a body carries both", async () => {
  setOverride(FLAGS.policy_updates, "on");
  setOverride(FLAGS.label_changes, "off");
  const saved = await put({
    policy_updates: false,
    policyUpdates: true,
    labelChanges: false,
    label_changes: true,
  });
  // Each snake_case value turns its flag back to the default, so both
  // overrides go. Had the camelCase values won, neither flag would move.
  assert.equal(overrideOf(FLAGS.policy_updates), null);
  assert.equal(overrideOf(FLAGS.label_changes), null);
  assert.equal(saved.prefs.policyUpdates, false);
  assert.equal(saved.prefs.labelChanges, true);
  const body = await get();
  assert.equal(body.prefs.policyUpdates, false);
  assert.equal(body.prefs.labelChanges, true);
});

test("a value that is not a boolean counts as absent", async () => {
  setOverride(FLAGS.policy_updates, "on");
  setOverride(FLAGS.label_changes, "off");
  await put({ policyUpdates: "true", labelChanges: null, policy_updates: 1 });
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(overrideOf(FLAGS.label_changes), "off");
});

test("a sparse PUT keeps the stored types it leaves out", async () => {
  setSetting(
    "notification_prefs",
    '{"versionUpdates":false,"aiTimeout":false}'
  );
  await put({ policyUpdates: true, aiTimeout: true });
  assert.deepEqual(JSON.parse(getSetting("notification_prefs", "")), {
    versionUpdates: false,
    aiTimeout: true,
    policyUpdates: true,
  });
  const shown = resolvePrefs((await get()).prefs);
  assert.equal(shown.versionUpdates, false);
  assert.equal(shown.aiTimeout, true);
  assert.equal(shown.policyUpdates, true);
});

test("when the resolver fails, each value the body carries is set as an override", async () => {
  setOverride(FLAGS.new_privacy_types, "off");
  // An audience the rule tables do not know makes the resolver throw.
  setSetting("flag.focus.audience", "garbage");
  const saved = await put({ labelChanges: true, policyUpdates: false });
  assert.equal(overrideOf(FLAGS.label_changes), "on");
  assert.equal(overrideOf(FLAGS.policy_updates), "off");
  assert.equal(overrideOf(FLAGS.new_privacy_types), "off");
  assert.equal(overrideOf(FLAGS.accessibility_changes), null);
  // The response falls back to the stored blob, camelCase keys only.
  assert.deepEqual(saved.prefs, { labelChanges: true, policyUpdates: false });
});

test("GET follows a policy flag set elsewhere, which is what the bell filters on", async () => {
  setOverride(FLAGS.policy_updates, "on");
  const on = await get();
  assert.equal(on.prefs.policy_updates, true);
  assert.equal(on.prefs.policyUpdates, true);
  // The bell passes `prefs` through resolvePrefs and filters rows by the
  // camelCase key classifyNotificationType returns.
  assert.equal(resolvePrefs(on.prefs as NotificationPrefs).policyUpdates, true);

  setOverride(FLAGS.label_changes, "off");
  const labelsOff = await get();
  assert.equal(labelsOff.prefs.labelChanges, false);
  assert.equal(labelsOff.prefs.label_changes, false);
});

test("with policy updates on, the bell lists a policy notification and counts it unread", async () => {
  await settingsSave({ policyUpdates: true });
  // The entry lib/privacy-policy.ts raises for a changed policy text.
  const entry: ChangeEntry = {
    type: "policy",
    category: "privacy-policy",
    description: "Privacy policy text changed at example.com.",
    details: ["Re-summarise from the AI Policy tab to refresh ratings."],
    policy_event: "changed",
  };
  createNotification("284882215", "Policy Fixture", [entry]);

  // What the bell fetches: the rows, then the prefs it filters them by.
  const listed = (await (await listNotifications()).json()) as {
    notifications: Array<{
      change_summary: ChangeEntry[];
      id: string;
      read: number;
    }>;
    unreadCount: number;
  };
  assert.equal(listed.unreadCount, 1);
  assert.equal(listed.notifications.length, 1);
  const [row] = listed.notifications;
  assert.equal(classifyNotificationType(row.change_summary), "policyUpdates");

  const prefs = resolvePrefs((await get()).prefs as NotificationPrefs);
  assert.equal(prefs.policyUpdates, true);
  const shown = filterNotificationsByPrefs(listed.notifications, prefs);
  assert.deepEqual(
    shown.visible.map((n) => n.id),
    [row.id]
  );
  assert.equal(shown.visibleUnread, 1);
  assert.equal(shown.hiddenUnread, 0);

  // Filtered by the defaults instead, as the bell was when it could not
  // read the flag, the same row is hidden and left out of the badge.
  const byDefaults = filterNotificationsByPrefs(
    listed.notifications,
    DEFAULT_NOTIFICATION_PREFS
  );
  assert.equal(byDefaults.visible.length, 0);
  assert.equal(byDefaults.visibleUnread, 0);
  assert.equal(byDefaults.hiddenUnread, 1);
});

test("prefs: null still clears every override and the stored blob", async () => {
  for (const flag of Object.values(FLAGS)) {
    setOverride(flag, "on");
  }
  setSetting("notification_prefs", '{"versionUpdates":false}');
  const cleared = await put(null);
  for (const flag of Object.values(FLAGS)) {
    assert.equal(overrideOf(flag), null, flag);
  }
  assert.equal(getSetting("notification_prefs", "missing"), "");
  assert.deepEqual(resolvePrefs(cleared.prefs), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(
    resolvePrefs((await get()).prefs),
    DEFAULT_NOTIFICATION_PREFS
  );
});
