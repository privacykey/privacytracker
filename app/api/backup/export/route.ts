export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { exportBackup, CURRENT_BACKUP_VERSION } from '../../../../lib/backup';
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from '../../../../lib/security';

/**
 * GET /api/backup/export
 *
 * Streams the entire user database as a versioned JSON download. Safe to call
 * at any time — the read runs inside a transaction so the snapshot is
 * internally consistent. Rate-limited lightly to prevent accidental loops
 * from tooling grabbing the whole DB repeatedly.
 *
 * Admin-token gate: when `AUDITOR_ADMIN_TOKEN` is configured we require the
 * `x-auditor-admin-token` header before producing the dump. The envelope is
 * already scrubbed of sensitive settings inside `lib/backup.ts` (see
 * `SENSITIVE_SETTING_KEYS`), but the gate is the cheaper, earlier defence —
 * it stops an unauthenticated caller from probing the contents at all and
 * keeps the export path consistent with the destructive sibling routes
 * (restore, snapshots).
 */
export async function GET(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'backup.export'),
    limit: 12,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    recordAudit({
      action: 'backup.export.rate_limited',
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${rate.retryAfterMs}`,
    });
    return NextResponse.json(
      { error: 'Too many export requests. Try again shortly.' },
      { status: 429 },
    );
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'backup.export.unauthorised',
      actorIp,
      userAgent,
      success: false,
      detail: 'admin token required but missing or invalid',
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  try {
    const envelope = exportBackup();
    const filename = `privacytracker-backup-${new Date(envelope.exportedAt ?? Date.now())
      .toISOString()
      .replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(envelope, null, 2);

    recordAudit({
      action: 'backup.export.success',
      actorIp,
      userAgent,
      success: true,
      detail: `version=${CURRENT_BACKUP_VERSION}, bytes=${body.length}`,
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Backup-Version': String(envelope.version),
      },
    });
  } catch (error) {
    console.error('[backup] export failed:', error);
    recordAudit({
      action: 'backup.export.failed',
      actorIp,
      userAgent,
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to build backup. Check server logs.' },
      { status: 500 },
    );
  }
}
