export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  deleteManualApp,
  getManualApp,
  updateManualApp,
} from '../../../../lib/manual-apps-server';
import {
  MANUAL_APP_SOURCES,
  isManualAppSource,
  type ManualAppInput,
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

// Next 16 hands params as a Promise. The webpack-mode build's TS check
// (`next build --webpack`) rejects union types like `T | Promise<T>` here
// with "Type 'X' is not a valid type for the function's second argument",
// so we declare the Promise variant exclusively. The
// `await Promise.resolve(context.params)` below stays for runtime
// resilience.
type Ctx = { params: Promise<{ id: string }> };

async function resolveId(context: Ctx): Promise<string | null> {
  const params = await Promise.resolve(context.params);
  const id = (params?.id ?? '').toString();
  // Manual apps use crypto.randomUUID(); 36 chars. Be generous for
  // forward-compat but still bound so we don't hit SQLite with arbitrary
  // strings via a malicious URL probe.
  if (!id || id.length > 128) return null;
  return id;
}

export async function GET(request: Request, context: Ctx) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'manual-apps.read'),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const app = getManualApp(id);
  if (!app) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ app });
}

/**
 * Partial update — fields omitted are left alone, fields set to `null` are
 * cleared. Mirrors the semantics of `updateManualApp` in the CRUD module.
 */
export async function PUT(request: Request, context: Ctx) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'manual-apps.write'),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'manual-apps.update.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid body' },
      { status: 400 },
    );
  }

  // Build the patch from only the keys the caller actually sent. Using
  // `hasOwnProperty` matches the update helper's shape (missing = leave
  // alone, present-with-null = clear).
  const patch: Partial<ManualAppInput> = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    patch.name = typeof body.name === 'string' ? body.name : '';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'source')) {
    if (!isManualAppSource(body.source)) {
      return NextResponse.json(
        { error: `source must be one of: ${MANUAL_APP_SOURCES.join(', ')}` },
        { status: 400 },
      );
    }
    patch.source = body.source;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'developer')) {
    patch.developer = typeof body.developer === 'string' ? body.developer : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'privacyPolicyUrl')) {
    patch.privacyPolicyUrl = typeof body.privacyPolicyUrl === 'string' ? body.privacyPolicyUrl : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sourceUrl')) {
    patch.sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    patch.notes = typeof body.notes === 'string' ? body.notes : null;
  }

  try {
    const updated = updateManualApp(id, patch);
    if (!updated) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    recordAudit({
      action: 'manual-apps.update.success',
      actorIp,
      userAgent,
      success: true,
      detail: `id=${id} fields=${Object.keys(patch).join(',')}`,
    });
    return NextResponse.json({ app: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update manual app';
    recordAudit({
      action: 'manual-apps.update.failed',
      actorIp,
      userAgent,
      success: false,
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: Ctx) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'manual-apps.write'),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'manual-apps.delete.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const removed = deleteManualApp(id);
  if (!removed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  recordAudit({
    action: 'manual-apps.delete.success',
    actorIp,
    userAgent,
    success: true,
    detail: `id=${id}`,
  });
  return NextResponse.json({ success: true });
}
