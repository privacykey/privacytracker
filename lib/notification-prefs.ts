/**
 * Client-safe notification preferences. Defines the bell's notification
 * types, their default on/off state, and defensive parsers shared by the
 * API route, settings view, and bell filter. No db/fs imports — safe to
 * import from client components.
 *
 * Storage: single JSON blob under `notification_prefs` in app_settings,
 * shape `{ [NotificationTypeKey]: boolean }`. Missing keys fall back to
 * DEFAULT_NOTIFICATION_PREFS so new types start enabled without a
 * migration.
 */

export const NOTIFICATION_TYPE_KEYS = [
  "labelChanges",
  "profileMismatch",
  "policyUpdates",
  "versionUpdates",
  "importCompleted",
  "manualAppsPrompt",
  "aiTimeout",
] as const;

export type NotificationTypeKey = (typeof NOTIFICATION_TYPE_KEYS)[number];

export interface NotificationTypeMeta {
  /** Default on/off when the user hasn't explicitly toggled the type. */
  defaultOn: boolean;
  description: string;
  /** Human-readable example shown as a hint in the settings view. */
  example: string;
  key: NotificationTypeKey;
  label: string;
}

export const NOTIFICATION_TYPE_META: Record<
  NotificationTypeKey,
  NotificationTypeMeta
> = {
  labelChanges: {
    key: "labelChanges",
    label: "App label changes",
    description:
      "When a tracked app adds, removes, or changes a privacy label on the App Store.",
    example:
      'e.g. "Instagram now collects Health & Fitness data (Linked to You)."',
    defaultOn: true,
  },
  profileMismatch: {
    key: "profileMismatch",
    label: "Privacy profile mismatches",
    description:
      "When a tracked app starts collecting data at a tier beyond what your privacy profile allows.",
    example: 'e.g. "TikTok just started exceeding your privacy profile."',
    defaultOn: true,
  },
  policyUpdates: {
    key: "policyUpdates",
    label: "Privacy policy updates",
    description:
      "When the developer\u2019s linked privacy policy document changes materially since the last sync.",
    example:
      'e.g. "Spotify\u2019s privacy policy has been updated \u2014 new section on third-party sharing."',
    defaultOn: true,
  },
  versionUpdates: {
    key: "versionUpdates",
    label: "App version updates",
    description:
      "When Apple reports a new App Store version for a tracked app \u2014 useful for cross-referencing a release with a privacy-label change.",
    example:
      'e.g. "Instagram updated from v287.0 to v288.0 (released 14 Apr 2026)."',
    defaultOn: true,
  },
  importCompleted: {
    key: "importCompleted",
    label: "Import finished",
    description:
      "A one-shot confirmation each time a bulk import finishes, including partial/queued runs.",
    example: 'e.g. "Imported 42 of 50 from ios-apps.csv \u00b7 8 queued."',
    defaultOn: true,
  },
  manualAppsPrompt: {
    key: "manualAppsPrompt",
    label: "Unmatched import rows",
    description:
      "A 24h-debounced nudge after an import to review rows that didn\u2019t match an App Store listing (e.g. TestFlight or web clips).",
    example:
      'e.g. "3 rows didn\u2019t match the App Store \u2014 track them under Manual apps."',
    defaultOn: true,
  },
  aiTimeout: {
    key: "aiTimeout",
    label: "AI policy summary timeouts",
    description:
      "When an AI-powered privacy-policy summary call aborts because it exceeded the configured timeout.",
    example: 'e.g. "AI direct summary call aborted after 60s (limit: 60s)."',
    defaultOn: true,
  },
};

export type NotificationPrefs = Partial<Record<NotificationTypeKey, boolean>>;

/** Default preferences with every known type enabled. */
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationTypeKey, boolean> =
  NOTIFICATION_TYPE_KEYS.reduce(
    (acc, key) => {
      acc[key] = NOTIFICATION_TYPE_META[key].defaultOn;
      return acc;
    },
    {} as Record<NotificationTypeKey, boolean>
  );

const KEY_SET: Set<string> = new Set(NOTIFICATION_TYPE_KEYS);

/**
 * Defensive parse for settings pulled from app_settings. Unknown keys
 * and non-boolean values are dropped. Returns `{}` for unrecoverable
 * shapes; never throws.
 */
export function parseStoredPrefs(
  raw: string | null | undefined
): NotificationPrefs {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const out: NotificationPrefs = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (!KEY_SET.has(key)) {
      continue;
    }
    if (typeof value !== "boolean") {
      continue;
    }
    out[key as NotificationTypeKey] = value;
  }
  return out;
}

/** Keep only known keys + boolean values; drop the rest. */
export function sanitizePrefs(input: unknown): NotificationPrefs {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: NotificationPrefs = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!KEY_SET.has(key)) {
      continue;
    }
    if (typeof value !== "boolean") {
      continue;
    }
    out[key as NotificationTypeKey] = value;
  }
  return out;
}

/**
 * Merge stored prefs with defaults so every known key has a concrete
 * boolean. Single source of truth for "is this notification type
 * currently enabled?" on both server and client.
 */
export function resolvePrefs(
  stored: NotificationPrefs | null | undefined
): Record<NotificationTypeKey, boolean> {
  const base = { ...DEFAULT_NOTIFICATION_PREFS };
  if (!stored) {
    return base;
  }
  for (const key of NOTIFICATION_TYPE_KEYS) {
    if (typeof stored[key] === "boolean") {
      base[key] = stored[key] as boolean;
    }
  }
  return base;
}

/**
 * Resolve a notification's type-key from the `change_summary` JSON payload.
 * Returns a NotificationTypeKey so callers can look up the user pref via
 * `resolvedPrefs[key]`. Synthetic types (ai_timeout, manual_apps_prompt,
 * etc.) are checked first; label-change payloads with a policy entry
 * classify as `policyUpdates`; everything else falls back to `labelChanges`.
 */
export function classifyNotificationType(
  entries: Array<{ type?: string }> | null | undefined
): NotificationTypeKey {
  if (!entries || entries.length === 0) {
    return "labelChanges";
  }
  const firstType = entries[0]?.type;
  if (firstType === "ai_timeout") {
    return "aiTimeout";
  }
  if (firstType === "manual_apps_prompt") {
    return "manualAppsPrompt";
  }
  if (firstType === "import_completed") {
    return "importCompleted";
  }
  if (firstType === "profile_mismatch") {
    return "profileMismatch";
  }
  if (firstType === "version_update") {
    return "versionUpdates";
  }
  // Any policy entry → classify the whole notification as a policy update
  // (only affects the user's on/off toggle; bell still renders the full list).
  if (
    entries.some((e) => e?.type === "policy" || e?.type === "policy_summary")
  ) {
    return "policyUpdates";
  }
  return "labelChanges";
}
