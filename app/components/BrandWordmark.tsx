/**
 * BrandWordmark — inline-SVG logotype for "privacytracker", with "privacy"
 * in currentColor and "tracker" in the brand gradient (#0a84ff → #5e5ce6).
 * Uses the system Inter font stack so no extra font file is required.
 */

interface Props {
  /** Pixel height; width auto-derives from viewBox. Default 28 px. */
  height?: number | string;
  /** Optional className for margin / filter wrappers. */
  className?: string;
  /** Accessible name. Wordmark is decorative when omitted. */
  ariaLabel?: string;
}

export default function BrandWordmark({
  height = 28,
  className,
  ariaLabel,
}: Props) {
  // viewBox 320×50 is the bounding box of "privacytracker" at the font
  // + tracking settings below. Height scales linearly via the height attr.
  const decorative = !ariaLabel;
  // Shared text attributes for both <tspan>s so the halves can't drift.
  const textAttrs = {
    fontFamily:
      "'Inter Variable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontWeight: 700,
    fontSize: 42,
    letterSpacing: -1.2,
  };
  return (
    <svg
      className={className}
      height={height}
      viewBox="0 0 320 50"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? undefined : 'img'}
      aria-label={ariaLabel}
      aria-hidden={decorative ? true : undefined}
    >
      <defs>
        <linearGradient
          id="brand-wordmark-grad"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          {/* Brand gradient — matches the magnifier-tile icon. */}
          <stop offset="0%" stopColor="#0a84ff" />
          <stop offset="100%" stopColor="#5e5ce6" />
        </linearGradient>
      </defs>
      <text
        // Centre on the viewBox so font-fallback width changes don't
        // shift the wordmark to the left edge.
        x="50%"
        y="38"
        textAnchor="middle"
        {...textAttrs}
        fill="currentColor"
      >
        <tspan>privacy</tspan>
        <tspan fill="url(#brand-wordmark-grad)">tracker</tspan>
      </text>
    </svg>
  );
}
