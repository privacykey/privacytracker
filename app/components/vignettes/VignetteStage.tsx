import type { ReactNode } from "react";

interface Props {
  destination: ReactNode;
  motif: ReactNode;
}

/**
 * Skeuomorphic vignette playback surface. Both children are rendered as
 * sibling SVG groups inside one viewBox so a motif (e.g. an email being
 * typed) and a destination (e.g. a second phone lighting up) can share
 * coordinates and choreograph their timing through a single CSS pass.
 *
 * The stage is purely decorative — the caller's `aria-label` on the
 * surrounding popover carries the semantic meaning. SVG itself is
 * `aria-hidden` and screen readers skip the motion.
 */
export default function VignetteStage({ motif, destination }: Props) {
  return (
    <svg
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 320 180"
      xmlns="http://www.w3.org/2000/svg"
    >
      {motif}
      {destination}
    </svg>
  );
}
