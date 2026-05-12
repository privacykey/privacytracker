export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markUnreadByIds,
} from '../../../lib/notifications';
import { readOptionalBoundedJson } from '../../../lib/security';

export async function GET() {
  const notifications = getNotifications(30);
  const unreadCount = getUnreadCount();
  return NextResponse.json({ notifications, unreadCount });
}

export async function POST(request: Request) {
  // Body parsing is intentionally permissive: the original surface
  // accepted `{ action: 'mark_read' }` with no other fields, and we
  // want a typo on the new `mark_unread` shape to fall through to
  // the existing "Unknown action" error rather than silently 500.
  let body: { action?: unknown; ids?: unknown };
  try {
    body = await readOptionalBoundedJson(request, 32 * 1024, {});
  } catch {
    body = {};
  }

  if (body.action === 'mark_read') {
    markAllRead();
    return NextResponse.json({ success: true });
  }

  // Cmd-Z undo for the bell's auto-mark-as-read. The client posts
  // the ids that were unread at the moment the bell opened, and we
  // flip just those back to read=0. We deliberately don't accept
  // an empty / missing array to flip "everything" — that would
  // silently re-unread rows the user has long since acknowledged
  // through other paths (per-app review actions, reset, etc.).
  if (body.action === 'mark_unread') {
    if (!Array.isArray(body.ids)) {
      return NextResponse.json(
        { error: 'mark_unread requires `ids: string[]`' },
        { status: 400 },
      );
    }
    const ids = body.ids.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length === 0) {
      // Idempotent no-op rather than an error — covers the harmless
      // case where the client's stash was empty (the bell opened
      // when there were already zero unread rows).
      return NextResponse.json({ success: true, flipped: 0 });
    }
    const flipped = markUnreadByIds(ids);
    return NextResponse.json({ success: true, flipped });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
