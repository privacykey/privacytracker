"use client";

/**
 * Client-side React hooks for the feature-flag resolver. Thin wrappers around
 * `subscribeToContext` / `getCachedContext` from `lib/feature-flags.ts`.
 *
 *   import { useFlag, useFocus } from '@/lib/feature-flags-hooks';
 *   const compare = useFlag('flag.page.compare');
 */

import { useSyncExternalStore } from "react";
import {
  type FlagKey,
  type FlagValue,
  type FocusState,
  HARD_DEFAULTS,
} from "./feature-flag-rules";
import {
  getCachedContext,
  resolveFlag,
  subscribeToContext,
} from "./feature-flags";

/**
 * Read a single flag's resolved value, re-rendering on context changes.
 * Falls back to the flag's hard default when no context is set yet.
 */
export function useFlag(key: FlagKey): FlagValue {
  return useSyncExternalStore(
    subscribeToContext,
    () => {
      const ctx = getCachedContext();
      return ctx ? resolveFlag(key, ctx) : HARD_DEFAULTS[key];
    },
    // Server snapshot — server components should use `resolveFlagFromDb()`.
    () => HARD_DEFAULTS[key]
  );
}

/** Read the active focus state in one call. */
export function useFocus(): FocusState {
  return useSyncExternalStore(
    subscribeToContext,
    () => getCachedContext()?.focus ?? FALLBACK_FOCUS,
    () => FALLBACK_FOCUS
  );
}

const FALLBACK_FOCUS: FocusState = {
  audience: "self",
  goals: new Set(["monitor"]),
  aiConfigured: false,
};
