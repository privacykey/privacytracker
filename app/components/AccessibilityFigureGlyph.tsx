/**
 * Canonical "person figure inside a circle" accessibility SVG used across
 * the app (footer quick-toggle, detail chip, shortlist, Settings, onboarding,
 * stats roll-up). Uses `currentColor` so callers theme it via `color`.
 */

import type { CSSProperties } from "react";

interface Props {
  /** Decorative by default. Pass an aria-label when the glyph is the only
   *  element in a button or link without a separate label. */
  ariaLabel?: string;
  /** Optional className passthrough. */
  className?: string;
  /** Pixel size on both axes. Defaults to 18. */
  size?: number | string;
  /** Optional inline style passthrough. */
  style?: CSSProperties;
}

export default function AccessibilityFigureGlyph({
  size = 18,
  className,
  style,
  ariaLabel,
}: Props) {
  const decorative = !ariaLabel;
  return (
    <svg
      aria-hidden={decorative ? true : undefined}
      aria-label={ariaLabel}
      className={className}
      fill="none"
      height={size}
      role={decorative ? undefined : "img"}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="7.2" fill="currentColor" r="1.4" />
      <path d="M6.5 10.5h11" />
      <path d="M12 10.5v4" />
      <path d="M9 18l3-3.5L15 18" />
    </svg>
  );
}
