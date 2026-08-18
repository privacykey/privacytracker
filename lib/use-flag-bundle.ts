"use client";

import { useEffect, useState } from "react";
import type { FlagKey, FlagValue } from "./feature-flag-rules";

/**
 * Client-side resolved-flag reader for Rust-core Phase 0.
 *
 * Pages used to call `resolveFlagFromDb()` in their server component and
 * pass the results down as props. Shells can't do that, and the existing
 * `useFlag` hook (lib/feature-flags-hooks.ts) can't stand in: it reads a
 * resolver context that nothing ever primes on the client, so it always
 * returns HARD_DEFAULTS. This hook reads the real resolved values from
 * `GET /api/feature-flags` instead — the same resolver output, via the
 * `flags[].currentValue` field.
 *
 * The response is the full registry (~42 KB), so it is fetched **once
 * per page load and shared**: the in-flight promise and its result are
 * module-level, so ten components asking for ten different bundles
 * still make one request. The cache deliberately lives for the lifetime
 * of the module (a page load) — flags change through Settings, which
 * navigates, and a stale-by-seconds flag is not worth per-component
 * revalidation.
 *
 * Returns `null` until the values land, so callers can hold rendering
 * rather than paint hard defaults and then flip.
 */

let cache: Map<string, FlagValue> | null = null;
let inFlight: Promise<Map<string, FlagValue>> | null = null;
/** True once a load attempt has failed — lets callers distinguish
 *  "resolved off" from "couldn't read" (see RequireFlagGate's failOpen). */
let loadFailed = false;

function loadFlags(): Promise<Map<string, FlagValue>> {
  if (cache) {
    return Promise.resolve(cache);
  }
  if (!inFlight) {
    inFlight = fetch("/api/feature-flags")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then((json: { flags?: { key: string; currentValue: FlagValue }[] }) => {
        const map = new Map<string, FlagValue>();
        for (const entry of json.flags ?? []) {
          map.set(entry.key, entry.currentValue);
        }
        cache = map;
        return map;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Testing / navigation escape hatch — drops the module-level cache. */
export function clearFlagBundleCache() {
  cache = null;
  inFlight = null;
  loadFailed = false;
}

/** Whether the shared flag fetch has failed this page load. */
export function useFlagBundleStatus(): { failedToLoad: boolean } {
  const [failedToLoad, setFailed] = useState(loadFailed);
  useEffect(() => {
    let live = true;
    loadFlags()
      .then(() => live && setFailed(false))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  return { failedToLoad };
}

/**
 * Resolve a fixed set of flag keys to their RAW values. `null` while
 * loading.
 *
 * Most flags are on/off, so `useFlagBundle` below coerces to boolean —
 * but a few are tri-state. `flag.detail.annotations_sidebar` is
 * `"on" | "off" | "collapsed"` with a HARD_DEFAULT of `"collapsed"`, so
 * `=== "on"` would read it as OFF and silently hide the annotations rail
 * for the default audience. Anything consuming a non-boolean flag must
 * use this instead.
 */
export function useFlagValues<K extends string>(
  keys: readonly K[]
): Record<K, FlagValue> | null {
  const [values, setValues] = useState<Record<K, FlagValue> | null>(null);
  const cacheKey = keys.join(",");

  useEffect(() => {
    let live = true;
    loadFlags()
      .then((map) => {
        if (!live) {
          return;
        }
        const out = {} as Record<K, FlagValue>;
        for (const key of cacheKey.split(",") as K[]) {
          const value = map.get(key);
          if (value !== undefined) {
            out[key] = value;
          }
        }
        setValues(out);
      })
      .catch((error) => {
        loadFailed = true;
        console.warn("[flags] bundle load failed:", error);
        if (live) {
          // Empty map, NOT a map of "off": a tri-state consumer must be
          // able to tell "couldn't read" from "resolved off" and apply
          // its own default (see RequireFlagGate's failOpen).
          setValues({} as Record<K, FlagValue>);
        }
      });
    return () => {
      live = false;
    };
  }, [cacheKey]);

  return values;
}

/**
 * Resolve a fixed set of flag keys to booleans (`value === "on"`).
 * `null` while loading.
 */
export function useFlagBundle<K extends string>(
  keys: readonly K[]
): Record<K, boolean> | null {
  const [values, setValues] = useState<Record<K, boolean> | null>(null);
  // Keys are authored as literal arrays at call sites; join them so a
  // fresh array identity per render doesn't re-trigger the effect.
  const cacheKey = keys.join(",");

  useEffect(() => {
    let live = true;
    loadFlags()
      .then((map) => {
        if (!live) {
          return;
        }
        const out = {} as Record<K, boolean>;
        for (const key of cacheKey.split(",") as K[]) {
          out[key] = map.get(key) === "on";
        }
        setValues(out);
      })
      .catch((error) => {
        loadFailed = true;
        console.warn("[flags] bundle load failed:", error);
        if (live) {
          // Fail closed, matching RequireFlagGate: an unreadable flag
          // hides its surface rather than exposing it.
          const out = {} as Record<K, boolean>;
          for (const key of cacheKey.split(",") as K[]) {
            out[key] = false;
          }
          setValues(out);
        }
      });
    return () => {
      live = false;
    };
  }, [cacheKey]);

  return values;
}

/** Single-flag convenience over the same shared fetch. */
export function useResolvedFlag(key: FlagKey): boolean | null {
  const bundle = useFlagBundle([key as string]);
  return bundle ? bundle[key as string] : null;
}
