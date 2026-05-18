"use client";

import { useEffect, useState } from "react";

/**
 * Mirrors the `html[data-a11y-shapes="on"]` toggle written by
 * `AccessibilityQuickToggles.tsx` into React state, so canvas-rendered
 * charts (which can't reach the CSS cascade) can swap their per-series
 * decals / symbol shapes in real time when the user flips shape mode.
 *
 * Why a hook instead of reading `document.documentElement.dataset` once
 * at render: the toggle can flip at any time after mount (the quick-
 * toggles popover writes the attribute synchronously and persists in
 * localStorage). A `MutationObserver` on the `data-a11y-shapes` attribute
 * gives every consumer a live signal so charts re-derive their option
 * object the moment the toggle fires, with no page reload.
 *
 * Returns `false` on the server (no DOM) and on the very first client
 * render before the effect fires — both are fine, because the chart
 * re-renders once the effect lands and the dependency on `shapesMode`
 * is captured in the chart's `useMemo` deps.
 *
 * Shared between `PrivacyHeatmap` and `AppChangeTimeline` (and any
 * future canvas-rendered chart that needs the same signal). DOM-only
 * surfaces driven by CSS — change-dots, timeline-dots, SmallMultiples
 * cells — don't need this hook because they already pick up the
 * attribute through the cascade.
 */
export function useShapesMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const html = document.documentElement;
    const read = () => html.getAttribute("data-a11y-shapes") === "on";
    setOn(read());
    const observer = new MutationObserver(() => setOn(read()));
    observer.observe(html, {
      attributes: true,
      attributeFilter: ["data-a11y-shapes"],
    });
    return () => observer.disconnect();
  }, []);
  return on;
}
