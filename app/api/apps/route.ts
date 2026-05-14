export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getAllApps, getAppWithPrivacy, getGroupedPrivacyView } from '../../../lib/scraper';
import { getChangelog } from '../../../lib/changelog';
import { markImportItemsRemovedForApp } from '../../../lib/imports';
import db from '../../../lib/db';
import {
  recordAudit,
  requestActorIp,
  checkRateLimit,
  rateLimitKeyForRequest,
  adminTokenRequiredForRequest,
  requestHasValidAdminToken,
} from '../../../lib/security';
import { withApiTiming } from '../../../lib/api-timing';

async function getAppsRoute(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const view = searchParams.get('view');
  const changelog = searchParams.get('changelog');

  if (id && changelog === 'true') {
    const logs = getChangelog(id);
    return NextResponse.json(logs);
  }

  if (id) {
    const appInfo = getAppWithPrivacy(id);
    if (!appInfo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(appInfo);
  }

  if (view === 'grouped') {
    return NextResponse.json(getGroupedPrivacyView());
  }

  return NextResponse.json(getAllApps());
}

export const GET = withApiTiming('/api/apps', getAppsRoute);

export async function DELETE(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'apps.delete'),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429 },
    );
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'app.delete.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  // The stored app id is the numeric Apple track id — validate so the audit
  // log isn't polluted with arbitrary user-supplied strings.
  if (!/^\d{1,20}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  // Flip any import rows that brought this app in to `status = 'removed'`
  // *first*, inside the same transaction as the actual delete. This keeps
  // the FK SET NULL from wiping out our record of which app was removed
  // (we copy app_id → removed_app_id before the cascade fires), and it
  // ensures a later retry / re-sync sees the tombstone and declines to
  // silently re-add the app the user explicitly removed.
  const tx = db.transaction(() => {
    markImportItemsRemovedForApp(id);
    db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  });
  try {
    tx();
  } catch (error) {
    recordAudit({
      action: 'app.delete.failed',
      actorIp,
      userAgent,
      success: false,
      detail: `id=${id} error=${error instanceof Error ? error.message : String(error)}`,
    });
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  recordAudit({
    action: 'app.delete.success',
    actorIp,
    userAgent,
    success: true,
    detail: `id=${id}`,
  });

  return NextResponse.json({ success: true });
}
