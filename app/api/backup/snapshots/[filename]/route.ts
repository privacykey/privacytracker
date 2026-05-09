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
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${path.basename(snapshotPath)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
