export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { recordActivity } from "../../../lib/activity";
import {
  describePresetTransition,
  type PrivacyProfile,
  sanitizeProfile,
} from "../../../lib/privacy-profile";
import {
  getPrivacyProfile,
  savePrivacyProfile,
} from "../../../lib/privacy-profile-server";
import { readBoundedJson } from "../../../lib/security";

/**
 * GET  → { profile: { [categoryKey]: tier } | null }
 * PUT  → body { profile: PrivacyProfile | null }  (null clears)
 *
 * Sparse objects are fine — keys the user hasn't chosen a tier for are simply
 * absent. The server sanitises on save, so unknown category keys or unknown
 * tier strings get dropped before they reach the DB.
 *
 * The PUT path also records a `profile_preset_applied` activity row when a
 * save crosses a preset boundary (picking a preset, switching presets, or
 * clearing a profile that previously had preferences). Custom-to-custom
 * edits — single-row tweaks that leave the profile in a non-preset state
 * — intentionally don't surface; the activity log is for noteworthy
 * transitions, not the editor's debounced keystrokes. See
 * `describePresetTransition` for the exact rule set.
 */
export async function GET() {
  return NextResponse.json({ profile: getPrivacyProfile() });
}

/**
 * Save the profile, then record an activity row if the change crossed a
 * preset boundary. We grab `getPrivacyProfile()` BEFORE the save so the
 * helper can see the actual transition (matchPreset on old vs. new).
 */
function saveAndLog(next: PrivacyProfile | null): void {
  const startedAt = Date.now();
  const previous = getPrivacyProfile();
  savePrivacyProfile(next);
  const transition = describePresetTransition(previous, next);
  if (transition) {
    recordActivity({
      type: "profile_preset_applied",
      status: "ok",
      summary: transition.summary,
      detail: transition.detail,
      startedAt,
    });
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, 16 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Body must be an object" },
      { status: 400 }
    );
  }

  const raw = (body as { profile?: unknown }).profile;
  if (raw === null) {
    saveAndLog(null);
    return NextResponse.json({ profile: null });
  }
  if (raw === undefined) {
    return NextResponse.json(
      {
        error:
          "Missing `profile` key. Pass null to clear, or an object to save.",
      },
      { status: 400 }
    );
  }

  const clean = sanitizeProfile(raw);
  saveAndLog(clean);
  return NextResponse.json({ profile: getPrivacyProfile() });
}
