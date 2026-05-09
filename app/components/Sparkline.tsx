'use client';

/**
 * Tiny inline-SVG sparkline.
 *
 * No charting library — just a polyline path drawn into a fixed-size
 * SVG. The diagnostics page renders one of these next to each headline
 * metric so the user can spot a trend (memory creeping up, p99 climbing
 * after a bulk import) without leaving the page.
 *
 * Props:
 *   - `values`        — number[] in chronological order (oldest first).
 *   - `width/height`  — SVG canvas size (default 120 x 28).
 *   - `severity`      — optional `'ok' | 'warn' | 'danger'` to colour the
 *                       stroke. Falls back to a neutral text colour.
 *   - `min/max`       — optional axis bounds. When omitted, the line is
 *                       auto-scaled to its own min/max with a small floor
 *                       so a flat zero-line is still visible.
 *   - `ariaLabel`     — required for accessibility — should describe what
 *                       the line tracks (e.g. "Event-loop p99 over last
 *                       60s").
 *
 * Rendering details:
 *   - Single `<path>` with a smooth Bezier-stitched stroke. We don't bother
 *     with gradients / fills — keeping it monochromatic + 1.5px keeps the
 *     SVG under 1 KB and looks tidy at 1x and 2x.
 *   - When `values.length < 2`, returns an empty box rather than a zero-
 *     length path (avoids an SVG warning in the console).
 *   - We cap the input length at 240 samples so a runaway client buffer
 *     can't drag the path string past the URL-data-style 16K guideline.
 */

const MAX_SAMPLES = 240;

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  severity?: 'ok' | 'warn' | 'danger';
  min?: number;
  max?: number;
  /** Required: short description of what this sparkline tracks. */
  ariaLabel: string;
  /** Optional last-value annotation rendered inline under the SVG. */
  lastValueLabel?: string;
}

function pickStroke(severity?: 'ok' | 'warn' | 'danger'): string {
  switch (severity) {
    case 'ok':
      return 'var(--success, #16a34a)';
    case 'warn':
      return 'var(--warning, #d97706)';
    case 'danger':
      return 'var(--danger, #dc2626)';
    default:
      return 'var(--text-2, #6b7280)';
  }
}

export default function Sparkline({
  values,
  width = 120,
  height = 28,
  severity,
  min,
  max,
  ariaLabel,
  lastValueLabel,
}: SparklineProps) {
  const trimmed = values.slice(-MAX_SAMPLES);
  if (trimmed.length < 2) {
    // Need at least two samples to draw a line. Render a placeholder
    // box so the layout doesn't reflow when the first sample arrives.
    return (
      <span
        className="sparkline sparkline-empty"
        style={{ display: 'inline-block', width, height }}
        role="img"
        aria-label={ariaLabel}
      />
    );
  }

  const lo = min ?? Math.min(...trimmed);
  const hi = max ?? Math.max(...trimmed);
  // Add a 5% floor to the range so a perfectly flat series still draws
  // a centred line rather than collapsing onto the bottom edge.
  const span = Math.max(hi - lo, Math.abs(hi) * 0.05, 1e-6);

  const stepX = trimmed.length === 1 ? 0 : width / (trimmed.length - 1);
  const padY = 2;
  const drawableHeight = height - padY * 2;

  const points = trimmed.map((v, i) => {
    const x = i * stepX;
    const norm = (v - lo) / span;
    const y = padY + (1 - Math.min(1, Math.max(0, norm))) * drawableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // Path: M first L rest. polyline would also work but a path is what
  // most existing chart libs emit so any future styling integrates
  // cleanly.
  const d = `M${points[0]} L${points.slice(1).join(' ')}`;

  const stroke = pickStroke(severity);

  return (
    <span className="sparkline" role="img" aria-label={ariaLabel}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {lastValueLabel && (
        <span className="sparkline-last" style={{ marginLeft: 6 }}>
          {lastValueLabel}
        </span>
      )}
    </span>
  );
}
