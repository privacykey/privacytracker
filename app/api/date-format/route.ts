/**
 * GET /api/date-format   — read the current preference.
 * POST /api/date-format  — body `{ mode: 'auto' | 'dmy' | 'mdy' | 'iso' }`,
 *                          stores the preference in app_settings.
 *
 * The value flows out to formatDate() consumers via:
 *   - server components: getDateFormatPreference() in lib/date-format-server.ts
 *   - client components: useDateFormat() hook (this endpoint as the source)
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  type DateFormatMode,
  normaliseDateFormat,
} from "../../../lib/date-format";
import { getSetting, setSetting } from "../../../lib/scheduler";
import { readBoundedJson } from "../../../lib/security";

export async function GET() {
  let raw = "";
  try {
    raw = getSetting("date_format", "");
  } catch {
    /* fall through — return default */
  }
  const mode = normaliseDateFormat(raw);
  return NextResponse.json({ mode });
}

export async function POST(request: Request) {
  let body: { mode?: unknown } = {};
  try {
    body = await readBoundedJson<{ mode?: unknown }>(request, 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const mode = normaliseDateFormat(
    typeof body.mode === "string" ? body.mode : null
  );
  // Round-trip through the normaliser so an attacker can't sneak an
  // arbitrary string in via the API and have it land in app_settings.
  // Anything we don't recognise comes back as 'auto', which is also
  // the safe default. Persist the normalised value, not the raw input.
  const safe: DateFormatMode = mode;
  try {
    setSetting("date_format", safe);
  } catch (e) {
    console.error("[/api/date-format] write failed:", e);
    return NextResponse.json(
      { error: "Could not save the date-format preference." },
      { status: 500 }
    );
  }
  return NextResponse.json({ mode: safe });
}
