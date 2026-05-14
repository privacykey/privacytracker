export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  createManualApp,
} from '../../../../lib/manual-apps-server';
import {
  MANUAL_APP_SOURCES,
  isManualAppSource,
  type ManualApp,
  type ManualAppInput,
  type ManualAppSource,
} from '../../../../lib/manual-apps';
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from '../../../../lib/security';

/**
 * POST /api/manual-apps/bulk
 *
 * Bulk-create manual_apps entries from an array of inputs. The onboarding
 * wizard's Step 3 uses this for two cases:
 *   - "Save all as Safari web apps" — for cfgutil rows whose bundle ID
 *     matches the WebKit push-bundle pattern (no App Store record).
 *   - "Save all as manual apps" — for triaged rows that couldn't be
 *     matched against the App Store (TestFlight, sideloaded, removed).
 *
 * Each input must carry { name, source } at a minimum. Per-row failures
 * are reported in the response without aborting the rest of the batch —
 * a couple of malformed rows in a 200-app import shouldn't cancel the
 * whole save.
 */

interface BulkInputRow {
  name?: unknown;
  source?: unknown;
  developer?: unknown;
}

interface BulkRowResult {
  index: number;
  ok: boolean;
  app?: ManualApp;
  error?: string;
}

// Cap per-batch — protects SQLite from a runaway client. A 500-app
// iPhone is well below this; anything bigger is almost certainly a
// bug in the caller.
const MAX_BULK_ROWS = 1000;

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'manual-apps.bulk'),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'manual-apps.bulk.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  let body: { apps?: unknown };
  try {
    // 256 KB cap — covers 1000 rows × ~250 bytes each. Anything larger is
    // an abuse signal.
    body = await readBoundedJson<{ apps?: unknown }>(request, 256 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid body' },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.apps) || body.apps.length === 0) {
    return NextResponse.json(
      { error: 'Expected { apps: [{ name, source, ... }, ...] }' },
      { status: 400 },
    );
  }

  if (body.apps.length > MAX_BULK_ROWS) {
    return NextResponse.json(
      { error: `Too many rows (${body.apps.length} > ${MAX_BULK_ROWS}). Split the batch.` },
      { status: 413 },
    );
  }

  const rows = body.apps as BulkInputRow[];
  const results: BulkRowResult[] = [];
  let created = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') {
      results.push({ index: i, ok: false, error: 'Row must be an object' });
      failed += 1;
      continue;
    }

    if (!isManualAppSource(row.source)) {
      results.push({
        index: i,
        ok: false,
        error: `source must be one of: ${MANUAL_APP_SOURCES.join(', ')}`,
      });
      failed += 1;
      continue;
    }

    const input: ManualAppInput = {
      name: typeof row.name === 'string' ? row.name : '',
      source: row.source as ManualAppSource,
      developer: typeof row.developer === 'string' ? row.developer : null,
      privacyPolicyUrl: null,
      sourceUrl: null,
      notes: null,
    };

    try {
      const app = createManualApp(input);
      results.push({ index: i, ok: true, app });
      created += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create manual app';
      results.push({ index: i, ok: false, error: message });
      failed += 1;
    }
  }

  recordAudit({
    action: 'manual-apps.bulk',
    actorIp,
    userAgent,
    success: created > 0,
    detail: `created=${created} failed=${failed} total=${rows.length}`,
  });

  return NextResponse.json(
    { created, failed, results },
    { status: created > 0 ? 200 : 400 },
  );
}
