/**
 * /api/import/audit-bundle — receive an audit-bundle JSON and apply it.
 *
 *   POST                              — validate-only preview (returns
 *                                       parsed bundle envelope + the
 *                                       existing-import dedup record so
 *                                       the client can render the
 *                                       confirm modal). Body shape:
 *                                       multipart/form-data with `file`
 *                                       OR application/json with the
 *                                       full parsed bundle inline.
 *   POST ?confirm=1                   — same as above but actually runs
 *                                       the merge after passing through
 *                                       validateBundle().
 *   POST ?confirm=1&allowDuplicate=1  — proceed even though the same
 *                                       exported_at has been imported
 *                                       before (used by the "you already
 *                                       imported this — proceed anyway"
 *                                       affordance).
 *   POST ?force=1                     — bypass the version check (schema
 *                                       + field checks still run). Power-
 *                                       user debug knob; surfaced only via
 *                                       URL param.
 *
 * The split between "preview" (no `confirm`) and "commit" (`?confirm=1`)
 * is what lets the client render the validation result + dedup prompt
 * BEFORE any data lands in the DB. Preview does not touch storage.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  validateBundle,
  importAuditBundle,
  findExistingImport,
} from '@/lib/audit-bundle-import';
import { recordActivity } from '@/lib/activity';

export const dynamic = 'force-dynamic';
// Bumped from the default 1 mb body cap — bundles can carry the per-app
// 4kb policy excerpt times N apps, plus annotations. 8 mb leaves
// headroom for a few hundred apps without hitting the limit; clients
// can always trim their export if they go bigger.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm') === '1';
  const allowDuplicate = url.searchParams.get('allowDuplicate') === '1';
  const force = url.searchParams.get('force') === '1';

  // Body parsing — support multipart (real file upload from the modal)
  // and application/json (testing / programmatic clients).
  let parsed: unknown;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'No file uploaded. Attach a `.audit.json` file to the `file` form field.' },
          { status: 400 },
        );
      }
      const text = await file.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        return NextResponse.json(
          { error: "This file isn't a valid audit bundle (couldn't parse JSON)." },
          { status: 400 },
        );
      }
    } else {
      // application/json — body is the parsed bundle directly.
      try {
        parsed = await request.json();
      } catch {
        return NextResponse.json(
          { error: "This file isn't a valid audit bundle (couldn't parse JSON)." },
          { status: 400 },
        );
      }
    }
  } catch (err) {
    console.error('[/api/import/audit-bundle POST] body read failed:', err);
    return NextResponse.json(
      { error: 'Could not read the uploaded file.' },
      { status: 400 },
    );
  }

  // Step 1-4: shape + version validation. See lib/audit-bundle-import.ts.
  const result = validateBundle(parsed, { force });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { bundle } = result;

  // Dedup probe — surfaced both on preview AND commit so a stale client
  // race can't slip through (preview said "fresh" → user clicks Confirm
  // → another import landed in between → server still detects).
  const existing = findExistingImport(bundle.exported_at);

  if (!confirm) {
    // Preview path — return the envelope + dedup status, no DB writes.
    return NextResponse.json({
      ok: true,
      preview: true,
      bundle: {
        version: bundle.version,
        app_version: bundle.app_version,
        exported_at: bundle.exported_at,
        recommender_name: bundle.recommender_name,
        exported_by_audience: bundle.exported_by_audience,
        apps_count: bundle.apps.length,
        annotations_count: bundle.annotations.length,
        has_recommender_profile: !!bundle.recommender_profile,
      },
      existingImport: existing,
    });
  }

  // Commit path — block on dedup unless the caller explicitly opted in.
  if (existing && !allowDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: 'duplicate',
        existingImport: existing,
        // Friendly copy the client can render verbatim if it doesn't
        // want to format the date itself.
        message: `You already imported this bundle on ${new Date(existing.importedAt).toLocaleString()}.`,
      },
      { status: 409 },
    );
  }

  try {
    const summary = importAuditBundle(bundle, { allowDuplicate });

    // Activity-log row so the Settings → Activity Log surface (and a
    // future "previous imports" page) can render the audit-bundle
    // import alongside other operational events. Best-effort: a logging
    // failure shouldn't fail the import after data already landed.
    try {
      recordActivity({
        type: 'bundle_imported',
        status: 'ok',
        summary: `${summary.appsAdded} added · ${summary.appsUpdated} updated · ${summary.appsSkipped} skipped · ${summary.annotationsAdded} note${summary.annotationsAdded === 1 ? '' : 's'}`,
        detail: {
          ...summary,
          exportedAt: bundle.exported_at,
        },
        startedAt: Date.now(),
      });
    } catch (logErr) {
      console.warn('[/api/import/audit-bundle POST] activity log failed:', logErr);
    }

    return NextResponse.json({ ok: true, preview: false, summary });
  } catch (err) {
    console.error('[/api/import/audit-bundle POST] import failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to import bundle.' },
      { status: 500 },
    );
  }
}
