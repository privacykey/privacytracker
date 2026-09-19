export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requestBodyErrorResponse } from "@/lib/request-body";
import type { FlagKey } from "../../../lib/feature-flag-rules";
import { clearOverride, setOverride } from "../../../lib/feature-flag-storage";
import { resolveFlagFromDb } from "../../../lib/feature-flags-server";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  type NotificationTypeKey,
  parseStoredPrefs,
  resolvePrefs,
  sanitizePrefs,
} from "../../../lib/notification-prefs";
import { getSetting, setSetting } from "../../../lib/scheduler";
import { readBoundedJson } from "../../../lib/security";

/**
 * The flag system tracks four notification types — see the
 * `flag.notifications.types.*` keys in feature-flag-rules.ts. These are the
 * keys the resolver writes/reads, distinct from the seven camelCase
 * `NotificationTypeKey`s in lib/notification-prefs.ts, which are what the
 * Settings section and the bell speak. Two types exist in both sets; see
 * `FLAG_ALIASES`.
 */
type FlagNotificationTypeKey =
  | "label_changes"
  | "policy_updates"
  | "accessibility_changes"
  | "new_privacy_types";

/**
 * The camelCase spelling of each flag type that has one. Settings and the
 * bell read and write these, so a response must carry them resolved from
 * the flag and a request may use them to set the flag. The other two flag
 * types have no camelCase key.
 */
const FLAG_ALIASES: Partial<
  Record<FlagNotificationTypeKey, NotificationTypeKey>
> = {
  label_changes: "labelChanges",
  policy_updates: "policyUpdates",
};

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
 * GET  → { prefs, stored, defaults }
 *   `prefs`:   fully-resolved booleans, in a fixed order: the four flag
 *              keys (`label_changes` … `new_privacy_types`) through the
 *              resolver, then every `NotificationTypeKey` in
 *              NOTIFICATION_TYPE_KEYS order. The camelCase half is
 *              `resolvePrefs` over the legacy blob, with `labelChanges` and
 *              `policyUpdates` taken from their flags, so what Settings and
 *              the bell show is what the notification pipeline does.
 *   `stored`: mirrors `prefs`.
 *   If the resolver throws, `prefs` and `stored` are the legacy blob
 *   alone, camelCase keys only.
 *
 * PUT  → body `{ prefs: object | null }`
 *   Pass `null` to clear all four flag overrides and the legacy blob.
 *   Otherwise each flag is set from its snake_case key when that is a
 *   boolean, else from its camelCase alias (`labelChanges`,
 *   `policyUpdates`) when that is, else its override is cleared so the
 *   focus default wins again. The camelCase keys are also stored in the
 *   legacy blob after `sanitizePrefs` drops unknown keys and non-booleans.
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
 * UI wants. The camelCase keys follow (see the GET comment above). Falls
 * back to the legacy stored blob if the resolver fails.
 */
function readResolvedPrefs():
  | (Record<FlagNotificationTypeKey, boolean> &
      Record<NotificationTypeKey, boolean>)
  | NotificationPrefs {
  const flags: Record<FlagNotificationTypeKey, boolean> = {
    label_changes: false,
    policy_updates: false,
    accessibility_changes: false,
    new_privacy_types: false,
  };
  try {
    for (const [type, flag] of Object.entries(TYPE_TO_FLAG) as [
      FlagNotificationTypeKey,
      FlagKey,
    ][]) {
      flags[type] = resolveFlagFromDb(flag) === "on";
    }
  } catch {
    return readStored();
  }
  const legacy = resolvePrefs(readStored());
  for (const [type, alias] of Object.entries(FLAG_ALIASES) as [
    FlagNotificationTypeKey,
    NotificationTypeKey,
  ][]) {
    legacy[alias] = flags[type];
  }
  return { ...flags, ...legacy };
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
  } catch (error) {
    const bodyLimitResponse = requestBodyErrorResponse(error);
    if (bodyLimitResponse) {
      return bodyLimitResponse;
    }

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
  // flag's key, or failing that its camelCase alias (the shape Settings
  // sends), flips the flag override to `on`, `false` to `off`, and a
  // missing key clears the override so the focus default wins again.
  const cleanRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  function readBool(key: FlagNotificationTypeKey): boolean | undefined {
    for (const name of [key, FLAG_ALIASES[key]]) {
      const v = name === undefined ? undefined : cleanRaw[name];
      if (typeof v === "boolean") {
        return v;
      }
    }
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
