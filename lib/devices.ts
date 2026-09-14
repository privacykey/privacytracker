/**
 * Devices module — server-safe CRUD over the `devices` table plus the
 * `app_devices` junction. One row per "the user said this is My iPhone"
 * import source.
 *
 * Cfgutil-driven imports pre-fill `ecid` + `name` + `model` from Apple
 * Configurator. CSV / manual / screenshot imports get the user-supplied
 * name only (NULL ecid). The unique partial index on `ecid` prevents
 * duplicates when the same device is re-imported.
 *
 * The orphan-detection logic in `unlinkAppFromDevice` is what makes the
 * re-sync flow's "removed" semantics work: when the user accepts a
 * remove on the diff screen, we drop the (app, device) row; if that
 * leaves the app with no other device links AND no manual annotations /
 * verdicts / shortlist entries, the app row is removed entirely.
 */

import { randomUUID } from "node:crypto";
import db from "./db";

/**
 * Which focus audience a device's owner corresponds to. Deliberately the
 * same vocabulary as `Audience` in lib/feature-flag-rules.ts — the whole
 * point of recording it is that the app can notice the device you are
 * looking at disagrees with the focus you are working under.
 *
 * Typed structurally rather than imported so this server module doesn't
 * pull the flag-rules graph in; `isDeviceOwnerAudience` is the guard.
 */
export type DeviceOwnerAudience = "self" | "loved_one" | "guardian";

const OWNER_AUDIENCES: readonly string[] = ["self", "loved_one", "guardian"];

export function isDeviceOwnerAudience(
  value: unknown
): value is DeviceOwnerAudience {
  return typeof value === "string" && OWNER_AUDIENCES.includes(value);
}

export interface Device {
  createdAt: number;
  deviceClass: string | null;
  ecid: string | null;
  id: string;
  iosVersion: string | null;
  isUnknownPlaceholder: boolean;
  lastSyncedAt: number;
  model: string | null;
  name: string;
  /**
   * Who this device belongs to. Both NULL until the user says so — we
   * never infer ownership from a device name, because a wrong guess
   * mislabels a real person's phone and can prompt an audience switch
   * for no reason.
   */
  ownerAudience: DeviceOwnerAudience | null;
  ownerLabel: string | null;
  /**
   * When the user attested they have the owner's permission to view
   * and act on this device. Null until explicitly given, and only ever
   * meaningful for a device owned by someone else — the uninstall gate
   * requires it before acting on any device whose owner is not 'self'.
   */
  permissionAcknowledgedAt: number | null;
}

interface DeviceRow {
  created_at: number;
  device_class: string | null;
  ecid: string | null;
  id: string;
  ios_version: string | null;
  is_unknown_placeholder: number;
  last_synced_at: number;
  model: string | null;
  name: string;
  owner_audience: string | null;
  owner_label: string | null;
  permission_acknowledged_at: number | null;
}

function rowToDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    ecid: row.ecid,
    model: row.model,
    iosVersion: row.ios_version,
    deviceClass: row.device_class,
    createdAt: row.created_at,
    lastSyncedAt: row.last_synced_at,
    isUnknownPlaceholder: row.is_unknown_placeholder === 1,
    ownerLabel: row.owner_label?.trim() || null,
    // An unrecognised stored value reads back as null rather than being
    // passed through: a junk audience would flow into the focus-switch
    // prompt and offer to set a focus that doesn't exist.
    ownerAudience: isDeviceOwnerAudience(row.owner_audience)
      ? row.owner_audience
      : null,
    permissionAcknowledgedAt: row.permission_acknowledged_at ?? null,
  };
}

export interface CreateDeviceInput {
  deviceClass?: string | null;
  ecid?: string | null;
  iosVersion?: string | null;
  model?: string | null;
  name: string;
  /** Whose device this is, if the user said at import time. */
  ownerAudience?: DeviceOwnerAudience | null;
  ownerLabel?: string | null;
  /** The user's attestation that they have the owner's permission.
   *  Ignored (never stored) when the owner is 'self' or unset. */
  permissionAcknowledged?: boolean;
}

/** Create a device row. Returns the persisted Device. */
export function createDevice(input: CreateDeviceInput): Device {
  const name = input.name.trim();
  if (!name) {
    throw new Error("device name must not be empty");
  }
  const id = randomUUID();
  const now = Date.now();
  const ownerAudience = isDeviceOwnerAudience(input.ownerAudience)
    ? input.ownerAudience
    : null;
  db.prepare(`
    INSERT INTO devices (id, name, ecid, model, ios_version, device_class,
                         created_at, last_synced_at, is_unknown_placeholder,
                         owner_label, owner_audience, permission_acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id,
    name,
    input.ecid ?? null,
    input.model ?? null,
    input.iosVersion ?? null,
    input.deviceClass ?? null,
    now,
    now,
    input.ownerLabel?.trim() || null,
    ownerAudience,
    // An attestation only makes sense for someone else's device.
    ownerAudience && ownerAudience !== "self" && input.permissionAcknowledged
      ? now
      : null
  );
  return getDeviceById(id)!;
}

/**
 * Look up a device by its cfgutil ECID. If a match exists, optionally
 * refresh the metadata (name/model/iosVersion/deviceClass) when the
 * caller supplies a newer reading — Apple Configurator keeps these
 * up-to-date. If no match, create a new row.
 */
export function findOrCreateDeviceByEcid(
  ecid: string,
  fallbackName: string,
  meta?: {
    model?: string | null;
    iosVersion?: string | null;
    deviceClass?: string | null;
  }
): Device {
  const trimmed = ecid.trim();
  if (!trimmed) {
    throw new Error("ecid must not be empty");
  }
  const existing = db
    .prepare("SELECT * FROM devices WHERE ecid = ?")
    .get(trimmed) as DeviceRow | undefined;
  if (existing) {
    // Refresh metadata if we got a better reading. Don't overwrite the
    // user's chosen name though — they may have renamed it.
    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (meta?.model && meta.model !== existing.model) {
      updates.push("model = ?");
      values.push(meta.model);
    }
    if (meta?.iosVersion && meta.iosVersion !== existing.ios_version) {
      updates.push("ios_version = ?");
      values.push(meta.iosVersion);
    }
    if (meta?.deviceClass && meta.deviceClass !== existing.device_class) {
      updates.push("device_class = ?");
      values.push(meta.deviceClass);
    }
    if (updates.length > 0) {
      db.prepare(`UPDATE devices SET ${updates.join(", ")} WHERE id = ?`).run(
        ...values,
        existing.id
      );
    }
    return getDeviceById(existing.id)!;
  }
  return createDevice({
    name: fallbackName,
    ecid: trimmed,
    model: meta?.model ?? null,
    iosVersion: meta?.iosVersion ?? null,
    deviceClass: meta?.deviceClass ?? null,
  });
}

export function getAllDevices(): Device[] {
  const rows = db
    .prepare("SELECT * FROM devices ORDER BY last_synced_at DESC, name")
    .all() as DeviceRow[];
  return rows.map(rowToDevice);
}

export function getDeviceById(id: string): Device | null {
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as
    | DeviceRow
    | undefined;
  return row ? rowToDevice(row) : null;
}

/**
 * Look up a device by ECID, tolerating spelling differences.
 *
 * cfgutil prints ECIDs `0x`-prefixed and mixed-case, and what lands in
 * `devices.ecid` is whatever spelling the import happened to see, while
 * callers may pass any other. A plain `WHERE ecid = ?` therefore misses
 * real matches — which matters here because the uninstall gate uses this
 * to decide whose device is being acted on, and a missed match silently
 * downgrades it to the older, coarser rule.
 *
 * Compared in JS rather than with SQL string surgery: the normalisation
 * lives in one place (`normalizeEcid`, lib/device-actions.ts, mirrored
 * here to avoid a server-only import), and a family install has a
 * handful of devices, not thousands.
 */
export function getDeviceByEcid(ecid: string): Device | null {
  const target = normalizeEcidForMatch(ecid);
  if (!target) {
    return null;
  }
  const rows = db
    .prepare("SELECT * FROM devices WHERE ecid IS NOT NULL AND ecid != ''")
    .all() as DeviceRow[];
  for (const row of rows) {
    if (row.ecid && normalizeEcidForMatch(row.ecid) === target) {
      return rowToDevice(row);
    }
  }
  return null;
}

/** Strip an `0x` prefix and upper-case the hex body. Deliberately the
 *  same shape as `normalizeEcid` in lib/device-actions.ts; that module
 *  is `server-only` and this one is imported more widely. */
function normalizeEcidForMatch(value: string): string | null {
  const body = value.trim().replace(/^0[xX]/, "");
  if (!/^[A-Fa-f0-9]{8,24}$/.test(body)) {
    return null;
  }
  return body.toUpperCase();
}

export function getDevicesForApp(appId: string): Device[] {
  const rows = db
    .prepare(`
      SELECT d.* FROM devices d
      JOIN app_devices ad ON ad.device_id = d.id
      WHERE ad.app_id = ?
      ORDER BY d.last_synced_at DESC, d.name
    `)
    .all(appId) as DeviceRow[];
  return rows.map(rowToDevice);
}

/** App count per device — drives the Settings → Devices list. */
export function getDeviceAppCounts(): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT device_id, COUNT(*) AS n FROM app_devices GROUP BY device_id"
    )
    .all() as { device_id: string; n: number }[];
  return new Map(rows.map((r) => [r.device_id, r.n]));
}

/**
 * Reverse lookup: `appId → deviceId[]`. Used to enrich the apps grid so
 * the client-side device filter can decide per-app inclusion without
 * needing a JOIN in every row payload. The map is dense — entries only
 * appear when the app has at least one device link. Apps with zero
 * links (e.g. manual-only entries that never went through cfgutil)
 * simply aren't in the map.
 *
 * Pass `appIds` to scope the lookup to one grid page of apps.
 */
export function getAppDeviceMap(
  appIds?: readonly string[]
): Map<string, string[]> {
  if (appIds && appIds.length === 0) {
    return new Map();
  }
  const idFilter = appIds
    ? ` WHERE app_id IN (${appIds.map(() => "?").join(", ")})`
    : "";
  const rows = db
    .prepare(`SELECT app_id, device_id FROM app_devices${idFilter}`)
    .all(...(appIds ?? [])) as { app_id: string; device_id: string }[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.app_id);
    if (existing) {
      existing.push(row.device_id);
    } else {
      map.set(row.app_id, [row.device_id]);
    }
  }
  return map;
}

/**
 * `appId → ecid[]` for the supplied app ids. Used by the review-and-act
 * wizard to warn the user when the *connected* cfgutil device's ECID
 * isn't one of the devices the queued-for-uninstall app was originally
 * imported from. That mismatch usually means the user is about to
 * uninstall an app that isn't on the phone they think it's on, or
 * they're targeting a device the app never lived on (cfgutil would
 * fail anyway, but a soft pre-flight warning beats a confusing error).
 *
 * Entries are absent from the map when the app has no device links OR
 * all linked devices have a NULL ecid (CSV / manual imports without
 * cfgutil — those rows are unmatchable). Callers must treat "no entry"
 * as "device source unknown, can't verify" rather than "mismatch".
 */
export function getDeviceEcidsForApps(
  appIds: readonly string[]
): Map<string, string[]> {
  if (appIds.length === 0) {
    return new Map();
  }
  const placeholders = appIds.map(() => "?").join(",");
  const rows = db
    .prepare(`
      SELECT ad.app_id AS app_id, d.ecid AS ecid
      FROM app_devices ad
      JOIN devices d ON d.id = ad.device_id
      WHERE ad.app_id IN (${placeholders}) AND d.ecid IS NOT NULL AND d.ecid != ''
    `)
    .all(...appIds) as { app_id: string; ecid: string }[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.app_id);
    if (existing) {
      if (!existing.includes(row.ecid)) {
        existing.push(row.ecid);
      }
    } else {
      map.set(row.app_id, [row.ecid]);
    }
  }
  return map;
}

/**
 * Set (or clear) who a device belongs to.
 *
 * Both fields are independently clearable with `null`, and omitting a
 * field leaves it alone — the Settings UI edits the label and the
 * audience in one form, but the audience-switch prompt only ever needs
 * to touch the audience.
 *
 * Note this never touches the device's NAME. "Mum's iPad" as a name and
 * "Mum" as an owner are different facts: several devices can share one
 * owner, which is exactly what makes grouping the picker worthwhile.
 */
export function setDeviceOwner(
  id: string,
  owner: {
    audience?: DeviceOwnerAudience | null;
    label?: string | null;
    /** true stamps now; false clears. Omit to leave alone. */
    permissionAcknowledged?: boolean;
  }
): void {
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (owner.label !== undefined) {
    updates.push("owner_label = ?");
    values.push(owner.label?.trim() || null);
  }
  const nextAudience =
    owner.audience === undefined
      ? undefined
      : isDeviceOwnerAudience(owner.audience)
        ? owner.audience
        : null;
  if (nextAudience !== undefined) {
    updates.push("owner_audience = ?");
    values.push(nextAudience);
  }
  // The attestation is about someone ELSE's device. Setting the owner
  // to self, or clearing it, makes a stored acknowledgement meaningless
  // — so it goes too. Otherwise handing the device back to a relative
  // later would inherit a stale "yes" from a previous owner.
  const resolvedAudience =
    nextAudience === undefined
      ? (getDeviceById(id)?.ownerAudience ?? null)
      : nextAudience;
  const ownerBecameSelfOrNone =
    nextAudience !== undefined && (!nextAudience || nextAudience === "self");
  if (owner.permissionAcknowledged !== undefined || ownerBecameSelfOrNone) {
    const stamp =
      owner.permissionAcknowledged === true &&
      resolvedAudience &&
      resolvedAudience !== "self"
        ? Date.now()
        : null;
    updates.push("permission_acknowledged_at = ?");
    values.push(stamp);
  }
  if (updates.length === 0) {
    return;
  }
  db.prepare(`UPDATE devices SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values,
    id
  );
}

export function renameDevice(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("device name must not be empty");
  }
  db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(trimmed, id);
}

/**
 * Delete a device. If `reassignToDeviceId` is supplied, every app_devices
 * row is repointed to the target device first (no cascade-and-orphan).
 * Without reassignment, `ON DELETE CASCADE` on `app_devices.device_id`
 * drops the link rows automatically — but we then run the orphan sweep
 * over those apps so any that have no other device links + no user data
 * attached are soft-deleted.
 */
export function deleteDevice(
  id: string,
  opts: { reassignToDeviceId?: string } = {}
): { orphanedAndDeleted: number } {
  if (opts.reassignToDeviceId) {
    if (opts.reassignToDeviceId === id) {
      throw new Error("cannot reassign a device to itself");
    }
    const target = getDeviceById(opts.reassignToDeviceId);
    if (!target) {
      throw new Error(
        `reassign target device not found: ${opts.reassignToDeviceId}`
      );
    }
    const tx = db.transaction(() => {
      // Pre-sniff: rows that already exist on the target device. SQLite
      // would otherwise fail the UPDATE on PK collision (two rows for the
      // same (app, device) pair). Drop the source row when a target row
      // already exists.
      const conflicts = db
        .prepare(`
          SELECT s.app_id AS app_id
          FROM app_devices s
          WHERE s.device_id = ?
            AND EXISTS (
              SELECT 1 FROM app_devices t
              WHERE t.app_id = s.app_id AND t.device_id = ?
            )
        `)
        .all(id, opts.reassignToDeviceId) as { app_id: string }[];
      for (const c of conflicts) {
        db.prepare(
          "DELETE FROM app_devices WHERE app_id = ? AND device_id = ?"
        ).run(c.app_id, id);
      }
      db.prepare(
        "UPDATE app_devices SET device_id = ? WHERE device_id = ?"
      ).run(opts.reassignToDeviceId, id);
      db.prepare("UPDATE imports SET device_id = ? WHERE device_id = ?").run(
        opts.reassignToDeviceId,
        id
      );
      db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    });
    tx();
    return { orphanedAndDeleted: 0 };
  }
  // No reassignment: collect the apps that were linked here, drop the
  // device (cascade clears their app_devices rows), then run the orphan
  // sweep over those app ids.
  const affectedApps = db
    .prepare("SELECT app_id FROM app_devices WHERE device_id = ?")
    .all(id) as { app_id: string }[];
  db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  let orphaned = 0;
  for (const a of affectedApps) {
    if (orphanSweepApp(a.app_id)) {
      orphaned += 1;
    }
  }
  return { orphanedAndDeleted: orphaned };
}

/** Insert-or-touch the (app, device) junction row. */
export function upsertAppDeviceLink(
  appId: string,
  deviceId: string,
  observedAt: number = Date.now()
): void {
  db.prepare(`
    INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(app_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(appId, deviceId, observedAt, observedAt);
}

/**
 * Remove the (app, device) junction row. With `allowOrphanDelete = true`,
 * also untracks the app entirely when it has zero remaining device links
 * AND no user-set verdicts / annotations / shortlist entries.
 *
 * Returns `{ orphaned: true }` when the app was untracked, otherwise
 * `{ orphaned: false }`.
 */
export function unlinkAppFromDevice(
  appId: string,
  deviceId: string,
  opts: { allowOrphanDelete: boolean } = { allowOrphanDelete: true }
): { orphaned: boolean } {
  db.prepare("DELETE FROM app_devices WHERE app_id = ? AND device_id = ?").run(
    appId,
    deviceId
  );
  if (!opts.allowOrphanDelete) {
    return { orphaned: false };
  }
  return { orphaned: orphanSweepApp(appId) };
}

/**
 * Check whether an app is now orphaned (no other devices, no user data),
 * and if so, delete the app row. Returns true when a deletion happened.
 *
 * "User data attached" means any of:
 *   - annotation rows on the app
 *   - app_verdicts rows where source='user'
 *   - shortlist_entries rows
 * Imported verdicts (source='imported' from an audit bundle) DON'T count —
 * they're someone else's recommendation, not the user's own intent, so we
 * shouldn't keep the app row alive just for them.
 */
export function orphanSweepApp(appId: string): boolean {
  const deviceLinks = (
    db
      .prepare("SELECT COUNT(*) AS n FROM app_devices WHERE app_id = ?")
      .get(appId) as { n: number }
  ).n;
  if (deviceLinks > 0) {
    return false;
  }

  const hasUserData = hasAttachedUserData(appId);
  if (hasUserData) {
    return false;
  }

  // Delete the apps row. FK cascades take care of the related child rows
  // (snapshots, privacy_types, app_devices is already empty, etc.).
  db.prepare("DELETE FROM apps WHERE id = ?").run(appId);
  return true;
}

function hasAttachedUserData(appId: string): boolean {
  // Each table may not exist on a partial DB (fresh install, mid-migration).
  // Wrap each check so a missing table doesn't blow up the sweep.
  const checks: Array<{ sql: string; param?: unknown }> = [
    {
      sql: "SELECT 1 FROM app_verdicts WHERE app_id = ? AND source = 'user' LIMIT 1",
      param: appId,
    },
    { sql: "SELECT 1 FROM annotations WHERE app_id = ? LIMIT 1", param: appId },
    {
      sql: "SELECT 1 FROM shortlist_entries WHERE app_id = ? LIMIT 1",
      param: appId,
    },
  ];
  for (const c of checks) {
    try {
      const row = db.prepare(c.sql).get(c.param);
      if (row) {
        return true;
      }
    } catch {
      // Table doesn't exist on this DB — skip.
    }
  }
  return false;
}

export function setDeviceLastSyncedAt(
  id: string,
  ts: number = Date.now()
): void {
  db.prepare("UPDATE devices SET last_synced_at = ? WHERE id = ?").run(ts, id);
}

/** Returns the device id used by the most recent import, or null. Useful
 *  for Tasks-panel default device picks. */
export function getMostRecentlySyncedDeviceId(): string | null {
  const row = db
    .prepare("SELECT id FROM devices ORDER BY last_synced_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}
