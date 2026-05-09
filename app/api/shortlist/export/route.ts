export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { exportShortlistMarkdown, listShortlistGroups } from '../../../../lib/shortlist';
import { checkRateLimit, rateLimitKeyForRequest } from '../../../../lib/security';

/**
 * Export the shortlist. Two formats:
 *   ?format=md  (default) — Markdown download, suitable for notes apps or
 *                            handing to a colleague.
 *   ?format=json          — Structured JSON, for scripts or the dashboard's
 *                            own print-preview page (which renders its own
 *                            stylesheet and needs the raw data).
 *
 * Intentionally unauthenticated. The shortlist payload is the list of apps
 * the user has ALREADY decided to consider downloading — nothing here is
 * more sensitive than what /api/apps already returns on this same origin.
 */
export async function GET(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'shortlist.export'),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'md').toLowerCase();

  if (format === 'json') {
    return NextResponse.json({
      exported_at: new Date().toISOString(),
      groups: listShortlistGroups(),
    });
  }

  const md = exportShortlistMarkdown();
  const filename = `app-shortlist-${new Date().toISOString().split('T')[0]}.md`;
  return new Response(md, {
    headers: {
      'Content-Type':        'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
