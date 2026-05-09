/**
 * v1 feature-flag migration runner.
 *
 * Runs once on server startup (called from instrumentation.ts). Idempotent
 * end-to-end; safe to retry. The 5 ordered steps:
 *
 *   1. Schema additions    — performed by lib/db.ts on import (CREATE TABLE
 *                            statements + ALTER TABLE migrations). This step
 *                            verifies the new tables exist; it doesn't
 *                            mutate them.
 *   2. user_intent → focus — read the legacy `user_intent` key, write the
 *                            new `flag.focus.audience` + `flag.focus.goal.*`
 *                            keys per the §4.5 mapping, drop `user_intent`.
 *   3. notification_prefs  — read the JSON blob, write per-type rows into
 *                            feature_flag_overrides as `flag.notifications.types.*`,
 *                            drop the old `notification_prefs` key.
 *   4. callout rename      — drop overrides for the old callout flag keys
 *                            (`flag.dashboard.cleanup_callout` etc.). They
 *                            don't carry across to the new keys.
 *   5. quarantine check    — un-quarantine rows whose keys are now known;
 *                            quarantine rows whose keys are no longer known.
 *
 * Each step writes activity_log rows so the migration is auditable. On
 * failure the runner aborts (no partial migration), and instrumentation.ts
 * surfaces the failure in the migration error UI.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags for the design.
 */

import db from '../db';
import { getSetting, setSetting } from '../scheduler';
import { recordActivity } from '../activity';
import { setActiveFocus, quarantineUnknownOverrides, unquarantineKnownOverrides } from '../feature-flag-storage';
import type { Audience } from '../feature-flag-rules';

// ---------------------------------------------------------------------------

const MIGRATION_VERSION = 1;
const MIGRATION_KEY = 'feature_flag_migration_version';

/** Mapping from old `user_intent` enum to new audience + goals (§4.5). */
const INTENT_MAP: Record<string, {
  audience: Audience;
  understand: boolean;
  declutter: boolean;
}> = {
  curious:  { audience: 'self',     understand: true,  declutter: false },
  cleanup:  { audience: 'self',     understand: false, declutter: true  },
  hygiene:  { audience: 'self',     understand: true,  declutter: true  },
  family:   { audience: 'guardian', understand: true,  declutter: false },
};

/** Old callout flag keys that get their overrides dropped during the rename. */
const CALLOUT_LEGACY_KEYS = [
  'flag.dashboard.cleanup_callout',
  'flag.dashboard.family_callout',
  'flag.dashboard.hygiene_callout',
  'flag.dashboard.definitions_callout',
];

/** Per-type notification keys we absorb from the JSON blob into individual flags. */
const NOTIFICATION_TYPE_KEYS: Record<string, string> = {
  label_changes:          'flag.notifications.types.label_changes',
  policy_updates:         'flag.notifications.types.policy_updates',
  accessibility_changes:  'flag.notifications.types.accessibility_changes',
  new_privacy_types:      'flag.notifications.types.new_privacy_types',
};

// ---------------------------------------------------------------------------

interface StepResult {
  name: string;
  durationMs: number;
}

export class MigrationError extends Error {
  constructor(public readonly step: string, public readonly cause: unknown) {
    super(
      `Migration step \`${step}\` failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MigrationError';
  }
}

/**
 * Run the full feature-flag migration. Idempotent.
 *
 * @returns Per-step durations for logging. Throws MigrationError if any step
 *          fails — instrumentation.ts catches and renders the error UI.
 */
export function runFeatureFlagMigration(): StepResult[] {
  // Skip if already at the current version.
  const current = parseInt(getSetting(MIGRATION_KEY, '0'), 10);
  if (current >= MIGRATION_VERSION) {
    return [];
  }

  const totalStart = Date.now();
  const results: StepResult[] = [];

  try {
    results.push(runStep('schema_check',           stepSchemaCheck));
    results.push(runStep('user_intent_migration',  stepUserIntentMigration));
    results.push(runStep('notification_prefs_absorb', stepNotificationPrefsAbsorb));
    results.push(runStep('callout_rename',         stepCalloutRename));
    results.push(runStep('quarantine_check',       stepQuarantineCheck));
  } catch (e) {
    // recordActivity is best-effort here; if even that fails we re-throw
    // the original error rather than swallowing it.
    if (e instanceof MigrationError) {
      try {
        recordActivity({
          type: 'migration',
          status: 'error',
          summary: `migration_v1_step_failed: ${e.step}`,
          detail: { error: e.cause instanceof Error ? e.cause.message : String(e.cause) },
          startedAt: Date.now(),
        });
      } catch { /* swallow secondary failure */ }
    }
    throw e;
  }

  // Mark migration complete only after all steps succeed.
  setSetting(MIGRATION_KEY, String(MIGRATION_VERSION));

  const totalMs = Date.now() - totalStart;
  recordActivity({
    type: 'migration',
    status: 'ok',
    summary: `migration_v1_completed: ${results.length}/${results.length} steps, total: ${totalMs}ms`,
    detail: { steps: results },
    startedAt: totalStart,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Step harness
// ---------------------------------------------------------------------------

function runStep(name: string, fn: () => void): StepResult {
  const start = Date.now();
  recordActivity({
    type: 'migration',
    status: 'ok',
    summary: `migration_v1_step_started: ${name}`,
    startedAt: start,
  });

  try {
    fn();
  } catch (e) {
    throw new MigrationError(name, e);
  }

  const durationMs = Date.now() - start;
  recordActivity({
    type: 'migration',
    status: 'ok',
    summary: `migration_v1_step_completed: ${name}, duration: ${durationMs}ms`,
    detail: { durationMs },
    startedAt: start,
  });

  return { name, durationMs };
}

// ---------------------------------------------------------------------------
// Step 1: schema check
// ---------------------------------------------------------------------------

function stepSchemaCheck(): void {
  // lib/db.ts runs CREATE TABLE IF NOT EXISTS on module load, so by the time
  // this step executes the tables already exist. We just verify they're
  // present — if either check fails the migration aborts and the user sees
  // the error UI. No structural changes here; this is a sanity gate.
  const flagOverridesExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_flag_overrides'",
  ).get();
  if (!flagOverridesExists) {
    throw new Error('feature_flag_overrides table is missing — lib/db.ts did not create it');
  }

  const annotationsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'annotations'",
  ).get();
  if (!annotationsExists) {
    throw new Error('annotations table is missing — lib/db.ts did not create it');
  }
}

// ---------------------------------------------------------------------------
// Step 2: user_intent → audience + goals
// ---------------------------------------------------------------------------

function stepUserIntentMigration(): void {
  const oldIntent = getSetting('user_intent', '');
  if (!oldIntent) {
    // No legacy intent set — user either hit "skip" on the old welcome splash
    // or never reached it. Either way, leave focus unset; the §4.10
    // hybrid-redirect will route them through the new screens.
    return;
  }

  const mapped = INTENT_MAP[oldIntent];
  if (!mapped) {
    // Unknown intent value — log a warning but don't fail the migration.
    // Likely a future-proofing issue; user can re-pick via the focus card.
    console.warn(`[Migration] Unknown user_intent value '${oldIntent}', skipping`);
    db.prepare("DELETE FROM app_settings WHERE key = 'user_intent'").run();
    return;
  }

  // Atomic write of the new focus keys + drop the old one.
  const transaction = db.transaction(() => {
    setActiveFocus({
      audience: mapped.audience,
      understand: mapped.understand,
      declutter: mapped.declutter,
      minimal: false,
      accessibility: false,
    });
    db.prepare("DELETE FROM app_settings WHERE key = 'user_intent'").run();
  });
  transaction();
}

// ---------------------------------------------------------------------------
// Step 3: notification_prefs JSON → per-type flag rows
// ---------------------------------------------------------------------------

function stepNotificationPrefsAbsorb(): void {
  const blob = getSetting('notification_prefs', '');
  if (!blob) return; // already absorbed or never written

  let parsed: Record<string, boolean | string>;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    // Corrupt JSON — drop it rather than failing the whole migration.
    console.warn('[Migration] notification_prefs JSON unparseable, dropping:', e);
    db.prepare("DELETE FROM app_settings WHERE key = 'notification_prefs'").run();
    return;
  }

  const now = Date.now();
  const transaction = db.transaction(() => {
    for (const [legacyKey, flagKey] of Object.entries(NOTIFICATION_TYPE_KEYS)) {
      if (!(legacyKey in parsed)) continue;
      const raw = parsed[legacyKey];
      const value = (raw === true || raw === 'on' || raw === 'true') ? 'on' : 'off';
      db.prepare(
        `INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, quarantined)
         VALUES (?, ?, ?, 'migration', 0)
         ON CONFLICT(flag_key) DO UPDATE SET
           override_value = excluded.override_value,
           set_at = excluded.set_at,
           set_by = 'migration',
           quarantined = 0`,
      ).run(flagKey, value, now);
    }
    db.prepare("DELETE FROM app_settings WHERE key = 'notification_prefs'").run();
  });
  transaction();
}

// ---------------------------------------------------------------------------
// Step 4: callout rename — drop legacy override rows
// ---------------------------------------------------------------------------

function stepCalloutRename(): void {
  // Existing user overrides for the old callout keys (if any) are dropped
  // rather than mapped to the new keys. Per §4.5, these flags weren't
  // user-facing in the pre-v1 build, so most installs have nothing to lose
  // here. Early-adopter testers who manually flipped them will re-override.
  const transaction = db.transaction(() => {
    for (const key of CALLOUT_LEGACY_KEYS) {
      db.prepare("DELETE FROM feature_flag_overrides WHERE flag_key = ?").run(key);
    }
  });
  transaction();
}

// ---------------------------------------------------------------------------
// Step 5: quarantine check
// ---------------------------------------------------------------------------

function stepQuarantineCheck(): void {
  // Two passes: un-quarantine rows that are now recognised (an app update
  // added the missing flag), and quarantine rows that aren't recognised
  // (an old flag was removed in this release). Both are idempotent.
  unquarantineKnownOverrides();
  quarantineUnknownOverrides();
}
