export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { previewRestore, BackupFormatError } from '../../../../lib/backup';

// Backups can be large — up to tens of MB for long-running installs. The
// proxy caps general API bodies at 256 KiB, but the preview/restore endpoints
// legitimately need much more. Accept up to 100 MiB, which comfortably covers
// any realistic user dataset while still refusing to swallow a malicious
// unbounded upload.
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

/**
 * POST /api/backup/preview
 *
 * Validates the shape of an uploaded backup JSON and returns a summary
 * (per-table row counts, warnings). Does NOT touch the database — the UI
 * calls this to populate the confirmation dialog before the user commits to
 * a destructive restore.
 */
export async function POST(request: Request) {
  try {
    const payload = await readJsonBody(request, MAX_BACKUP_BYTES);
    const preview = previewRestore(payload);
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof BackupFormatError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[backup] preview failed:', error);
    return NextResponse.json(
      { error: message || 'Could not preview backup.' },
      { status: 400 },
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
