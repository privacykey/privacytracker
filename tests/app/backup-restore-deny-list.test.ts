/**
 * A restore applies the settings deny-list to the table the flag
 * resolver actually reads (`feature_flag_overrides`), not only to
 * `app_settings`, and an untrusted envelope cannot plant a quarantined
 * override that a later upgrade would switch on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { exportBackup, restoreBackup } from "../../lib/backup";
import db from "../../lib/db";

interface OverrideRow {
  flag_key: string;
  override_value: string;
  quarantined: number;
}

function overrides(): OverrideRow[] {
  return db
    .prepare(
      "SELECT flag_key, override_value, quarantined FROM feature_flag_overrides ORDER BY flag_key"
    )
    .all() as OverrideRow[];
}

function settingValue(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function override(key: string, value: string, quarantined: unknown = 0) {
  return {
    flag_key: key,
    override_value: value,
    set_at: 1,
    set_by: "user",
    previous_focus: null,
    quarantined,
  };
}

function unsignedEnvelope(tables: Record<string, unknown>) {
  return { version: 1, exportedAt: 1, appName: "privacytracker", tables };
}

test("an untrusted restore refuses flag.devopts overrides and quarantined rows", () => {
  const result = restoreBackup(
    unsignedEnvelope({
      feature_flag_overrides: {
        rows: [
          override("flag.devopts.cfgutil_uninstall", "on"),
          override("flag.devopts.feature_flag_system.enabled", "off"),
          override("AUDITOR_ADMIN_TOKEN", "planted"),
          override("flag.dashboard.stats", "off"),
          override("flag.future.unknown", "on", 1),
          override("flag.dashboard.activity", "off", "1"),
          override("flag.dashboard.review_cta", "off", true),
          override("flag.nav.device_scope", "off", "0"),
          override("flag.detail.timeline.wayback_rows", "off", false),
        ],
      },
      app_settings: {
        rows: [
          { key: "flag.devopts.cfgutil_uninstall", value: "on" },
          { key: "sync_schedule", value: "weekly" },
        ],
      },
    }),
    { allowUntrusted: true }
  );

  assert.equal(result.trust, "untrusted");
  assert.deepEqual(
    overrides().map((r) => [r.flag_key, r.override_value, r.quarantined]),
    [
      ["flag.dashboard.stats", "off", 0],
      ["flag.detail.timeline.wayback_rows", "off", 0],
      ["flag.nav.device_scope", "off", 0],
    ]
  );
  assert.deepEqual(
    result.blocked.find((b) => b.name === "feature_flag_overrides"),
    { name: "feature_flag_overrides", rows: 6 }
  );
  assert.equal(settingValue("flag.devopts.cfgutil_uninstall"), undefined);
  assert.equal(settingValue("sync_schedule"), "weekly");
});

test("a trusted restore still refuses flag.devopts overrides but keeps its own quarantined rows", () => {
  db.prepare("DELETE FROM feature_flag_overrides").run();
  const insert = db.prepare(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, quarantined) VALUES (?, ?, 1, 'user', ?)"
  );
  insert.run("flag.devopts.cfgutil_uninstall", "on", 0);
  insert.run("flag.dashboard.stats", "off", 0);
  insert.run("flag.from.a.newer.version", "on", 1);

  const envelope = exportBackup();
  const result = restoreBackup(envelope);

  assert.equal(result.trust, "trusted");
  assert.deepEqual(
    overrides().map((r) => [r.flag_key, r.quarantined]),
    [
      ["flag.dashboard.stats", 0],
      ["flag.from.a.newer.version", 1],
    ]
  );
  assert.deepEqual(
    result.blocked.find((b) => b.name === "feature_flag_overrides"),
    { name: "feature_flag_overrides", rows: 1 }
  );
});
