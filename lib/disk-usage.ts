/**
 * Disk + data-directory snapshot for the diagnostics page.
 *
 * Surfaces "is the volume filling up?" and "is the SQLite WAL out of
 * control?" — the two most common disk-space-related causes of weird
 * runtime behaviour on a long-lived install.
 *
 * Uses synchronous fs APIs deliberately. Node's `statfs()` is
 * lightweight (one syscall, no I/O) and the diagnostics endpoint is
 * already in-band on the request thread.
 */

import { existsSync, statSync, statfsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db';
import { getSetting } from './scheduler';

export interface DiskSnapshot {
  /** Absolute data dir. Same as `dataDir` from lib/db. */
  dataDir: string;
  /** Bytes used by everything inside dataDir. Walks the tree shallowly. */
  dataDirBytes: number;
  /** Free bytes on the volume `dataDir` lives on. */
  freeBytes: number;
  /** Total bytes on the volume. */
  totalBytes: number;
  /** Free %. Below 10% should yellow-flag; below 5% red. */
  freePct: number;
  /** Per-file sizes for the most relevant files. */
  files: {
    db: number;
    wal: number;
    shm: number;
    backups: number;
  };
  /** Last completed automated-backup snapshot, if any. */
  lastBackupSnapshotAt: number | null;
  /** Number of `.json` files in data/backups/, if the dir exists. */
  backupSnapshotCount: number;
}

function safeSize(p: string): number {
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

/** Sum the sizes of every regular file under `dir`, one level deep + the
 *  `backups/` subdir if present. We don't need a full recursive walk —
 *  the data directory only has a handful of well-known files. */
function dataDirSize(dir: string): { total: number; backupsBytes: number; backupCount: number } {
  if (!existsSync(dir)) return { total: 0, backupsBytes: 0, backupCount: 0 };
  let total = 0;
  let backupsBytes = 0;
  let backupCount = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        total += safeSize(full);
      } else if (entry.isDirectory() && entry.name === 'backups') {
        try {
          for (const sub of readdirSync(full, { withFileTypes: true })) {
            if (!sub.isFile()) continue;
            const size = safeSize(join(full, sub.name));
            total += size;
            backupsBytes += size;
            if (sub.name.endsWith('.json')) backupCount += 1;
          }
        } catch {
          // backups dir read failed — ignore, surface 0.
        }
      }
    }
  } catch {
    // top-level readdir failed — return whatever we have.
  }
  return { total, backupsBytes, backupCount };
}

export function snapshotDisk(): DiskSnapshot {
  const dbPath = join(dataDir, 'privacy.db');
  const dbBytes = safeSize(dbPath);
  const walBytes = safeSize(`${dbPath}-wal`);
  const shmBytes = safeSize(`${dbPath}-shm`);

  const { total: dataDirBytes, backupsBytes, backupCount } = dataDirSize(dataDir);

  // statfs() returns block-counts; multiply by bsize for bytes. Node 18+
  // supports the sync variant; we fall back to zero if the call fails
  // (e.g. running inside a container where the fs isn't visible).
  let freeBytes = 0;
  let totalBytes = 0;
  try {
    const stats = statfsSync(dataDir);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
    totalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // Older Node, or restricted container — leave zeros.
  }
  const freePct = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0;

  // Last automated-backup timestamp. Settings key matches
  // lib/backup-snapshots.ts SETTINGS.lastRunAt — kept in sync there.
  const lastBackupRaw = getSetting('backup_snapshot_last_run_at');
  const lastBackupSnapshotAt = lastBackupRaw ? Number(lastBackupRaw) || null : null;

  return {
    dataDir,
    dataDirBytes,
    freeBytes,
    totalBytes,
    freePct,
    files: {
      db: dbBytes,
      wal: walBytes,
      shm: shmBytes,
      backups: backupsBytes,
    },
    lastBackupSnapshotAt,
    backupSnapshotCount: backupCount,
  };
}
