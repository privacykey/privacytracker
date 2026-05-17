"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Tracks the most recent pathname+search the user visited, stored in
 * sessionStorage. Works around `document.referrer` being frozen across
 * App Router soft navigations: child detail pages read sessionStorage
 * before this parent effect overwrites it, so the value at read time
 * is the path the user was just on.
 *
 * Two keys:
 *  - `pt:nav:current` — current path
 *  - `pt:nav:last-non-app` — most recent non-`/apps/[id]` path, so
 *    app-to-app hops resolve back to a sensible list page.
 *
 * Mount once in the root layout.
 */

const CURRENT_PATH_KEY = "pt:nav:current";
const LAST_NON_APP_PATH_KEY = "pt:nav:last-non-app";

/** Path patterns considered an app-detail page (skipped from non-app log). */
function isAppDetailPath(path: string): boolean {
  return /^\/apps\/[^/?#]+/.test(path);
}

export default function NavigationHistoryTracker() {
  // Don't use `useSearchParams` — it would opt every parent out of SSR.
  // Read `window.location.search` inside the effect instead.
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!pathname) {
      return;
    }

    const search = window.location.search || "";
    const full = search ? `${pathname}${search}` : pathname;

    try {
      sessionStorage.setItem(CURRENT_PATH_KEY, full);
      if (!isAppDetailPath(pathname)) {
        sessionStorage.setItem(LAST_NON_APP_PATH_KEY, full);
      }
    } catch {
      /* sessionStorage can throw in private mode / quota-exceeded. Ignore —
         the back link just falls back to document.referrer or the default. */
    }
  }, [pathname]);

  return null;
}

/**
 * Returns the path the user was on before the current render. Parent
 * effects run after child effects, so children mounting on a route
 * change read the previous value. Returns `null` on first hard-load.
 */
export function getPreviousPath(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return sessionStorage.getItem(CURRENT_PATH_KEY);
  } catch {
    return null;
  }
}

/**
 * Returns the most recent path the user visited that wasn't `/apps/[id]`,
 * so navigating app-to-app still resolves back to the originating list page.
 */
export function getLastNonAppPath(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return sessionStorage.getItem(LAST_NON_APP_PATH_KEY);
  } catch {
    return null;
  }
}
