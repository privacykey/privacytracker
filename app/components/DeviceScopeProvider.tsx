"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type DeviceScope,
  SCOPE_ALL,
  serialiseScopeParam,
} from "@/lib/device-scope";

/**
 * Client-side holder for the global device scope.
 *
 * Mounted once in AppChrome, above every page, because the scope's whole
 * purpose is that it is visible and consistent everywhere — the nav
 * picker and the page it scopes must never disagree about whose device
 * is being shown.
 *
 * Writes are OPTIMISTIC: the picker's checkbox flips immediately and the
 * PUT catches up. A scope is a view preference, so a slow round trip
 * showing a stale checkbox is a worse failure than a brief disagreement
 * with the DB. The server's reconciled scope is authoritative on arrival
 * and replaces the optimistic value (it may differ — ticking the last
 * unticked device collapses a subset to "all").
 */

export interface ScopeDeviceEntry {
  appCount: number;
  deviceClass: string | null;
  id: string;
  model: string | null;
  name: string;
}

interface DeviceScopeValue {
  devices: ScopeDeviceEntry[];
  /** True once scope + devices have landed (or the fetch failed). Consumers
   *  that would otherwise flash unscoped content should hold on this. */
  ready: boolean;
  refresh: () => void;
  scope: DeviceScope;
  /**
   * Stable string identity for the current scope. Use as a React `key`
   * on subtrees whose hydration effects are mount-only (AppGrid), or in
   * a fetch effect's dependency array.
   */
  scopeKey: string;
  /** Value for `?devices=`, or null when unrestricted — in which case
   *  callers must omit the param entirely so the request stays
   *  byte-identical to an unscoped one. */
  scopeParam: string | null;
  setScope: (next: DeviceScope) => void;
}

const FALLBACK: DeviceScopeValue = {
  devices: [],
  ready: true,
  refresh: () => {
    /* no provider mounted */
  },
  scope: SCOPE_ALL,
  scopeKey: "all",
  scopeParam: null,
  setScope: () => {
    /* no provider mounted */
  },
};

const DeviceScopeContext = createContext<DeviceScopeValue>(FALLBACK);

/**
 * Read the active scope. Safe to call outside the provider — Storybook,
 * the login page and any test harness get the unrestricted fallback
 * rather than a thrown error, so a component is never un-renderable just
 * because the chrome around it is absent.
 */
export function useDeviceScope(): DeviceScopeValue {
  return useContext(DeviceScopeContext);
}

/** Append `?devices=` to a URL when a scope is active. Centralised so
 *  the "omit the param entirely when unrestricted" rule is applied the
 *  same way by every caller. */
export function withScopeParam(url: string, scopeParam: string | null): string {
  if (!scopeParam) {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}devices=${encodeURIComponent(scopeParam)}`;
}

/**
 * Fixed-value provider for Storybook and tests. Takes the place of the
 * real one so a story can render any scope state without a fetch; toggles
 * update local state so the popover is still interactive.
 */
export function DeviceScopeStoryProvider({
  children,
  devices,
  scope: initialScope,
}: {
  children: ReactNode;
  devices: ScopeDeviceEntry[];
  scope: DeviceScope;
}) {
  const [scope, setScope] = useState(initialScope);
  const value = useMemo<DeviceScopeValue>(() => {
    const scopeParam = serialiseScopeParam(scope);
    return {
      devices,
      ready: true,
      refresh: () => {
        /* nothing to refresh from */
      },
      scope,
      scopeKey: scopeParam ?? "all",
      scopeParam,
      setScope,
    };
  }, [devices, scope]);
  return (
    <DeviceScopeContext.Provider value={value}>
      {children}
    </DeviceScopeContext.Provider>
  );
}

export default function DeviceScopeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [scope, setScopeState] = useState<DeviceScope>(SCOPE_ALL);
  const [devices, setDevices] = useState<ScopeDeviceEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/device-scope")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!live) {
          return;
        }
        if (json?.scope) {
          setScopeState(json.scope);
        }
        if (Array.isArray(json?.devices)) {
          setDevices(json.devices);
        }
        setReady(true);
      })
      .catch(() => {
        // Fail OPEN: an unreadable scope must show the whole fleet, never
        // an empty one. `scope` is already SCOPE_ALL here.
        if (live) {
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const setScope = useCallback((next: DeviceScope) => {
    setScopeState(next);
    fetch("/api/device-scope", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: next }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.scope) {
          setScopeState(json.scope);
        }
        if (Array.isArray(json?.devices)) {
          setDevices(json.devices);
        }
      })
      .catch(() => {
        // Keep the optimistic value. The scope is re-read on the next
        // page load anyway, and reverting under the user's cursor is
        // more confusing than a preference that didn't persist.
      });
  }, []);

  const value = useMemo<DeviceScopeValue>(() => {
    const scopeParam = serialiseScopeParam(scope);
    return {
      devices,
      ready,
      refresh,
      scope,
      scopeKey: scopeParam ?? "all",
      scopeParam,
      setScope,
    };
  }, [devices, ready, refresh, scope, setScope]);

  return (
    <DeviceScopeContext.Provider value={value}>
      {children}
    </DeviceScopeContext.Provider>
  );
}
