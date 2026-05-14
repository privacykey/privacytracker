'use client';

/**
 * Tiny wireframe SVGs that hint at the visual layout of each dashboard
 * card. Used by the list-view editor's row preview so users can map a
 * row's label to the shape of the actual card on the dashboard.
 *
 * Design notes:
 *  - All thumbnails are 80×56 viewBox so the row column is fixed-width
 *    and the SVGs render consistently regardless of zoom.
 *  - Strokes use `currentColor` so the sketches pick up the row's text
 *    colour, working in light, dark, and high-contrast themes without
 *    extra rules.
 *  - These are intentionally abstract — they're recognition aids, not
 *    pixel-accurate previews. Hand-maintained when the underlying card
 *    visual changes meaningfully (kept brief so updates are cheap).
 */

import type { DashboardCardId } from '../../lib/dashboard-layout';

interface ThumbProps {
  id: DashboardCardId;
}

/* Shared wrapper. All sketches share viewBox + stroke style. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="80"
      height="56"
      viewBox="0 0 80 56"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden="true"
    >
      {/* Outer card frame — light dashed so the inner content reads as
          a sketch of "what's inside this card". */}
      <rect
        x="1.5"
        y="1.5"
        width="77"
        height="53"
        rx="6"
        strokeDasharray="2 2"
        opacity="0.55"
      />
      {children}
    </svg>
  );
}

export function CardThumbnail({ id }: ThumbProps) {
  switch (id) {
    case 'task_list':
      // Vertical list of checkbox-style rows.
      return (
        <Frame>
          {[14, 26, 38].map(y => (
            <g key={y}>
              <rect x="8" y={y - 4} width="8" height="8" rx="2" />
              <line x1="20" y1={y} x2="62" y2={y} />
            </g>
          ))}
        </Frame>
      );
    case 'review_cta':
      // CTA banner — pill-shaped row with an icon on the left, two
      // lines of text in the middle, and an arrow on the right.
      return (
        <Frame>
          <rect
            x="6"
            y="18"
            width="68"
            height="20"
            rx="10"
            fill="currentColor"
            stroke="none"
            opacity="0.15"
          />
          <circle cx="14" cy="28" r="4" />
          <line x1="22" y1="25" x2="50" y2="25" />
          <line x1="22" y1="32" x2="44" y2="32" opacity="0.55" />
          <path d="M58 24 L66 28 L58 32" />
        </Frame>
      );
    case 'focus_strip':
      // Slim horizontal bar of chip outlines.
      return (
        <Frame>
          <rect x="8" y="22" width="64" height="12" rx="6" opacity="0.4" />
          <rect x="12" y="25" width="14" height="6" rx="3" />
          <rect x="30" y="25" width="20" height="6" rx="3" />
          <rect x="54" y="25" width="14" height="6" rx="3" />
        </Frame>
      );
    case 'background_mode_wizard':
      // Wizard card — small play triangle on a rounded panel.
      return (
        <Frame>
          <rect x="10" y="14" width="60" height="28" rx="4" opacity="0.5" />
          <path d="M30 22 L42 28 L30 34 Z" fill="currentColor" stroke="none" />
          <line x1="48" y1="24" x2="62" y2="24" />
          <line x1="48" y1="30" x2="58" y2="30" />
        </Frame>
      );
    case 'manual_apps_banner':
      // "+" icon next to text lines.
      return (
        <Frame>
          <circle cx="18" cy="28" r="7" />
          <line x1="18" y1="24" x2="18" y2="32" />
          <line x1="14" y1="28" x2="22" y2="28" />
          <line x1="32" y1="22" x2="68" y2="22" />
          <line x1="32" y1="30" x2="56" y2="30" />
          <line x1="32" y1="38" x2="50" y2="38" />
        </Frame>
      );
    case 'risk_section':
      // Row of pills with severity dots, hinting at the watchlist.
      return (
        <Frame>
          <line x1="8" y1="14" x2="42" y2="14" opacity="0.6" />
          {[24, 36].map(y => (
            <g key={y}>
              <rect x="8" y={y - 4} width="64" height="8" rx="4" opacity="0.45" />
              <circle cx="13" cy={y} r="2" fill="currentColor" stroke="none" />
              <line x1="18" y1={y} x2="48" y2={y} />
            </g>
          ))}
        </Frame>
      );
    case 'hero':
      // Big headline + smaller subline.
      return (
        <Frame>
          <rect x="10" y="14" width="50" height="8" rx="2" fill="currentColor" stroke="none" opacity="0.85" />
          <line x1="10" y1="30" x2="64" y2="30" />
          <line x1="10" y1="38" x2="44" y2="38" />
        </Frame>
      );
    case 'cleanup_callout':
      // Alert-style banner with a "!"
      return (
        <Frame>
          <rect x="6" y="14" width="68" height="28" rx="5" opacity="0.5" />
          <circle cx="16" cy="28" r="5" />
          <line x1="16" y1="25" x2="16" y2="29" />
          <circle cx="16" cy="31.5" r="0.8" fill="currentColor" stroke="none" />
          <line x1="26" y1="24" x2="66" y2="24" />
          <line x1="26" y1="32" x2="54" y2="32" />
        </Frame>
      );
    case 'family_callout':
      // Two stacked silhouettes hinting at "family".
      return (
        <Frame>
          <circle cx="18" cy="22" r="4" />
          <path d="M11 36 Q11 28 18 28 Q25 28 25 36" />
          <circle cx="30" cy="26" r="3" />
          <path d="M25 36 Q25 31 30 31 Q35 31 35 36" />
          <line x1="44" y1="22" x2="68" y2="22" />
          <line x1="44" y1="30" x2="62" y2="30" />
          <line x1="44" y1="38" x2="58" y2="38" />
        </Frame>
      );
    case 'third_party_callout':
      // Connected nodes hinting at "third-party data flow".
      return (
        <Frame>
          <circle cx="16" cy="20" r="3" />
          <circle cx="40" cy="36" r="3" />
          <circle cx="64" cy="20" r="3" />
          <line x1="16" y1="20" x2="40" y2="36" />
          <line x1="40" y1="36" x2="64" y2="20" />
          <line x1="16" y1="20" x2="64" y2="20" opacity="0.4" />
        </Frame>
      );
    case 'glance_section':
      // 2×2 grid of stat boxes.
      return (
        <Frame>
          {[10, 42].map(x =>
            [10, 30].map(y => (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width="28"
                height="16"
                rx="3"
                opacity="0.5"
              />
            )),
          )}
        </Frame>
      );
    case 'definitions_callout':
      // Book / glossary icon + text lines.
      return (
        <Frame>
          <rect x="8" y="14" width="20" height="28" rx="2" opacity="0.55" />
          <line x1="18" y1="14" x2="18" y2="42" opacity="0.5" />
          <line x1="34" y1="20" x2="68" y2="20" />
          <line x1="34" y1="28" x2="62" y2="28" />
          <line x1="34" y1="36" x2="58" y2="36" />
        </Frame>
      );
    case 'review_section':
      // List of dot + text rows (review queue).
      return (
        <Frame>
          {[14, 26, 38].map(y => (
            <g key={y}>
              <circle cx="12" cy={y} r="3" fill="currentColor" stroke="none" />
              <line x1="20" y1={y - 2} x2="60" y2={y - 2} />
              <line x1="20" y1={y + 3} x2="42" y2={y + 3} opacity="0.55" />
            </g>
          ))}
        </Frame>
      );
    case 'profile_mismatch_section':
      // Stacked horizontal bars at different fill widths.
      return (
        <Frame>
          {[
            { y: 14, w: 60 },
            { y: 24, w: 44 },
            { y: 34, w: 52 },
          ].map(({ y, w }) => (
            <g key={y}>
              <rect x="8" y={y} width="64" height="6" rx="3" opacity="0.35" />
              <rect
                x="8"
                y={y}
                width={w}
                height="6"
                rx="3"
                fill="currentColor"
                stroke="none"
                opacity="0.65"
              />
            </g>
          ))}
        </Frame>
      );
    case 'stale_section':
      // Clock + text rows hinting at "not synced recently".
      return (
        <Frame>
          <circle cx="16" cy="28" r="8" />
          <line x1="16" y1="22" x2="16" y2="28" />
          <line x1="16" y1="28" x2="21" y2="30" />
          <line x1="32" y1="22" x2="66" y2="22" />
          <line x1="32" y1="30" x2="60" y2="30" />
          <line x1="32" y1="38" x2="54" y2="38" />
        </Frame>
      );
    case 'activity_section':
      // Vertical timeline with dots.
      return (
        <Frame>
          <line x1="14" y1="10" x2="14" y2="46" opacity="0.4" />
          {[16, 28, 40].map(y => (
            <g key={y}>
              <circle cx="14" cy={y} r="2.5" fill="currentColor" stroke="none" />
              <line x1="22" y1={y} x2="62" y2={y} />
            </g>
          ))}
        </Frame>
      );
    case 'risk_tier_legend':
      // Four short bars stacked (the legend's four tiers).
      return (
        <Frame>
          {[
            { y: 12, opacity: 0.85 },
            { y: 22, opacity: 0.65 },
            { y: 32, opacity: 0.45 },
            { y: 42, opacity: 0.3 },
          ].map(({ y, opacity }) => (
            <rect
              key={y}
              x="10"
              y={y}
              width="60"
              height="5"
              rx="2"
              fill="currentColor"
              stroke="none"
              opacity={opacity}
            />
          ))}
        </Frame>
      );
    default:
      // Defensive fallback — should be unreachable thanks to the
      // exhaustive `DashboardCardId` union, but a generic "card with
      // text lines" sketch is safer than throwing.
      return (
        <Frame>
          <line x1="10" y1="20" x2="64" y2="20" />
          <line x1="10" y1="30" x2="58" y2="30" />
          <line x1="10" y1="40" x2="48" y2="40" />
        </Frame>
      );
  }
}
