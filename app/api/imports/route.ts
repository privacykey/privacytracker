export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  IMPORT_SOURCES,
  createImport,
  deleteImport,
  getImport,
  listImports,
  type ImportSource,
} from '../../../lib/imports';
import { readBoundedJson } from '../../../lib/security';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (id) {
    const result = getImport(id);
    if (!result) return NextResponse.json({ error: 'Import not found' }, { status: 404 });
    return NextResponse.json(result);
  }
  return NextResponse.json(listImports());
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      { status: 400 },
    );
  }

  try {
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!IMPORT_SOURCES.includes(source as ImportSource)) {
      return NextResponse.json(
        { error: `source must be one of ${IMPORT_SOURCES.join(', ')}` },
        { status: 400 },
      );
    }

    const row = createImport({
      source: source as ImportSource,
      sourceLabel: typeof body?.sourceLabel === 'string' ? body.sourceLabel : undefined,
      total: typeof body?.total === 'number' ? body.total : 0,
    });

    return NextResponse.json(row);
  } catch (error) {
    console.error('Create import error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const removeApps = searchParams.get('removeApps') === 'true';
  try {
    const { deletedApps } = deleteImport(id, { removeApps });
    return NextResponse.json({ success: true, deletedApps });
  } catch (error) {
    console.error('Delete import error', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
