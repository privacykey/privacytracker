/**
 * SQLite health snapshot for the diagnostics dashboard.
 *
 * `snapshotDatabaseHealth()` is O(1) — only reads the sqlite header /
 * freelist metadata — so it's safe to call on every diagnostics poll.
 *
 * `runIntegrityCheck()` scans every page (slow on large DBs); it must
 * be invoked explicitly (the "Run integrity check" button) rather
 * than from the live polling loop.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import db from "./db";

export interface DatabaseHealthSnapshot {
  busyTimeoutMs: number;
  /** Bytes on disk: db file + wal + shm. wal/shm only exist while open. */
  fileBytes: number;
  /** Foreign-key enforcement; should be 1 for our setup. 0 means a migration broke it. */
  foreignKeysEnabled: 0 | 1;
  /** Free pages — high freelist + low fileSize means lots of churn / fragmentation. */
  freelistCount: number;
  /** Latest integrity-check result. `null` until the user clicks "Run integrity check". */
  integrityCheck?: {
    status: "ok" | "error";
    detail?: string;
    checkedAt: number;
    durationMs: number;
  } | null;
  /** Always 'wal' for our setup (set in lib/db.ts). Surface in case someone tweaks pragmas. */
  journalMode: string;
  /** Total page count = db size in pages. Multiply by pageSize for bytes. */
  pageCount: number;
  pageSize: number;
  /** Path the better-sqlite3 instance opened. Absolute. */
  path: string;
  shmBytes: number;
  /** % of pages allocated to data (vs free). Lower = more fragmented. */
  utilisationPct: number;
  /** Number of WAL frames since last checkpoint. High = checkpointing falling behind. */
  walAutocheckpoint: number;
  walBytes: number;
}

/**
 * In-process cache of the latest integrity-check outcome so polls
 * after a manual run still surface the result. Lost on restart.
 */
let lastIntegrityCheck: DatabaseHealthSnapshot["integrityCheck"] = null;

function safeStat(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function readPragma<T>(name: string): T {
  // PRAGMA result columns vary; read the named column first, fall back
  // to the first column present.
  const row = db.prepare(`PRAGMA ${name}`).get() as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return undefined as unknown as T;
  }
  const val = row[name] ?? Object.values(row)[0];
  return val as T;
}

export function snapshotDatabaseHealth(): DatabaseHealthSnapshot {
  // Sibling -wal/-shm files live next to the main file.
  const dbPath =
    (db as unknown as { name: string }).name ??
    join(process.cwd(), "data", "privacy.db");
  const fileBytes = safeStat(dbPath);
  const walBytes = safeStat(`${dbPath}-wal`);
  const shmBytes = safeStat(`${dbPath}-shm`);

  const pageCount = Number(readPragma<number>("page_count") ?? 0);
  const pageSize = Number(readPragma<number>("page_size") ?? 0);
  const freelistCount = Number(readPragma<number>("freelist_count") ?? 0);
  const journalMode = String(readPragma<string>("journal_mode") ?? "unknown");
  const busyTimeoutMs = Number(readPragma<number>("busy_timeout") ?? 0);
  const foreignKeys = Number(readPragma<number>("foreign_keys") ?? 0) as 0 | 1;
  const walAutocheckpoint = Number(
    readPragma<number>("wal_autocheckpoint") ?? 0
  );

  const utilisationPct =
    pageCount > 0
      ? Math.round(((pageCount - freelistCount) / pageCount) * 100)
      : 0;

  return {
    path: dbPath,
    fileBytes,
    walBytes,
    shmBytes,
    pageCount,
    pageSize,
    freelistCount,
    utilisationPct,
    journalMode,
    busyTimeoutMs,
    foreignKeysEnabled: foreignKeys,
    walAutocheckpoint,
    integrityCheck: lastIntegrityCheck,
  };
}

/**
 * Run `PRAGMA integrity_check`. Slow on large DBs — call only from the
 * user-initiated button, never from the polling loop. The result is
 * cached so subsequent snapshots return it without re-scanning.
 */
export function runIntegrityCheck(): NonNullable<
  DatabaseHealthSnapshot["integrityCheck"]
> {
  const start = Date.now();
  let status: "ok" | "error" = "ok";
  let detail: string | undefined;
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    // Single 'ok' row on success; one row per problem otherwise.
    const messages = rows
      .map((r) => String(r.integrity_check ?? r.integrity_check ?? ""))
      .filter(Boolean);
    if (
      messages.length === 0 ||
      (messages.length === 1 && messages[0] === "ok")
    ) {
      status = "ok";
    } else {
      status = "error";
      detail = messages.slice(0, 5).join("; ");
    }
  } catch (e) {
    status = "error";
    detail = e instanceof Error ? e.message : String(e);
  }
  const result = {
    status,
    detail,
    checkedAt: Date.now(),
    durationMs: Date.now() - start,
  };
  lastIntegrityCheck = result;
  return result;
}
