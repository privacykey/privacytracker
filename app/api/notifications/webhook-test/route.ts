/**
 * /api/notifications/webhook-test
 *
 *   POST { url, format } → { ok, status, detail? }
 *
 * Test endpoint for the background-mode wizard's "Test webhook" button.
 * Fires a one-off sample payload to the user-supplied URL so they can
 * verify the webhook works before committing to saving it.
 *
 * Bypasses persisted settings — caller passes the URL + format inline
 * so the wizard can test without writing anything to the DB yet.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { postWebhookTestPayload, type WebhookFormat } from '@/lib/notification-webhooks';
import { readBoundedJson } from '@/lib/security';

export const dynamic = 'force-dynamic';

const VALID_FORMATS = ['slack', 'discord', 'teams', 'generic'] as const;

interface Body {
  url?: string;
  format?: string;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = await readBoundedJson<Body>(request, 2 * 1024);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const url = String(body.url ?? '').trim();
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }
  const format = String(body.format ?? 'generic') as WebhookFormat;
  if (!(VALID_FORMATS as readonly string[]).includes(format)) {
    return NextResponse.json(
      { error: `format must be one of: ${VALID_FORMATS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const result = await postWebhookTestPayload(url, format);
    return NextResponse.json(result);
  } catch (e) {
    console.error('[/api/notifications/webhook-test] failed:', e);
    return NextResponse.json(
      { ok: false, status: 0, detail: e instanceof Error ? e.message : 'Unknown error' },
      { status: 200 }, // 200 so the UI can read the error from the body
    );
  }
}
