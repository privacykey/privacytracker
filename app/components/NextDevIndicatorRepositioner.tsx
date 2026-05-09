'use client';

/**
 * Repositions the Next.js dev indicator ("N" badge) above our own dev
 * affordances (DevMenu, a11y quick toggle, keyboard hint).
 *
 * Uses inline styles via JS (rather than CSS) because Next has renamed
 * the indicator's host element / data attribute multiple times. Inline
 * styles win the cascade and survive future renames as long as the
 * MutationObserver finds the host through one of the attrs in HOST_ATTRS.
 * Production strips the indicator entirely; gated on NODE_ENV defensively.
 */

import { useEffect } from 'react';

/** Attribute names Next has used for its dev-indicator host. First match wins;
 *  append future names if Next renames again. */
const HOST_ATTRS = [
  'data-nextjs-dev-overlay',  // Next 16.2+
  'data-devtools-indicator',  // Next 16.0
  'data-next-badge-root',     // Next 15
  'data-next-mark',           // older Next 15
  'data-nextjs-toast',        // Next ≤ 14
];

/** Position for the badge — see app/globals.css for the full bottom-right stack. */
const TARGET_STYLE: Record<string, string> = {
  position: 'fixed',
  bottom: '148px',
  right: '16px',
  zIndex: '901',
};

export default function NextDevIndicatorRepositioner() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    if (typeof document === 'undefined') return;

    /** Apply target style to the first matching attribute. Returns true if found. */
    const reposition = (): boolean => {
      for (const attr of HOST_ATTRS) {
        const host = document.querySelector<HTMLElement>(`[${attr}]`);
        if (!host) continue;
        // Skip if already styled — avoids layout thrash on every observer tick.
        if (host.dataset.privacytrackerRepositioned === 'true') return true;
        Object.assign(host.style, TARGET_STYLE);
        host.dataset.privacytrackerRepositioned = 'true';
        return true;
      }
      return false;
    };

    reposition();

    // Next mounts the indicator asynchronously and re-creates it on hot-reload,
    // so a one-shot check isn't enough.
    const observer = new MutationObserver(() => {
      reposition();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    return () => observer.disconnect();
  }, []);

  return null;
}
