/**
 * Server-only helpers for the global device scope. Stores the
 * JSON-encoded scope as a single `app_settings` row keyed `device.scope`.
 * Pure helpers (reconcile, match, serialise, describe) live in
 * `lib/device-scope.ts` so client components can import them without
 * dragging the SQLite layer in.
 *
 * Mirrors the split used by `lib/dashboard-layout-server.ts` /
 * `lib/dashboard-layout.ts`.
 *
 * Two ways to apply a scope to a query, and they are not interchangeable:
 *
 *   - `scopeSqlClause()` returns a SQL fragment for callers that page or
 *     count in the database (`getAppsPage`, `countApps`). Nothing is
 *     materialised, so it stays flat at 10k apps.
 *   - `getScopedAppIds()` returns a Set for callers that already hold
 *     rows in memory and filter in JS (review queue, shortlist groups).
 *     Bounded by the fleet size — don't reach for it on a hot path that
 *     the SQL fragment could serve.
 */

// `server-only` not used here — this codebase relies on the `-server.ts`
// filename convention plus DB imports to keep the module out of the
// client bundle.
import db from "./db";
import {
  type DeviceScope,
  parseScopeParam,
  reconcileScope,
  SCOPE_ALL,
} from "./device-scope";
import { getSetting, setSetting } from "./scheduler";

const SCOPE_SETTING_KEY = "device.scope";

function knownDeviceIds(): string[] {
  try {
    const rows = db.prepare("SELECT id FROM devices").all() as { id: string }[];
    return rows.map((r) => r.id);
  } catch {
    // `devices` missing mid-migration — behave as if no devices exist,
    // which reconciles every stored subset back to SCOPE_ALL.
    return [];
  }
}

/**
 * Read the stored scope, reconciled against the devices that currently
 * exist. Always returns a usable scope — missing, malformed, or
 * stale-pointing rows fall through to SCOPE_ALL.
 */
export function getDeviceScope(): DeviceScope {
  const raw = getSetting(SCOPE_SETTING_KEY, "");
  if (!raw) {
    return { ...SCOPE_ALL };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt row — bail to the unrestricted scope without clobbering
    // it, so an operator can still salvage the value by hand.
    return { ...SCOPE_ALL };
  }
  return reconcileScope(parsed, knownDeviceIds());
}

/** Persist a scope. Untrusted input must go through `reconcileScope`
 *  first — the API route does. */
export function setDeviceScope(scope: DeviceScope): void {
  setSetting(SCOPE_SETTING_KEY, JSON.stringify(scope));
}

/** Reconcile untrusted input against the live device list and persist it. */
export function saveDeviceScope(stored: unknown): DeviceScope {
  const reconciled = reconcileScope(stored, knownDeviceIds());
  setDeviceScope(reconciled);
  return reconciled;
}

export function resetDeviceScope(): DeviceScope {
  const scope = { ...SCOPE_ALL };
  setDeviceScope(scope);
  return scope;
}

/**
 * Resolve the scope a REQUEST should run under.
 *
 * The `?devices=` param wins; there is no fallback to the stored scope.
 * That is the contract this whole feature rests on: a bare
 * `GET /api/apps` returns the full fleet exactly as documented, whatever
 * the user last clicked in the nav. Persisted UI state must never
 * silently change a documented response shape — the client provider is
 * responsible for passing the param on requests it wants scoped.
 */
export function scopeFromRequest(url: string): DeviceScope {
  let raw: string | null = null;
  try {
    raw = new URL(url).searchParams.get("devices");
  } catch {
    return { ...SCOPE_ALL };
  }
  return parseScopeParam(raw, knownDeviceIds()) ?? { ...SCOPE_ALL };
}

/**
 * SQL fragment restricting a query on `apps` to the scope, or null when
 * unrestricted.
 *
 * `alias` is interpolated into the SQL, so it must be a caller-supplied
 * literal and never user input — every call site passes a hard-coded
 * table alias. The device ids themselves are bound parameters.
 */
export function scopeSqlClause(
  scope: DeviceScope,
  alias = "a"
): { clause: string; params: string[] } | null {
  if (scope.mode === "all") {
    return null;
  }
  const terms: string[] = [];
  const params: string[] = [];
  if (scope.deviceIds.length > 0) {
    const placeholders = scope.deviceIds.map(() => "?").join(", ");
    terms.push(
      `EXISTS (SELECT 1 FROM app_devices ad WHERE ad.app_id = ${alias}.id AND ad.device_id IN (${placeholders}))`
    );
    params.push(...scope.deviceIds);
  }
  if (scope.includeUnattached) {
    terms.push(
      `NOT EXISTS (SELECT 1 FROM app_devices adu WHERE adu.app_id = ${alias}.id)`
    );
  }
  if (terms.length === 0) {
    // reconcileScope guarantees this is unreachable (an empty subset
    // collapses to SCOPE_ALL); fail open rather than emit `WHERE ()`.
    return null;
  }
  return { clause: `(${terms.join(" OR ")})`, params };
}

/**
 * Correlated variant of `scopeSqlClause` for queries whose FROM clause
 * isn't `apps` — a count over `privacy_categories`, a join from
 * `notifications`, and so on. `appIdExpr` is the column holding the app
 * id in the outer query (e.g. `pt.app_id`).
 *
 * Like `scopeSqlClause`, `appIdExpr` is interpolated and must be a
 * caller-supplied literal, never user input.
 */
export function scopeAppIdClause(
  scope: DeviceScope,
  appIdExpr: string
): { clause: string; params: string[] } | null {
  const inner = scopeSqlClause(scope, "sa");
  if (!inner) {
    return null;
  }
  return {
    clause: `EXISTS (SELECT 1 FROM apps sa WHERE sa.id = ${appIdExpr} AND ${inner.clause})`,
    params: inner.params,
  };
}

/**
 * App ids inside the scope, or null when unrestricted. For in-memory
 * filtering by callers that don't own their SQL.
 */
export function getScopedAppIds(scope: DeviceScope): Set<string> | null {
  const fragment = scopeSqlClause(scope);
  if (!fragment) {
    return null;
  }
  try {
    const rows = db
      .prepare(`SELECT a.id FROM apps a WHERE ${fragment.clause}`)
      .all(...fragment.params) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch (error) {
    console.warn("[device-scope] getScopedAppIds failed:", error);
    return null;
  }
}
