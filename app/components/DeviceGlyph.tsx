"use client";

import type { ReactElement } from "react";
import { type DeviceGlyphKind, deviceGlyphKind } from "@/lib/device-scope";

/**
 * Small inline SVG marking a device as a phone / tablet / watch / player.
 *
 * Inline rather than emoji because the device scope picker's whole job is
 * telling an iPhone from an iPad at a glance, and the two most obvious
 * emoji for that (📱 and 📱) are the same character — which is exactly
 * why `deviceGlyph` in DeviceConnectedToast.tsx returns one glyph for
 * both. A toast naming the device in the very next word can afford that;
 * a persistent nav control cannot.
 *
 * Shapes differ in outline, not just colour, so the icon still carries
 * its meaning for a colour-blind user or in forced-colours mode
 * (`currentColor` throughout). It is `aria-hidden` in every case — the
 * device name always renders beside it, so the icon is decoration and
 * announcing "phone graphic" would only add noise.
 */

const PATHS: Record<DeviceGlyphKind, ReactElement> = {
  // Narrow body, tall aspect, speaker slot.
  phone: (
    <>
      <rect height="19" rx="2.5" width="11" x="6.5" y="2.5" />
      <line x1="10" x2="14" y1="5.5" y2="5.5" />
      <line x1="10.5" x2="13.5" y1="18.5" y2="18.5" />
    </>
  ),
  // Wider body, squarer aspect, home-button dot.
  tablet: (
    <>
      <rect height="19" rx="2" width="15" x="4.5" y="2.5" />
      <circle cx="12" cy="18.5" r="0.9" />
    </>
  ),
  // Squat case with two straps.
  watch: (
    <>
      <rect height="11" rx="2.5" width="10" x="7" y="6.5" />
      <line x1="9.5" x2="9.5" y1="6.5" y2="3.5" />
      <line x1="14.5" x2="14.5" y1="6.5" y2="3.5" />
      <line x1="9.5" x2="9.5" y1="17.5" y2="20.5" />
      <line x1="14.5" x2="14.5" y1="17.5" y2="20.5" />
    </>
  ),
  // Click-wheel silhouette.
  player: (
    <>
      <rect height="19" rx="2.5" width="11" x="6.5" y="2.5" />
      <circle cx="12" cy="16" r="3" />
    </>
  ),
  // Deliberately not a phone: a question-marked slab, so "we don't know
  // what this is" never reads as a confident "it's an iPhone".
  other: (
    <>
      <rect height="19" rx="2.5" width="13" x="5.5" y="2.5" />
      <line x1="9.5" x2="14.5" y1="12" y2="12" />
    </>
  ),
};

export default function DeviceGlyph({
  className,
  device,
  size = 16,
}: {
  className?: string;
  device: { deviceClass?: string | null; model?: string | null };
  size?: number;
}) {
  const kind = deviceGlyphKind(device);
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[kind]}
    </svg>
  );
}

/** The "everything" icon for the picker's All-devices row — a stack of
 *  two slabs, so it reads as "more than one" without naming a type. */
export function AllDevicesGlyph({
  className,
  size = 16,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="15" rx="2" width="10" x="9.5" y="6.5" />
      <path d="M6.5 17.5A2 2 0 0 1 5 15.6V4.5a2 2 0 0 1 2-2h6.6" />
    </svg>
  );
}
