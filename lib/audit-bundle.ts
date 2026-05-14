/**
 * Audit-bundle export (round 3 PR 5).
 *
 * Produces a versioned JSON file the recommender shares with the loved one.
 * Bundle contents (per docs §4.8):
 *
 *   - app list with privacy labels + risk classifications
 *   - policy text + AI summaries (hand-written or generated)
 *   - accessibility coverage per app
 *   - annotations (only those with visibility = 'export'; private notes
 *     are unconditionally excluded by the SQL filter, no escape hatch)
 *   - the recommender's privacy profile (optional; controlled by the
 *     `includeRecommenderProfile` flag at export time), plus the
 *     matching preset key (Strict / Balanced / Anti-tracking only /
 *     Permissive) when the profile happens to match one of the named
 *     shortcuts — surfaced as `recommender_profile_preset`
 *
 * Excluded by design:
 *
 *   - the user's focus state (audience + goals — recipient picks their own)
 *   - flag overrides (recipient gets fresh defaults)
 *   - AI provider config + keys
 *   - notification prefs
 *
 * Filename convention: `{recommender-name}-{ISO-date}-{HHmm}.audit.json`,
 * with `audit-{date}-{HHmm}.audit.json` as the no-name fallback.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

import packageJson from '../package.json';
import db from './db';
import { getPrivacyProfile } from './privacy-profile-server';
import { matchPreset, type ProfilePresetKey } from './privacy-profile';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Bumped to 2 when verdicts were added — the importer's contract is
// "accept v1 OR v2 bundles". v1 bundles simply have no `verdicts` field
// and import as-before. v2 bundles include verdicts; older app builds
// reading a v2 bundle ignore the field and still produce a working
// import (forward-compatible). When breaking the shape becomes
// necessary, bump again and add a v2-import path that's distinct from
// the latest.
export const BUNDLE_VERSION = 2;

export interface AuditBundle {
  version: number;
  app_version: string;
  exported_at: string;          // ISO-8601
  exported_by_audience: 'self' | 'loved_one' | 'guardian';
  recommender_name: string | null;
  apps: BundleApp[];
  recommender_profile: ReturnType<typeof getPrivacyProfile> | null;
  /**
   * The named preset key (`strict` / `balanced` / `anti_tracking` /
   * `permissive`) the recommender's profile exactly matches at export
   * time, or `null` when their profile is custom or absent. Optional in
   * the type for forward/back compat — older bundles simply omit the
   * field, and importers that don't know about it just ignore the value.
   *
   * Only meaningful when `recommender_profile` is non-null; if the
   * profile is excluded from the export, this field is null too.
   */
  recommender_profile_preset?: ProfilePresetKey | null;
  annotations: BundleAnnotation[];
  /**
   * Per-app verdicts the recommender has set. Only 'user' source rows
   * are exported — imported recommendations the recommender themselves
   * received from someone else don't propagate (those are advisory by
   * definition; a user has to make their own decision before re-sharing).
   *
   * Optional in the type for v1 backward compat; the v2 builder always
   * emits the field (empty array when nothing's been decided yet).
   */
  verdicts?: BundleVerdict[];
  /**
   * Migration-flow marker. Added in v1.2 of the desktop migration wizard
   * (round 3). When present and `true`, the receiving install treats the
   * import as a same-user device migration rather than a recommendation
   * from a third party — and will route the user straight into the
   * Review-and-Act wizard once the import lands instead of dropping them
   * on the dashboard.
   *
   * Optional + defaults to absent so older bundles continue to import as
   * regular recommendations. The server only sets it when the export
   * caller explicitly opts in via `migrationFlow: true`.
   */
  migration_flow?: boolean;
}

export interface BundleApp {
  id: string;
  name: string;
  developer: string | null;
  bundle_id: string | null;
  url: string | null;
  icon_url: string | null;
  current_version: string | null;
  privacy_policy_url: string | null;
  has_privacy_details: number | null;
  has_accessibility_labels: number | null;
  privacy_types: BundlePrivacyType[];
  accessibility_features: BundleAccessibilityFeature[];
  policy_summary: BundlePolicySummary | null;
  /**
   * Phase 2 pricing snapshot. All four are optional on the type for
   * v1 backward compat — older bundles simply don't carry them, and
   * the importer falls back to "leave the row's existing value alone"
   * when a field is absent. v2+ exporters always emit the four fields
   * (NULL when the recommender's DB hasn't seen a successful lookup
   * yet) so the recipient sees the same financials the recommender
   * saw at export time.
   */
  price_amount?: number | null;
  price_currency?: string | null;
  price_formatted?: string | null;
  has_iap?: number | null;
}

export interface BundlePrivacyType {
  identifier: string;
  title: string;
  detail: string | null;
  categories: Array<{ identifier: string; title: string }>;
}

export interface BundleAccessibilityFeature {
  identifier: string;
  title: string;
  declared: boolean;
  description: string | null;
}

export interface BundlePolicySummary {
  summary_json: string | null;
  source_text_excerpt: string | null;
  fetched_at: number | null;
  generated_at: number | null;
}

export interface BundleAnnotation {
  id: string;
  app_id: string;
  content: string;
  source: 'user' | 'imported';
  source_name: string | null;
  /** visibility is always 'export' in the bundle — private notes filtered out at SQL */
  visibility: 'export';
  tag: string | null;
  created_at: number;
  updated_at: number;
}

export interface BundleVerdict {
  app_id: string;
  /** 'safe' | 'replace' | 'uninstall'. */
  verdict: string;
  rationale: string | null;
  set_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Build the bundle
// ---------------------------------------------------------------------------

interface BuildOptions {
  /**
   * Whether to include the user's privacy profile in the bundle.
   * Defaults to true (matches the export-modal default checkbox).
   */
  includeRecommenderProfile?: boolean;
  /** Free-text recommender name. Falls back to "your friend" downstream. */
  recommenderName?: string | null;
  /** The exporter's audience. Captured for downstream UX (banner copy etc.). */
  exportedByAudience?: 'self' | 'loved_one' | 'guardian';
  /**
   * Migration-flow opt-in (round 3 v1.2). When true, the bundle's
   * `migration_flow` field is set so the receiving install can
   * detect a same-user migration and route the user straight to
   * /dashboard/review-recommendations on import. Defaults to false —
   * normal recommend-to-loved-one exports never flip this on.
   */
  migrationFlow?: boolean;
}

/**
 * Build the bundle as a plain JS object. Caller serialises to JSON.
 * Synchronous (better-sqlite3 reads); intended for server-side use only.
 */
export function buildAuditBundle(opts: BuildOptions = {}): AuditBundle {
  const {
    includeRecommenderProfile = true,
    recommenderName = null,
    exportedByAudience = 'self',
    migrationFlow = false,
  } = opts;

  const apps = buildAppList();
  const annotations = buildAnnotationList();
  const verdicts = buildVerdictList();
  const recommenderProfile = includeRecommenderProfile ? getPrivacyProfile() : null;
  // Compute the matching preset key only when the profile is being
  // included. matchPreset() returns null for sparse / customised
  // profiles, which is the value we want to surface either way —
  // recipients can render "exported with the Strict preset" only when
  // the field carries a real key.
  const recommenderProfilePreset = recommenderProfile
    ? matchPreset(recommenderProfile)
    : null;

  return {
    version: BUNDLE_VERSION,
    app_version: (packageJson as { version: string }).version,
    exported_at: new Date().toISOString(),
    exported_by_audience: exportedByAudience,
    recommender_name: recommenderName,
    apps,
    recommender_profile: recommenderProfile,
    recommender_profile_preset: recommenderProfilePreset,
    annotations,
    verdicts,
    // Only emit the field when the caller explicitly opted in — older
    // recipients that don't know the field exists will simply ignore
    // the absence (current behaviour) instead of seeing a `false` they
    // need to special-case. Forward-compat too: a future v3 importer
    // can rely on `migration_flow === true` as a signal without having
    // to inspect the absence/null dance.
    ...(migrationFlow ? { migration_flow: true as const } : {}),
  };
}

function buildAppList(): BundleApp[] {
  const appRows = db.prepare(`
    SELECT id, name, developer, bundleId, url, iconUrl, currentVersion,
           privacyPolicyUrl, hasPrivacyDetails, hasAccessibilityLabels,
           priceAmount, priceCurrency, priceFormatted, hasIap
    FROM apps
    ORDER BY name COLLATE NOCASE
  `).all() as Array<{
    id: string;
    name: string;
    developer: string | null;
    bundleId: string | null;
    url: string | null;
    iconUrl: string | null;
    currentVersion: string | null;
    privacyPolicyUrl: string | null;
    hasPrivacyDetails: number | null;
    hasAccessibilityLabels: number | null;
    priceAmount: number | null;
    priceCurrency: string | null;
    priceFormatted: string | null;
    hasIap: number | null;
  }>;

  return appRows.map((row) => ({
    id: row.id,
    name: row.name,
    developer: row.developer,
    bundle_id: row.bundleId,
    url: row.url,
    icon_url: row.iconUrl,
    current_version: row.currentVersion,
    privacy_policy_url: row.privacyPolicyUrl,
    has_privacy_details: row.hasPrivacyDetails,
    has_accessibility_labels: row.hasAccessibilityLabels,
    privacy_types: buildPrivacyTypes(row.id),
    accessibility_features: buildAccessibilityFeatures(row.id),
    policy_summary: buildPolicySummary(row.id),
    price_amount: row.priceAmount,
    price_currency: row.priceCurrency,
    price_formatted: row.priceFormatted,
    has_iap: row.hasIap,
  }));
}

function buildPrivacyTypes(appId: string): BundlePrivacyType[] {
  const types = db.prepare(`
    SELECT id, identifier, title, detail
    FROM privacy_types
    WHERE app_id = ?
    ORDER BY title
  `).all(appId) as Array<{ id: string; identifier: string; title: string; detail: string | null }>;

  return types.map((t) => {
    const categories = db.prepare(`
      SELECT identifier, title
      FROM privacy_categories
      WHERE type_id = ?
      ORDER BY title
    `).all(t.id) as Array<{ identifier: string; title: string }>;

    return {
      identifier: t.identifier,
      title: t.title,
      detail: t.detail,
      categories,
    };
  });
}

function buildAccessibilityFeatures(appId: string): BundleAccessibilityFeature[] {
  // The accessibility_features table may not exist on all installs (depends
  // on whether the user opted into a11y tracking). Return empty array when
  // the table is missing rather than crashing the export.
  try {
    const rows = db.prepare(`
      SELECT identifier, title, description
      FROM accessibility_features
      WHERE app_id = ?
      ORDER BY title
    `).all(appId) as Array<{
      identifier: string;
      title: string;
      description: string | null;
    }>;
    return rows.map((r) => ({
      identifier: r.identifier,
      title: r.title,
      declared: true,
      description: r.description,
    }));
  } catch {
    return [];
  }
}

function buildPolicySummary(appId: string): BundlePolicySummary | null {
  try {
    const row = db.prepare(`
      SELECT summary_json, source_text, source_fetched_at, updated_at AS generated_at
      FROM privacy_policy_analyses
      WHERE app_id = ?
      LIMIT 1
    `).get(appId) as
      | { summary_json: string | null; source_text: string | null; source_fetched_at: number | null; generated_at: number | null }
      | undefined;
    if (!row) return null;

    // Truncate source text — don't ship the full policy in every bundle.
    // 4kb is enough context for the recipient to verify what was summarised.
    const excerpt = row.source_text ? row.source_text.slice(0, 4096) : null;

    return {
      summary_json: row.summary_json,
      source_text_excerpt: excerpt,
      fetched_at: row.source_fetched_at,
      generated_at: row.generated_at,
    };
  } catch {
    return null;
  }
}

function buildAnnotationList(): BundleAnnotation[] {
  // visibility = 'export' filter is the hard guarantee — private notes
  // never leave the device, regardless of any caller flags.
  const rows = db.prepare(`
    SELECT id, app_id, content, source, source_name, visibility,
           tag, created_at, updated_at
    FROM annotations
    WHERE deleted_at IS NULL
      AND visibility = 'export'
    ORDER BY created_at DESC
  `).all() as Array<BundleAnnotation>;
  return rows;
}

/**
 * Recommender's own verdicts only. Imported recommendations the
 * recommender received from someone else stay put — they don't
 * propagate through a re-share, because a verdict's authority comes
 * from the person who set it, not from being passed along.
 */
function buildVerdictList(): BundleVerdict[] {
  const rows = db.prepare(`
    SELECT app_id, verdict, rationale, set_at, updated_at
    FROM app_verdicts
    WHERE source = 'user'
    ORDER BY updated_at DESC
  `).all() as Array<BundleVerdict>;
  return rows;
}

// ---------------------------------------------------------------------------
// Filename helper
// ---------------------------------------------------------------------------

/**
 * Build the suggested filename for the saved bundle, per §4.8 conventions.
 * `{name}-{YYYY-MM-DD}-{HHmm}.audit.json` with a `audit-...` fallback when
 * no name was captured at export time.
 */
export function buildBundleFilename(recommenderName: string | null, when: Date = new Date()): string {
  const yyyy = when.getFullYear();
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const min = String(when.getMinutes()).padStart(2, '0');
  const datePart = `${yyyy}-${mm}-${dd}-${hh}${min}`;

  // Slugify the name: lower, replace whitespace with hyphens, strip
  // unsafe filesystem chars. Empty / null falls back to 'audit'.
  const sanitised = (recommenderName ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const stem = sanitised || 'audit';

  return `${stem}-${datePart}.audit.json`;
}
