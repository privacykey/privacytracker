/**
 * Audit-bundle import (round 3 PR 5 follow-up; v1 final).
 *
 * Counterpart to `lib/audit-bundle.ts` (the export side). Receives a
 * `.audit.json` bundle produced by another instance of the app — the
 * recommender's run — and merges it into the loved one's local DB.
 *
 * Spec: https://privacytracker-docs.privacykey.org/develop/feature-flags.
 *
 * Flow:
 *
 *   1. `validateBundle(parsed)` — strict JSON-shape + version check.
 *      No partial imports: a bundle either parses cleanly or the user
 *      gets a specific, actionable error string (NO best-effort
 *      recovery, per spec).
 *
 *   2. `importAuditBundle(bundle, opts)` — runs inside a single SQLite
 *      transaction. Per-app merge: newer `lastSynced` wins for label
 *      data; bundle annotations are inserted as separate `imported`
 *      rows so user notes never get clobbered. Apps in the bundle that
 *      the loved one doesn't have yet are inserted fresh; apps the
 *      loved one has that aren't in the bundle stay untouched.
 *
 *   3. The recommender's privacy profile is **not** auto-applied. We
 *      stash it under `app_settings.recommender_profile_suggestion`
 *      so the loved one can preview + accept it from Settings later.
 *      This matches spec §4.8: "starting suggestion that the loved one
 *      can accept, edit, or discard".
 *
 *   4. Re-import dedup: a bundle's `exported_at` is the natural key.
 *      `findExistingImport()` lets the API tell the user "you imported
 *      this on Date X — proceed anyway?" before running the merge.
 *
 *   5. Activity log: each accepted import writes a `bundle_imported`
 *      activity row with the summary numbers. The dashboard
 *      provenance banner reads the most recent row's `recommender_name`
 *      to populate "Apps imported from {name}'s recommendation."
 *
 * Tables touched (all inside one tx):
 *   - apps                        (insert / update lastSynced + metadata)
 *   - privacy_types               (delete + reinsert for updated apps)
 *   - privacy_categories          (cascade)
 *   - accessibility_features      (delete + reinsert for updated apps)
 *   - privacy_policy_analyses     (upsert)
 *   - annotations                 (insert source='imported' rows)
 *   - audit_bundle_imports        (insert summary row for dedup + log)
 *   - app_settings                (recommender_profile_suggestion blob)
 *
 * Tables intentionally NOT touched:
 *   - feature_flag_overrides      (recipient keeps their own)
 *   - app_settings.flag.focus.*   (recipient keeps their audience/goals)
 *   - app_settings.ai_*           (recipient keeps their AI config)
 *   - notification_prefs          (recipient keeps their bell prefs)
 *   - imports / import_items      (audit-bundle imports are a separate
 *                                  surface from onboarding-import history)
 */

import crypto from 'crypto';
import packageJson from '../package.json';
import db from './db';
import type {
  AuditBundle,
  BundleApp,
  BundleAnnotation,
} from './audit-bundle';
import { BUNDLE_VERSION } from './audit-bundle';
import type { ProfilePresetKey } from './privacy-profile';
import { getSetting, setSetting } from './scheduler';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /**
   * Skip the version-check step. Power users debugging a malformed
   * bundle (or testing forward-compat behaviour locally) can pass this
   * via the API's `?force=1` query param. Schema + field checks still
   * run regardless.
   */
  force?: boolean;
}

export type ValidateResult =
  | { ok: true; bundle: AuditBundle }
  | { ok: false; error: string };

/**
 * Strict shape validation per spec §4.8 step 1-4. Each failure mode
 * produces the exact error string the spec calls out so the client UI
 * can render it verbatim. A `force=true` skips the version check only.
 */
export function validateBundle(parsed: unknown, opts: ValidateOptions = {}): ValidateResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: "This file isn't a valid audit bundle (couldn't parse JSON)." };
  }

  const obj = parsed as Record<string, unknown>;

  // Step 2 — version check. Forward-compat: refuse newer bundles
  // unless `force=true` (ours, older field-shape checks still run).
  if (!opts.force) {
    if (typeof obj.version !== 'number') {
      return { ok: false, error: 'This bundle appears corrupted (missing required field: `version`).' };
    }
    if (obj.version > BUNDLE_VERSION) {
      const yours = obj.app_version || `${obj.version}`;
      return {
        ok: false,
        error: `This bundle is for app version ${yours} (you're on ${packageJson.version}). Update to import.`,
      };
    }
  }

  // Step 3 — required fields.
  const requiredKeys = ['exported_at', 'apps', 'annotations'];
  for (const key of requiredKeys) {
    if (!(key in obj)) {
      return {
        ok: false,
        error: `This bundle appears corrupted (missing required field: \`${key}\`).`,
      };
    }
  }
  if (typeof obj.exported_at !== 'string' || obj.exported_at.length === 0) {
    return { ok: false, error: 'This bundle appears corrupted (missing required field: `exported_at`).' };
  }
  if (!Array.isArray(obj.apps)) {
    return { ok: false, error: 'This bundle appears corrupted (missing required field: `apps`).' };
  }
  if (!Array.isArray(obj.annotations)) {
    return { ok: false, error: 'This bundle appears corrupted (missing required field: `annotations`).' };
  }

  // Step 4 — per-app shape. The spec says "reject the whole bundle with
  // per-app diagnostics"; we surface the first offender in the error
  // string so the user can find the bad row in their file.
  for (let i = 0; i < obj.apps.length; i++) {
    const app = obj.apps[i] as Record<string, unknown> | null | undefined;
    if (!app || typeof app !== 'object') {
      return {
        ok: false,
        error: `This bundle appears corrupted (apps[${i}] isn't an object).`,
      };
    }
    if (typeof app.id !== 'string' || app.id.length === 0) {
      return {
        ok: false,
        error: `This bundle appears corrupted (apps[${i}] is missing \`id\`).`,
      };
    }
    if (typeof app.name !== 'string' || app.name.length === 0) {
      return {
        ok: false,
        error: `This bundle appears corrupted (apps[${i}] "${app.id}" is missing \`name\`).`,
      };
    }
    if (!Array.isArray(app.privacy_types)) {
      return {
        ok: false,
        error: `This bundle appears corrupted (apps[${i}] "${app.id}" is missing \`privacy_types\`).`,
      };
    }
  }

  return { ok: true, bundle: obj as unknown as AuditBundle };
}

// ---------------------------------------------------------------------------
// Dedup lookup
// ---------------------------------------------------------------------------

export interface ExistingImportInfo {
  importedAt: number;
  recommenderName: string | null;
  appsTotal: number;
  appsAdded: number;
  appsUpdated: number;
  appsSkipped: number;
  annotationsAdded: number;
}

/**
 * Most-recently-imported bundle (regardless of which file produced it).
 * Used by the dashboard provenance banner to render
 *   "Apps imported from {recommender_name}'s recommendation"
 * for 24 h after an import. Returns null when nothing's been imported,
 * or when the most recent import is older than `withinMs`.
 */
export function getMostRecentImport(
  withinMs: number = 24 * 60 * 60 * 1000,
): ExistingImportInfo | null {
  const cutoff = Date.now() - withinMs;
  const row = db
    .prepare(
      `SELECT imported_at, recommender_name, apps_total, apps_added,
              apps_updated, apps_skipped, annotations_added
         FROM audit_bundle_imports
        WHERE imported_at >= ?
        ORDER BY imported_at DESC
        LIMIT 1`,
    )
    .get(cutoff) as
    | {
        imported_at: number;
        recommender_name: string | null;
        apps_total: number;
        apps_added: number;
        apps_updated: number;
        apps_skipped: number;
        annotations_added: number;
      }
    | undefined;
  if (!row) return null;
  return {
    importedAt: row.imported_at,
    recommenderName: row.recommender_name,
    appsTotal: row.apps_total,
    appsAdded: row.apps_added,
    appsUpdated: row.apps_updated,
    appsSkipped: row.apps_skipped,
    annotationsAdded: row.annotations_added,
  };
}

/**
 * One-shot migration-flow redirect. The dashboard reads this on every
 * load — when present, it (a) fires the redirect to whatever path the
 * marker points at (currently always /dashboard/review-recommendations)
 * and (b) clears the marker so the next dashboard load behaves
 * normally. Returns null when no marker is set, parse-fails, or has
 * already been consumed.
 *
 * The "consume" semantics matter — we never want a stale marker
 * trapping the user in a redirect loop. Tied to a dashboard load
 * specifically because that's the natural landing point post-import;
 * direct nav to /dashboard/review-recommendations clears the marker
 * defensively too (called from the wizard's mount).
 */
export function consumeMigrationFlowMarker(): { targetPath: string; recommenderName: string | null } | null {
  let raw: string | null;
  try {
    raw = getSetting('migration_flow_pending');
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: { targetPath?: string; recommenderName?: string | null } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt blob — clear it and bail. Better silent than caught in a
    // redirect loop.
    try { setSetting('migration_flow_pending', ''); } catch { /* ignore */ }
    return null;
  }
  // Always clear after read. The marker is one-shot; if the redirect
  // somehow fails to land, the user can re-run the migration wizard.
  try { setSetting('migration_flow_pending', ''); } catch { /* ignore */ }

  const target = typeof parsed.targetPath === 'string' && parsed.targetPath.startsWith('/')
    ? parsed.targetPath
    : '/dashboard/review-recommendations';
  return {
    targetPath: target,
    recommenderName: typeof parsed.recommenderName === 'string' ? parsed.recommenderName : null,
  };
}

/**
 * Has a bundle with this `exported_at` been imported already? Used by
 * the API to surface the "you already imported this on {date}" prompt
 * before running the merge again.
 */
export function findExistingImport(exportedAt: string): ExistingImportInfo | null {
  const row = db
    .prepare(
      `SELECT imported_at, recommender_name, apps_total, apps_added,
              apps_updated, apps_skipped, annotations_added
         FROM audit_bundle_imports
        WHERE exported_at = ?`,
    )
    .get(exportedAt) as
    | {
        imported_at: number;
        recommender_name: string | null;
        apps_total: number;
        apps_added: number;
        apps_updated: number;
        apps_skipped: number;
        annotations_added: number;
      }
    | undefined;
  if (!row) return null;
  return {
    importedAt: row.imported_at,
    recommenderName: row.recommender_name,
    appsTotal: row.apps_total,
    appsAdded: row.apps_added,
    appsUpdated: row.apps_updated,
    appsSkipped: row.apps_skipped,
    annotationsAdded: row.annotations_added,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportSummary {
  /** Total apps in the bundle (added + updated + skipped). */
  appsTotal: number;
  /** Apps the loved one didn't have — inserted fresh. */
  appsAdded: number;
  /** Apps both sides had — bundle's `lastSynced` was newer, so we updated. */
  appsUpdated: number;
  /** Apps both sides had — local data was newer, so we kept it. */
  appsSkipped: number;
  /** Annotations from the bundle that landed in the local DB. */
  annotationsAdded: number;
  /**
   * Verdicts (recommendations) from the bundle that landed as
   * `source='imported'` rows. Always advisory — the recipient still
   * has to set their own user-source verdict before any action runs.
   * 0 on v1 bundles (which had no verdicts field).
   */
  verdictsAdded: number;
  /** Whether the recommender's privacy profile suggestion was stashed. */
  recommenderProfileStashed: boolean;
  /**
   * The named preset key the recommender's profile matched at export
   * time, when the bundle carries one. `null` for v1/v2 bundles (which
   * predate the field) and for recommenders whose profile was custom.
   */
  recommenderProfilePreset: ProfilePresetKey | null;
  /** Recommender display name (for the provenance banner). */
  recommenderName: string;
}

export interface ImportOptions {
  /**
   * If true (default), allow the import even when the same `exported_at`
   * has been seen before. Caller flips this off to short-circuit the
   * merge when a dedup-prompt resolves to "skip". When the import
   * proceeds despite the dedup match, the audit_bundle_imports row's
   * `imported_at` is updated to "now" so re-imports walk forward.
   */
  allowDuplicate?: boolean;
}

const FALLBACK_RECOMMENDER_NAME = 'your friend';

/**
 * Run the merge. Single SQLite transaction; either everything lands or
 * nothing does. Returns an `ImportSummary` on success. The caller is
 * expected to have already passed the bundle through `validateBundle`.
 */
export function importAuditBundle(
  bundle: AuditBundle,
  opts: ImportOptions = {},
): ImportSummary {
  const recommenderName = (bundle.recommender_name ?? '').trim() || FALLBACK_RECOMMENDER_NAME;
  const importedAt = Date.now();
  const importId = `bundle-${crypto.randomBytes(12).toString('hex')}`;

  let appsAdded = 0;
  let appsUpdated = 0;
  let appsSkipped = 0;
  let annotationsAdded = 0;
  let verdictsAdded = 0;

  const tx = db.transaction(() => {
    // Index existing apps by id + lastSynced so we can decide who wins
    // the merge per app without a DB round-trip per row.
    const existingApps = new Map<string, { lastSynced: number }>(
      (db.prepare('SELECT id, lastSynced FROM apps').all() as Array<{ id: string; lastSynced: number }>)
        .map((r) => [r.id, { lastSynced: r.lastSynced }]),
    );

    for (const app of bundle.apps) {
      const incomingLastSynced = guessIncomingLastSynced(app, bundle.exported_at);
      const existing = existingApps.get(app.id);
      if (!existing) {
        // App isn't tracked locally — insert fresh + label data.
        upsertApp(app, incomingLastSynced);
        replaceAppLabels(app);
        upsertPolicySummary(app);
        appsAdded++;
        continue;
      }
      if (incomingLastSynced > existing.lastSynced) {
        // Bundle is newer — overwrite label data + policy summary.
        upsertApp(app, incomingLastSynced);
        replaceAppLabels(app);
        upsertPolicySummary(app);
        appsUpdated++;
      } else {
        // Local copy is newer or same age — keep what we have.
        appsSkipped++;
      }
    }

    // Annotations land regardless of which side won the per-app merge.
    // They're additive (new rows), and labelled with `source='imported'`
    // + recommender's name so the sidebar can render them as "Note from
    // {name}" without colliding with user-authored notes.
    const insertAnnotation = db.prepare(
      `INSERT INTO annotations
         (id, app_id, content, source, source_name, visibility, tag,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'imported', ?, ?, ?, ?, ?, NULL)`,
    );
    for (const ann of bundle.annotations) {
      // Defensive: the bundle's annotation might point at an app that
      // didn't make it into the bundle's own apps array. Skip silently
      // — the spec doesn't call for partial-failure on this case.
      const exists =
        existingApps.has(ann.app_id) ||
        bundle.apps.some((a) => a.id === ann.app_id);
      if (!exists) continue;
      const newId = `imp-${crypto.randomBytes(12).toString('hex')}`;
      insertAnnotation.run(
        newId,
        ann.app_id,
        ann.content,
        recommenderName,
        // Imported notes are always treated as `export` visibility — a
        // private flag in someone else's bundle wouldn't make sense
        // (private notes never travel; this is a defensive coalesce).
        'export',
        ann.tag ?? null,
        ann.created_at ?? importedAt,
        ann.updated_at ?? importedAt,
      );
      annotationsAdded++;
    }

    // Verdicts — recommender's recommendations land as advisory
    // 'imported' rows under their display name. UPSERT semantics: a
    // re-import from the same recommender for the same app replaces
    // the previous recommendation rather than stacking duplicates.
    // The recipient's own (source='user') verdict is never touched —
    // imported recommendations can't override a decision the user
    // already made themselves. This preserves the safety property
    // that any actual device action (Phase 3) is gated by the user's
    // own verdict, not by anything in the bundle.
    if (Array.isArray(bundle.verdicts) && bundle.verdicts.length > 0) {
      const upsertVerdict = db.prepare(
        `INSERT INTO app_verdicts
           (id, app_id, verdict, rationale, source, source_name, set_at, updated_at)
         VALUES (?, ?, ?, ?, 'imported', ?, ?, ?)
         ON CONFLICT(app_id, source, source_name) DO UPDATE SET
           verdict    = excluded.verdict,
           rationale  = excluded.rationale,
           updated_at = excluded.updated_at`,
      );
      const VALID = new Set(['safe', 'replace', 'uninstall']);
      for (const v of bundle.verdicts) {
        // Defensive: skip rows for apps that didn't make it into the
        // merged set, and rows with unknown verdict values (forward-
        // compat — older app versions reading a future bundle).
        const exists =
          existingApps.has(v.app_id) ||
          bundle.apps.some((a) => a.id === v.app_id);
        if (!exists) continue;
        if (!VALID.has(v.verdict)) continue;
        const newId = `imp-vrd-${crypto.randomBytes(12).toString('hex')}`;
        upsertVerdict.run(
          newId,
          v.app_id,
          v.verdict,
          v.rationale ?? null,
          recommenderName,
          v.set_at ?? importedAt,
          v.updated_at ?? importedAt,
        );
        verdictsAdded++;
      }
    }

    // Stash the recommender's privacy profile suggestion (if any) for
    // later acceptance via Settings. We store as JSON because the
    // app_settings table is plain key/value strings — the consuming UI
    // parses on read.
    let recommenderProfileStashed = false;
    if (bundle.recommender_profile && Object.keys(bundle.recommender_profile).length > 0) {
      try {
        setSetting('recommender_profile_suggestion', JSON.stringify({
          profile: bundle.recommender_profile,
          // Stash the preset key alongside the raw profile so the loved
          // one's "preview + accept" UI can render "Recommender used the
          // Strict preset" without recomputing matchPreset() every time.
          // Falls through as undefined for v1/v2 bundles that predate
          // the field; the consumer treats undefined the same as null.
          preset: bundle.recommender_profile_preset ?? null,
          recommenderName,
          stashedAt: importedAt,
        }));
        recommenderProfileStashed = true;
      } catch (e) {
        console.warn('[audit-bundle-import] failed to stash recommender profile:', e);
      }
    }

    // Migration-flow one-shot marker. Set when the bundle was exported
    // via the desktop migration wizard — the next dashboard load reads
    // this key, redirects to /dashboard/review-recommendations once,
    // then clears it. The marker is a JSON blob (rather than a bare
    // 'true') so future tweaks (route override, expiry, etc.) can
    // extend it without a schema migration.
    if (bundle.migration_flow === true) {
      try {
        setSetting('migration_flow_pending', JSON.stringify({
          recommenderName,
          stashedAt: importedAt,
          targetPath: '/dashboard/review-recommendations',
        }));
      } catch (e) {
        console.warn('[audit-bundle-import] failed to stash migration flag:', e);
      }
    }

    // Dedup row + activity log.
    if (opts.allowDuplicate) {
      // Walk the imported_at forward so subsequent finds report the
      // most recent acceptance. UPSERT keeps the unique-on-exported_at
      // constraint happy.
      db.prepare(
        `INSERT INTO audit_bundle_imports
           (id, exported_at, imported_at, recommender_name, bundle_app_version,
            apps_total, apps_added, apps_updated, apps_skipped, annotations_added)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(exported_at) DO UPDATE SET
           imported_at        = excluded.imported_at,
           recommender_name   = excluded.recommender_name,
           apps_total         = excluded.apps_total,
           apps_added         = excluded.apps_added,
           apps_updated       = excluded.apps_updated,
           apps_skipped       = excluded.apps_skipped,
           annotations_added  = excluded.annotations_added`,
      ).run(
        importId,
        bundle.exported_at,
        importedAt,
        bundle.recommender_name,
        bundle.app_version ?? null,
        bundle.apps.length,
        appsAdded,
        appsUpdated,
        appsSkipped,
        annotationsAdded,
      );
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO audit_bundle_imports
           (id, exported_at, imported_at, recommender_name, bundle_app_version,
            apps_total, apps_added, apps_updated, apps_skipped, annotations_added)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        importId,
        bundle.exported_at,
        importedAt,
        bundle.recommender_name,
        bundle.app_version ?? null,
        bundle.apps.length,
        appsAdded,
        appsUpdated,
        appsSkipped,
        annotationsAdded,
      );
    }

    return recommenderProfileStashed;
  });

  const recommenderProfileStashed = tx();

  return {
    appsTotal: bundle.apps.length,
    appsAdded,
    appsUpdated,
    appsSkipped,
    annotationsAdded,
    verdictsAdded,
    recommenderProfileStashed,
    // Pass through whatever the bundle carried — null for v1/v2 bundles
    // and for custom profiles. The caller decides whether to render it.
    recommenderProfilePreset: bundle.recommender_profile_preset ?? null,
    recommenderName,
  };
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * The bundle doesn't carry per-app `last_synced` directly (that's an
 * apps-table column the export currently leaves out — see lib/audit-
 * bundle.ts). The next-best signal is the `policy_summary.fetched_at`
 * if present, falling back to the bundle's `exported_at` epoch (since
 * the recommender's last sync can't have happened later than the
 * export). This rule is conservative: if either side has never
 * synced (lastSynced = 0) we treat the incoming as newer so the
 * recipient gets the data, not nothing.
 */
function guessIncomingLastSynced(app: BundleApp, exportedAt: string): number {
  const policyFetchedAt = app.policy_summary?.fetched_at ?? null;
  if (policyFetchedAt && policyFetchedAt > 0) return policyFetchedAt;
  const ms = Date.parse(exportedAt);
  return Number.isFinite(ms) ? ms : Date.now();
}

function upsertApp(app: BundleApp, lastSynced: number): void {
  // Pricing fields are COALESCE'd on update so a v1 bundle (which
  // doesn't carry price columns) doesn't blow away a recipient's
  // already-synced price data. v2 bundles carry them and re-sync them
  // through, but a recipient's own next sync still wins because that
  // hits the iTunes Lookup endpoint directly.
  db.prepare(
    `INSERT INTO apps
       (id, name, url, iconUrl, bundleId, developer, firstSeen, lastSynced,
        currentVersion, versionUpdatedAt, whatsNew, hasPrivacyDetails,
        hasAccessibilityLabels, privacyPolicyUrl,
        priceAmount, priceCurrency, priceFormatted, hasIap)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name                   = excluded.name,
       url                    = COALESCE(excluded.url, apps.url),
       iconUrl                = excluded.iconUrl,
       bundleId               = COALESCE(excluded.bundleId, apps.bundleId),
       developer              = COALESCE(excluded.developer, apps.developer),
       lastSynced             = excluded.lastSynced,
       currentVersion         = COALESCE(excluded.currentVersion, apps.currentVersion),
       hasPrivacyDetails      = excluded.hasPrivacyDetails,
       hasAccessibilityLabels = excluded.hasAccessibilityLabels,
       privacyPolicyUrl       = COALESCE(excluded.privacyPolicyUrl, apps.privacyPolicyUrl),
       priceAmount            = COALESCE(excluded.priceAmount, apps.priceAmount),
       priceCurrency          = COALESCE(excluded.priceCurrency, apps.priceCurrency),
       priceFormatted         = COALESCE(excluded.priceFormatted, apps.priceFormatted),
       hasIap                 = COALESCE(excluded.hasIap, apps.hasIap)`,
  ).run(
    app.id,
    app.name,
    app.url ?? '',
    app.icon_url,
    app.bundle_id,
    app.developer,
    lastSynced,
    lastSynced,
    app.current_version,
    app.has_privacy_details,
    app.has_accessibility_labels,
    app.privacy_policy_url,
    app.price_amount ?? null,
    app.price_currency ?? null,
    app.price_formatted ?? null,
    app.has_iap ?? null,
  );
}

function replaceAppLabels(app: BundleApp): void {
  // Wipe + re-insert: privacy_types FKs cascade to privacy_categories,
  // and accessibility_features is keyed solely by app_id. Mirrors the
  // scrape pipeline's transactional replace pattern in lib/scraper.ts.
  db.prepare('DELETE FROM privacy_types WHERE app_id = ?').run(app.id);
  db.prepare('DELETE FROM accessibility_features WHERE app_id = ?').run(app.id);

  for (const type of app.privacy_types) {
    const typeId = `pt-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(
      'INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(typeId, app.id, type.identifier, type.title, type.detail ?? null);

    for (const cat of type.categories ?? []) {
      const catId = `pc-${crypto.randomBytes(8).toString('hex')}`;
      db.prepare(
        'INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)',
      ).run(catId, typeId, cat.identifier, cat.title);
    }
  }

  for (const feature of app.accessibility_features ?? []) {
    if (!feature.declared) continue;
    const featureId = `af-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(
      `INSERT INTO accessibility_features
         (id, app_id, identifier, title, description, icon_template)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(featureId, app.id, feature.identifier, feature.title, feature.description ?? null);
  }
}

function upsertPolicySummary(app: BundleApp): void {
  const summary = app.policy_summary;
  if (!summary || (!summary.summary_json && !summary.source_text_excerpt)) return;
  if (!app.privacy_policy_url) return;

  // The bundle ships an excerpt of the source text rather than the full
  // doc (see lib/audit-bundle.ts); we store the excerpt as-is so the
  // existing UI's "preview policy text" affordance has something to show.
  const now = Date.now();
  db.prepare(
    `INSERT INTO privacy_policy_analyses
       (app_id, policy_url, status, source_text, source_word_count,
        analysis_mode, summary_json, model, error, updated_at,
        source_fetched_at, generated_at)
     VALUES (?, ?, 'ok', ?, ?, 'imported', ?, 'imported', NULL, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       policy_url        = excluded.policy_url,
       status            = excluded.status,
       source_text       = COALESCE(excluded.source_text, privacy_policy_analyses.source_text),
       source_word_count = excluded.source_word_count,
       analysis_mode     = excluded.analysis_mode,
       summary_json      = COALESCE(excluded.summary_json, privacy_policy_analyses.summary_json),
       model             = excluded.model,
       updated_at        = excluded.updated_at,
       source_fetched_at = COALESCE(excluded.source_fetched_at, privacy_policy_analyses.source_fetched_at),
       generated_at      = COALESCE(excluded.generated_at, privacy_policy_analyses.generated_at)`,
  ).run(
    app.id,
    app.privacy_policy_url,
    summary.source_text_excerpt ?? null,
    summary.source_text_excerpt ? summary.source_text_excerpt.split(/\s+/).length : 0,
    summary.summary_json ?? null,
    now,
    summary.fetched_at ?? null,
    summary.generated_at ?? null,
  );
}

// Type guard helper used by tests / debug callers — exported so
// future callers can re-use the validation result without re-parsing.
export type { BundleAnnotation };
