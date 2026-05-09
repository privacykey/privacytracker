export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  clearUserIntent,
  getManualAppsBannerDismissed,
  getUserIntent,
  setManualAppsBannerDismissed,
  setUserIntent,
} from '../../../lib/preferences-server';
import { INTENT_META, USER_INTENTS, isUserIntent } from '../../../lib/preferences';
import { readBoundedJson } from '../../../lib/security';

/**
 * Read the user's onboarding preferences. Currently just the `userIntent`
 * archetype, but this route is the stable surface for future per-user
 * toggles so we don't have to keep inventing new endpoints.
 *
 * Returns `userIntent: null` when the user hasn't answered the welcome
 * splash yet — callers (routing, dashboard tailoring) use that to decide
 * whether to show the splash or fall back to neutral defaults.
 */
export async function GET() {
  return NextResponse.json({
    userIntent: getUserIntent(),
    manualAppsBannerDismissed: getManualAppsBannerDismissed(),
    options: USER_INTENTS.map(value => ({ ...INTENT_META[value] })),
  });
}

/**
 * Update preferences. Body shape: `{ userIntent: 'curious' | 'cleanup' |
 * 'hygiene' | 'family' | null }`. Passing `null` explicitly clears the
 * stored value — useful for a "re-run onboarding" action even though the
 * UI doesn't expose it yet.
 */
export async function PUT(request: Request) {
  let body: any;
  try {
    body = await readBoundedJson(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body && Object.prototype.hasOwnProperty.call(body, 'userIntent')) {
    const value = body.userIntent;
    if (value === null) {
      clearUserIntent();
    } else if (isUserIntent(value)) {
      setUserIntent(value);
    } else {
      return NextResponse.json(
        {
          error: `userIntent must be one of: ${USER_INTENTS.join(', ')} or null`,
        },
        { status: 400 },
      );
    }
  }

  // Allow clients to stash the "don't show the manual-apps banner again"
  // flag. `true` dismisses, `false` (or `null`) resurfaces it — both
  // directions are useful so a future "Show onboarding tips again"
  // Settings control can flip it back.
  if (body && Object.prototype.hasOwnProperty.call(body, 'dismissManualAppsBanner')) {
    const value = body.dismissManualAppsBanner;
    if (typeof value !== 'boolean' && value !== null) {
      return NextResponse.json(
        { error: 'dismissManualAppsBanner must be a boolean or null' },
        { status: 400 },
      );
    }
    setManualAppsBannerDismissed(value === true);
  }

  return NextResponse.json({
    userIntent: getUserIntent(),
    manualAppsBannerDismissed: getManualAppsBannerDismissed(),
  });
}
