"use client";

import { useTranslations } from "next-intl";
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
  describeScope,
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
  ownerAudience: "self" | "loved_one" | "guardian" | null;
  ownerLabel: string | null;
}

interface DeviceScopeValue {
  /**
   * The focus audience currently in effect, or null while it loads / if
   * the read failed.
   *
   * The scope context owns this because "whose device am I looking at?"
   * and "whose apps am I set up to work on?" are the same question asked
   * two ways, and the only consumer — the picker's switch prompt —
   * needs both answers to agree before it can say anything useful.
   */
  audience: "self" | "loved_one" | "guardian" | null;
  devices: ScopeDeviceEntry[];
  /** True once scope + devices have landed (or the fetch failed). Consumers
   *  that would otherwise flash unscoped content should hold on this. */
  ready: boolean;
  refresh: () => void;
  /**
   * Ask for `audience` to be read. It is read on demand, not at mount:
   * the provider mounts above AppChrome's flag hold, on every page, and
   * only the picker's switch prompt uses the answer. The picker calls
   * this once it has devices to pick from.
   */
  requestAudience: () => void;
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
  /**
   * Switch the focus audience, preserving every other focus setting.
   *
   * Read-modify-write on purpose: `POST /api/focus` takes the WHOLE
   * focus and coerces absent goal flags to false, so posting an audience
   * on its own would silently wipe the user's goals. Resolves to true
   * when the switch landed.
   */
  setAudience: (next: "self" | "loved_one" | "guardian") => Promise<boolean>;
  setScope: (next: DeviceScope) => void;
}

const FALLBACK: DeviceScopeValue = {
  audience: null,
  devices: [],
  ready: true,
  refresh: () => {
    /* no provider mounted */
  },
  requestAudience: () => {
    /* no provider mounted */
  },
  scope: SCOPE_ALL,
  scopeKey: "all",
  scopeParam: null,
  setAudience: () => Promise.resolve(false),
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

/**
 * Human name for the active scope, or null when unrestricted.
 *
 * One implementation, because three surfaces need the same phrase and
 * three copies would drift: the grid's "Sync {scope}" button, its
 * "Showing {scope}" chip, and the export notices that have to admit
 * they ignore the scope.
 *
 * Names the DEVICE, not its owner, even where an owner is recorded.
 * These are labels on things being acted on or counted — "Sync Mum's
 * iPad" says precisely what will be synced, where "Sync Mum" does not.
 * Owner-first phrasing belongs to the focus-switch prompt, which is
 * about a person rather than a device and carries its own strings.
 */
export function useScopeLabel(): string | null {
  const t = useTranslations("device_scope");
  const { devices, scope } = useDeviceScope();
  return useMemo(() => {
    const described = describeScope(scope, devices);
    if (described.kind === "all") {
      return null;
    }
    if (described.kind === "single" && described.name) {
      return described.name;
    }
    if (described.kind === "unattached") {
      return t("unattached_label");
    }
    return t("multi_label", { count: described.count });
  }, [devices, scope, t]);
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
  audience = "self",
  children,
  devices,
  scope: initialScope,
}: {
  audience?: "self" | "loved_one" | "guardian" | null;
  children: ReactNode;
  devices: ScopeDeviceEntry[];
  scope: DeviceScope;
}) {
  const [scope, setScope] = useState(initialScope);
  const [storyAudience, setStoryAudience] = useState(audience);
  const value = useMemo<DeviceScopeValue>(() => {
    const scopeParam = serialiseScopeParam(scope);
    return {
      audience: storyAudience,
      devices,
      ready: true,
      refresh: () => {
        /* nothing to refresh from */
      },
      requestAudience: () => {
        /* the story's audience is fixed */
      },
      scope,
      scopeKey: scopeParam ?? "all",
      scopeParam,
      setAudience: (next) => {
        setStoryAudience(next);
        return Promise.resolve(true);
      },
      setScope,
    };
  }, [devices, scope, storyAudience]);
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
  const [audience, setAudienceState] = useState<
    "self" | "loved_one" | "guardian" | null
  >(null);

  // Focus audience, read once per page load, and only when asked
  // (`requestAudience`). Only the picker's switch prompt consumes it, and
  // that prompt is not worth holding the tree for — a null audience
  // simply means no prompt yet.
  //
  // It used to be read at mount. That was harmless while the provider
  // mounted together with the page, but the provider now mounts above
  // AppChrome's flag hold so the scope read starts early, and an eager
  // read here became the first /api/focus request on every page, ahead
  // of the page's own (welcome, onboarding, dashboard). On pages with no
  // picker at all it was a wasted request, and when that read failed the
  // page's own read succeeded and its "couldn't load" state never showed.
  const [audienceWanted, setAudienceWanted] = useState(false);
  const requestAudience = useCallback(() => setAudienceWanted(true), []);
  useEffect(() => {
    if (!audienceWanted) {
      return;
    }
    let live = true;
    fetch("/api/focus")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live && json?.audience) {
          setAudienceState(json.audience);
        }
      })
      .catch(() => {
        // No audience means no prompt. Failing quiet is right here: a
        // focus read that didn't land is not grounds for suggesting the
        // user change their focus.
      });
    return () => {
      live = false;
    };
  }, [nonce, audienceWanted]);

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

  const setAudience = useCallback(
    async (next: "self" | "loved_one" | "guardian") => {
      try {
        // Read-modify-write. POST /api/focus takes the whole focus and
        // coerces absent goal flags to false, so posting `{audience}`
        // alone would quietly clear the user's goals — turning "show me
        // Mum's apps in helper mode" into "reset my setup".
        const current = await fetch("/api/focus").then((res) =>
          res.ok ? res.json() : null
        );
        if (!current) {
          return false;
        }
        const res = await fetch("/api/focus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessibility: current.accessibility === true,
            audience: next,
            childAgeBand: current.childAgeBand ?? null,
            cleanup: current.cleanup === true,
            minimal: current.minimal === true,
            monitor: current.monitor === true,
            ...(current.workflow ? { workflow: current.workflow } : {}),
          }),
        });
        if (!res.ok) {
          return false;
        }
        setAudienceState(next);
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const value = useMemo<DeviceScopeValue>(() => {
    const scopeParam = serialiseScopeParam(scope);
    return {
      audience,
      devices,
      ready,
      refresh,
      requestAudience,
      scope,
      scopeKey: scopeParam ?? "all",
      scopeParam,
      setAudience,
      setScope,
    };
  }, [
    audience,
    devices,
    ready,
    refresh,
    requestAudience,
    scope,
    setAudience,
    setScope,
  ]);

  return (
    <DeviceScopeContext.Provider value={value}>
      {children}
    </DeviceScopeContext.Provider>
  );
}
