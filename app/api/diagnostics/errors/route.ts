/**
 * Error / warning ring buffer endpoint.
 *
 *   GET    — newest-first slice of captured console.error / console.warn
 *            lines. Lightweight; polled by the diagnostics page.
 *   DELETE — drop every entry. Admin-token gated; useful when the user
 *            wants a clean window before reproducing an issue.
 */

import { NextResponse } from 'next/server';
import { clearErrorLog, snapshotErrorLog } from '@/lib/error-log-ring';
import {
  adminTokenConfigured,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  return NextResponse.json(
    snapshotErrorLog({ limit: Number.isFinite(limit) ? limit : undefined }),
  );
}

export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'diagnostics.errors.clear'),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again shortly.' },
      { status: 429 },
    );
  }

  if (adminTokenConfigured() && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'diagnostics.errors.clear.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  clearErrorLog();
  recordAudit({
    action: 'diagnostics.errors.clear.success',
    actorIp,
    userAgent,
    success: true,
  });
  return NextResponse.json(snapshotErrorLog());
}
