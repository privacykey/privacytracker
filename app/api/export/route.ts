export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '../../../lib/db';
import { getAllApps, getAppWithPrivacy } from '../../../lib/scraper';

function getExportRows() {
  return db.prepare(`
    SELECT
      a.name        AS app_name,
      a.developer,
      a.url,
      a.lastSynced,
      pt.title      AS privacy_type,
      pc.title      AS category
    FROM apps a
    LEFT JOIN privacy_types      pt  ON pt.app_id   = a.id
    LEFT JOIN privacy_categories pc  ON pc.type_id   = pt.id
    ORDER BY a.name, pt.identifier, pc.identifier
  `).all() as any[];
}

function toCsv(rows: any[]): string {
  const headers = ['App Name', 'Developer', 'URL', 'Last Synced', 'Privacy Type', 'Category'];
  const escape  = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmtDate = (ts: number) => ts ? new Date(ts).toISOString().split('T')[0] : '';

  return [
    headers.map(escape).join(','),
    ...rows.map(r =>
      [r.app_name, r.developer, r.url, fmtDate(r.lastSynced), r.privacy_type, r.category]
        .map(escape).join(',')
    ),
  ].join('\n');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') ?? 'csv';

  if (format === 'json') {
    const apps = getAllApps() as any[];
    const full  = apps.map((a: any) => getAppWithPrivacy(a.id));
    return NextResponse.json({ exported_at: new Date().toISOString(), apps: full });
  }

  const csv      = toCsv(getExportRows());
  const filename = `privacytracker-${new Date().toISOString().split('T')[0]}.csv`;
  return new Response(csv, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
