import db from "./db";
import type { DeviceScope } from "./device-scope";
import { scopeSqlClause } from "./device-scope-server";

const DAY = 86_400_000;
export const REVIEW_DAYS = [1, 7, 30] as const;
const get = (key: string): string =>
  (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value ?? "";
const put = (key: string, value: string) =>
  db
    .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
    .run(key, value);

/** A new collection type, category or data item reopens the decision. Removals
 * alone do not. Policy and accessibility notifications remain independent. */
export function collectionTokens(appId: string): string[] {
  const rows = db
    .prepare(`SELECT t.identifier AS kind, c.identifier AS category, d.title AS item
    FROM privacy_types t LEFT JOIN privacy_categories c ON c.type_id = t.id
    LEFT JOIN privacy_data_types d ON d.category_id = c.id WHERE t.app_id = ?`)
    .all(appId);
  return [
    ...new Set(
      rows.flatMap((row) => {
        const r = row as {
          kind: string;
          category: string | null;
          item: string | null;
        };
        const tokens = [JSON.stringify([r.kind])];
        if (r.category !== null) {
          tokens.push(JSON.stringify([r.kind, r.category]));
        }
        if (r.item !== null) {
          tokens.push(JSON.stringify([r.kind, r.category, r.item]));
        }
        return tokens;
      })
    ),
  ];
}

export function acceptCurrentConcern(appId: string): void {
  put(
    `review.accept.${appId}`,
    JSON.stringify({
      profile: get("privacy_profile"),
      tokens: collectionTokens(appId),
    })
  );
}

/** Undoing a new acceptance must not leave the new concern suppressed. */
export function clearConcernAcceptance(appId: string): void {
  put(`review.accept.${appId}`, "");
}

function acceptedCollections(): Map<string, string[]> {
  const rows = db
    .prepare(`SELECT t.app_id AS appId, t.identifier AS kind, c.identifier AS category, d.title AS item
    FROM privacy_types t LEFT JOIN privacy_categories c ON c.type_id = t.id
    LEFT JOIN privacy_data_types d ON d.category_id = c.id
    WHERE EXISTS (SELECT 1 FROM app_settings s WHERE s.key = 'review.accept.' || t.app_id)`)
    .all() as {
    appId: string;
    kind: string;
    category: string | null;
    item: string | null;
  }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.appId) ?? [];
    list.push(JSON.stringify([r.kind]));
    if (r.category !== null) {
      list.push(JSON.stringify([r.kind, r.category]));
    }
    if (r.item !== null) {
      list.push(JSON.stringify([r.kind, r.category, r.item]));
    }
    map.set(r.appId, list);
  }
  return map;
}

export function hasAcceptedConcern(
  appId: string,
  collections?: Map<string, string[]>
): boolean {
  const verdict = db
    .prepare(
      "SELECT verdict FROM app_verdicts WHERE app_id = ? AND source = 'user'"
    )
    .get(appId) as { verdict: string } | undefined;
  if (verdict?.verdict !== "safe") {
    return false;
  }
  try {
    const saved = JSON.parse(get(`review.accept.${appId}`));
    return (
      saved.profile === get("privacy_profile") &&
      Array.isArray(saved.tokens) &&
      (collections
        ? (collections.get(appId) ?? [])
        : collectionTokens(appId)
      ).every((token) => saved.tokens.includes(token))
    );
  } catch {
    return false;
  }
}

export function deferredUntil(appId: string): number | null {
  const n = Number(get(`review.defer.${appId}`));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function clearDeferral(appId: string): void {
  if (get(`review.defer.${appId}`)) {
    put(`review.defer.${appId}`, "");
  }
}
export function deferDecision(
  appId: string,
  days: number,
  now = Date.now()
): number {
  if (!REVIEW_DAYS.includes(days as 1 | 7 | 30)) {
    throw new Error("deferDays must be 1, 7 or 30");
  }
  if (!db.prepare("SELECT id FROM apps WHERE id = ?").get(appId)) {
    throw new Error("App not found");
  }
  const until = now + days * DAY;
  put(`review.defer.${appId}`, String(until));
  return until;
}

export interface FocusOverviewApp {
  changeCount: number;
  decision: "review" | "kept" | "replace" | "uninstall" | "later" | "due";
  iconUrl: string | null;
  id: string;
  name: string;
  remindAt: number | null;
}
export interface FocusOverviewData {
  apps: FocusOverviewApp[];
  dueCount: number;
  newChanges: number | null;
  pendingChanges: number;
  replacementCount: number;
}

export function getReviewDecisions(
  scope?: DeviceScope,
  now = Date.now()
): {
  acceptedAppIds: string[];
  deferredAppIds: string[];
  reopenedAppIds: string[];
} {
  const fragment = scope ? scopeSqlClause(scope, "a") : null;
  const apps = db
    .prepare(
      `SELECT a.id FROM apps a ${fragment ? `WHERE ${fragment.clause}` : ""} ORDER BY a.id`
    )
    .all(...(fragment?.params ?? [])) as { id: string }[];
  const result = {
    acceptedAppIds: [] as string[],
    deferredAppIds: [] as string[],
    reopenedAppIds: [] as string[],
  };
  const collections = acceptedCollections();
  for (const { id } of apps) {
    const accepted = hasAcceptedConcern(id, collections);
    const until = deferredUntil(id);
    if (accepted) {
      result.acceptedAppIds.push(id);
    }
    if (until && until > now) {
      result.deferredAppIds.push(id);
    }
    if (
      (until && until <= now) ||
      (get(`review.accept.${id}`) &&
        !accepted &&
        !!db
          .prepare(
            "SELECT id FROM app_verdicts WHERE app_id = ? AND source = 'user' AND verdict = 'safe'"
          )
          .get(id))
    ) {
      result.reopenedAppIds.push(id);
    }
  }
  return result;
}

export function getFocusOverview(
  scope?: DeviceScope,
  since?: number,
  now = Date.now()
): FocusOverviewData {
  const fragment = scope ? scopeSqlClause(scope, "a") : null;
  const rows = db
    .prepare(`SELECT a.id, a.name, a.iconUrl, a.changeCount,
    (SELECT MAX(scraped_at) FROM privacy_snapshots WHERE app_id = a.id AND changes_detected = 1 AND COALESCE(source, 'live') = 'live') AS changedAt,
    (SELECT verdict FROM app_verdicts WHERE app_id = a.id AND source = 'user') AS verdict
    FROM apps a ${fragment ? `WHERE ${fragment.clause}` : ""} ORDER BY a.name, a.id`)
    .all(...(fragment?.params ?? [])) as Array<{
    id: string;
    name: string;
    iconUrl: string | null;
    changeCount: number;
    changedAt: number | null;
    verdict: string | null;
  }>;
  let dueCount = 0;
  let replacementCount = 0;
  const collections = acceptedCollections();
  const apps: FocusOverviewApp[] = rows.map((row) => {
    const remindAt = deferredUntil(row.id);
    if (remindAt && remindAt <= now) {
      dueCount++;
    }
    if (row.verdict === "replace") {
      replacementCount++;
    }
    const decision = remindAt
      ? remindAt <= now
        ? "due"
        : "later"
      : row.verdict === "safe" && hasAcceptedConcern(row.id, collections)
        ? "kept"
        : row.verdict === "replace" || row.verdict === "uninstall"
          ? row.verdict
          : "review";
    return {
      id: row.id,
      name: row.name,
      iconUrl: row.iconUrl,
      changeCount: row.changeCount,
      decision,
      remindAt,
    };
  });
  const priority = (a: FocusOverviewApp) =>
    a.remindAt && a.remindAt <= now
      ? 0
      : a.decision === "replace"
        ? 1
        : a.changeCount > 0
          ? 2
          : 3;
  apps.sort((a, b) => priority(a) - priority(b));
  return {
    apps: apps.slice(0, 8),
    pendingChanges: rows.filter((a) => a.changeCount > 0).length,
    newChanges:
      since === undefined
        ? null
        : rows.filter((a) => (a.changedAt ?? 0) > since).length,
    dueCount,
    replacementCount,
  };
}
