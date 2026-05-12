import { NextResponse } from 'next/server';
import os from 'node:os';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { getSetting } from '@/lib/scheduler';
import db from '@/lib/db';
import { installRuntimeDiagnostics, snapshotRuntimeMetrics } from '@/lib/runtime-diagnostics';
import { snapshotDbWorkerTimings } from '@/lib/db-worker-client';

/**
 * Node-side diagnostics payload.
 *
 * The Rust `get_diagnostics_report` command calls this route and splices
 * the JSON into the human-readable report the user copies to the
 * clipboard. Every field here is best-effort — we never throw, we fall
 * back to `null` and let the Rust side render the partial payload.
 *
 * Don't leak sensitive data from here: no API keys, no privacy_policy
 * text, no auth tokens. This blob is going to show up in GitHub issues.
 */
export const dynamic = 'force-dynamic';

function readLastSync(): { scheduleMode: string; lastAutoSync: number | null; syncRunning: boolean } {
  return {
    scheduleMode: getSetting('sync_schedule', 'manual'),
    lastAutoSync: (() => {
      const raw = parseInt(getSetting('last_auto_sync', '0'), 10);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    syncRunning: getSetting('sync_running', 'false') === 'true',
  };
}

function readBulkRunners(): Record<string, unknown> {
  // Three crash-safe bulk runners each write a mutex key + a state blob.
  // The mutex alone is enough for diagnostics — if something's stuck, we
  // want to know the lock is held. The full state blob can be large; the
  // user who needs it can grab the DB file via "Show data folder" and
  // SELECT from app_settings directly.
  return {
    wayback: {
      running: getSetting('wayback_import_running', 'false') === 'true',
      has_state: getSetting('wayback_bulk_state', '') !== '',
    },
    sync: {
      running: getSetting('sync_running', 'false') === 'true',
      has_state: getSetting('sync_bulk_state', '') !== '',
    },
    policy: {
      running: getSetting('policy_sync_running', 'false') === 'true',
      has_state: getSetting('policy_bulk_state', '') !== '',
    },
  };
}

function readDbStats(): Record<string, unknown> {
  try {
    const apps = (db.prepare('SELECT COUNT(*) AS c FROM apps').get() as { c: number }).c;
    const snapshots = (db.prepare('SELECT COUNT(*) AS c FROM privacy_snapshots').get() as { c: number }).c;
    const unread = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get() as { c: number }).c;

    const dbPath = path.join(
      process.env.PRIVACYTRACKER_DATA_DIR
        ? path.resolve(process.env.PRIVACYTRACKER_DATA_DIR)
        : path.join(process.cwd(), 'data'),
      'privacy.db',
    );
    const dbSize = existsSync(dbPath) ? statSync(dbPath).size : null;
    return { apps, snapshots, unread_notifications: unread, db_path: dbPath, db_size_bytes: dbSize };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function GET() {
  // Live runtime metrics — memory / heap / event-loop / slow-query
  // counts. Cap the slow-query excerpt at 20 rows here because this
  // payload ships to GitHub issues and we don't want a 200-row dump in
  // every bug report. The full ring is available via
  // /api/diagnostics/runtime for the live dashboard.
  installRuntimeDiagnostics(db);
  const runtimeMetrics = snapshotRuntimeMetrics(20);

  const payload = {
    generated_at: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
    },
    host: {
      os_release: os.release(),
      os_type: os.type(),
      total_mem_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_mem_mb: Math.round(os.freemem() / 1024 / 1024),
      cpu_count: os.cpus().length,
    },
    // Performance vitals — added so the user-copyable diagnostics report
    // surfaces "is the Node sidecar swapping or stalling?" without
    // requiring the user to open the live diagnostics dashboard. The
    // dashboard re-uses the same shape via /api/diagnostics/runtime.
    runtime_metrics: runtimeMetrics,
    db_worker: snapshotDbWorkerTimings(20),
    scheduler: readLastSync(),
    bulk_runners: readBulkRunners(),
    db: readDbStats(),
  };
  return NextResponse.json(payload);
}
