import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNotificationType,
  DEFAULT_NOTIFICATION_PREFS,
  describeNotificationKind,
  NOTIFICATION_TYPE_KEYS,
  parseStoredPrefs,
  resolvePrefs,
  sanitizePrefs,
} from "../../lib/notification-prefs";

test("stored notification prefs parsing drops invalid JSON and unsafe shapes", () => {
  assert.deepEqual(parseStoredPrefs(null), {});
  assert.deepEqual(parseStoredPrefs("{bad json"), {});
  assert.deepEqual(parseStoredPrefs("[]"), {});
  assert.deepEqual(parseStoredPrefs('"labelChanges"'), {});
});

test("stored notification prefs parsing keeps only known boolean keys", () => {
  const parsed = parseStoredPrefs(
    JSON.stringify({
      labelChanges: false,
      aiTimeout: true,
      policyUpdates: "false",
      unknownType: false,
    })
  );

  assert.deepEqual(parsed, {
    labelChanges: false,
    aiTimeout: true,
  });
});

test("sanitizePrefs mirrors parser behavior for request bodies", () => {
  assert.deepEqual(sanitizePrefs(null), {});
  assert.deepEqual(sanitizePrefs(["labelChanges"]), {});
  assert.deepEqual(
    sanitizePrefs({
      manualAppsPrompt: false,
      importCompleted: true,
      aiTimeout: 0,
      extra: true,
    }),
    {
      manualAppsPrompt: false,
      importCompleted: true,
    }
  );
});

test("resolvePrefs merges partial stored prefs with every default key", () => {
  const resolved = resolvePrefs({ labelChanges: false });

  assert.equal(resolved.labelChanges, false);
  assert.deepEqual(
    Object.keys(resolved).sort(),
    [...NOTIFICATION_TYPE_KEYS].sort()
  );

  for (const key of NOTIFICATION_TYPE_KEYS) {
    if (key === "labelChanges") {
      continue;
    }
    assert.equal(resolved[key], DEFAULT_NOTIFICATION_PREFS[key]);
  }
});

test("policy and version updates are the two notification types off by default", () => {
  // A fresh install notifies on privacy-label changes only. Policy text
  // changes are opt-in so a webhook is not flooded by policy rescrapes
  // (the flag side of that default is pinned in
  // tests/app/policy-change-events.test.ts), and an App Store version
  // update is not a privacy change at all: with it on, every app update
  // read as "1 privacy change detected" in the bell and the desktop toast.
  assert.equal(DEFAULT_NOTIFICATION_PREFS.policyUpdates, false);
  assert.equal(DEFAULT_NOTIFICATION_PREFS.versionUpdates, false);
  for (const key of NOTIFICATION_TYPE_KEYS) {
    if (key === "policyUpdates" || key === "versionUpdates") {
      continue;
    }
    assert.equal(DEFAULT_NOTIFICATION_PREFS[key], true, key);
  }
});

test("describeNotificationKind names what a row is about", () => {
  assert.equal(describeNotificationKind(null), "system");
  assert.equal(describeNotificationKind([]), "system");
  assert.equal(
    describeNotificationKind([{ type: "version_update" }]),
    "version_update"
  );
  assert.equal(
    describeNotificationKind([{ type: "profile_mismatch" }]),
    "profile_mismatch"
  );
  assert.equal(
    describeNotificationKind([{ type: "import_completed" }]),
    "import"
  );
  assert.equal(
    describeNotificationKind([{ type: "manual_apps_prompt" }]),
    "unmatched"
  );
  assert.equal(
    describeNotificationKind([{ type: "ai_timeout" }]),
    "ai_timeout"
  );
  assert.equal(
    describeNotificationKind([{ type: "parser_fallthrough" }]),
    "parser_warning"
  );
  for (const type of [
    "sync_resumed",
    "wayback_stale_cleared",
    "policy_resumed",
  ]) {
    assert.equal(describeNotificationKind([{ type }]), "job_resumed", type);
  }
  // Diff rows are told apart by their categories.
  assert.equal(
    describeNotificationKind([{ type: "policy", category: "privacy-policy" }]),
    "privacy_policy"
  );
  assert.equal(
    describeNotificationKind([
      { type: "added", category: "accessibility" },
      { type: "removed", category: "accessibility" },
    ]),
    "accessibility"
  );
  assert.equal(
    describeNotificationKind([{ type: "added", category: "privacy-label" }]),
    "privacy_labels"
  );
  // Mixed rows read as label changes: labels are what the bell is for.
  assert.equal(
    describeNotificationKind([
      { type: "added" },
      { type: "policy", category: "privacy-policy" },
    ]),
    "privacy_labels"
  );
  // An object-prototype name is not a synthetic type.
  assert.equal(
    describeNotificationKind([{ type: "constructor" }]),
    "privacy_labels"
  );
});

test("classifyNotificationType maps synthetic payload markers before fallbacks", () => {
  assert.equal(classifyNotificationType(null), "labelChanges");
  assert.equal(classifyNotificationType([]), "labelChanges");
  assert.equal(classifyNotificationType([{ type: "ai_timeout" }]), "aiTimeout");
  assert.equal(
    classifyNotificationType([{ type: "manual_apps_prompt" }]),
    "manualAppsPrompt"
  );
  assert.equal(
    classifyNotificationType([{ type: "import_completed" }]),
    "importCompleted"
  );
  assert.equal(
    classifyNotificationType([{ type: "profile_mismatch" }]),
    "profileMismatch"
  );
  assert.equal(
    classifyNotificationType([{ type: "version_update" }]),
    "versionUpdates"
  );
  assert.equal(
    classifyNotificationType([
      { type: "category_added" },
      { type: "policy_summary" },
    ]),
    "policyUpdates"
  );
  assert.equal(
    classifyNotificationType([{ type: "category_added" }]),
    "labelChanges"
  );
});

test("classifyNotificationType routes the resume and stale-cleared cards", () => {
  // All six are one concept to the user — "a background job was
  // interrupted and picked back up" — so they share one switch, matching
  // how `flag.notifications.resume.enabled` groups them write-side.
  for (const type of [
    "sync_resumed",
    "wayback_resumed",
    "policy_resumed",
    "sync_stale_cleared",
    "wayback_stale_cleared",
    "policy_stale_cleared",
  ]) {
    assert.equal(classifyNotificationType([{ type }]), "jobResumed", type);
  }
});

test("classifyNotificationType routes the parser-fallthrough warning", () => {
  assert.equal(
    classifyNotificationType([{ type: "parser_fallthrough" }]),
    "parserFallthrough"
  );
});

test("every synthetic notification type has its own pref key", () => {
  // The bug this guards: a synthetic writer whose `type` no branch
  // recognises falls through to `labelChanges`, so turning label changes
  // off silently hides it. Any new writer must be added here and to
  // `classifyNotificationType` together.
  const SYNTHETIC_TYPES = [
    "ai_timeout",
    "manual_apps_prompt",
    "import_completed",
    "profile_mismatch",
    "version_update",
    "sync_resumed",
    "wayback_resumed",
    "policy_resumed",
    "sync_stale_cleared",
    "wayback_stale_cleared",
    "policy_stale_cleared",
    "parser_fallthrough",
  ];
  for (const type of SYNTHETIC_TYPES) {
    assert.notEqual(
      classifyNotificationType([{ type }]),
      "labelChanges",
      `${type} falls through to labelChanges`
    );
  }
});
