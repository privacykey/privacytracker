/**
 * POST /api/feature-flags/resolve-preview — resolve the curated feature-toggle
 * flags against an IN-PROGRESS focus selection (the goals/audience the user is
 * editing in the form but hasn't saved yet), so the toggle row can show the
 * right focus baseline before the focus is persisted.
 *
 *   POST { audience, monitor, cleanup, minimal, accessibility }
 *        → { focusValues: { <key>: 'on' | 'off' | 'collapsed', ... } }
 *
 * Read-only: it never calls setActiveFocus / writes anything, so — unlike the
 * override mutations — it is NOT behind requireMutationGuard. It only exposes
 * resolved flag values, which the public GET /api/feature-flags already returns.
 */

import { NextResponse } from "next/server";
import {
  type Audience,
  activeGoalsFrom,
  type FlagKey,
  type FlagValue,
} from "@/lib/feature-flag-rules";
import { resolveFocusBaseline } from "@/lib/feature-flags";
import { getResolverContextFromDb } from "@/lib/feature-flags-server";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * The curated keys the toggle row exposes — kept in lockstep with the TOGGLES
 * array in FeatureToggleRow.tsx. Previewing only these avoids resolving the
 * whole registry against a synthetic focus on every keystroke.
 */
const PREVIEW_KEYS: readonly FlagKey[] = [
  "flag.detail.policy.ai_summary",
  "flag.page.compare",
  "flag.page.privacy_map",
  "flag.page.stats",
  "flag.nav.notification_bell",
  "flag.page.shortlist",
];

const VALID_AUDIENCES: readonly Audience[] = ["self", "loved_one", "guardian"];

interface PreviewBody {
  accessibility?: unknown;
  audience?: unknown;
  cleanup?: unknown;
  minimal?: unknown;
  monitor?: unknown;
}

export async function POST(request: Request) {
  let body: PreviewBody;
  try {
    body = await readBoundedJson<PreviewBody>(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { audience } = body;
  if (
    typeof audience !== "string" ||
    !VALID_AUDIENCES.includes(audience as Audience)
  ) {
    return NextResponse.json(
      { error: `audience must be one of: ${VALID_AUDIENCES.join(", ")}` },
      { status: 400 }
    );
  }

  // Mirror resolvePurposeSelection: `minimal` is subtractive and wins over the
  // additive goal tiles. activeGoalsFrom enforces that, so a would-be submit
  // and this preview resolve to the same goal set.
  const goals = activeGoalsFrom({
    monitor: body.monitor === true,
    cleanup: body.cleanup === true,
    minimal: body.minimal === true,
    accessibility: body.accessibility === true,
  });

  // Real resolver context (kill-switch, runtime env, aiConfigured, the live
  // overrides) with ONLY the focus swapped for the in-progress selection.
  const live = getResolverContextFromDb();
  const previewCtx = {
    ...live,
    focus: {
      audience: audience as Audience,
      goals,
      aiConfigured: live.focus.aiConfigured,
    },
  };

  const focusValues: Record<string, FlagValue> = {};
  for (const key of PREVIEW_KEYS) {
    focusValues[key] = resolveFocusBaseline(key, previewCtx);
  }

  return NextResponse.json({ focusValues });
}
