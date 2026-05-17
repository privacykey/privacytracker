/**
 * Server-only accessor for the date-format preference. Pure read helper —
 * no DB writes here, callers go through `setSetting('date_format', …)`
 * directly when they save the preference.
 *
 * Kept in its own file (separate from lib/date-format.ts) because
 * lib/scheduler imports better-sqlite3, which Next refuses to bundle
 * into client components. The pure formatter (formatDate, etc.)
 * stays in lib/date-format.ts so client code can `import { formatDate }
 * from '@/lib/date-format'` without dragging the DB layer along.
 */

import "server-only";
import { type DateFormatMode, normaliseDateFormat } from "./date-format";
import { getSetting } from "./scheduler";

export function getDateFormatPreference(): DateFormatMode {
  let raw = "";
  try {
    raw = getSetting("date_format", "");
  } catch {
    // Fresh DB / migration in-flight — fall through to default.
  }
  return normaliseDateFormat(raw);
}
