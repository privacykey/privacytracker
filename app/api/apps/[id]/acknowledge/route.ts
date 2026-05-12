export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  recordReviewAction,
  SNOOZE_DAYS_OPTIONS,
  type ReviewAction,
  type SnoozeDays,
} from '../../../../../lib/changelog';
import { readOptionalBoundedJson } from '../../../../../lib/security';

/**
 * POST /api/apps/[id]/acknowledge
 *
 * Records a review-panel action against the app's "What's changed" list.
 * Optional body shape:
 *   { action?: 'reviewed' | 'dismissed' | 'snoozed' | 'unsnoozed',
 *     snoozeDays?: 1 | 7 | 30 }
 *
 * Back-compat: an empty body (the original single-button behaviour) is
 * treated as { action: 'reviewed' } so existing fetch() calls keep
 * working without change.
 *
 * snoozeDays is only honoured when action === 'snoozed'. Unrecognised
 * values fall back to 7 days so a future client that drops a typo in
 * doesn't leave the panel stuck.
 */
const VALID_ACTIONS: ReviewAction[] = ['reviewed', 'dismissed', 'snoozed', 'unsnoozed'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  // Body is optional — `await request.json()` throws on an empty payload,
  // so guard it and treat any failure to parse as "use defaults". Keeps
  // the old caller (fetch without a body) working without a version bump.
  let body: { action?: unknown; snoozeDays?: unknown } = {};
  try {
    body = await readOptionalBoundedJson(request, 2 * 1024, {});
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawAction = typeof body?.action === 'string' ? body.action.trim() : 'reviewed';
  if (!VALID_ACTIONS.includes(rawAction as ReviewAction)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }
  const action = rawAction as ReviewAction;

  let snoozeDays: SnoozeDays | undefined;
  if (action === 'snoozed') {
    const rawDays = Number(body?.snoozeDays);
    if (SNOOZE_DAYS_OPTIONS.includes(rawDays as SnoozeDays)) {
      snoozeDays = rawDays as SnoozeDays;
    } else {
      // Default to 1 week so a missing / invalid value still does something
      // sensible rather than 400-ing the user at the checkout stage.
      snoozeDays = 7;
    }
  }

  const record = recordReviewAction(id, { action, snoozeDays });
  return NextResponse.json({ ok: true, record });
}
