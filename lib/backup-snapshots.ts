import fs from 'node:fs';
import path from 'node:path';
import { exportBackup, CURRENT_BACKUP_VERSION } from './backup';
import { recordActivity } from './activity';
import { dataDir } from './db';
import { getSetting, setSetting } from './scheduler';

const SNAPSHOT_DIR = path.join(dataDir, 'backups');
const SNAPSHOT_PREFIX = 'privacytracker-snapshot-';
const SNAPSHOT_SUFFIX = '.json';

const SETTINGS = {
  enabled: 'backup_snapshot_enabled',
  intervalHours: 'backup_snapshot_interval_hours',
  retentionCount: 'backup_snapshot_retention_count',
  lastRunAt: 'backup_snapshot_last_run_at',
};

export interface BackupSnapshotSettings {
  enabled: boolean;
  intervalHours: number;
  retentionCount: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface BackupSnapshotRow {
  filename: string;
  path: string;
  createdAt: number;
  sizeBytes: number;
}

export interface CreateBackupSnapshotResult {
  snapshot: BackupSnapshotRow;
  pruned: BackupSnapshotRow[];
}

export const DEFAULT_BACKUP_SNAPSHOT_SETTINGS = {
  enabled: false,
  intervalHours: 24,
  retentionCount: 10,
};

export function getBackupSnapshotDir(): string {
  return SNAPSHOT_DIR;
}

export function getBackupSnapshotSettings(): BackupSnapshotSettings {
  const enabled = getSetting(SETTINGS.enabled, 'false') === 'true';
  const intervalHours = sanitizeIntervalHours(getSetting(SETTINGS.intervalHours, '24'));
  const retentionCount = sanitizeRetentionCount(getSetting(SETTINGS.retentionCount, '10'));
  const lastRunRaw = parseInt(getSetting(SETTINGS.lastRunAt, '0'), 10);
  const lastRunAt = Number.isFinite(lastRunRaw) && lastRunRaw > 0 ? lastRunRaw : null;
  const nextRunAt = enabled && lastRunAt ? lastRunAt + intervalHours * 60 * 60_000 : null;
  return { enabled, intervalHours, retentionCount, lastRunAt, nextRunAt };
}

export function saveBackupSnapshotSettings(input: {
  enabled?: unknown;
  intervalHours?: unknown;
  retentionCount?: unknown;
}): BackupSnapshotSettings {
  if (input.enabled !== undefined) {
    setSetting(SETTINGS.enabled, input.enabled ? 'true' : 'false');
  }
  if (input.intervalHours !== undefined) {
    setSetting(SETTINGS.intervalHours, String(sanitizeIntervalHours(input.intervalHours)));
  }
  if (input.retentionCount !== undefined) {
    setSetting(SETTINGS.retentionCount, String(sanitizeRetentionCount(input.retentionCount)));
  }
  return getBackupSnapshotSettings();
}

export function listBackupSnapshots(): BackupSnapshotRow[] {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter(name => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .map(filename => {
      const full = path.join(SNAPSHOT_DIR, filename);
      const stat = fs.statSync(full);
      return {
        filename,
        path: full,
        createdAt: parseTimestamp(filename) ?? stat.mtimeMs,
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getBackupSnapshotPath(filename: string): string | null {
  if (!isSnapshotFilename(filename)) return null;
  const full = path.join(SNAPSHOT_DIR, filename);
  const resolved = path.resolve(full);
  const root = path.resolve(SNAPSHOT_DIR);
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

export function createBackupSnapshot(
  triggeredBy: 'manual' | 'scheduled' = 'manual',
): CreateBackupSnapshotResult {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const startedAt = Date.now();
  const envelope = exportBackup();
  const timestamp = new Date(envelope.exportedAt ?? startedAt).toISOString().replace(/[:.]/g, '-');
  let filename = `${SNAPSHOT_PREFIX}${timestamp}${SNAPSHOT_SUFFIX}`;
  let finalPath = path.join(SNAPSHOT_DIR, filename);
  let collision = 1;
  while (fs.existsSync(finalPath)) {
    collision += 1;
    filename = `${SNAPSHOT_PREFIX}${timestamp}-${collision}${SNAPSHOT_SUFFIX}`;
    finalPath = path.join(SNAPSHOT_DIR, filename);
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const body = JSON.stringify(envelope, null, 2);

  fs.writeFileSync(tempPath, body, { mode: 0o600 });
  fs.renameSync(tempPath, finalPath);
  setSetting(SETTINGS.lastRunAt, String(envelope.exportedAt ?? startedAt));

  const settings = getBackupSnapshotSettings();
  const pruned = pruneBackupSnapshots(settings.retentionCount);
  const stat = fs.statSync(finalPath);
  const snapshot = {
    filename,
    path: finalPath,
    createdAt: envelope.exportedAt ?? startedAt,
    sizeBytes: stat.size,
  };

  try {
    recordActivity({
      type: 'backup_export',
      status: 'ok',
      summary:
        triggeredBy === 'scheduled'
          ? 'Automatic local backup snapshot created'
          : 'Local backup snapshot created',
      detail: {
        mode: 'local-snapshot',
        triggeredBy,
        filename,
        bytes: stat.size,
        pruned: pruned.length,
        backupVersion: CURRENT_BACKUP_VERSION,
      },
      startedAt,
      endedAt: Date.now(),
    });
  } catch {
    // Activity logging is best-effort; the snapshot itself already exists.
  }

  return { snapshot, pruned };
}

export function isBackupSnapshotDue(now = Date.now()): boolean {
  const settings = getBackupSnapshotSettings();
  if (!settings.enabled) return false;
  if (!settings.lastRunAt) return true;
  return now >= settings.lastRunAt + settings.intervalHours * 60 * 60_000;
}

export function runScheduledBackupSnapshotIfDue(
  now = Date.now(),
): CreateBackupSnapshotResult | null {
  if (!isBackupSnapshotDue(now)) return null;
  return createBackupSnapshot('scheduled');
}

export function pruneBackupSnapshots(retentionCount: number): BackupSnapshotRow[] {
  const keep = sanitizeRetentionCount(retentionCount);
  const snapshots = listBackupSnapshots();
  const extra = snapshots.slice(keep);
  for (const row of extra) {
    try {
      fs.unlinkSync(row.path);
    } catch {
      // A concurrent manual download/list can race; best-effort pruning is fine.
    }
  }
  return extra;
}

function sanitizeIntervalHours(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return DEFAULT_BACKUP_SNAPSHOT_SETTINGS.intervalHours;
  return Math.min(24 * 30, Math.max(1, Math.round(value)));
}

function sanitizeRetentionCount(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return DEFAULT_BACKUP_SNAPSHOT_SETTINGS.retentionCount;
  return Math.min(100, Math.max(1, Math.round(value)));
}

function isSnapshotFilename(filename: string): boolean {
  return (
    path.basename(filename) === filename &&
    filename.startsWith(SNAPSHOT_PREFIX) &&
    filename.endsWith(SNAPSHOT_SUFFIX)
  );
}

function parseTimestamp(filename: string): number | null {
  if (!isSnapshotFilename(filename)) return null;
  const raw = filename.slice(SNAPSHOT_PREFIX.length, -SNAPSHOT_SUFFIX.length);
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}
