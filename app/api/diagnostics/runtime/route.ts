/**
 * Live runtime diagnostics endpoint.
 *
 *   GET    — return the current snapshot (memory / heap / event-loop /
 *            slow-query ring). Cheap, no DB writes. Polled every ~2s by
 *            the diagnostics dashboard.
 *   DELETE — clear the slow-query ring AND reset the event-loop
 *            histogram so the user can capture a fresh window after
 *            making a change. Admin-token gated when configured.
 *
 * Distinct from `/api/desktop/diagnostics` (which is a one-shot
 * "copy report to clipboard" surface). The desktop route bundles every
 * piece of debug context into a single payload meant for GitHub issues;
 * this route is the live, polled, repeated read for the dashboard.
 */
import { NextResponse } from 'next/server';
import {
  clearSlowQueryRing,
  resetEventLoopMonitor,
  setProfilingEnabled,
  snapshotRuntimeMetrics,
} from '@/lib/runtime-diagnostics';
import { clearApiTimings, snapshotApiTimings } from '@/lib/api-timing';
import { clearScrapeActivity, snapshotScrapeActivity } from '@/lib/scrape-activity';
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
  readBoundedJson,
} from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET() {
  // No rate limit on the read path — the dashboard polls this. The
  // snapshot helper does no DB I/O so cost is dominated by serialisation
  // of the slow-query ring (~200 rows max).
  const runtime = snapshotRuntimeMetrics();
  return NextResponse.json({
    ...runtime,
    apiTimings: snapshotApiTimings(),
    scrapeActivity: snapshotScrapeActivity(),
  });
}

export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  // Tight rate limit — clearing the histogram is cheap, but we don't
  // want a misbehaving client to wipe the diagnostic state every tick
  // and turn the dashboard into a blind hill.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'diagnostics.runtime.clear'),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again shortly.' },
      { status: 429 },
    );
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'diagnostics.runtime.clear.unauthorised',
      actorIp,
      userAgent,
      success: false,
      detail: 'admin token required but missing or invalid',
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  clearSlowQueryRing();
  resetEventLoopMonitor();
  clearApiTimings();
  clearScrapeActivity();
  recordAudit({
    action: 'diagnostics.runtime.clear.success',
    actorIp,
    userAgent,
    success: true,
  });
  const runtime = snapshotRuntimeMetrics();
  return NextResponse.json({
    ...runtime,
    apiTimings: snapshotApiTimings(),
    scrapeActivity: snapshotScrapeActivity(),
  });
}

/**
 * POST toggles the slow-query profiling flag. Body shape:
 *   { profilingEnabled: boolean }
 * The flag defaults to ON in non-test environments; this exists so a
 * power user investigating a perf regression can flip it off to confirm
 * the wrapper itself isn't contributing measurable overhead.
 */
export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'diagnostics.runtime.config'),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again shortly.' },
      { status: 429 },
    );
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'diagnostics.runtime.config.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  let body: { profilingEnabled?: unknown };
  try {
    body = await readBoundedJson<{ profilingEnabled?: unknown }>(request, 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid body' },
      { status: 400 },
    );
  }

  if (typeof body.profilingEnabled !== 'boolean') {
    return NextResponse.json(
      { error: '`profilingEnabled` must be a boolean.' },
      { status: 400 },
    );
  }

  setProfilingEnabled(body.profilingEnabled);
  recordAudit({
    action: 'diagnostics.runtime.config.success',
    actorIp,
    userAgent,
    success: true,
    detail: `profilingEnabled=${body.profilingEnabled}`,
  });
  return NextResponse.json(snapshotRuntimeMetrics());
}
