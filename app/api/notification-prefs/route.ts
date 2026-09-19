export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requestBodyErrorResponse } from "@/lib/request-body";
import type { FlagKey, FlagValue } from "../../../lib/feature-flag-rules";
import { clearOverride, setOverride } from "../../../lib/feature-flag-storage";
import { resolveFlag, resolveFocusBaseline } from "../../../lib/feature-flags";
import {
  getResolverContextFromDb,
  resolveFlagFromDb,
} from "../../../lib/feature-flags-server";
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
 *   Otherwise the body changes only the types it carries. A flag reads
 *   its snake_case key when that is a boolean, else its camelCase alias
 *   (`labelChanges`, `policyUpdates`) when that is; a flag with neither
 *   keeps its override. `planOverrideWrites` decides whether a value sets
 *   the override or clears it. The camelCase keys with boolean values are
 *   merged into the legacy blob, so the types a body leaves out keep what
 *   was stored.
 */

const PREFS_KEY = "notification_prefs";

function readStored(): NotificationPrefs {
  const raw = getSetting(PREFS_KEY, "");
  return parseStoredPrefs(raw);
}

/**
 * The override writes for the flag values a PUT carries, `null` meaning
 * clear. Settings sends every checkbox on each save, so a value the flag
 * already has writes nothing: a save changes only the flags whose value
 * it changes, and an override set elsewhere (Developer Options, the v1
 * migration) on any other flag stays. A changed value that matches the
 * flag's focus default (what it resolves to without its own override)
 * clears the override, so a later change of focus or default can move
 * the flag again, as in FeatureToggleRow; any other changed value sets
 * one.
 *
 * If the resolver throws, neither the flag's value nor its focus default
 * is known, so every value the body carries is set as an override.
 */
function planOverrideWrites(
  requested: [FlagKey, FlagValue][]
): [FlagKey, FlagValue | null][] {
  try {
    const ctx = getResolverContextFromDb();
    return requested
      .filter(([flag, value]) => resolveFlag(flag, ctx) !== value)
      .map(([flag, value]): [FlagKey, FlagValue | null] => [
        flag,
        resolveFocusBaseline(flag, ctx) === value ? null : value,
      ]);
  } catch {
    return requested;
  }
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
  // Each flag reads its own snake_case key, or failing that its camelCase
  // alias (the shape Settings sends). Anything but a boolean counts as
  // absent, and an absent flag is left alone rather than cleared: Settings
  // has no checkbox for `accessibility_changes` or `new_privacy_types`, so
  // clearing the flags a body leaves out reset those two on every save.
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
  const requested: [FlagKey, FlagValue][] = [];
  for (const [type, flag] of Object.entries(TYPE_TO_FLAG) as [
    FlagNotificationTypeKey,
    FlagKey,
  ][]) {
    const value = readBool(type);
    if (value !== undefined) {
      requested.push([flag, value ? "on" : "off"]);
    }
  }
  for (const [flag, value] of planOverrideWrites(requested)) {
    if (value === null) {
      clearOverride(flag);
    } else {
      setOverride(flag, value);
    }
  }
  // GET reads the five types that have no flag from this blob. Merge
  // rather than replace, so a body that leaves a type out keeps it.
  setSetting(PREFS_KEY, JSON.stringify({ ...readStored(), ...clean }));
  const prefs = readResolvedPrefs();
  return NextResponse.json({
    prefs,
    stored: prefs,
    defaults: DEFAULT_NOTIFICATION_PREFS,
  });
}
