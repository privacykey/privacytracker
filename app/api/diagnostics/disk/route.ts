/**
 * Disk + data-directory snapshot.
 *
 *   GET — file sizes, free / total bytes on the volume, last automated
 *         backup timestamp + count of snapshot files. Read-only, no
 *         rate-limit, polled at ~10 s by the diagnostics page.
 */

import { NextResponse } from 'next/server';
import { snapshotDisk } from '@/lib/disk-usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(snapshotDisk());
}
