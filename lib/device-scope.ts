/**
 * Device scope — which devices' apps the user is currently looking at.
 *
 * "Family mode" lets one install hold apps imported from several phones
 * and tablets (the `devices` table + the `app_devices` junction — see
 * lib/devices.ts). Before this module existed the only way to narrow the
 * view was a single-select dropdown buried in the apps-grid toolbar, so
 * every other surface — dashboard counts, stats, the review queue that
 * feeds "delete apps off a phone" — silently spoke for the whole fleet.
 * A user helping a relative could be several screens into a removal
 * workflow without ever being told whose device it applied to.
 *
 * The scope is therefore a GLOBAL axis, in the same spirit as the two
 * axes documented for the dashboard layout:
 *
 *   1. Capability — `flag.nav.device_scope` decides whether the picker
 *      exists at all.
 *   2. Preference — this scope, stored in `app_settings` under
 *      `device.scope`, decides which devices' apps every surface counts.
 *
 * Deliberately NOT a filter on the public API: `GET /api/apps` with no
 * params still returns the whole fleet. Routes opt in via `?devices=`,
 * which the client provider supplies from the stored scope. Persisted
 * UI state must never silently change a documented response shape —
 * same posture as the `?limit=` pagination opt-in.
 *
 * Pure data + helpers only. No React, no SQLite — client components and
 * route handlers both import this. Persistence lives in
 * `lib/device-scope-server.ts`.
 */

/**
 * Sentinel id for "apps with no `app_devices` row at all". Manual entries
 * and CSV imports that never went through cfgutil have no device link,
 * and they are the single most common reason a user reports "my app
 * disappeared when I picked a device" — so they get an explicit,
 * selectable bucket rather than being silently dropped.
 *
 * Chosen to be impossible to collide with a real device id, which is
 * always a `randomUUID()`.
 */
export const UNATTACHED_ID = "unattached";

export interface DeviceScope {
  /**
   * Device ids in the subset. Empty when `mode === 'all'`. Order is not
   * meaningful — the picker renders in device-list order, not this one.
   */
  deviceIds: string[];
  /** Whether apps with zero device links are included. */
  includeUnattached: boolean;
  /**
   * `'all'` means "everything, including anything imported later".
   * It is NOT the same as a subset that happens to list every current
   * device: importing a new phone must widen an "all" scope and must
   * NOT widen a deliberate subset.
   */
  mode: "all" | "subset";
  v: 1;
}

/** The unrestricted scope. Every surface's default. */
export const SCOPE_ALL: DeviceScope = {
  v: 1,
  mode: "all",
  deviceIds: [],
  includeUnattached: true,
};

/** Minimal device shape this module needs. A structural subset of
 *  `Device` (lib/devices.ts) so both server rows and the client's
 *  fetched JSON satisfy it. */
export interface ScopeDevice {
  deviceClass?: string | null;
  id: string;
  model?: string | null;
  name: string;
}

export function isScopeAll(scope: DeviceScope): boolean {
  return scope.mode === "all";
}

/**
 * Normalise untrusted input against the devices that actually exist.
 *
 * Mirrors `reconcileLayout` in lib/dashboard-layout.ts: malformed input
 * degrades to the default rather than throwing, and ids that no longer
 * resolve are dropped. That last part matters — deleting a device the
 * scope pointed at must not leave the user staring at a permanently
 * empty grid with no obvious way out.
 *
 * A subset that reconciles down to nothing selectable collapses back to
 * `SCOPE_ALL`, which is the fail-open direction: showing too much is
 * recoverable by picking again, showing nothing looks like data loss.
 */
export function reconcileScope(
  stored: unknown,
  knownDeviceIds: readonly string[]
): DeviceScope {
  if (!stored || typeof stored !== "object") {
    return { ...SCOPE_ALL };
  }
  const s = stored as Partial<DeviceScope>;
  if (s.mode !== "subset") {
    return { ...SCOPE_ALL };
  }
  // Ordered by the known-device list, not by however the caller happened
  // to supply them, so a scope has ONE canonical representation. Without
  // this, {A,B} and {B,A} are the same scope but produce different
  // `?devices=` params and different `scopeKey`s — and scopeKey is used
  // as a React key and a fetch-effect dependency, so an unstable one
  // means spurious remounts and refetches.
  const requested = new Set(
    (Array.isArray(s.deviceIds) ? s.deviceIds : []).filter(
      (id): id is string => typeof id === "string"
    )
  );
  const deviceIds = knownDeviceIds.filter((id) => requested.has(id));
  const known = new Set(knownDeviceIds);
  const includeUnattached = s.includeUnattached === true;
  if (deviceIds.length === 0 && !includeUnattached) {
    return { ...SCOPE_ALL };
  }
  // A subset naming every known device AND the unattached bucket is
  // indistinguishable from "all" *today*, but not tomorrow: keeping it a
  // subset would mean a newly imported device silently stayed hidden.
  // Collapse it so "I ticked everything" behaves like the user expects.
  if (deviceIds.length === known.size && includeUnattached) {
    return { ...SCOPE_ALL };
  }
  return { v: 1, mode: "subset", deviceIds, includeUnattached };
}

/**
 * Does an app fall inside the scope? `linkedDeviceIds` is the app's row
 * from `getAppDeviceMap()` — absent/empty means unattached.
 */
export function appMatchesScope(
  scope: DeviceScope,
  linkedDeviceIds: readonly string[] | undefined
): boolean {
  if (scope.mode === "all") {
    return true;
  }
  if (!linkedDeviceIds || linkedDeviceIds.length === 0) {
    return scope.includeUnattached;
  }
  return linkedDeviceIds.some((id) => scope.deviceIds.includes(id));
}

/** Toggle one device (or `UNATTACHED_ID`) in a scope, returning a new
 *  scope. Starting from `all`, the first toggle-off means "everything
 *  except this one" — which is what a user unticking a row in a
 *  fully-ticked list means, and it keeps the picker's checkboxes honest. */
export function toggleScopeDevice(
  scope: DeviceScope,
  id: string,
  knownDeviceIds: readonly string[]
): DeviceScope {
  const current = expandScope(scope, knownDeviceIds);
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return scopeFromSelection(next, knownDeviceIds);
}

/**
 * The scope as a concrete selection set (device ids plus possibly
 * `UNATTACHED_ID`). `all` expands to every known device — the picker
 * needs concrete checkbox state, not a mode.
 */
export function expandScope(
  scope: DeviceScope,
  knownDeviceIds: readonly string[]
): Set<string> {
  if (scope.mode === "all") {
    return new Set([...knownDeviceIds, UNATTACHED_ID]);
  }
  const set = new Set(scope.deviceIds);
  if (scope.includeUnattached) {
    set.add(UNATTACHED_ID);
  }
  return set;
}

/** Inverse of `expandScope`. Runs through `reconcileScope` so the
 *  all-collapse and empty-collapse rules apply in one place. */
export function scopeFromSelection(
  selection: ReadonlySet<string>,
  knownDeviceIds: readonly string[]
): DeviceScope {
  const deviceIds = knownDeviceIds.filter((id) => selection.has(id));
  return reconcileScope(
    {
      v: 1,
      mode: "subset",
      deviceIds,
      includeUnattached: selection.has(UNATTACHED_ID),
    },
    knownDeviceIds
  );
}

// ─────────────────────────────────────────────
// URL / query-param serialisation
// ─────────────────────────────────────────────

/**
 * Serialise for `?devices=`. `all` returns null (omit the param
 * entirely) so an unscoped request is byte-identical to one from a
 * client that has never heard of scoping.
 */
export function serialiseScopeParam(scope: DeviceScope): string | null {
  if (scope.mode === "all") {
    return null;
  }
  const parts = [...scope.deviceIds];
  if (scope.includeUnattached) {
    parts.push(UNATTACHED_ID);
  }
  return parts.join(",");
}

/**
 * Parse a `?devices=` / `?device=` value. Accepts a comma-separated list
 * of device ids, the `unattached` sentinel, or the literal `all`.
 *
 * Returns null for input that names nothing recognisable, so callers can
 * distinguish "no scope requested" from "scope requested but stale" and
 * fall back to the full fleet in both cases. Deliberately lenient about
 * unknown ids — a bookmark to a since-deleted device should still render
 * a page.
 */
export function parseScopeParam(
  raw: string | null | undefined,
  knownDeviceIds: readonly string[]
): DeviceScope | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "all") {
    return { ...SCOPE_ALL };
  }
  const selection = new Set(
    trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  const scope = scopeFromSelection(selection, knownDeviceIds);
  // Nothing in the param resolved — treat as "not requested" rather than
  // as an empty scope, so a stale deep link shows apps instead of a void.
  if (scope.mode === "all" && !selection.has("all")) {
    const resolvedAnything =
      selection.has(UNATTACHED_ID) ||
      knownDeviceIds.some((id) => selection.has(id));
    if (!resolvedAnything) {
      return null;
    }
  }
  return scope;
}

// ─────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────

export type DeviceGlyphKind = "phone" | "tablet" | "watch" | "player" | "other";

/** Just the fields iconography reads. Narrower than `ScopeDevice` on
 *  purpose so a renderer that only has metadata (no id) can still ask. */
export interface DeviceGlyphSource {
  deviceClass?: string | null;
  model?: string | null;
}

/**
 * Classify a device for iconography. Reads `deviceClass` (cfgutil's own
 * label) first, then falls back to the model string for CSV / manual
 * imports that never had one.
 *
 * Note this splits phone from tablet, which the toast's emoji helper
 * (app/components/DeviceConnectedToast.tsx) does not — it returns the
 * same 📱 for both. That was fine for a transient "device connected"
 * toast naming the device in text right beside it; it is not fine for a
 * persistent picker whose whole job is telling an iPhone from an iPad.
 */
export function deviceGlyphKind(device: DeviceGlyphSource): DeviceGlyphKind {
  const cls = (device.deviceClass ?? "").toLowerCase();
  const model = (device.model ?? "").toLowerCase();
  const haystack = `${cls} ${model}`;
  if (haystack.includes("ipad")) {
    return "tablet";
  }
  if (haystack.includes("watch")) {
    return "watch";
  }
  if (haystack.includes("ipod")) {
    return "player";
  }
  if (haystack.includes("iphone")) {
    return "phone";
  }
  return "other";
}

export interface ScopeDescription {
  /** How many buckets are selected (devices + the unattached bucket). */
  count: number;
  /** Device to draw an icon for — only set when `kind === 'single'`. */
  device: ScopeDevice | null;
  kind: "all" | "single" | "unattached" | "multi";
  /** Device name for `single`; callers localise the other kinds. */
  name: string | null;
}

/**
 * Reduce a scope to what the nav trigger should show. Returns a shape,
 * not a string — the caller owns i18n. `single` is the case worth
 * getting right: it's the one that answers "whose phone am I looking
 * at?" with a name and an icon rather than a count.
 */
export function describeScope(
  scope: DeviceScope,
  devices: readonly ScopeDevice[]
): ScopeDescription {
  if (scope.mode === "all") {
    return { kind: "all", count: devices.length, device: null, name: null };
  }
  const selected = devices.filter((d) => scope.deviceIds.includes(d.id));
  const count = selected.length + (scope.includeUnattached ? 1 : 0);
  if (selected.length === 1 && !scope.includeUnattached) {
    const device = selected[0];
    return { kind: "single", count: 1, device, name: device.name };
  }
  if (selected.length === 0 && scope.includeUnattached) {
    return { kind: "unattached", count: 1, device: null, name: null };
  }
  return { kind: "multi", count, device: null, name: null };
}
