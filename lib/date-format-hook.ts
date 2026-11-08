"use client";

/**
 * useDateFormat — client hook returning the active date-format preference.
 * Fetches once on mount, then stays in sync via a custom-window-event pub/sub.
 *
 * Server-rendered surfaces should prefer `getDateFormatPreference()` and
 * thread the resolved mode down as a prop to avoid a brief default-mode flash.
 * Use this hook on pages that are client-rendered top to bottom.
 */

import { useEffect, useState } from "react";
import {
  DATE_FORMAT_DEFAULT,
  type DateFormatMode,
  normaliseDateFormat,
} from "./date-format";

const CHANGE_EVENT = "privacytracker:date-format-change";

let cachedMode: DateFormatMode | null = null;

/**
 * Notify every mounted hook subscriber that the preference changed. Called
 * by the Settings save handler so the whole app re-renders without a reload.
 */
export function broadcastDateFormat(next: DateFormatMode): void {
  cachedMode = next;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<DateFormatMode>(CHANGE_EVENT, { detail: next })
    );
  }
}

export function useDateFormat(): DateFormatMode {
  // Seed with the cached preference when one mount has already fetched it,
  // otherwise the default. Every page is a client-fetching shell, so no date
  // is server-rendered and the seed never has to be locale-independent; it
  // used to be 'iso', which painted "2026-11-07" for a beat before the fetch
  // swapped in the preference and made the same date read two ways.
  const [mode, setMode] = useState<DateFormatMode>(
    () => cachedMode ?? DATE_FORMAT_DEFAULT
  );

  useEffect(() => {
    let live = true;
    // Hydrate from cache first so multi-mount components don't race the fetch.
    if (cachedMode) {
      setMode(cachedMode);
    } else {
      fetch("/api/date-format")
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { mode?: string } | null) => {
          if (!live) {
            return;
          }
          const next = normaliseDateFormat(body?.mode ?? null);
          cachedMode = next;
          setMode(next);
        })
        .catch(() => {
          if (live) {
            setMode(DATE_FORMAT_DEFAULT);
          }
        });
    }
    function onChange(e: Event) {
      const ce = e as CustomEvent<DateFormatMode>;
      if (typeof ce.detail === "string") {
        setMode(ce.detail);
      }
    }
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  return mode;
}
