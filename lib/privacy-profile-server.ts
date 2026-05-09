/**
 * Server-only helpers for the privacy profile feature. Reads/writes the
 * `privacy_profile` row in app_settings, and computes per-app mismatch data
 * by running a single SQL query against privacy_types/categories.
 *
 * Client components must NOT import from this file — they pull types and
 * pure helpers from `lib/privacy-profile.ts` instead.
 */

// Not using the `server-only` package — this codebase relies on the
// `-server.ts` filename convention plus db/fs imports to keep the module out
// of the client bundle, mirroring `lib/preferences-server.ts`.
import db from './db';
import { getSetting, setSetting } from './scheduler';
import {
  type AppMismatchSummary,
  type AppProfileBadge,
  type AppProfileFootprint,
  type PrivacyProfile,
  type ProfileMismatchResult,
  type ProfileTier,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
  computeProfileMismatch,
  parseStoredProfile,
  sanitizeProfile,
  summariseBadge,
} from './privacy-profile';

// Re-export so callers that already imported the server module get the shape
// without an extra dependency on privacy-profile. This is just a transitional
// convenience — new code should import straight from privacy-profile.
export type { AppMismatchSummary };

// ─────────────────────────────────────────────────────────────────────────────
// Profile read / write via app_settings. A single JSON blob keeps the DB
// schema unchanged — no migration needed — and gets imported/exported for free
// by existing backup tooling that round-trips the settings table.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_SETTING_KEY = 'privacy_profile';

/** Returns null when no profile has ever been saved, or when the stored JSON is unusable. */
export function getPrivacyProfile(): PrivacyProfile | null {
  const raw = getSetting(PROFILE_SETTING_KEY, '');
  return parseStoredProfile(raw);
}

/** Overwrite the profile. Pass `null` to clear ("no profile"). */
export function savePrivacyProfile(profile: PrivacyProfile | null): void {
  if (profile === null) {
    setSetting(PROFILE_SETTING_KEY, '');
    return;
  }
  const clean = sanitizeProfile(profile);
  setSetting(PROFILE_SETTING_KEY, JSON.stringify(clean));
}

/** `true` when the user has at least one explicit per-category preference set. */
export function hasPrivacyProfile(): boolean {
  const profile = getPrivacyProfile();
  if (!profile) return false;
  return Object.values(profile).some(v => typeof v === 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// Footprint builders. For a single app we need, per category the app collects,
// the WORST tier observed. The identifiers on privacy_types give us the tier
// directly (TYPE_IDENTIFIER_TO_TIER), and privacy_categories joins to them.
// ─────────────────────────────────────────────────────────────────────────────

interface FootprintRow {
  identifier: string; // category identifier, e.g. "LOCATION"
  type_identifier: string; // e.g. "DATA_USED_TO_TRACK_YOU"
}

function rowsToFootprint(rows: FootprintRow[]): AppProfileFootprint {
  const worst: Record<string, Exclude<ProfileTier, 'not_collected'>> = {};
  for (const row of rows) {
    const tier = TYPE_IDENTIFIER_TO_TIER[row.type_identifier];
    if (!tier || tier === 'not_collected') continue;
    const existing = worst[row.identifier];
    if (!existing || TIER_RANK[tier] > TIER_RANK[existing]) {
      worst[row.identifier] = tier as Exclude<ProfileTier, 'not_collected'>;
    }
  }
  return { worstByCategory: worst };
}

/** Build a footprint for a single app. Returns an empty footprint if the app has no privacy data. */
export function buildAppFootprint(appId: string): AppProfileFootprint {
  const rows = db
    .prepare(
      `SELECT c.identifier AS identifier, t.identifier AS type_identifier
       FROM privacy_categories c
       JOIN privacy_types t ON c.type_id = t.id
       WHERE t.app_id = ?`,
    )
    .all(appId) as FootprintRow[];
  return rowsToFootprint(rows);
}

/** Build footprints for every tracked app in a single SQL query. */
export function buildAllFootprints(): Map<string, AppProfileFootprint> {
  const rows = db
    .prepare(
      `SELECT t.app_id AS app_id, c.identifier AS identifier, t.identifier AS type_identifier
       FROM privacy_categories c
       JOIN privacy_types t ON c.type_id = t.id`,
    )
    .all() as Array<FootprintRow & { app_id: string }>;

  const byApp = new Map<string, FootprintRow[]>();
  for (const row of rows) {
    const list = byApp.get(row.app_id) ?? [];
    list.push({ identifier: row.identifier, type_identifier: row.type_identifier });
    byApp.set(row.app_id, list);
  }

  const out = new Map<string, AppProfileFootprint>();
  for (const [appId, list] of byApp) {
    out.set(appId, rowsToFootprint(list));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mismatch queries — pull profile once, iterate footprints.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the mismatch comparison over every tracked app. Returns only apps that
 * actually mismatch, sorted by totalGap desc. Callers that need "all apps,
 * even clean ones" can call computeAppMismatch() per app instead.
 */
export function getMismatchedApps(): AppMismatchSummary[] {
  const profile = getPrivacyProfile();
  if (!profile) return [];

  const apps = db
    .prepare(`SELECT id, name, iconUrl, developer FROM apps`)
    .all() as Array<{ id: string; name: string; iconUrl?: string; developer?: string }>;
  const footprints = buildAllFootprints();

  const out: AppMismatchSummary[] = [];
  for (const app of apps) {
    const footprint = footprints.get(app.id) ?? { worstByCategory: {} };
    const mismatch = computeProfileMismatch(profile, footprint);
    if (mismatch.count === 0) continue;
    out.push({
      appId: app.id,
      appName: app.name,
      iconUrl: app.iconUrl,
      developer: app.developer,
      mismatch,
    });
  }

  out.sort((a, b) => b.mismatch.totalGap - a.mismatch.totalGap || a.appName.localeCompare(b.appName));
  return out;
}

/** Convenience: mismatch for a single app using the currently saved profile. */
export function computeAppMismatch(appId: string): ProfileMismatchResult {
  const profile = getPrivacyProfile();
  const footprint = buildAppFootprint(appId);
  return computeProfileMismatch(profile, footprint);
}

/** Map of appId → mismatch count — lightweight accessor for list views / badges. */
export function getMismatchCountsByApp(): Map<string, number> {
  const profile = getPrivacyProfile();
  if (!profile) return new Map();

  const footprints = buildAllFootprints();
  const out = new Map<string, number>();
  for (const [appId, footprint] of footprints) {
    const result = computeProfileMismatch(profile, footprint);
    if (result.count > 0) out.set(appId, result.count);
  }
  return out;
}

/**
 * Per-app badge data for the grid / any card-like surface. Returns the full
 * `Record<appId, AppProfileBadge>` for every tracked app — including clean
 * matches, so the grid can render a green "Matches profile" pill as well as
 * the orange / red mismatch pills. Returns an empty object when no profile
 * is set (callers should hide the badge entirely in that case).
 */
export function getProfileBadgesByApp(): Record<string, AppProfileBadge> {
  const profile = getPrivacyProfile();
  if (!profile) return {};

  const apps = db.prepare(`SELECT id FROM apps`).all() as Array<{ id: string }>;
  const footprints = buildAllFootprints();

  const out: Record<string, AppProfileBadge> = {};
  for (const { id } of apps) {
    const footprint = footprints.get(id) ?? { worstByCategory: {} };
    const result = computeProfileMismatch(profile, footprint);
    // When no preferences are active, summariseBadge returns the "no profile"
    // placeholder — which we never want to surface on cards. Skip those so
    // the grid can treat "missing key" as "hide the badge".
    if (!result.profileActive) continue;
    out[id] = summariseBadge(result);
  }
  return out;
}
