/**
 * /api/focus — write audience + goals from the onboarding screens.
 *
 * Replaces the old `/api/preferences` user_intent flow for the new two-axis
 * focus model. Writes the five `flag.focus.*` keys atomically. Per docs §4.5
 * the migration in instrumentation.ts handles the legacy `user_intent` key
 * on first boot; new flows never touch it.
 */

import { type NextRequest, NextResponse } from "next/server";
import type { Audience } from "@/lib/feature-flag-rules";
import { getActiveFocus, setActiveFocus } from "@/lib/feature-flag-storage";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * GET — return the current focus + AI-configured derivation. Used by the
 * developer menu to seed its audience/goals toggles without forcing
 * every consumer to parse the full feature-flag list.
 */
export async function GET() {
  const focus = getActiveFocus();
  return NextResponse.json({
    audience: focus.audience,
    understand: focus.goals.has("understand"),
    declutter: focus.goals.has("declutter"),
    minimal: focus.goals.has("minimal"),
    accessibility: focus.goals.has("accessibility"),
    aiConfigured: focus.aiConfigured,
  });
}

interface FocusBody {
  accessibility?: boolean;
  audience: Audience;
  declutter?: boolean;
  minimal?: boolean;
  understand?: boolean;
}

const VALID_AUDIENCES: readonly Audience[] = ["self", "loved_one", "guardian"];

export async function POST(request: NextRequest) {
  let body: Partial<FocusBody>;
  try {
    body = await readBoundedJson<Partial<FocusBody>>(request, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const audience = body.audience;
  if (!(audience && VALID_AUDIENCES.includes(audience))) {
    return NextResponse.json(
      { error: `audience must be one of: ${VALID_AUDIENCES.join(", ")}` },
      { status: 400 }
    );
  }

  // Coerce goal flags to booleans. Undefined fields default to false.
  let understand = Boolean(body.understand);
  let declutter = Boolean(body.declutter);
  const minimal = Boolean(body.minimal);
  const accessibility = Boolean(body.accessibility);

  // Mutual exclusion: minimal can't combine with understand or declutter.
  // If client sent both, minimal wins (matches the screen 2 UI behaviour
  // where picking "Just the basics" deselects the other checkboxes).
  if (minimal) {
    understand = false;
    declutter = false;
  } else if (!(understand || declutter)) {
    // Silent fallback per §4.2 — empty primary goals defaults to understand.
    understand = true;
  }

  try {
    setActiveFocus({ audience, understand, declutter, minimal, accessibility });
  } catch (e) {
    console.error("[/api/focus] write failed:", e);
    return NextResponse.json(
      { error: "Failed to save focus" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    audience,
    understand,
    declutter,
    minimal,
    accessibility,
  });
}
