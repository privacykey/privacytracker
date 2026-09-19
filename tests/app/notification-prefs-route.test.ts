/**
 * Pin the two key spellings /api/notification-prefs has to speak.
 *
 * The route stores four notification types as `flag.notifications.types.*`
 * overrides, keyed `label_changes`, `policy_updates`,
 * `accessibility_changes` and `new_privacy_types`. Its two clients, the
 * Settings "Notifications" section and the bell, speak the seven camelCase
 * `NotificationTypeKey`s from lib/notification-prefs.ts and read the
 * response through `resolvePrefs`, which only looks at camelCase keys.
 *
 * When the route spoke only snake_case, both clients always saw the
 * defaults: the "Privacy policy updates" checkbox read unticked however the
 * flag was set, the bell hid policy notifications even with the flag on,
 * and every Settings save cleared all four overrides because none of its
 * keys matched. These cases drive the real handlers the way those two
 * clients do.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { GET, PUT } from "../../app/api/notification-prefs/route";
import db from "../../lib/db";
import type { FlagKey } from "../../lib/feature-flag-rules";
import { setOverride } from "../../lib/feature-flag-storage";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_TYPE_KEYS,
  type NotificationPrefs,
  resolvePrefs,
} from "../../lib/notification-prefs";
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

test("a Settings-shaped full camelCase map round-trips, so the checkbox stays ticked", async () => {
  // What SettingsView sends: every NotificationTypeKey, as the user sees it.
  const sent: Record<string, boolean> = {
    ...DEFAULT_NOTIFICATION_PREFS,
    policyUpdates: true,
    versionUpdates: false,
    aiTimeout: false,
  };
  const saved = await put(sent);
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(overrideOf(FLAGS.label_changes), "on");
  // What Settings renders after the save response, and on the next load.
  assert.deepEqual(resolvePrefs(saved.prefs), sent);
  assert.deepEqual(resolvePrefs((await get()).prefs), sent);

  // Unticking label changes in the same section turns that flag off.
  const unticked = { ...sent, labelChanges: false };
  const second = await put(unticked);
  assert.equal(overrideOf(FLAGS.label_changes), "off");
  assert.equal(overrideOf(FLAGS.policy_updates), "on");
  assert.equal(second.prefs.label_changes, false);
  assert.deepEqual(resolvePrefs((await get()).prefs), unticked);
});

test("snake_case wins over camelCase when a body carries both", async () => {
  const saved = await put({
    policy_updates: false,
    policyUpdates: true,
    labelChanges: false,
    label_changes: true,
  });
  assert.equal(overrideOf(FLAGS.policy_updates), "off");
  assert.equal(overrideOf(FLAGS.label_changes), "on");
  assert.equal(saved.prefs.policyUpdates, false);
  assert.equal(saved.prefs.labelChanges, true);
  const body = await get();
  assert.equal(body.prefs.policyUpdates, false);
  assert.equal(body.prefs.labelChanges, true);
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
