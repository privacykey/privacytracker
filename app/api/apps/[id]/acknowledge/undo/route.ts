/**
 * POST /api/apps/[id]/acknowledge/undo — reverses a prior recordReviewAction.
 *
 * Body: `{ actionId, preState: { changeCount, changesAcknowledgedAt,
 * changesSnoozedUntil } }`. Powers the Cmd-Z undo stack on the change-review
 * panel; the client stashes preState when the action is recorded and posts
 * it back here.
 */
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { undoReviewAction } from '../../../../../../lib/changelog';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  let body: {
    actionId?: unknown;
    preState?: {
      changeCount?: unknown;
      changesAcknowledgedAt?: unknown;
      changesSnoozedUntil?: unknown;
    };
  };
  try {
    const text = await request.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const actionId = typeof body?.actionId === 'string' ? body.actionId.trim() : '';
  if (!actionId) {
    return NextResponse.json({ error: 'Missing actionId' }, { status: 400 });
  }

  // Defensive numeric coercion to reject NaN / negative / non-finite values.
  const raw = body?.preState ?? {};
  const changeCount = Number(raw.changeCount);
  const changesAcknowledgedAt = Number(raw.changesAcknowledgedAt);
  const changesSnoozedUntil = Number(raw.changesSnoozedUntil);
  const allFinite = [changeCount, changesAcknowledgedAt, changesSnoozedUntil].every(
    n => Number.isFinite(n) && n >= 0,
  );
  if (!allFinite) {
    return NextResponse.json(
      { error: 'preState fields must be finite, non-negative numbers' },
      { status: 400 },
    );
  }

  const result = undoReviewAction(id, actionId, {
    changeCount: Math.floor(changeCount),
    changesAcknowledgedAt: Math.floor(changesAcknowledgedAt),
    changesSnoozedUntil: Math.floor(changesSnoozedUntil),
  });

  if (!result.ok) {
    // 410 Gone signals a stale undo stack (double Cmd-Z, sibling-tab undo)
    // so the UI can quietly drop the op without an error toast.
    return NextResponse.json(
      { error: 'Review action no longer exists or does not belong to this app' },
      { status: 410 },
    );
  }
  return NextResponse.json({ ok: true });
}
