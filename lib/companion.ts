/**
 * Companion pairing: the scoped, read-only tokens that let the iOS
 * companion app (privacykey/privacytracker-ios) read this instance.
 *
 * A companion token is NOT a weaker admin token. It is a separate
 * credential that unlocks exactly one thing: GET on the handful of routes
 * the phone app reads (`COMPANION_ROUTE_PATTERNS` in lib/companion-gate.ts).
 * Anything else it is sent with, any other path and any method but GET, is
 * refused outright by the gate, so a leaked or photographed pairing code can
 * read the app list and its history and nothing more: no settings, no
 * exports, no backups, no AI configuration, no devices, no mutations.
 *
 *   - Tokens are `ptc_` + 64 lowercase hex characters (32 random bytes).
 *     Only the SHA-256 is stored; the plaintext exists once, in the reply
 *     to the pairing request, which the Settings screen turns into a QR code.
 *   - A token never used within `COMPANION_CLAIM_WINDOW_MS` of being made
 *     stops working, so a pairing code left on screen or in a screenshot
 *     goes stale on its own.
 *   - `last_used_at` is written at most once a minute per token, so a phone
 *     paging the library does not turn every read into a write.
 *   - Revoking deletes the row. A full wipe ("Delete everything") empties
 *     the table (lib/reset-tables.ts); backups leave it out, so restoring
 *     one never brings an old pairing back.
 *
 * This module owns the table; lib/companion-gate.ts owns the in-memory view
 * of it that proxy.ts checks. Every change here updates both. Mirrored in
 * core/src/server/companion.rs.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  COMPANION_CLAIM_WINDOW_MS,
  COMPANION_SCOPE_READ,
  COMPANION_TOKEN_PREFIX,
  type CompanionEntry,
  hashCompanionToken,
  installCompanionUsageSink,
  isCompanionRegistryLoaded,
  putCompanionEntry,
  removeCompanionEntry,
  replaceCompanionRegistry,
} from "./companion-gate";
import db from "./db";
import { getSetting, setSetting } from "./scheduler";

export const COMPANION_LABEL_MAX = 60;
export const COMPANION_INSTANCE_NAME_MAX = 60;
export const COMPANION_INSTANCE_NAME_KEY = "companion_instance_name";
export const COMPANION_INSTANCE_NAME_DEFAULT = "privacytracker";
export const COMPANION_LABEL_DEFAULT = "iPhone";
/** At most this many pairings exist at once; pairing another is refused. */
export const COMPANION_MAX_DEVICES = 20;

interface CompanionRow {
  claim_expires_at: number;
  created_at: number;
  first_used_at: number | null;
  id: string;
  label: string;
  last_used_at: number | null;
  scope: string;
  token_hash: string;
}

export type CompanionDeviceState = "waiting" | "active" | "expired";

export interface CompanionDevice {
  claimExpiresAt: number;
  createdAt: number;
  firstUsedAt: number | null;
  id: string;
  label: string;
  lastUsedAt: number | null;
  scope: string;
  state: CompanionDeviceState;
}

function describe(
  row: Omit<CompanionRow, "token_hash">,
  now: number
): CompanionDevice {
  let state: CompanionDeviceState = "active";
  if (row.first_used_at === null) {
    state = now > row.claim_expires_at ? "expired" : "waiting";
  }
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    createdAt: row.created_at,
    claimExpiresAt: row.claim_expires_at,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
    state,
  };
}

function entryOf(row: CompanionRow): CompanionEntry {
  return {
    id: row.id,
    label: row.label,
    claimExpiresAt: row.claim_expires_at,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
  };
}

const SELECT_ALL = `SELECT id, label, token_hash, scope, created_at, claim_expires_at,
                           first_used_at, last_used_at
                      FROM companion_tokens
                     ORDER BY created_at DESC, id`;

const UPDATE_USE =
  "UPDATE companion_tokens SET first_used_at = COALESCE(first_used_at, ?), last_used_at = ? WHERE id = ?";

/**
 * Loads the gate's registry from the table and installs the sink that
 * writes uses back. instrumentation.ts calls it at boot; every route in this
 * feature calls `ensureCompanionRegistry` first, so a route served before
 * boot finished still sees a loaded registry.
 */
export function loadCompanionRegistry(): void {
  const rows = db.prepare(SELECT_ALL).all() as CompanionRow[];
  replaceCompanionRegistry(rows.map((row) => [row.token_hash, entryOf(row)]));
  installCompanionUsageSink((id, firstUsedAt, lastUsedAt) => {
    db.prepare(UPDATE_USE).run(firstUsedAt, lastUsedAt, id);
  });
}

export function ensureCompanionRegistry(): void {
  if (!isCompanionRegistryLoaded()) {
    loadCompanionRegistry();
  }
}

export function listCompanionDevices(now = Date.now()): CompanionDevice[] {
  const rows = db.prepare(SELECT_ALL).all() as CompanionRow[];
  return rows.map((row) => describe(row, now));
}

export function countCompanionDevices(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM companion_tokens")
    .get() as { n: number };
  return row.n;
}

/** Trim, collapse whitespace, cap the length; empty falls back to `fallback`. */
export function cleanLabel(
  raw: unknown,
  fallback: string,
  max = COMPANION_LABEL_MAX
): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, max).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export interface CreatedPairing {
  device: CompanionDevice;
  /** Plaintext token. Returned once; only its hash is stored. */
  token: string;
}

export function createCompanionPairing(
  label: string,
  now = Date.now()
): CreatedPairing {
  ensureCompanionRegistry();
  const token = COMPANION_TOKEN_PREFIX + randomBytes(32).toString("hex");
  const row: CompanionRow = {
    id: randomUUID(),
    label,
    token_hash: hashCompanionToken(token),
    scope: COMPANION_SCOPE_READ,
    created_at: now,
    claim_expires_at: now + COMPANION_CLAIM_WINDOW_MS,
    first_used_at: null,
    last_used_at: null,
  };
  db.prepare(
    `INSERT INTO companion_tokens
       (id, label, token_hash, scope, created_at, claim_expires_at, first_used_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(
    row.id,
    row.label,
    row.token_hash,
    row.scope,
    row.created_at,
    row.claim_expires_at
  );
  putCompanionEntry(row.token_hash, entryOf(row));
  return { token, device: describe(row, now) };
}

/** Deletes one pairing. Returns its label, or null when there was none. */
export function revokeCompanionPairing(id: string): string | null {
  ensureCompanionRegistry();
  const row = db
    .prepare("SELECT label FROM companion_tokens WHERE id = ?")
    .get(id) as { label: string } | undefined;
  if (!row) {
    return null;
  }
  db.prepare("DELETE FROM companion_tokens WHERE id = ?").run(id);
  removeCompanionEntry(id);
  return row.label;
}

export function getCompanionInstanceName(): string {
  return cleanLabel(
    getSetting(COMPANION_INSTANCE_NAME_KEY, ""),
    COMPANION_INSTANCE_NAME_DEFAULT,
    COMPANION_INSTANCE_NAME_MAX
  );
}

export function setCompanionInstanceName(name: unknown): string {
  const cleaned = cleanLabel(
    name,
    COMPANION_INSTANCE_NAME_DEFAULT,
    COMPANION_INSTANCE_NAME_MAX
  );
  setSetting(COMPANION_INSTANCE_NAME_KEY, cleaned);
  return cleaned;
}
