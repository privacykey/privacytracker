/**
 * Full-database backup + restore.
 *
 * Design goals
 * ─────────────
 * - Portability: the backup is a single JSON document that any SQLite-backed
 *   install of this app can consume. No binary blobs, no file system layout
 *   assumptions, no opaque SQLite dumps.
 * - Completeness: by default every user-data table is captured. Restoring a
 *   backup onto an empty database reproduces the original state; restoring
 *   onto a populated database first wipes it (destructive full-replace).
 * - Safety: restore runs inside a single `db.transaction()` with FK enforcement
 *   temporarily disabled so insert order doesn't matter inside the write, but
 *   we run `PRAGMA foreign_key_check` before committing so inconsistent
 *   backups are rejected rather than corrupting the DB.
 *
 * The format is intentionally simple so it survives future schema changes:
 * each table is a plain object with `columns` + `rows`. On restore we only
 * insert rows whose columns still exist in the live schema (new columns get
 * their DEFAULT, dropped columns are silently skipped). That gives the backup
 * a forward-compatibility window without requiring a migration hop for every
 * schema tweak.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db";
import { SECRET_SETTING_KEYS } from "./secret-settings";
import { recordAudit, sanitizePolicyUrl } from "./security";

export const CURRENT_BACKUP_VERSION = 1;

/**
 * Per-install HMAC key. Generated once on first export and stored as a
 * single base64 line in `<data-dir>/backup-signing.key` with 0600
 * permissions. Lives **outside** the SQLite DB on purpose: `/api/reset`
 * and `restoreBackup` both wipe `app_settings`, so storing the key
 * there would silently invalidate every existing backup the moment the
 * user did a reset. The key file persists across DB wipes, so the
 * normal same-install "reset, then restore from backup" flow stays a
 * trusted operation.
 *
 * Independent of {@link AUDITOR_ADMIN_TOKEN}: that gate is about who
 * can call the route, this is about whether the envelope is authentic.
 *
 * Cross-install / hand-crafted bundles will always fail verification
 * (different key); restoring them requires the explicit
 * `allowUntrusted: true` opt-in.
 */
const BACKUP_HMAC_ALG = "HMAC-SHA256";
const BACKUP_KEY_FILENAME = "backup-signing.key";

function backupKeyPath(): string {
  // Match lib/db.ts's resolution rule: env var wins, otherwise <cwd>/data.
  const dataDir =
    process.env.PRIVACYTRACKER_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, BACKUP_KEY_FILENAME);
}

function getOrCreateSigningKey(): Buffer {
  const file = backupKeyPath();
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      const buf = Buffer.from(raw, "base64");
      if (buf.length >= 16) {
        return buf;
      }
    }
  } catch {
    // Missing file or read error — fall through to generate.
  }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600 — owner read/write only. Anyone who can read this can forge
    // signed envelopes targeting this install.
    fs.writeFileSync(file, `${fresh.toString("base64")}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn("[backup] failed to persist signing key:", err);
  }
  return fresh;
}

/** Stable string representation for HMAC input — order of object keys matters. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((value as Record<string, unknown>)[k])
      )
      .join(",") +
    "}"
  );
}

function computeEnvelopeMac(
  envelopeWithoutSignature: object,
  key: Buffer
): string {
  return crypto
    .createHmac("sha256", key)
    .update(canonicalize(envelopeWithoutSignature))
    .digest("base64");
}

/**
 * Tables captured by a full backup, in parent-first order. Wipe iterates this
 * list in reverse (children first) and insert walks it forward. Any table
 * missing on an older schema is silently skipped so older installs can still
 * consume a backup taken from a newer install.
 */
export const TABLES_IN_INSERT_ORDER: readonly string[] = [
  "apps",
  "privacy_types",
  "privacy_purposes",
  "privacy_categories",
  "privacy_data_types",
  "accessibility_features",
  "privacy_snapshots",
  "privacy_policy_analyses",
  "privacy_policy_versions",
  "annotations",
  "app_verdicts",
  "manual_apps",
  "manual_app_events",
  "manual_app_policy_versions",
  "shortlist_entries",
  "notifications",
  "imports",
  "import_items",
  "audit_bundle_imports",
  "app_settings",
  "feature_flag_overrides",
  "ai_debug_log",
  "audit_log",
];

export interface BackupTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface BackupSignature {
  /** Currently always 'HMAC-SHA256'. */
  alg: string;
  /** Base64-encoded MAC over the canonicalised envelope (signature excluded). */
  mac: string;
}

export interface BackupEnvelope {
  appName: string;
  exportedAt: number | null;
  /**
   * Optional. Present when the envelope was produced by `exportBackup()` on
   * an install with a signing key. Absence is treated as "untrusted" by
   * default (cross-device / hand-crafted bundles).
   */
  signature?: BackupSignature;
  tables: Record<string, BackupTable>;
  version: number;
}

/**
 * Settings whose values are sensitive and must NEVER appear in any backup
 * envelope, regardless of which call site triggered the export. These rows
 * are still emitted (so the restore path can detect a fresh-from-backup
 * install and prompt the user to re-enter the secret) but the value column
 * is overwritten with the empty string before the row leaves
 * `exportBackup()`. Adding to this set is the safe place to land any future
 * secret-shaped setting (OAuth tokens, vendor API keys, webhook signing
 * secrets, etc.).
 *
 * Why "scrub at the source" rather than "redact at the route":
 * `exportBackup()` is also called by `lib/backup-snapshots.ts` to write
 * scheduled snapshot files to disk, so a route-level redaction would still
 * persist plaintext secrets on the filesystem. Doing it here is the only
 * point that catches every code path — current and future.
 */
export const SENSITIVE_SETTING_KEYS = SECRET_SETTING_KEYS;

/**
 * `app_settings` keys we refuse to write during a restore. These are
 * keys that unlock dangerous code paths (destructive cfgutil flag) or
 * impersonate server-side secrets — a malicious envelope could otherwise
 * silently pre-enable them.
 *
 * The check is by prefix so future flags in the same namespace are
 * covered automatically. The local HMAC signing key is in here too:
 * even a trusted envelope must not replace our key with the
 * sender's — that would let the sender forge future envelopes.
 */
const RESTORE_SETTING_KEY_DENY_PREFIXES = ["flag.devopts.", "AUDITOR_"];
const RESTORE_SETTING_KEY_DENY_EXACT = new Set<string>();

function isRestoreSettingKeyDenied(key: unknown): boolean {
  if (typeof key !== "string") {
    return false;
  }
  if (RESTORE_SETTING_KEY_DENY_EXACT.has(key)) {
    return true;
  }
  return RESTORE_SETTING_KEY_DENY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Sentinel value used in place of a redacted setting. The empty string is
 * deliberately chosen over a marker like `'__REDACTED__'` so that restoring
 * a scrubbed backup leaves the setting in the same "not configured" state
 * the UI already understands — the settings GET route already maps empty
 * to `ai_api_key_set: false` and the UI prompts the user to re-enter the
 * key. Anything more clever (e.g. preserving the existing key on restore
 * when the imported value is empty) would let a stale unredacted backup
 * silently keep its key on a fresh box, which is the opposite of what we
 * want.
 */
const REDACTED_SETTING_VALUE = "";

/**
 * Strip secret values from `app_settings`-style rows. Pure, deterministic,
 * exported for tests and any caller that wants to share the same redaction
 * policy (e.g. an audit-bundle composer that wraps `app_settings`).
 *
 * Mutates a shallow clone — the input rows are not modified.
 */
export function redactSensitiveSettingsRows(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const key = row.key;
    if (typeof key !== "string") {
      return row;
    }
    if (!SENSITIVE_SETTING_KEYS.has(key)) {
      return row;
    }
    return { ...row, value: REDACTED_SETTING_VALUE };
  });
}

/**
 * Dump every configured table into a versioned envelope.
 *
 * Reads are batched inside a single read transaction so the snapshot is
 * internally consistent even if a scraper tick or user action fires while
 * the export is in flight. Sensitive `app_settings` rows (currently: AI API
 * keys and webhook destinations) are scrubbed via
 * {@link redactSensitiveSettingsRows} before the envelope is returned — see
 * {@link SENSITIVE_SETTING_KEYS} for the full set and rationale.
 */
export function exportBackup(): BackupEnvelope {
  const tables: Record<string, BackupTable> = {};

  const runReads = db.transaction(() => {
    for (const name of TABLES_IN_INSERT_ORDER) {
      if (!tableExists(name)) {
        continue;
      }
      const columns = getColumns(name);
      const rows = db.prepare(`SELECT * FROM ${name}`).all() as Record<
        string,
        unknown
      >[];
      const safeRows =
        name === "app_settings" ? redactSensitiveSettingsRows(rows) : rows;
      tables[name] = { columns, rows: safeRows };
    }
  });
  runReads();

  const unsigned = {
    version: CURRENT_BACKUP_VERSION,
    exportedAt: Date.now(),
    appName: "privacytracker",
    tables,
  };
  const signature: BackupSignature = {
    alg: BACKUP_HMAC_ALG,
    mac: computeEnvelopeMac(unsigned, getOrCreateSigningKey()),
  };
  return { ...unsigned, signature };
}

/**
 * Shape of the "dry run" result the preview endpoint returns. Lets the UI
 * render a summary ("this backup has 42 apps, 318 snapshots…") before the
 * user confirms the destructive restore.
 */
export interface RestorePreview {
  exportedAt: number | null;
  perTable: { name: string; rows: number }[];
  totalRows: number;
  version: number;
  warnings: string[];
}

export function summarizeBackup(envelope: BackupEnvelope): RestorePreview {
  const perTable: { name: string; rows: number }[] = [];
  const warnings: string[] = [];
  let totalRows = 0;
  // Walk the *backup's* table list so unknown tables still surface in the
  // summary — the restore path will simply skip them, but the user should
  // see the count so they understand why (e.g. schema drift).
  for (const [name, table] of Object.entries(envelope.tables)) {
    const count = Array.isArray(table?.rows) ? table.rows.length : 0;
    perTable.push({ name, rows: count });
    totalRows += count;
    if (!TABLES_IN_INSERT_ORDER.includes(name)) {
      warnings.push(
        `Table "${name}" is in the backup but not recognised by this app version; its ${count} rows will be skipped on restore.`
      );
    }
  }
  // Sort the per-table rows by insert order so the summary reads top-to-bottom
  // in the same shape the restore will apply.
  perTable.sort((a, b) => {
    const ai = TABLES_IN_INSERT_ORDER.indexOf(a.name);
    const bi = TABLES_IN_INSERT_ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) {
      return a.name.localeCompare(b.name);
    }
    if (ai === -1) {
      return 1;
    }
    if (bi === -1) {
      return -1;
    }
    return ai - bi;
  });
  return {
    version: envelope.version,
    exportedAt: envelope.exportedAt,
    perTable,
    totalRows,
    warnings,
  };
}

/**
 * Validate the shape of an uploaded backup without writing anything. Returns
 * a summary the UI renders in the confirmation dialog.
 */
export function previewRestore(payload: unknown): RestorePreview {
  const envelope = parseEnvelope(payload);
  return summarizeBackup(envelope);
}

export interface RestoreResult {
  /** Rows the per-field sanitiser refused to write (e.g. javascript: URLs, blocked settings). */
  blocked: { name: string; rows: number }[];
  inserted: { name: string; rows: number }[];
  restoredAt: number;
  totalRows: number;
  /** 'trusted' if the envelope's signature matched this install's key. */
  trust: "trusted" | "untrusted";
}

/**
 * Thrown when the envelope's signature doesn't match the local HMAC key
 * (or the signature is missing) and the caller didn't opt in to an
 * untrusted restore. Carries enough metadata for the route layer to
 * surface a "this backup wasn't produced on this install — proceed?"
 * confirmation UI.
 */
export class BackupUntrustedError extends Error {
  signaturePresent: boolean;
  constructor(signaturePresent: boolean) {
    super(
      signaturePresent
        ? "Backup signature does not match this install. Pass allowUntrusted=true to restore anyway."
        : "Backup is unsigned (no signature found). Pass allowUntrusted=true to restore anyway."
    );
    this.name = "BackupUntrustedError";
    this.signaturePresent = signaturePresent;
  }
}

/**
 * Apply a backup envelope to the live database, wiping all rows in the
 * tracked tables first. Wrapped in a single transaction with FKs disabled
 * inside; on commit we run `foreign_key_check` so a malformed backup fails
 * loudly instead of leaving dangling refs.
 *
 * Audit trail: we record the outcome in `audit_log` after the transaction
 * commits. We intentionally capture the pre-restore counts before the wipe
 * so the forensic log preserves what was lost.
 */
export function restoreBackup(
  payload: unknown,
  meta?: { actorIp?: string; userAgent?: string; allowUntrusted?: boolean }
): RestoreResult {
  const envelope = parseEnvelope(payload);
  const summary = summarizeBackup(envelope);

  // Signature gate. Verify FIRST so we never wipe the DB on a tampered
  // envelope just to find out at the end that it didn't authenticate.
  const trust: "trusted" | "untrusted" = verifyEnvelope(envelope);
  if (trust === "untrusted" && !meta?.allowUntrusted) {
    throw new BackupUntrustedError(Boolean(envelope.signature));
  }

  // Capture pre-restore snapshot metadata *before* we wipe. The audit_log
  // table itself is part of the wipe (it's in TABLES_IN_INSERT_ORDER so the
  // backup can carry a historical trail forward), so we re-append the
  // restore-event row after the transaction commits.
  const priorCounts = TABLES_IN_INSERT_ORDER.map((name) => ({
    name,
    rows: tableExists(name)
      ? (db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number })
          .c
      : 0,
  }));

  const inserted: { name: string; rows: number }[] = [];
  const blocked: { name: string; rows: number }[] = [];
  let totalRows = 0;
  const restoredAt = Date.now();

  // `better-sqlite3` can't toggle pragmas inside a transaction cleanly, so we
  // flip FK enforcement off *around* the transaction block. This is safe
  // because `db.transaction()` is synchronous in better-sqlite3 — no other
  // statements can interleave.
  const wasFk = db.pragma("foreign_keys", { simple: true }) as number;
  try {
    db.pragma("foreign_keys = OFF");

    const writeAll = db.transaction(() => {
      // Wipe children-first (reverse of insert order). Some installs may be
      // missing newer tables, so guard with tableExists.
      for (const name of [...TABLES_IN_INSERT_ORDER].reverse()) {
        if (!tableExists(name)) {
          continue;
        }
        db.prepare(`DELETE FROM ${name}`).run();
      }

      for (const name of TABLES_IN_INSERT_ORDER) {
        if (!tableExists(name)) {
          continue;
        }
        const table = envelope.tables[name];
        if (!(table && Array.isArray(table.rows)) || table.rows.length === 0) {
          inserted.push({ name, rows: 0 });
          continue;
        }
        const liveColumns = getColumns(name);
        // Only write columns that still exist in the live schema. Dropped
        // columns from the backup are silently ignored; new columns fall back
        // to their DEFAULT.
        const writableCols = (
          table.columns ?? Object.keys(table.rows[0] ?? {})
        ).filter((col) => liveColumns.includes(col));
        if (writableCols.length === 0) {
          inserted.push({ name, rows: 0 });
          continue;
        }

        const placeholders = writableCols.map(() => "?").join(", ");
        const colList = writableCols.map(quoteIdent).join(", ");
        const stmt = db.prepare(
          `INSERT INTO ${name} (${colList}) VALUES (${placeholders})`
        );
        let n = 0;
        let rejected = 0;
        for (const row of table.rows) {
          if (!row || typeof row !== "object") {
            continue;
          }
          const sanitised = sanitiseRowForRestore(
            name,
            row as Record<string, unknown>
          );
          if (sanitised === null) {
            rejected += 1;
            continue;
          }
          const values = writableCols.map((col) =>
            coerceSqlValue(sanitised[col])
          );
          stmt.run(...values);
          n += 1;
        }
        inserted.push({ name, rows: n });
        if (rejected > 0) {
          blocked.push({ name, rows: rejected });
        }
        totalRows += n;
      }

      // Final integrity check — if any FK is dangling this throws, which
      // aborts + rolls back the transaction.
      const violations = db
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Backup restore aborted: ${violations.length} foreign-key violation(s) detected. ` +
            "The backup references rows that no longer exist. No changes were applied."
        );
      }
    });
    writeAll();
  } finally {
    db.pragma(`foreign_keys = ${wasFk ? "ON" : "OFF"}`);
  }

  // Post-restore audit trail entry. Best-effort — if this fails we still
  // succeeded at the restore, so we don't rethrow.
  try {
    recordAudit({
      action:
        trust === "trusted" ? "backup.restore" : "backup.restore.untrusted",
      actorIp: meta?.actorIp ?? null,
      userAgent: meta?.userAgent ?? null,
      success: true,
      detail: JSON.stringify({
        restoredAt,
        version: envelope.version,
        exportedAt: envelope.exportedAt ?? null,
        totalRows,
        inserted,
        blocked,
        priorCounts,
        trust,
        summary,
      }).slice(0, 1024),
    });
  } catch (err) {
    console.warn("[backup] Failed to write audit log for restore:", err);
  }

  return { inserted, totalRows, restoredAt, trust, blocked };
}

/**
 * Constant-time signature verification. Returns 'trusted' iff the
 * envelope carries an HMAC-SHA256 signature that matches the local
 * key; otherwise 'untrusted'.
 */
function verifyEnvelope(envelope: BackupEnvelope): "trusted" | "untrusted" {
  if (!envelope.signature || envelope.signature.alg !== BACKUP_HMAC_ALG) {
    return "untrusted";
  }
  const { signature, ...withoutSig } = envelope;
  const expectedMac = computeEnvelopeMac(withoutSig, getOrCreateSigningKey());
  const a = Buffer.from(expectedMac, "base64");
  const b = Buffer.from(signature.mac, "base64");
  if (a.length === 0 || a.length !== b.length) {
    return "untrusted";
  }
  return crypto.timingSafeEqual(a, b) ? "trusted" : "untrusted";
}

/**
 * Per-row sanitiser applied to every restored row regardless of trust
 * state (defence in depth: a trusted-looking envelope from a future
 * compromised exporter should still not be able to plant
 * `flag.devopts.cfgutil_uninstall=on` or `javascript:` URLs).
 *
 * Returns the (possibly modified) row, or `null` if the row must be
 * dropped entirely.
 */
function sanitiseRowForRestore(
  table: string,
  row: Record<string, unknown>
): Record<string, unknown> | null {
  if (table === "app_settings") {
    if (isRestoreSettingKeyDenied(row.key)) {
      return null;
    }
    return row;
  }
  if (table === "apps") {
    return {
      ...row,
      url: typeof row.url === "string" ? sanitizePolicyUrl(row.url) || "" : "",
      iconUrl:
        typeof row.iconUrl === "string"
          ? sanitizePolicyUrl(row.iconUrl) || null
          : null,
      privacyPolicyUrl:
        typeof row.privacyPolicyUrl === "string"
          ? sanitizePolicyUrl(row.privacyPolicyUrl) || null
          : null,
    };
  }
  if (table === "manual_apps") {
    return {
      ...row,
      privacy_policy_url:
        typeof row.privacy_policy_url === "string"
          ? sanitizePolicyUrl(row.privacy_policy_url) || null
          : null,
      source_url:
        typeof row.source_url === "string"
          ? sanitizePolicyUrl(row.source_url) || null
          : null,
    };
  }
  return row;
}

// ── helpers ──────────────────────────────────────────────────────────────

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function getColumns(name: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
  ).map((c) => c.name);
}

function quoteIdent(name: string): string {
  // SQLite accepts double-quoted identifiers. Escape embedded quotes to be
  // safe even though our column names come from the schema.
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Coerce a JSON-round-tripped value back into something better-sqlite3 will
 * accept as a bound parameter. Objects/arrays are preserved as stringified
 * JSON so columns that already hold JSON (e.g. snapshot_json) survive
 * unchanged. Booleans become 0/1 because SQLite doesn't have a native
 * boolean type.
 */
function coerceSqlValue(v: unknown): string | number | bigint | Buffer | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "object") {
    return JSON.stringify(v);
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") {
    return v;
  }
  // Unknown exotic type — stringify defensively rather than crash.
  return String(v);
}

function parseEnvelope(payload: unknown): BackupEnvelope {
  if (!payload || typeof payload !== "object") {
    throw new BackupFormatError("Backup payload must be a JSON object.");
  }
  const p = payload as Record<string, unknown>;
  const version = typeof p.version === "number" ? p.version : Number.NaN;
  if (!Number.isFinite(version) || version < 1) {
    throw new BackupFormatError(
      "Backup payload is missing a valid `version` field."
    );
  }
  if (version > CURRENT_BACKUP_VERSION) {
    throw new BackupFormatError(
      `Backup version ${version} is newer than this app supports (max ${CURRENT_BACKUP_VERSION}). Upgrade the app and try again.`
    );
  }
  if (!p.tables || typeof p.tables !== "object") {
    throw new BackupFormatError("Backup payload is missing a `tables` object.");
  }

  const tables: Record<string, BackupTable> = {};
  for (const [name, value] of Object.entries(
    p.tables as Record<string, unknown>
  )) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const t = value as Record<string, unknown>;
    if (!Array.isArray(t.rows)) {
      continue;
    }
    const cols = Array.isArray(t.columns)
      ? (t.columns.filter((c) => typeof c === "string") as string[])
      : t.rows[0] && typeof t.rows[0] === "object"
        ? Object.keys(t.rows[0] as Record<string, unknown>)
        : [];
    tables[name] = { columns: cols, rows: t.rows as Record<string, unknown>[] };
  }

  // Preserve the signature object verbatim if present so verifyEnvelope
  // can recompute the MAC over the same canonicalised bytes the
  // exporter used. Dropping it here was the bug that turned every
  // round-trip into "untrusted".
  let signature: BackupSignature | undefined;
  if (p.signature && typeof p.signature === "object") {
    const sig = p.signature as Record<string, unknown>;
    if (typeof sig.alg === "string" && typeof sig.mac === "string") {
      signature = { alg: sig.alg, mac: sig.mac };
    }
  }

  return {
    version,
    exportedAt: typeof p.exportedAt === "number" ? p.exportedAt : null,
    appName: typeof p.appName === "string" ? p.appName : "privacytracker",
    tables,
    ...(signature ? { signature } : {}),
  };
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}
