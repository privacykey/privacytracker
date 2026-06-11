interface Props {
  /** Optional className applied to the wrapping `<g>` — handy for CSS-
   *  scoped animations (e.g. "Phone A dims, Phone B brightens"). */
  className?: string;
  /** Phone body height. */
  height: number;
  /** Screen fill colour. Defaults to `var(--surface-active)` so light app
   *  content reads against a slightly-greyed screen. */
  screenFill?: string;
  /** Phone body width. */
  width: number;
  /** Left edge of the phone body. */
  x: number;
  /** Top edge of the phone body. */
  y: number;
}

/**
 * Reusable iPhone-shaped SVG frame. Renders the body, screen,
 * dynamic-island pill, home indicator and side buttons in one go.
 * The caller positions form fields, app icons, etc. as siblings (or
 * children of the same parent `<svg>`) using the frame's coordinates
 * as a layout reference.
 *
 * Designed for a 320×180 viewBox; defaults look right at a body of
 * roughly 110×156 px.
 */
export default function PhoneFrame({
  x,
  y,
  width,
  height,
  screenFill = "var(--surface-active)",
  className,
}: Props) {
  const islandWidth = 28;
  const islandHeight = 7;
  const islandX = x + width / 2 - islandWidth / 2;
  const islandY = y + 12;

  const homeWidth = 36;
  const homeHeight = 3;
  const homeX = x + width / 2 - homeWidth / 2;
  const homeY = y + height - 7;

  return (
    <g className={className}>
      {/* Side buttons (left — silent toggle + volume up/down) */}
      <rect
        fill="var(--border-strong)"
        height="6"
        rx="1"
        width="2"
        x={x - 1.5}
        y={y + 26}
      />
      <rect
        fill="var(--border-strong)"
        height="14"
        rx="1"
        width="2"
        x={x - 1.5}
        y={y + 40}
      />
      <rect
        fill="var(--border-strong)"
        height="14"
        rx="1"
        width="2"
        x={x - 1.5}
        y={y + 60}
      />
      {/* Side button (right — sleep/wake) */}
      <rect
        fill="var(--border-strong)"
        height="22"
        rx="1"
        width="2"
        x={x + width - 0.5}
        y={y + 44}
      />

      {/* Phone body — rounded, with a subtle inner highlight for depth */}
      <rect
        fill="var(--surface)"
        height={height}
        rx="20"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
        width={width}
        x={x}
        y={y}
      />
      {/* Inner bezel ring — sells the "glass over chassis" detail */}
      <rect
        fill="none"
        height={height - 4}
        rx="18"
        stroke="var(--border)"
        strokeWidth="0.6"
        width={width - 4}
        x={x + 2}
        y={y + 2}
      />

      {/* Screen */}
      <rect
        fill={screenFill}
        height={height - 14}
        rx="15"
        width={width - 10}
        x={x + 5}
        y={y + 7}
      />

      {/* Dynamic island */}
      <rect
        fill="#0a0a0a"
        height={islandHeight}
        rx={islandHeight / 2}
        width={islandWidth}
        x={islandX}
        y={islandY}
      />

      {/* Home indicator */}
      <rect
        fill="var(--text-3)"
        height={homeHeight}
        opacity="0.7"
        rx={homeHeight / 2}
        width={homeWidth}
        x={homeX}
        y={homeY}
      />
    </g>
  );
}
