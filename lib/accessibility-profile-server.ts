/**
 * Server-only helpers for the accessibility profile feature. Reads/writes the
 * `accessibility_profile` row in app_settings, and computes per-app mismatch
 * data by running a single SQL query against `accessibility_features`.
 *
 * Client components must NOT import from this file — they pull types and pure
 * helpers from `lib/accessibility-profile.ts` instead. Mirrors
 * `lib/privacy-profile-server.ts` almost 1:1 — keep them in lockstep so the
 * Settings / grid / Compare wiring stays symmetrical.
 */

import {
  type A11yMismatchResult,
  type A11yProfileBadge,
  type AccessibilityFootprint,
  type AccessibilityProfile,
  computeA11yMismatch,
  parseStoredA11yProfile,
  sanitizeA11yProfile,
  summariseA11yBadge,
} from "./accessibility-profile";
// `-server.ts` filename convention keeps this module out of the client bundle,
// same pattern as lib/privacy-profile-server.ts.
import db from "./db";
import { getSetting, setSetting } from "./scheduler";

// ─────────────────────────────────────────────────────────────────────────────
// Profile read / write via app_settings. A single JSON blob keeps the DB
// schema unchanged — no migration needed — and gets imported/exported for free
// by existing backup tooling that round-trips the settings table.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_SETTING_KEY = "accessibility_profile";

/** Returns null when no profile has ever been saved, or when the stored JSON is unusable. */
export function getAccessibilityProfile(): AccessibilityProfile | null {
  const raw = getSetting(PROFILE_SETTING_KEY, "");
  return parseStoredA11yProfile(raw);
}

/** Overwrite the profile. Pass `null` to clear ("no profile"). */
export function saveAccessibilityProfile(
  profile: AccessibilityProfile | null
): void {
  if (profile === null) {
    setSetting(PROFILE_SETTING_KEY, "");
    return;
  }
  const clean = sanitizeA11yProfile(profile);
  setSetting(PROFILE_SETTING_KEY, JSON.stringify(clean));
}

/** `true` when the user has at least one explicit per-feature preference set. */
export function hasAccessibilityProfile(): boolean {
  const profile = getAccessibilityProfile();
  if (!profile) {
    return false;
  }
  return Object.values(profile).some((v) => typeof v === "string");
}

// ─────────────────────────────────────────────────────────────────────────────
// Footprint builders. For a single app we just need the set of declared
// feature identifiers, since mismatch is a plain set difference against the
// user's preference keys.
// ─────────────────────────────────────────────────────────────────────────────

interface FootprintRow {
  identifier: string; // feature identifier, e.g. "voiceover"
}

/** Build a footprint for a single app. Returns an empty footprint when the app has no accessibility rows. */
export function buildAppA11yFootprint(appId: string): AccessibilityFootprint {
  const rows = db
    .prepare("SELECT identifier FROM accessibility_features WHERE app_id = ?")
    .all(appId) as FootprintRow[];
  return { declared: new Set(rows.map((r) => r.identifier)) };
}

/** Build footprints for every tracked app in a single SQL query. */
export function buildAllA11yFootprints(): Map<string, AccessibilityFootprint> {
  const rows = db
    .prepare("SELECT app_id, identifier FROM accessibility_features")
    .all() as Array<FootprintRow & { app_id: string }>;

  const byApp = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byApp.get(row.app_id) ?? new Set<string>();
    set.add(row.identifier);
    byApp.set(row.app_id, set);
  }

  const out = new Map<string, AccessibilityFootprint>();
  for (const [appId, declared] of byApp) {
    out.set(appId, { declared });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mismatch queries — pull profile once, iterate footprints.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppA11yMismatchSummary {
  appId: string;
  appName: string;
  developer?: string;
  iconUrl?: string;
  mismatch: A11yMismatchResult;
}

/**
 * Run the mismatch comparison over every tracked app. Returns only apps that
 * actually mismatch, sorted by totalGap desc. Callers that need "all apps,
 * even clean ones" can call computeAppA11yMismatch() per app instead.
 */
export function getA11yMismatchedApps(): AppA11yMismatchSummary[] {
  const profile = getAccessibilityProfile();
  if (!profile) {
    return [];
  }

  const apps = db
    .prepare("SELECT id, name, iconUrl, developer FROM apps")
    .all() as Array<{
    id: string;
    name: string;
    iconUrl?: string;
    developer?: string;
  }>;
  const footprints = buildAllA11yFootprints();

  const out: AppA11yMismatchSummary[] = [];
  for (const app of apps) {
    const footprint = footprints.get(app.id) ?? { declared: new Set<string>() };
    const mismatch = computeA11yMismatch(profile, footprint);
    if (mismatch.count === 0) {
      continue;
    }
    out.push({
      appId: app.id,
      appName: app.name,
      iconUrl: app.iconUrl,
      developer: app.developer,
      mismatch,
    });
  }

  out.sort(
    (a, b) =>
      b.mismatch.totalGap - a.mismatch.totalGap ||
      a.appName.localeCompare(b.appName)
  );
  return out;
}

/** Convenience: mismatch for a single app using the currently saved profile. */
export function computeAppA11yMismatch(appId: string): A11yMismatchResult {
  const profile = getAccessibilityProfile();
  const footprint = buildAppA11yFootprint(appId);
  return computeA11yMismatch(profile, footprint);
}

/** Map of appId → mismatch count — lightweight accessor for list views / badges. */
export function getA11yMismatchCountsByApp(): Map<string, number> {
  const profile = getAccessibilityProfile();
  if (!profile) {
    return new Map();
  }

  const footprints = buildAllA11yFootprints();
  const out = new Map<string, number>();
  for (const [appId, footprint] of footprints) {
    const result = computeA11yMismatch(profile, footprint);
    if (result.count > 0) {
      out.set(appId, result.count);
    }
  }
  return out;
}

/**
 * Per-app badge data for the grid / any card-like surface. Returns the full
 * `Record<appId, A11yProfileBadge>` for every tracked app — including clean
 * matches, so the grid can render a green "A11y match" pill as well as the
 * amber / red mismatch pills. Returns an empty object when no profile is set
 * (callers should hide the badge entirely in that case).
 */
export function getA11yBadgesByApp(): Record<string, A11yProfileBadge> {
  const profile = getAccessibilityProfile();
  if (!profile) {
    return {};
  }

  const apps = db.prepare("SELECT id FROM apps").all() as Array<{ id: string }>;
  const footprints = buildAllA11yFootprints();

  const out: Record<string, A11yProfileBadge> = {};
  for (const { id } of apps) {
    const footprint = footprints.get(id) ?? { declared: new Set<string>() };
    const result = computeA11yMismatch(profile, footprint);
    // `summariseA11yBadge` returns a "No profile" placeholder when no
    // preferences are active — the grid would never want to surface that, so
    // drop those rows and let callers treat "missing key" as "hide the badge".
    if (!result.profileActive) {
      continue;
    }
    out[id] = summariseA11yBadge(result);
  }
  return out;
}
