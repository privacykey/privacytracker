'use client';

/**
 * Thin ECharts wrapper that:
 *   - Imports echarts + echarts-for-react only on the client (Next App Router
 *     server-renders components by default, and ECharts touches `window`
 *     during init).
 *   - Registers a single shared 'privacy' theme matching globals.css tokens
 *     so every chart has the same dark surface, typography, and tooltip chrome.
 *   - Handles resize via ResizeObserver so charts re-flow inside flex/grid
 *     parents without callers wiring a window listener per instance.
 *
 * Callers pass an ECharts `option` object; this component owns only the chrome.
 */
import { useEffect, useRef } from 'react';
import type * as ECharts from 'echarts';

const THEME_NAME = 'privacy';
let themeRegistered = false;

async function registerThemeOnce(echarts: typeof ECharts) {
  if (themeRegistered) return;
  echarts.registerTheme(THEME_NAME, {
    backgroundColor: 'transparent',
    textStyle: {
      color: '#f0f0f5',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    },
    title: { textStyle: { color: '#f0f0f5' } },
    legend: { textStyle: { color: '#a0a0b0' } },
    tooltip: {
      backgroundColor: 'rgba(18, 18, 26, 0.92)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      textStyle: { color: '#f0f0f5' },
    },
  });
  themeRegistered = true;
}

interface EChartProps {
  option: ECharts.EChartsCoreOption;
  /** Height in px or any valid CSS length. Width is always 100% of parent. */
  height?: number | string;
  /** Extra className appended to the root div. */
  className?: string;
  /** Optional click handler for interactive charts. */
  onClick?: (params: unknown) => void;
  /**
   * Called once, after the chart instance is initialised. Used by callers
   * that need to dispatch imperative actions (e.g. `highlight`/`downplay`
   * to lock a Sankey adjacency selection) without rebuilding the chart.
   * The caller receives the raw ECharts instance.
   */
  onReady?: (instance: ECharts.ECharts) => void;
}

export default function EChart({ option, height = 360, className, onClick, onReady }: EChartProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts.ECharts | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Dynamically import so the ~900KB echarts bundle stays out of the SSR/
    // initial-paint path. The first chart on a page pays the hit; subsequent
    // charts reuse the cached module.
    (async () => {
      const echarts = await import('echarts');
      if (cancelled || !rootRef.current) return;
      await registerThemeOnce(echarts);
      const inst = echarts.init(rootRef.current, THEME_NAME, { renderer: 'canvas' });
      instanceRef.current = inst;
      inst.setOption(option);
      if (onClick) inst.on('click', onClick);
      if (onReady) onReady(inst);
    })();

    return () => {
      cancelled = true;
      if (instanceRef.current) {
        instanceRef.current.dispose();
        instanceRef.current = null;
      }
    };
    // We intentionally initialise once. Option updates flow through the next
    // effect so we don't rebuild the canvas every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push new option when it changes, preserving the existing canvas.
  useEffect(() => {
    if (instanceRef.current) {
      instanceRef.current.setOption(option, { notMerge: true });
    }
  }, [option]);

  // ResizeObserver — safer than window resize because the chart can live
  // inside a flex parent that changes independently of the viewport.
  useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => instanceRef.current?.resize());
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className={className}
      style={{ width: '100%', height: typeof height === 'number' ? `${height}px` : height }}
    />
  );
}
