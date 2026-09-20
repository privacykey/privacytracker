/**
 * Feature-flag migration oracle for the Rust server (Phase 6, batch 2b).
 *
 * Runs the REAL `runFeatureFlagMigration` from
 * `lib/migrations/v1_feature_flags.ts`, which `instrumentation.ts` calls
 * once at boot before any ticker starts, over a scratch database: the
 * version gate, each of the six steps over the legacy state it migrates,
 * the steps together, and the failures that leave the version unwritten
 * so that the next boot tries again. Records, per case, the setup rows,
 * every write in order with its transaction markers, the three tables the
 * migration touches, and what the call returned or threw.
 *
 * Determinism as the other oracles: a frozen clock (so every step takes
 * 0 ms), counted ids and each case in a SAVEPOINT. A case may drop a table
 * or add a trigger inside its savepoint; the rollback restores the schema.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-flag-migration-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";

const now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};

let idCounter = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: nextId,
  configurable: true,
  writable: true,
});
nodeCrypto.randomUUID = nextId;
syncBuiltinESMExports();

// ── The database, recorded ──────────────────────────────────────────
const { default: db } = await import("../../lib/db.ts");

let recording = null;
const realPrepare = db.prepare.bind(db);
const realTransaction = db.transaction.bind(db);
db.prepare = (sql) => {
  const stmt = realPrepare(sql);
  const run = stmt.run.bind(stmt);
  stmt.run = (...params) => {
    if (recording) {
      recording.push({ sql, params });
    }
    return run(...params);
  };
  return stmt;
};
db.transaction = (fn) => {
  const tx = realTransaction(fn);
  return (...args) => {
    if (recording) {
      recording.push({ sql: "BEGIN", params: [] });
    }
    try {
      const out = tx(...args);
      if (recording) {
        recording.push({ sql: "COMMIT", params: [] });
      }
      return out;
    } catch (error) {
      if (recording) {
        recording.push({ sql: "ROLLBACK", params: [] });
      }
      throw error;
    }
  };
};

const { runFeatureFlagMigration } = await import(
  "../../lib/migrations/v1_feature_flags.ts"
);

for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = ["app_settings", "feature_flag_overrides", "activity_log"];

// ── Fixture rows ─────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const version = (value) => setting("feature_flag_migration_version", value);
const override = (
  key,
  value,
  { setBy = "user", quarantined = 0, previousFocus = null } = {}
) =>
  stmt(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, ?, ?, ?)",
    key,
    value,
    1_700_000_000_000,
    setBy,
    previousFocus,
    quarantined
  );
const drop = (table) => stmt(`DROP TABLE ${table}`);
// A stored value a step cannot use is dropped, not failed on, so a step
// after the schema check fails only on a broken schema: here, a trigger.
const refuseOverrideInserts = stmt(
  "CREATE TRIGGER refuse_override_inserts BEFORE INSERT ON feature_flag_overrides BEGIN SELECT RAISE(ABORT, 'feature_flag_overrides is read-only'); END"
);
const prefs = (value) =>
  setting(
    "notification_prefs",
    typeof value === "string" ? value : JSON.stringify(value)
  );
const CALLOUTS = [
  "flag.dashboard.cleanup_callout",
  "flag.dashboard.family_callout",
  "flag.dashboard.hygiene_callout",
  "flag.dashboard.definitions_callout",
];

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
function run(name, setup = []) {
  db.exec("SAVEPOINT migration_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let outcome;
    try {
      outcome = { ok: true, steps: runFeatureFlagMigration() };
    } catch (error) {
      outcome = {
        ok: false,
        error: {
          name: error?.name ?? null,
          step: error?.step ?? null,
          message: String(error?.message ?? error),
        },
      };
    }
    recording = null;
    const rows = {};
    for (const table of TABLES) {
      // A table the case dropped reads as null.
      const present = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table);
      rows[table] = present
        ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        : null;
    }
    // `undefined` in a refused bind reads as null, as JSON writes it.
    cases.push(
      JSON.parse(JSON.stringify({ name, setup, stream, rows, outcome }))
    );
  } finally {
    recording = null;
    db.exec("ROLLBACK TO migration_case; RELEASE migration_case");
  }
}

// ── The version gate: `Number.parseInt(stored, 10) >= 2` skips ──────
run("a fresh install runs all six steps");
run("version 2 skips everything", [version("2")]);
run("a later version skips everything", [version("7")]);
run("a version with a fraction reads as its whole part", [version("2.5")]);
run("a version after whitespace still reads", [version("\t 2")]);
run("version 1 runs again", [version("1")]);
run("a version just under two runs", [version("1.99")]);
run("a hexadecimal version reads as zero", [version("0x2")]);
run("a version that is not a number runs", [version("two")]);
run("an empty version runs", [version("")]);
run("a negative version runs", [version("-3")]);

// ── Step 2: user_intent becomes a focus ──────────────────────────────
for (const intent of ["curious", "cleanup", "hygiene", "family"]) {
  run(`the ${intent} intent becomes a focus`, [setting("user_intent", intent)]);
}
run("an unknown intent is dropped", [setting("user_intent", "tidy")]);
run("an intent is matched exactly", [setting("user_intent", "Curious ")]);
run("an empty intent is left alone", [setting("user_intent", "")]);
run("an intent replaces a stored focus", [
  setting("user_intent", "family"),
  setting("flag.focus.audience", "self"),
  setting("flag.focus.goal.cleanup", "true"),
  setting("flag.focus.workflow", "self_cleanup"),
  setting("flag.focus.child_age_band", "13_15"),
]);
run("an intent named like an object method is dropped as unknown", [
  setting("user_intent", "toString"),
]);
run("the __proto__ intent is dropped as unknown", [
  setting("user_intent", "__proto__"),
]);
run("an inherited intent from version 1 is dropped and the run completes", [
  version("1"),
  setting("user_intent", "valueOf"),
]);

// ── Step 3: notification_prefs becomes overrides ────────────────────
run("notification prefs become four overrides", [
  prefs({
    label_changes: true,
    policy_updates: "on",
    accessibility_changes: "true",
    new_privacy_types: false,
  }),
]);
run("only true, on and true switch a type on", [
  prefs({
    label_changes: "yes",
    policy_updates: 1,
    accessibility_changes: null,
    new_privacy_types: "TRUE",
  }),
]);
run("only the types present are written", [
  prefs({ policy_updates: true, digest: "weekly" }),
]);
run("an override already there is replaced", [
  override("flag.notifications.types.label_changes", "on", {
    quarantined: 1,
    previousFocus: '{"audience":"self"}',
  }),
  prefs({ label_changes: false }),
]);
run("prefs that are not JSON are dropped", [prefs("{label_changes: true")]);
run("prefs of null are dropped", [prefs("null")]);
run("prefs of null are dropped and the later steps still run", [
  setting("user_intent", "hygiene"),
  prefs("null"),
  setting("flag.focus.goal.understand", "true"),
]);
run("prefs that are an array write nothing", [prefs("[true, true]")]);
run("prefs that are a number write nothing", [prefs("5")]);
run("prefs that are a string write nothing", [prefs('"label_changes"')]);
run("a type nested under __proto__ is not an own key", [
  prefs('{"__proto__": {"label_changes": true}}'),
]);
run("a repeated type keeps its last value", [
  prefs('{"label_changes": true, "label_changes": false}'),
]);
run("empty prefs are left in place", [prefs("")]);

// ── Step 4: the legacy callout overrides ────────────────────────────
run("the four legacy callout overrides are dropped", [
  ...CALLOUTS.map((key) => override(key, "off")),
  override("flag.global.social_share", "on"),
]);

// ── Step 5: quarantine ───────────────────────────────────────────────
run("known overrides leave quarantine and unknown ones enter it", [
  override("flag.global.social_share", "on", { quarantined: 1 }),
  override("flag.global.about_modal", "off"),
  override("flag.retired.thing", "on"),
  override("flag.retired.other", "off", { quarantined: 1 }),
  override("constructor", "on"),
]);

// ── Step 6: the goal keys' rename ───────────────────────────────────
run("old goal keys move to their new names", [
  setting("flag.focus.goal.understand", "true"),
  setting("flag.focus.goal.declutter", "false"),
]);
run("a new goal key already set is kept", [
  setting("flag.focus.goal.understand", "false"),
  setting("flag.focus.goal.monitor", "true"),
]);
run("an empty old goal key is only deleted", [
  setting("flag.focus.goal.declutter", ""),
  setting("flag.focus.goal.cleanup", ""),
]);

// ── Failures: the version stays unwritten ───────────────────────────
run("a missing overrides table fails the schema check", [
  drop("feature_flag_overrides"),
]);
run("a missing annotations table fails the schema check", [
  drop("annotations"),
]);
run("a later step's failure keeps the earlier steps' writes", [
  setting("user_intent", "hygiene"),
  refuseOverrideInserts,
  prefs({ label_changes: true }),
  setting("flag.focus.goal.understand", "true"),
]);
run("a failed run from version 1 leaves version 1", [
  version("1"),
  drop("annotations"),
]);

// ── Everything at once ───────────────────────────────────────────────
run("a legacy install migrates everything in one run", [
  version("0"),
  setting("user_intent", "curious"),
  prefs({
    label_changes: true,
    policy_updates: false,
    accessibility_changes: "on",
    new_privacy_types: true,
  }),
  override("flag.dashboard.cleanup_callout", "on"),
  override("flag.retired.thing", "on"),
  override("flag.global.social_share", "on", { quarantined: 1 }),
  setting("flag.focus.goal.declutter", "true"),
]);

const fixture = {
  source:
    "the real runFeatureFlagMigration from lib/migrations/v1_feature_flags.ts, over lib/feature-flag-storage.ts, lib/scheduler.ts and lib/activity.ts",
  now,
  cases,
};
writeFileSync(
  new URL("../tests/fixtures/flag-migration-cases.json", import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`
);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  `Recorded ${cases.length} feature-flag migration cases from the real Node migration.`
);
