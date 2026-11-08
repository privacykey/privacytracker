/**
 * Apple's privacy-label classes as one vocabulary.
 *
 * The App Store sorts what an app collects into three classes (Data Used
 * to Track You, Data Linked to You, Data Not Linked to You), and an app
 * that collects nothing is labelled Data Not Collected. The UI used to
 * name them differently on every surface ("track", "Tracking", "Used to
 * track you", the full Apple name) and colour them from four places.
 * This module is the single mapping from a class to its identifier, its
 * `severity-*` colour class in globals.css and its `severity.*` locale
 * key; `app/components/LabelClassChip.tsx` renders it, and the short
 * words live under `label_class.*` in the locale bundles.
 *
 * Client-safe: no React, no SQLite.
 */
import type { ProfileTier } from "./privacy-profile";
import { TYPE_IDENTIFIER_TO_TIER } from "./privacy-profile";

/** The four classes, least to most invasive. Same values as `ProfileTier`
 *  because a profile tier is "the worst class I accept". */
export type LabelClass = ProfileTier;

export const LABEL_CLASSES: readonly LabelClass[] = [
  "not_collected",
  "not_linked",
  "linked",
  "tracking",
] as const;

export interface LabelClassMeta {
  /** Apple's `privacy_types.identifier`, or DATA_NOT_COLLECTED. */
  identifier: string;
  /** The one colour rule for the class, in globals.css. */
  severityCls: string;
  /** Key under `severity.*` holding the full Apple name. */
  severityKey: string;
}

export const LABEL_CLASS_META: Record<LabelClass, LabelClassMeta> = {
  not_collected: {
    identifier: "DATA_NOT_COLLECTED",
    severityCls: "severity-not-collected",
    severityKey: "data_not_collected",
  },
  not_linked: {
    identifier: "DATA_NOT_LINKED_TO_YOU",
    severityCls: "severity-unlinked",
    severityKey: "data_not_linked_to_you",
  },
  linked: {
    identifier: "DATA_LINKED_TO_YOU",
    severityCls: "severity-linked",
    severityKey: "data_linked_to_you",
  },
  tracking: {
    identifier: "DATA_USED_TO_TRACK_YOU",
    severityCls: "severity-track",
    severityKey: "data_used_to_track_you",
  },
};

/** `DATA_USED_TO_TRACK_YOU` → `tracking`; null for anything else. */
export function labelClassFromIdentifier(
  identifier: string | null | undefined
): LabelClass | null {
  if (!identifier) {
    return null;
  }
  if (identifier === "DATA_NOT_COLLECTED") {
    return "not_collected";
  }
  return TYPE_IDENTIFIER_TO_TIER[identifier] ?? null;
}

/** The change-review panel classifies a change as track / linked /
 *  unlinked / none; this maps the first three onto a class. */
export function labelClassFromChangeSeverity(
  severity: "track" | "linked" | "unlinked" | "none"
): LabelClass | null {
  switch (severity) {
    case "track":
      return "tracking";
    case "linked":
      return "linked";
    case "unlinked":
      return "not_linked";
    default:
      return null;
  }
}
