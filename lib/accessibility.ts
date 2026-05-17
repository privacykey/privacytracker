/**
 * Accessibility nutrition labels — Apple's App Store shelf declaring which
 * accessibility features (VoiceOver, Voice Control, …) an app supports.
 *
 *   extractAccessibilityFeatures(html)   → AccessibilityFeatureRecord[]
 *   writeAccessibilityFeatures(appId, …) → persists in a transaction
 *   buildAccessibilitySnapshot(appId)    → current DB state
 *   diffAccessibility(prev, next)        → ChangeEntry[] (category:'accessibility')
 *
 * Apple's JSON ships features at two paths in `shelfMapping`. We prefer the
 * rich `accessibilityHeader.seeAllAction.pageData.shelves[…]` path
 * (title + description) and fall back to the compact `accessibilityFeatures`
 * shelf (title only). Both absent → hasAccessibilityLabels = 0.
 */

import {
  type AccessibilityFeature,
  CANONICAL_ACCESSIBILITY_FEATURES as CANONICAL_FEATURES_TYPES,
  type CanonicalAccessibilityFeature,
} from "./accessibility-types";
import type { ChangeEntry } from "./changelog-types";
import db from "./db";

/**
 * A single accessibility feature on an app's listing. `identifier` is our
 * own slug (stable across scrapes if Apple keeps the en-US title stable)
 * — Apple does not expose a machine id.
 */
export interface AccessibilityFeatureRecord {
  description: string | null;
  /** SF Symbol template URI, e.g. "systemimage://voiceover". Null on legacy rows. */
  iconTemplate: string | null;
  identifier: string;
  title: string;
}

/**
 * Canonical feature catalogue. Used by the stats chart (every bar is present
 * even if no app supports the feature) and the app-detail legend (showing
 * what an app is missing). Re-exported from the client-safe `./accessibility-types`.
 */
export const CANONICAL_ACCESSIBILITY_FEATURES: readonly CanonicalAccessibilityFeature[] =
  CANONICAL_FEATURES_TYPES;

export type { AccessibilityFeature, CanonicalAccessibilityFeature };

/**
 * Convert a feature display title ("Voice Control") into a stable slug
 * ("voice_control") used as the row identifier.
 */
export function slugifyFeatureTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Walk the parsed serialized-server-data payload and return the features
 * declared by the developer. Returns `null` when the accessibility shelf is
 * absent entirely (hasAccessibilityLabels = 0); returns `[]` when the shelf
 * is present but empty. Unrecognised subtrees are skipped silently.
 */
export function extractAccessibilityFeatures(
  data: unknown
): AccessibilityFeatureRecord[] | null {
  const shelfMapping = readPath(data, [0, "data", "shelfMapping"]);
  if (!shelfMapping || typeof shelfMapping !== "object") {
    return null;
  }

  // Path 1 (preferred): rich variant with descriptions.
  const headerShelves = readPath(shelfMapping, [
    "accessibilityHeader",
    "seeAllAction",
    "pageData",
    "shelves",
  ]);
  if (Array.isArray(headerShelves)) {
    for (const shelf of headerShelves) {
      if (!shelf || typeof shelf !== "object") {
        continue;
      }
      if ((shelf as any).contentType !== "accessibilityFeatures") {
        continue;
      }
      const items = (shelf as any).items;
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (item && Array.isArray((item as any).features)) {
          return normalizeFeatures((item as any).features);
        }
      }
    }
  }

  // Path 2 (fallback): compact variant without descriptions.
  const directShelf = (shelfMapping as any).accessibilityFeatures;
  if (directShelf && typeof directShelf === "object") {
    const items = directShelf.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && Array.isArray((item as any).features)) {
          return normalizeFeatures((item as any).features);
        }
      }
    }
  }

  // Header present but no feature shelf — return empty array to signal
  // "shelf exists but is empty" rather than "completely absent". Callers
  // can still treat hasAccessibilityLabels as 0 since nothing is claimed.
  const headerAlone = (shelfMapping as any).accessibilityHeader;
  if (headerAlone) {
    return [];
  }

  return null;
}

function normalizeFeatures(raw: unknown[]): AccessibilityFeatureRecord[] {
  const seen = new Set<string>();
  const out: AccessibilityFeatureRecord[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") {
      continue;
    }
    const rawTitle = (f as any).title;
    if (typeof rawTitle !== "string") {
      continue;
    }
    const title = rawTitle.trim();
    if (!title) {
      continue;
    }

    const identifier = slugifyFeatureTitle(title);
    if (!identifier || seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);

    const rawDescription = (f as any).description;
    const description =
      typeof rawDescription === "string" && rawDescription.trim().length > 0
        ? rawDescription.trim()
        : null;

    const rawTemplate = (f as any).artwork?.template;
    const iconTemplate =
      typeof rawTemplate === "string" && rawTemplate.length > 0
        ? rawTemplate
        : null;

    out.push({ identifier, title, description, iconTemplate });
  }
  return out;
}

function readPath(obj: unknown, path: Array<string | number>): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null) {
      return null;
    }
    cur = cur[key as any];
  }
  return cur ?? null;
}

/**
 * Replace the entire accessibility feature set for an app in one transaction.
 * Callers MUST capture the previous snapshot via buildAccessibilitySnapshot
 * BEFORE calling this, otherwise the subsequent diff sees a freshly-wiped table.
 */
export function writeAccessibilityFeatures(
  appId: string,
  features: AccessibilityFeatureRecord[]
): void {
  const del = db.prepare("DELETE FROM accessibility_features WHERE app_id = ?");
  const ins = db.prepare(
    "INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    del.run(appId);
    for (const f of features) {
      ins.run(
        `${appId}_${f.identifier}`,
        appId,
        f.identifier,
        f.title,
        f.description,
        f.iconTemplate
      );
    }
  });
  tx();
}

/**
 * Read the current accessibility features for an app from the DB. Returns
 * `[]` for both "never scraped" and "no labels filed" — callers distinguish
 * the two via `apps.hasAccessibilityLabels`.
 */
export function buildAccessibilitySnapshot(
  appId: string
): AccessibilityFeatureRecord[] {
  const rows = db
    .prepare(
      "SELECT identifier, title, description, icon_template FROM accessibility_features WHERE app_id = ? ORDER BY identifier"
    )
    .all(appId) as Array<{
    identifier: string;
    title: string;
    description: string | null;
    icon_template: string | null;
  }>;
  return rows.map((r) => ({
    identifier: r.identifier,
    title: r.title,
    description: r.description,
    iconTemplate: r.icon_template,
  }));
}

/**
 * Diff two feature sets and emit ChangeEntry rows tagged
 * `category: 'accessibility'`. Merged into the privacy-label changes_summary
 * so the History timeline, bell notification, and review panel pick them up.
 */
export function diffAccessibility(
  prev: AccessibilityFeatureRecord[],
  next: AccessibilityFeatureRecord[]
): ChangeEntry[] {
  const prevMap = new Map(prev.map((f) => [f.identifier, f]));
  const nextMap = new Map(next.map((f) => [f.identifier, f]));

  const changes: ChangeEntry[] = [];

  for (const [id, feature] of nextMap) {
    if (!prevMap.has(id)) {
      changes.push({
        type: "added",
        description: `Now supports accessibility feature: "${feature.title}"`,
        category: "accessibility",
      });
    }
  }
  for (const [id, feature] of prevMap) {
    if (!nextMap.has(id)) {
      changes.push({
        type: "removed",
        description: `No longer claims accessibility feature: "${feature.title}"`,
        category: "accessibility",
      });
    }
  }

  return changes;
}

/**
 * List per-feature app counts across all tracked apps. Used by the stats
 * page's "X% of tracked apps support Y" chart.
 */
export function getAccessibilityCoverageByFeature(): Array<{
  identifier: string;
  title: string;
  appCount: number;
}> {
  return db
    .prepare(
      `SELECT identifier, MIN(title) AS title, COUNT(DISTINCT app_id) AS appCount
         FROM accessibility_features
         GROUP BY identifier
         ORDER BY appCount DESC, title ASC`
    )
    .all() as Array<{ identifier: string; title: string; appCount: number }>;
}
