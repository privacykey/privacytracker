export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type { FlagKey } from "../../../lib/feature-flag-rules";
import { clearOverride, setOverride } from "../../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../../lib/feature-flags-server";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  parseStoredPrefs,
  sanitizePrefs,
} from "../../../lib/notification-prefs";
import { getSetting, setSetting } from "../../../lib/scheduler";
import { readBoundedJson } from "../../../lib/security";

/**
 * The flag system tracks four notification types — see the
 * `flag.notifications.types.*` keys in feature-flag-rules.ts. These are the
 * keys the resolver writes/reads, distinct from the legacy
 * `NotificationTypeKey` union in lib/notification-prefs.ts (which still
 * exists for the back-compat blob). We treat both sets as opaque strings
 * here and only the four below project through to flag overrides.
 */
type FlagNotificationTypeKey =
  | "label_changes"
  | "policy_updates"
  | "accessibility_changes"
  | "new_privacy_types";

/**
 * Round 3 wave I: per-type notification preferences are now backed by the
 * `flag.notifications.types.*` flag overrides rather than the legacy
 * `notification_prefs` JSON blob (which the v1 migration drained on first
 * boot). The API surface is unchanged — NotificationBell still posts to
 * /api/notification-prefs the same way — but reads/writes project across
 * the two storage layouts so a flag override and a Settings UI toggle stay
 * in sync.
 */
const TYPE_TO_FLAG: Record<FlagNotificationTypeKey, FlagKey> = {
  label_changes: "flag.notifications.types.label_changes",
  policy_updates: "flag.notifications.types.policy_updates",
  accessibility_changes: "flag.notifications.types.accessibility_changes",
  new_privacy_types: "flag.notifications.types.new_privacy_types",
};

/**
 * GET  → { prefs: Record<NotificationTypeKey, boolean>, stored: NotificationPrefs }
 *   `prefs`  — fully-resolved booleans for every known type (what the UI
 *              should render). Missing keys fall back to defaults, so new
 *              types added in code start enabled for existing users.
 *   `stored` — the raw, possibly-sparse object actually persisted to the DB
 *              (handy for the settings view to distinguish explicit toggles
 *              from defaults). This is always a plain `{}` if nothing's been
 *              saved yet.
 *
 * PUT  → body `{ prefs: NotificationPrefs | null }`
 *   Pass `null` to clear all overrides (reverts everything to defaults).
 *   Pass a sparse object to override only specific keys — anything the user
 *   hasn't explicitly set stays at the default. Unknown keys / non-boolean
 *   values are dropped by `sanitizePrefs` before the DB write.
 */

const PREFS_KEY = "notification_prefs";

function readStored(): NotificationPrefs {
  const raw = getSetting(PREFS_KEY, "");
  return parseStoredPrefs(raw);
}

/**
 * Read the resolved prefs by asking the resolver about each flag. The
 * resolver returns the user's override if set, otherwise the focus-driven
 * default, otherwise the hard default — exactly the layered cascade the
 * UI wants. Falls back to the legacy stored blob if the resolver fails.
 */
function readResolvedPrefs():
  | Record<FlagNotificationTypeKey, boolean>
  | NotificationPrefs {
  try {
    const out: Record<FlagNotificationTypeKey, boolean> = {
      label_changes: false,
      policy_updates: false,
      accessibility_changes: false,
      new_privacy_types: false,
    };
    for (const [type, flag] of Object.entries(TYPE_TO_FLAG) as [
      FlagNotificationTypeKey,
      FlagKey,
    ][]) {
      out[type] = resolveFlagFromDb(flag) === "on";
    }
    return out;
  } catch {
    return readStored();
  }
}

export async function GET() {
  const prefs = readResolvedPrefs();
  return NextResponse.json({
    prefs,
    stored: prefs, // mirror — UI uses this to distinguish explicit toggles, but with the flag system the two are equivalent
    defaults: DEFAULT_NOTIFICATION_PREFS,
  });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, 8 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Body must be an object" },
      { status: 400 }
    );
  }

  const raw = (body as { prefs?: unknown }).prefs;
  if (raw === null) {
    // Clear all four flag overrides + the legacy blob (belt and braces).
    setSetting(PREFS_KEY, "");
    for (const flag of Object.values(TYPE_TO_FLAG)) {
      clearOverride(flag);
    }
    const prefs = readResolvedPrefs();
    return NextResponse.json({
      prefs,
      stored: prefs,
      defaults: DEFAULT_NOTIFICATION_PREFS,
    });
  }
  if (raw === undefined) {
    return NextResponse.json(
      {
        error:
          "Missing `prefs` key. Pass null to clear, or an object of booleans to save.",
      },
      { status: 400 }
    );
  }

  const clean = sanitizePrefs(raw);
  // The new flag-based scheme exposes its four type keys (label_changes,
  // policy_updates, accessibility_changes, new_privacy_types) alongside
  // the legacy camelCase keys preserved by `sanitizePrefs`. We project
  // both shapes into the flag override layer: a `true` value for the
  // matching key flips the flag override to `on`, `false` to `off`, and
  // a missing key clears the override so the focus default wins again.
  const cleanRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  function readBool(key: FlagNotificationTypeKey): boolean | undefined {
    const v = cleanRaw[key];
    if (typeof v === "boolean") {
      return v;
    }
    return;
  }
  for (const [type, flag] of Object.entries(TYPE_TO_FLAG) as [
    FlagNotificationTypeKey,
    FlagKey,
  ][]) {
    const value = readBool(type);
    if (value === true) {
      setOverride(flag, "on");
    } else if (value === false) {
      setOverride(flag, "off");
    } else {
      clearOverride(flag);
    }
  }
  // Keep the legacy blob in sync as a back-compat read path; nothing in
  // the new flow reads it but pre-migration code paths might.
  setSetting(PREFS_KEY, JSON.stringify(clean));
  const prefs = readResolvedPrefs();
  return NextResponse.json({
    prefs,
    stored: prefs,
    defaults: DEFAULT_NOTIFICATION_PREFS,
  });
}
