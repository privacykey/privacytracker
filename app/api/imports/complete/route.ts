export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { completeImport } from '../../../../lib/imports';
import { createManualAppsPromptNotification } from '../../../../lib/notifications';
import { readBoundedJson } from '../../../../lib/security';

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 4 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      { status: 400 },
    );
  }

  try {
    const importId = typeof body?.importId === 'string' ? body.importId.trim() : '';
    if (!importId) {
      return NextResponse.json({ error: 'importId is required' }, { status: 400 });
    }

    const row = completeImport(importId);
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 });
    }

    // If the import left rows unmatched, nudge the user toward the
    // manual-apps page — unmatched Configurator rows are often Safari web
    // clips, TestFlight installs, or sideloads that App Store search can't
    // resolve. The helper debounces so back-to-back imports don't nag.
    try {
      createManualAppsPromptNotification({
        unmatchedCount: row.unmatched ?? 0,
        sourceLabel: row.sourceLabel,
      });
    } catch (notifyError) {
      // Never let the nudge fail the import completion itself.
      console.warn('[complete-import] manual-apps notification failed:', notifyError);
    }

    return NextResponse.json(row);
  } catch (error) {
    console.error('Complete import error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
