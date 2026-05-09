export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { restoreBackup, BackupFormatError } from '../../../../lib/backup';
import { getSetting } from '../../../../lib/scheduler';
import {
  adminTokenConfigured,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from '../../../../lib/security';

// Match the preview cap. See preview/route.ts for rationale.
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

/**
 * POST /api/backup/restore
 *
 * Destructive. Wipes the database and replaces every row with the contents
 * of the uploaded backup. Defence-in-depth mirrors /api/reset:
 *   - Rate-limited (3 attempts per 10 minutes).
 *   - Requires AUDITOR_ADMIN_TOKEN when configured.
 *   - Refuses to run while a background sync is in flight.
 *   - Records success + failure in audit_log.
 */
export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'backup.restore'),
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) {
    recordAudit({
      action: 'backup.restore.rate_limited',
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${rate.retryAfterMs}`,
    });
    return NextResponse.json(
      { error: 'Too many restore attempts. Try again later.' },
      { status: 429 },
    );
  }

  if (adminTokenConfigured() && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'backup.restore.unauthorised',
      actorIp,
      userAgent,
      success: false,
      detail: 'admin token required but missing or invalid',
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  if (getSetting('sync_running', 'false') === 'true') {
    return NextResponse.json(
      { error: 'A sync is currently running. Please wait until it finishes before restoring.' },
      { status: 409 },
    );
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request, MAX_BACKUP_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit({
      action: 'backup.restore.bad_request',
      actorIp,
      userAgent,
      success: false,
      detail: message.slice(0, 256),
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = restoreBackup(payload, {
      actorIp,
      userAgent: userAgent ?? undefined,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof BackupFormatError) {
      recordAudit({
        action: 'backup.restore.format_error',
        actorIp,
        userAgent,
        success: false,
        detail: error.message.slice(0, 256),
      });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[backup] restore failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    recordAudit({
      action: 'backup.restore.failed',
      actorIp,
      userAgent,
      success: false,
      detail: message.slice(0, 256),
    });
    return NextResponse.json(
      { error: message || 'Failed to restore backup.' },
      { status: 500 },
    );
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Backup too large (${declared} > ${maxBytes} bytes).`);
  }
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`Backup too large (${buf.byteLength} > ${maxBytes} bytes).`);
  }
  if (buf.byteLength === 0) {
    throw new Error('Empty upload.');
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('Uploaded file is not valid JSON.');
  }
}
