/**
 * /api/export/audit-bundle — POST returns a downloadable audit bundle.
 *
 * Body: { recommenderName?, includeRecommenderProfile? (default true),
 *   migrationFlow? }
 *
 * Returns a JSON file with `Content-Disposition: attachment; filename=…`.
 * Private annotations (visibility='private') are unconditionally excluded
 * by the SQL filter in `buildAuditBundle()` — no force-include escape hatch.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { buildAuditBundle, buildBundleFilename } from '@/lib/audit-bundle';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';
import { getActiveFocus } from '@/lib/feature-flag-storage';

export const dynamic = 'force-dynamic';

interface ExportBody {
  recommenderName?: string | null;
  includeRecommenderProfile?: boolean;
  /**
   * When true, the produced bundle carries `migration_flow: true`. The
   * receiving install treats the import as a same-user migration (no
   * provenance banner) and records a one-shot marker in
   * app_settings.migration_flow_pending so the next dashboard load can
   * redirect to /dashboard/review-recommendations.
   */
  migrationFlow?: boolean;
}

export async function POST(request: NextRequest) {
  let body: ExportBody = {};
  try {
    body = (await request.json()) as ExportBody;
  } catch {
    // Empty body is fine — defaults apply.
  }

  // Gate: only callable when the bundle export flag is on. Client surfaces
  // hide the button when off, but the API is the authoritative gate.
  try {
    if (resolveFlagFromDb('flag.settings.admin.export.audit_bundle') !== 'on') {
      return NextResponse.json(
        { error: 'Audit-bundle export is not enabled for your focus' },
        { status: 403 },
      );
    }
  } catch (e) {
    console.warn('[/api/export/audit-bundle] flag resolution failed:', e);
    // Fail closed when we can't confirm the gate.
    return NextResponse.json(
      { error: 'Could not check export permission' },
      { status: 500 },
    );
  }

  const focus = (() => {
    try { return getActiveFocus(); } catch { return null; }
  })();

  let bundle;
  try {
    bundle = buildAuditBundle({
      recommenderName: body.recommenderName ?? null,
      includeRecommenderProfile: body.includeRecommenderProfile !== false,
      exportedByAudience: focus?.audience ?? 'self',
      migrationFlow: body.migrationFlow === true,
    });
  } catch (e) {
    console.error('[/api/export/audit-bundle] build failed:', e);
    return NextResponse.json({ error: 'Failed to build audit bundle' }, { status: 500 });
  }

  const filename = buildBundleFilename(body.recommenderName ?? null);
  const json = JSON.stringify(bundle, null, 2);

  return new NextResponse(json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Discourage caching — bundles are point-in-time exports.
      'Cache-Control': 'no-store',
    },
  });
}
