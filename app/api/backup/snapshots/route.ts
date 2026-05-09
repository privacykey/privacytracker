export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  createBackupSnapshot,
  getBackupSnapshotDir,
  getBackupSnapshotSettings,
  listBackupSnapshots,
  saveBackupSnapshotSettings,
} from '@/lib/backup-snapshots';
import { requireMutationGuard } from '@/lib/api-guards';
import { readBoundedJson } from '@/lib/security';

function snapshotPayload() {
  return {
    settings: getBackupSnapshotSettings(),
    directory: getBackupSnapshotDir(),
    snapshots: listBackupSnapshots(),
  };
}

export async function GET() {
  return NextResponse.json(snapshotPayload());
}

export async function PUT(request: Request) {
  const guard = requireMutationGuard(request, {
    action: 'backup.snapshot.settings',
    rateLimit: {
      keyPrefix: 'backup.snapshot.settings',
      limit: 20,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 4 * 1024);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON body';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  saveBackupSnapshotSettings({
    enabled: body?.enabled,
    intervalHours: body?.intervalHours,
    retentionCount: body?.retentionCount,
  });
  return NextResponse.json(snapshotPayload());
}

export async function POST(request: Request) {
  const guard = requireMutationGuard(request, {
    action: 'backup.snapshot.create',
    rateLimit: {
      keyPrefix: 'backup.snapshot.create',
      limit: 5,
      windowMs: 10 * 60_000,
      message: 'Too many backup snapshots. Try again later.',
    },
  });
  if (!guard.ok) return guard.response;

  const result = createBackupSnapshot('manual');
  return NextResponse.json({
    ...snapshotPayload(),
    created: result.snapshot,
    pruned: result.pruned,
  });
}
