/**
 * Pieces the wizard shell and its state machine both need.
 *
 * `useOnboardWizard` owns the machine and `OnboardWizard` owns the
 * markup, so anything referenced by both would otherwise create a cycle
 * between them. This module is the shared floor.
 */

import type { DeviceClass } from "@/lib/device";

export type ImportMethod = "screenshots" | "file" | "configurator" | "manual";

export interface ImportedAppEntry {
  bundleId?: string;
  developer?: string;
  /** Stable client-side id (`uuid-or-fallback()`); not persisted. */
  id: string;
  likelyWebClip?: boolean;
  name: string;
  source: "manual" | "cfgutil" | "file" | "ocr";
}

/**
 * Build an {@link ImportedAppEntry} with a stable client-side id.
 * Falls back to a non-crypto id when `crypto.randomUUID` is missing
 * (older browsers / non-secure contexts) — the id only needs to be
 * stable within the current render tree so React keys don't churn.
 */
export function makeImportedAppEntry(
  input: Omit<ImportedAppEntry, "id">
): ImportedAppEntry {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `ie_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return { id, ...input };
}

/**
 * Per-device method layout for the step-1 picker. Keys:
 *   - `primary`   recommended option, default selection, rendered full-width.
 *   - `secondary` also visible up front, but below the primary card.
 *   - `advanced`  tucked inside a <details> drawer so they don't distract
 *                 most users but stay accessible if someone really wants them.
 * We deliberately drop the in-browser screenshot OCR path from phone + tablet
 * layouts — it doesn't work on iOS Safari — and route users to Live Text
 * instead via the modal opened from the manual-entry panel.
 */
export const METHOD_LAYOUT: Record<
  DeviceClass,
  {
    primary: ImportMethod;
    secondary: ImportMethod[];
    advanced: ImportMethod[];
  }
> = {
  phone: {
    primary: "manual",
    secondary: [],
    advanced: ["file"],
  },
  tablet: {
    primary: "manual",
    secondary: [],
    advanced: ["file", "configurator"],
  },
  desktop: {
    primary: "configurator",
    secondary: ["file"],
    advanced: ["manual", "screenshots"],
  },
};
