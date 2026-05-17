/**
 * One-shot diagnostics bundle for support tickets.
 *
 *   GET — returns a single JSON blob with every diagnostics snapshot
 *         the app exposes (runtime metrics, DB health, disk, errors,
 *         background-job state, rate limits, feature flags, deployment
 *         + desktop info when available). The diagnostics page wires a
 *         "Copy diagnostics" button straight to this endpoint, so a
 *         user filing a GitHub issue can paste the full snapshot in
 *         one click.
 *
 * Compared to the individual `/api/diagnostics/*` endpoints, this one
 * is a *snapshot at a point in time* — no streaming, no polling, no
 * mutations. The price is one extra round-trip per copy; the win is a
 * single source of truth for what "diagnostic context" means.
 *
 * Sensitive data: we already mask AI keys in `app_settings` reads, and
 * the rate-limit / DB / disk snapshots only contain paths + counts. If
 * a future addition does need redaction, do it inside the helper that
 * produces the snapshot, not here.
 */

import os from "node:os";
import { NextResponse } from "next/server";
import { snapshotApiTimings } from "@/lib/api-timing";
import db from "@/lib/db";
import { snapshotDatabaseHealth } from "@/lib/db-health";
import { snapshotDbWorkerTimings } from "@/lib/db-worker-client";
import { buildDeploymentDiagnostics } from "@/lib/deployment-diagnostics";
import { snapshotDisk } from "@/lib/disk-usage";
import { snapshotErrorLog } from "@/lib/error-log-ring";
import {
  type FlagKey,
  type FlagValue,
  HARD_DEFAULTS,
} from "@/lib/feature-flag-rules";
import { resolveFlag } from "@/lib/feature-flags";
import { getResolverContextFromDb } from "@/lib/feature-flags-server";
import { describeCurrentPolicyRun } from "@/lib/policy-bulk-runner";
import { getAllRateLimits } from "@/lib/rate-limit";
import {
  installRuntimeDiagnostics,
  snapshotRuntimeMetrics,
} from "@/lib/runtime-diagnostics";
import { describeCurrentSyncRun } from "@/lib/sync-bulk-runner";
import { describeCurrentRun as describeWaybackRun } from "@/lib/wayback-bulk-runner";

export const dynamic = "force-dynamic";

interface FlagDiff {
  current: FlagValue;
  hardDefault: FlagValue;
  key: FlagKey;
  override: FlagValue | null;
}

/** Compare resolved flags against their hard defaults and return the
 *  ones that disagree. Used as a debugging aid in the bundle output —
 *  "why is feature X showing/hiding" is almost always a stale override. */
function flagsDiffFromDefaults(): FlagDiff[] {
  try {
    const ctx = getResolverContextFromDb();
    const diffs: FlagDiff[] = [];
    for (const key of Object.keys(HARD_DEFAULTS) as FlagKey[]) {
      const hardDefault = HARD_DEFAULTS[key];
      const current = resolveFlag(key, ctx);
      const override = ctx.overrides.get(key) ?? null;
      if (current !== hardDefault || override !== null) {
        diffs.push({ key, hardDefault, current, override });
      }
    }
    return diffs;
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const generatedAt = new Date().toISOString();

  // Each helper is wrapped in its own try/catch so a single broken
  // subsystem never wipes out the rest of the bundle. The user is
  // probably collecting this *because* something's broken.
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  // Host info copied verbatim from /api/desktop/diagnostics. We
  // duplicate the four lines instead of self-fetching that route so
  // the bundle stays a single in-process call.
  const host = {
    osType: safe(() => os.type(), "unknown"),
    osRelease: safe(() => os.release(), "unknown"),
    totalMemMb: safe(() => Math.round(os.totalmem() / 1024 / 1024), 0),
    freeMemMb: safe(() => Math.round(os.freemem() / 1024 / 1024), 0),
    cpuCount: safe(() => os.cpus().length, 0),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  };

  const bundle = {
    generatedAt,
    schemaVersion: 2,
    app: {
      version: process.env.npm_package_version ?? null,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    host,
    runtime: safe(() => {
      installRuntimeDiagnostics(db);
      return snapshotRuntimeMetrics();
    }, null),
    apiTimings: safe(() => snapshotApiTimings(), null),
    dbWorker: safe(() => snapshotDbWorkerTimings(), null),
    database: safe(() => snapshotDatabaseHealth(), null),
    disk: safe(() => snapshotDisk(), null),
    errorLog: safe(() => snapshotErrorLog({ limit: 50 }), {
      entries: [],
      capacity: 0,
    }),
    backgroundJobs: {
      wayback: safe(() => describeWaybackRun(), null),
      sync: safe(() => describeCurrentSyncRun(), null),
      policy: safe(() => describeCurrentPolicyRun(), null),
    },
    rateLimits: safe(() => getAllRateLimits(), null),
    featureFlagOverrides: safe(() => flagsDiffFromDefaults(), []),
    // Deployment diagnostics covers runtime + health + db + network +
    // security checks. Headers come from the inbound request so the
    // network-inference path can read x-forwarded-for / host etc.
    // (which is otherwise impossible from a server-side direct call).
    deployment: safe(() => buildDeploymentDiagnostics(request.headers), null),
  };

  return NextResponse.json(bundle);
}
