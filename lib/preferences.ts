/**
 * Client-safe preferences module — types, enums, and presentation metadata
 * only. Do NOT import server-only helpers here (scheduler / db / node
 * built-ins); client components import from this file. Server-side
 * read/write helpers live in `lib/preferences-server.ts`.
 */

/**
 * User-declared archetype captured on the welcome splash. Drives subtle UI
 * tailoring across the dashboard (emphasis and ordering, never feature
 * gating). Users can change it at any time from Settings.
 */
export type UserIntent = "curious" | "cleanup" | "hygiene" | "family";

export const USER_INTENTS: UserIntent[] = [
  "curious",
  "cleanup",
  "hygiene",
  "family",
];

export function isUserIntent(value: unknown): value is UserIntent {
  return (
    typeof value === "string" && (USER_INTENTS as string[]).includes(value)
  );
}

export interface IntentMeta {
  description: string;
  icon: string;
  label: string;
  tagline: string;
  value: UserIntent;
}

/**
 * Presentation metadata shared between the welcome splash and the settings
 * editor so the copy stays in lockstep across both surfaces.
 */
export const INTENT_META: Record<UserIntent, IntentMeta> = {
  curious: {
    value: "curious",
    label: "I'm just curious",
    tagline: "Learn what my apps collect",
    description:
      "See a stats-first view of your apps, with definitions front and centre so every label makes sense.",
    icon: "🔍",
  },
  cleanup: {
    value: "cleanup",
    label: "Delete invasive apps",
    tagline: "Find and remove the worst offenders",
    description:
      "High-risk apps are surfaced at the top of your dashboard with a clear path to delete them from your device.",
    icon: "🧹",
  },
  hygiene: {
    value: "hygiene",
    label: "Improve my security hygiene",
    tagline: "Third-party sharing and policy health",
    description:
      "Emphasises third-party data sharing signals and flags apps with stale or broken privacy-policy links.",
    icon: "🛡️",
  },
  family: {
    value: "family",
    label: "Keep my family safe",
    tagline: "Watch apps my kids use",
    description:
      "Highlights apps with high tracking signal and child-directed categories so you can review them together.",
    icon: "👪",
  },
};
