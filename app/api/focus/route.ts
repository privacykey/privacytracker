/**
 * /api/focus — write audience + goals from the onboarding screens.
 *
 * Replaces the old `/api/preferences` user_intent flow for the new two-axis
 * focus model. Writes the five `flag.focus.*` keys atomically. Per docs §4.5
 * the migration in instrumentation.ts handles the legacy `user_intent` key
 * on first boot; new flows never touch it.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isValidAgeBand } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
  setActiveFocus,
} from "@/lib/feature-flag-storage";
import {
  type FocusWorkflow,
  inferFocusWorkflow,
  isFocusWorkflow,
} from "@/lib/focus-workflow";
import { getSetting, setSetting } from "@/lib/scheduler";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * GET — return the current focus + AI-configured derivation. Used by the
 * developer menu to seed its audience/goals toggles without forcing
 * every consumer to parse the full feature-flag list.
 */
export async function GET() {
  const focus = getActiveFocus();
  const workflow = getActiveFocusWorkflow(focus);
  return NextResponse.json({
    audience: focus.audience,
    understand: focus.goals.has("understand"),
    declutter: focus.goals.has("declutter"),
    minimal: focus.goals.has("minimal"),
    accessibility: focus.goals.has("accessibility"),
    aiConfigured: focus.aiConfigured,
    workflow,
    childAgeBand: getSetting("guardian_child_age_band", "") || null,
  });
}

interface FocusBody {
  accessibility?: boolean;
  audience: Audience;
  /** Guardian child age band (AgeBandKey); "" or null clears it. */
  childAgeBand?: string | null;
  declutter?: boolean;
  minimal?: boolean;
  understand?: boolean;
  workflow?: FocusWorkflow;
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
  const workflow = body.workflow;
  if (workflow !== undefined && !isFocusWorkflow(workflow)) {
    return NextResponse.json(
      {
        error:
          "workflow must be one of: self_monitor, self_cleanup, other_handoff, other_monitor, custom",
      },
      { status: 400 }
    );
  }

  // Mutual exclusion: minimal can't combine with understand or declutter.
  // If client sent both, minimal wins (matches the goals-picker UI behaviour
  // where picking "Just the basics" deselects the other checkboxes).
  if (minimal) {
    understand = false;
    declutter = false;
  } else if (!(understand || declutter)) {
    // Silent fallback per §4.2 — empty primary goals defaults to understand.
    understand = true;
  }
  const finalWorkflow =
    workflow ??
    inferFocusWorkflow({ audience, understand, declutter, minimal });

  // Guardian child age band. `undefined` = field absent = leave unchanged
  // (older callers don't send it); "" / null = explicit clear. The band is
  // kept when the audience switches away — flags make every surface inert.
  const childAgeBand = body.childAgeBand;
  if (
    childAgeBand !== undefined &&
    childAgeBand !== null &&
    childAgeBand !== "" &&
    !isValidAgeBand(childAgeBand)
  ) {
    return NextResponse.json(
      { error: "childAgeBand must be a known age band key" },
      { status: 400 }
    );
  }

  try {
    setActiveFocus({
      audience,
      understand,
      declutter,
      minimal,
      accessibility,
      workflow: finalWorkflow,
    });
    if (childAgeBand !== undefined) {
      setSetting("guardian_child_age_band", childAgeBand ?? "");
    }
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
    workflow: finalWorkflow,
    childAgeBand: getSetting("guardian_child_age_band", "") || null,
  });
}
