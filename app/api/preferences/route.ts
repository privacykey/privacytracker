export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getManualAppsBannerDismissed,
  setManualAppsBannerDismissed,
} from "../../../lib/preferences-server";
import { readBoundedJson } from "../../../lib/security";

/**
 * Read the user's dashboard preferences. Currently just the manual-apps
 * banner dismissal flag; this route is kept as the stable surface for
 * future per-user toggles so we don't have to keep inventing endpoints.
 * (The legacy `userIntent` archetype it used to expose was retired once the
 * dashboard moved to the audience + goals focus model.)
 */
export async function GET() {
  return NextResponse.json({
    manualAppsBannerDismissed: getManualAppsBannerDismissed(),
  });
}

/**
 * Update preferences. Body shape: `{ dismissManualAppsBanner: boolean | null }`.
 * `true` dismisses the "consider adding manual apps" banner, `false`/`null`
 * resurfaces it — both directions are useful so a future "show onboarding
 * tips again" Settings control can flip it back.
 */
export async function PUT(request: Request) {
  let body: any;
  try {
    body = await readBoundedJson(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body && Object.hasOwn(body, "dismissManualAppsBanner")) {
    const value = body.dismissManualAppsBanner;
    if (typeof value !== "boolean" && value !== null) {
      return NextResponse.json(
        { error: "dismissManualAppsBanner must be a boolean or null" },
        { status: 400 }
      );
    }
    setManualAppsBannerDismissed(value === true);
  }

  return NextResponse.json({
    manualAppsBannerDismissed: getManualAppsBannerDismissed(),
  });
}
