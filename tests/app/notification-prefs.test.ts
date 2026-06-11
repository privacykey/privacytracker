import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNotificationType,
  DEFAULT_NOTIFICATION_PREFS,
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
