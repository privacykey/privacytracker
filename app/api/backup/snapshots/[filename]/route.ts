export const dynamic = 'force-dynamic';

import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getBackupSnapshotPath } from '@/lib/backup-snapshots';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  const snapshotPath = getBackupSnapshotPath(filename);
  if (!snapshotPath) {
    return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
  }

  const body = fs.readFileSync(snapshotPath);
  // Defence-in-depth filename sanitisation. The upstream
  // `isSnapshotFilename` regex (lib/backup-snapshots.ts) only admits
  // `privacytracker-snapshot-<ISO>.json`, so today the basename is
  // structurally safe. But if a future loosening of that regex ever
  // permitted bytes the HTTP header layer treats specially (CR/LF for
  // header injection, `"` to escape the quoted-filename) we'd be
  // dropping them into a header verbatim. Strip every char that isn't
  // an ASCII filename component so the response is structurally safe
  // regardless of upstream changes.
  const safeName = path
    .basename(snapshotPath)
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
