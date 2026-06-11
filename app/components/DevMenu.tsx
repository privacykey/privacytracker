"use client";

/**
 * DevMenu — bottom-right footer-anchored developer overlay.
 *
 * Lives inside the global footer landmark in `app/layout.tsx`, sitting in
 * the right-side cluster alongside AccessibilityQuickToggles and
 * KeyboardHint. The trigger is a small purple icon button at
 * `bottom: 100px / right: 16px` (above the a11y quick-toggle); the
 * popover anchors upward from its top edge so the menu reads as
 * "rising" out of the trigger.
 *
 * The previous mount sat in the navbar between the notification bell
 * and the "+ Add Apps" CTA. We moved it because:
 *   1. Routes without a navbar (`/onboard`, `/legal`, `/privacy-policy`)
 *      had no way to reach it — devs hit Cmd-L to navigate elsewhere
 *      just to flip a flag.
 *   2. The bottom-right cluster is already the home of "global chrome"
 *      controls (a11y, kbd, dev) — putting them all together is more
 *      discoverable than splitting them across two screen edges.
 *
 * Two-layer gate (unchanged from the navbar version):
 *   1. `flag.devopts.visible === 'on'`   — the existing dev-mode gate
 *   2. localStorage `dev-menu-on === 'true'` — per-device opt-in toggled
 *      from Settings → Developer Options → "Dev menu trigger"
 *
 * Sections in the dropdown:
 *   - Quick actions:
 *       · Language picker (POST /api/locale)
 *       · Sync controls (start = /api/sync/trigger, stop = /api/dev/sync-stop)
 *       · Test data (seed-sample-data)
 *       · Audience + goals quick-pickers (POST /api/focus)
 *       · Kill switch (overrides flag.devopts.feature_flag_system.enabled)
 *       · Destructive ops with confirmation (wipe-apps, reset-changelog,
 *         delete-shortlists)
 *   - Feature flags (current-page-highlighted; same picker chips as before)
 *
 * State + side-effects:
 *   - Toggles fire `router.refresh()` after a successful API call so any
 *     server-rendered chrome reading the same flag/state re-renders in
 *     place.
 *   - The localStorage key listens to both cross-tab `storage` and a
 *     same-tab custom event (`dev-menu:changed`) so flipping it from
 *     Settings updates the trigger without a reload.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlagValue } from "../../lib/feature-flag-rules";
import { getFlagUsage } from "../../lib/feature-flag-usage";
import { useFlag } from "../../lib/feature-flags-hooks";

// localStorage key — exported so the Settings panel can write to the
// same key from its toggle. Renamed from FLOATING_FLAGS_STORAGE_KEY but
// kept under that const-name as an alias for back-compat.
export const DEV_MENU_STORAGE_KEY = "dev-menu-on";
/** @deprecated alias retained while DevOptionsFeatureFlagPanel still imports the old name. */
export const FLOATING_FLAGS_STORAGE_KEY = DEV_MENU_STORAGE_KEY;

interface FlagRow {
  currentValue: FlagValue;
  hardDefault: FlagValue;
  key: string;
  override: FlagValue | null;
  surface: string;
  wired: boolean;
}

interface ActiveTaskInfo {
  currentAppName: string | null;
  initiator: string | null;
  running: boolean;
  summary: {
    total: number;
    done: number;
    failed: number;
    remaining: number;
  } | null;
}

interface LocaleInfo {
  locale: string;
  supported: string[];
}

/**
 * Snapshot of the active focus, served by GET /api/focus. Mirrors the
 * shape POST /api/focus accepts so the picker can round-trip without
 * a second translation step.
 */
interface FocusInfo {
  accessibility: boolean;
  aiConfigured: boolean;
  audience: "self" | "loved_one" | "guardian";
  declutter: boolean;
  minimal: boolean;
  understand: boolean;
}

/**
 * Whether each per-category preference profile is currently active.
 * The full editors live in Settings → Privacy / Accessibility Profile;
 * the dev menu just exposes an enabled/disabled toggle for quick
 * round-trips and links out to the editor for fine-tuning. `null`
 * means the API hasn't returned yet.
 */
interface ProfilesState {
  accessibilityEnabled: boolean | null;
  privacyEnabled: boolean | null;
}

const AUDIENCE_OPTIONS: Array<{
  value: FocusInfo["audience"];
  labelKey: string;
}> = [
  { value: "self", labelKey: "audience_self" },
  { value: "loved_one", labelKey: "audience_loved_one" },
  { value: "guardian", labelKey: "audience_guardian" },
];

const GOAL_OPTIONS: Array<{
  key: "understand" | "declutter" | "minimal" | "accessibility";
  labelKey: string;
}> = [
  { key: "understand", labelKey: "goal_understand" },
  { key: "declutter", labelKey: "goal_declutter" },
  { key: "minimal", labelKey: "goal_minimal" },
  { key: "accessibility", labelKey: "goal_accessibility" },
];

/**
 * Kill-switch flag — flipping this to 'off' collapses every flag back
 * to its hard default. Documented in CLAUDE.md as the recovery path
 * when a release misbehaves; surfacing it here so devs can flip it
 * without opening the full Settings → Developer Options panel.
 */
const KILL_SWITCH_KEY = "flag.devopts.feature_flag_system.enabled";

const ALWAYS_VISIBLE_SURFACES = new Set([
  "global",
  "nav",
  "notifications",
  "taskcenter",
  "devopts",
]);

function primarySurfacesForPath(pathname: string): string[] {
  if (pathname.startsWith("/apps/")) {
    return ["detail"];
  }
  if (pathname.startsWith("/manual-apps/")) {
    return ["detail"];
  }
  if (pathname.startsWith("/onboard")) {
    return ["onboarding"];
  }
  if (pathname.startsWith("/help")) {
    return ["help"];
  }
  if (pathname.startsWith("/legal")) {
    return ["legal"];
  }
  if (pathname.startsWith("/privacy-policy")) {
    return ["legal"];
  }
  if (pathname.startsWith("/dashboard/apps")) {
    return ["appgrid"];
  }
  if (pathname.startsWith("/dashboard/privacy")) {
    return ["stats", "page"];
  }
  if (pathname.startsWith("/dashboard/stats")) {
    return ["stats"];
  }
  if (pathname.startsWith("/dashboard/shortlist")) {
    return ["shortlist"];
  }
  if (pathname.startsWith("/dashboard/settings")) {
    return ["settings", "devopts"];
  }
  if (pathname.startsWith("/dashboard/compare")) {
    return ["page"];
  }
  if (pathname.startsWith("/dashboard/review-recommendations")) {
    return ["page"];
  }
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return ["dashboard"];
  }
  return [];
}

/**
 * Per-path overrides that promote individual flag KEYS into the
 * "On this page" primary group regardless of their surface bucket.
 *
 * Used for cross-cutting flags whose effect is page-specific but
 * whose surface label puts them somewhere unintuitive. e.g.
 * `flag.devopts.cfgutil_uninstall` is structurally a `devopts` flag
 * (lives in the always-visible "Global chrome" group) but only
 * matters on the review-recommendations page — surfacing it as a
 * primary chip there makes it discoverable without devs hunting
 * through the chrome group every time.
 *
 * The dev menu's `grouped.primary` lifter looks up this table and
 * pulls any matching rows out of the chrome / other buckets so the
 * flag appears once, in the primary section, with the rest of the
 * page-relevant flags.
 */
const PAGE_PRIMARY_FLAG_KEYS: Array<{
  prefix: string;
  keys: readonly string[];
}> = [
  {
    prefix: "/dashboard/review-recommendations",
    keys: ["flag.devopts.cfgutil_uninstall"],
  },
];

function pagePrimaryFlagKeysFor(pathname: string): readonly string[] {
  for (const o of PAGE_PRIMARY_FLAG_KEYS) {
    if (pathname.startsWith(o.prefix)) {
      return o.keys;
    }
  }
  return [];
}

const SURFACE_LABEL_KEYS: Record<string, string> = {
  about: "subsystem_about",
  appgrid: "subsystem_appgrid",
  dashboard: "subsystem_dashboard",
  desktop: "subsystem_desktop",
  detail: "subsystem_detail",
  devopts: "subsystem_devopts",
  global: "subsystem_global",
  help: "subsystem_help",
  legal: "subsystem_legal",
  nav: "subsystem_nav",
  notifications: "subsystem_notifications",
  onboarding: "subsystem_onboarding",
  page: "subsystem_page",
  settings: "subsystem_settings",
  shortlist: "subsystem_shortlist",
  stats: "subsystem_stats",
  taskcenter: "subsystem_taskcenter",
};

const VALUE_OPTIONS: FlagValue[] = ["on", "off", "collapsed"];

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  zh: "中文",
};

function readInitialEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(DEV_MENU_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function DevMenu() {
  const tDev = useTranslations("dev_menu_panel");
  // Shared with TaskCenter's footer link — same target page, same hint.
  const tDiagLink = useTranslations("diagnostics_link");
  const devOptsVisible = useFlag("flag.devopts.visible") === "on";
  const pathname = usePathname() || "/";
  const router = useRouter();

  const [enabled, setEnabled] = useState<boolean>(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setEnabled(readInitialEnabled());
  }, []);

  // Server-side state pull. localStorage works for the web build but
  // breaks across Tauri launches (sidecar gets a fresh port → new
  // origin → empty localStorage). The /api/dev-menu-state endpoint
  // persists the flag in app_settings so it survives quits. We mirror
  // the API's answer back to localStorage so the rest of the file's
  // synchronous checks (and DevOptionsFeatureFlagPanel's same-tab
  // listener) pick it up without an additional round-trip.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/dev-menu-state");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { enabled?: boolean };
        if (cancelled || data.enabled !== true) {
          return;
        }
        // Server says enabled — mirror to localStorage and broadcast
        // so the panel's matching toggle UI flips on without a manual
        // re-flip from the user.
        try {
          localStorage.setItem(DEV_MENU_STORAGE_KEY, "true");
        } catch {
          /* localStorage unavailable in some private modes */
        }
        setEnabled(true);
        window.dispatchEvent(new CustomEvent("dev-menu:changed"));
      } catch (err) {
        console.warn("[dev-menu] failed to read state from API:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEV_MENU_STORAGE_KEY) {
        return;
      }
      setEnabled(e.newValue === "true");
    };
    const onSameTab = () => setEnabled(readInitialEnabled());
    window.addEventListener("storage", onStorage);
    window.addEventListener("dev-menu:changed", onSameTab);
    // Backwards-compat alias used by older callers.
    window.addEventListener("floating-flags:changed", onSameTab);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("dev-menu:changed", onSameTab);
      window.removeEventListener("floating-flags:changed", onSameTab);
    };
  }, []);

  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Selected flag inside the DevMenu's flag list. Mirrors the pattern
   * used in the full Settings panel: clicking a row's key area marks it
   * selected, applying a purple ring + revealing the inline "where it's
   * used" preview underneath. Clicking another row replaces the
   * selection. Stays sticky across re-renders so the user can scan
   * around the popover without losing their place.
   */
  const [selectedFlagKey, setSelectedFlagKey] = useState<string | null>(null);
  // Reset whenever the popover closes so re-opening lands on a clean
  // state — otherwise the stale highlight would persist into the
  // next session.
  useEffect(() => {
    if (!open) {
      setSelectedFlagKey(null);
    }
  }, [open]);

  // Closing the menu after a "Show me where" click is the last bit of
  // bookkeeping the row needs from the parent. Captured as a stable
  // callback so DevFlagRow's deps stay clean.
  const closeMenu = useCallback(() => setOpen(false), []);

  // Global keyboard-shortcut bridge. KeyboardShortcuts dispatches
  // `dev-menu:open` for the `g then x` sequence; we open the popover
  // and push focus to the close button so keyboard users land inside
  // the dialog rather than back on the trigger they can't see.
  // The handler self-gates on the same two layers as the trigger
  // (devmode flag + opt-in localStorage) so a stray event from a
  // misconfigured environment can't pop the menu open for end users.
  useEffect(() => {
    const onRequestOpen = () => {
      if (!devOptsVisible) {
        return;
      }
      if (!enabled) {
        return;
      }
      setOpen(true);
      requestAnimationFrame(() => {
        const closeBtn = popoverRef.current?.querySelector<HTMLButtonElement>(
          ".dev-menu-popover-close"
        );
        closeBtn?.focus();
      });
    };
    window.addEventListener("dev-menu:open", onRequestOpen);
    return () => window.removeEventListener("dev-menu:open", onRequestOpen);
  }, [devOptsVisible, enabled]);

  // ── Flags state (same plumbing as the old panel) ─────────────────────
  const [rows, setRows] = useState<FlagRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFlags = useCallback(
    async (mode: "initial" | "silent" = "initial") => {
      if (mode === "initial") {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await fetch("/api/feature-flags", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { flags: FlagRow[] };
        setRows(body.flags);
      } catch (e) {
        setError(e instanceof Error ? e.message : tDev("load_flags_failed"));
      } finally {
        if (mode === "initial") {
          setLoading(false);
        }
      }
    },
    [tDev]
  );

  // ── Quick-action state ───────────────────────────────────────────────
  const [locale, setLocale] = useState<LocaleInfo | null>(null);
  const [task, setTask] = useState<ActiveTaskInfo | null>(null);
  // Disable buttons while their action is in flight so devs can't
  // accidentally double-fire during a slow round-trip.
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  // Two-step confirmation. Destructive actions require a second click on
  // the same button within ~6 s — enough to interrupt muscle memory but
  // not so long it blocks deliberate workflows.
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLocale = useCallback(async () => {
    try {
      const res = await fetch("/api/locale", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as LocaleInfo;
      setLocale(body);
    } catch {
      /* non-fatal — language picker just shows nothing */
    }
  }, []);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/active", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as { sync?: ActiveTaskInfo };
      setTask(body.sync ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  // Active focus snapshot. The POST handler echoes the canonical shape
  // back, so we just swap state with whatever the server confirmed —
  // saves a second GET on each change. Falls back to the previous
  // value when the server returns an error so the UI doesn't flicker
  // to a half-empty state mid-write.
  const [focus, setFocus] = useState<FocusInfo | null>(null);
  const [focusBusy, setFocusBusy] = useState(false);

  const fetchFocus = useCallback(async () => {
    try {
      const res = await fetch("/api/focus", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as FocusInfo;
      setFocus(body);
    } catch {
      /* non-fatal — focus picker just stays disabled */
    }
  }, []);

  // ── Privacy + A11y profile snapshots ─────────────────────────────────
  // Both endpoints return `{ profile: null | {...} }`. We only care
  // whether the profile is non-null (enabled) for the dev menu — the
  // full editors live in Settings. Toggling here flips between
  // "enabled (load saved profile)" and "disabled (PUT {profile:null})".
  const [profiles, setProfiles] = useState<ProfilesState>({
    privacyEnabled: null,
    accessibilityEnabled: null,
  });
  const [profileBusy, setProfileBusy] = useState<
    "privacy" | "accessibility" | null
  >(null);

  const fetchProfiles = useCallback(async () => {
    try {
      const [privRes, a11yRes] = await Promise.all([
        fetch("/api/privacy-profile", { cache: "no-store" }),
        fetch("/api/accessibility-profile", { cache: "no-store" }),
      ]);
      const next: ProfilesState = {
        privacyEnabled: null,
        accessibilityEnabled: null,
      };
      if (privRes.ok) {
        const body = (await privRes.json()) as { profile: unknown };
        next.privacyEnabled =
          body.profile !== null && body.profile !== undefined;
      }
      if (a11yRes.ok) {
        const body = (await a11yRes.json()) as { profile: unknown };
        next.accessibilityEnabled =
          body.profile !== null && body.profile !== undefined;
      }
      setProfiles(next);
    } catch {
      /* non-fatal — toggles just stay disabled */
    }
  }, []);

  // `toggleProfile` is declared further down — after `flashToast` /
  // `router` so the useCallback deps don't reference variables in
  // their temporal dead zone. The profile state + fetcher above are
  // self-contained, so they can stay at the natural grouping spot.

  // First-open hydration. We also poll the task endpoint at 4 s while
  // open so the "Run sync" button updates from "Run sync" to "Stop" the
  // moment a sync starts, even when triggered elsewhere.
  useEffect(() => {
    if (!open) {
      return;
    }
    fetchFlags(rows ? "silent" : "initial");
    fetchLocale();
    fetchTask();
    fetchFocus();
    fetchProfiles();
    const id = setInterval(fetchTask, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    pathname,
    fetchFlags,
    fetchLocale,
    fetchTask,
    fetchFocus,
    fetchProfiles,
  ]);

  // Outside-click + Escape to dismiss.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // `pointerdown` (not `mousedown`) so iOS Safari closes the popover
    // on tap-outside. See `AppDetailView.tsx` outside-click handler for
    // the canonical comment on the iOS mouse-event-synthesis quirk.
    window.addEventListener("pointerdown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ── Confirmation timeout helpers ─────────────────────────────────────
  const armConfirm = useCallback((action: string) => {
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
    }
    setConfirming(action);
    confirmTimer.current = setTimeout(() => {
      setConfirming(null);
      confirmTimer.current = null;
    }, 6000);
  }, []);
  const clearConfirm = useCallback(() => {
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirming(null);
  }, []);

  useEffect(
    () => () => {
      if (confirmTimer.current) {
        clearTimeout(confirmTimer.current);
      }
    },
    []
  );

  // ── Toast helper for action feedback ─────────────────────────────────
  const flashToast = useCallback((message: string) => {
    setActionToast(message);
    setTimeout(() => {
      setActionToast((prev) => (prev === message ? null : prev));
    }, 3500);
  }, []);

  // Toggle a privacy / accessibility profile on/off. Disabling sends
  // `{ profile: null }` to clear; enabling sends `{ profile: {} }`
  // (empty object — server treats absent keys as "no preference",
  // the natural "enabled but unconfigured" starting point — the user
  // can edit specifics from Settings). Declared down here (rather
  // than next to the profile state above) so the useCallback deps
  // can reference `flashToast` and `router` without hitting their
  // temporal dead zone — both are declared just above.
  const toggleProfile = useCallback(
    async (kind: "privacy" | "accessibility") => {
      if (profileBusy) {
        return;
      }
      const url =
        kind === "privacy"
          ? "/api/privacy-profile"
          : "/api/accessibility-profile";
      const currentlyOn =
        kind === "privacy"
          ? profiles.privacyEnabled
          : profiles.accessibilityEnabled;
      if (currentlyOn === null) {
        return; // still loading — ignore clicks
      }
      const nextOn = !currentlyOn;
      setProfileBusy(kind);
      setProfiles((p) => ({
        ...p,
        [kind === "privacy" ? "privacyEnabled" : "accessibilityEnabled"]:
          nextOn,
      }));
      try {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: nextOn ? {} : null }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        flashToast(
          "✓ " +
            tDev("profile_toast_saved", {
              kind: tDev(
                kind === "privacy"
                  ? "profile_kind_privacy"
                  : "profile_kind_a11y"
              ),
              action: tDev(
                nextOn ? "profile_action_enabled" : "profile_action_disabled"
              ),
            })
        );
        router.refresh();
      } catch (e) {
        flashToast(
          "✗ " +
            tDev("profile_toast_failed", {
              kind: tDev(
                kind === "privacy"
                  ? "profile_kind_privacy"
                  : "profile_kind_a11y"
              ),
              message: e instanceof Error ? e.message : tDev("failed_word"),
            })
        );
        setProfiles((p) => ({
          ...p,
          [kind === "privacy" ? "privacyEnabled" : "accessibilityEnabled"]:
            currentlyOn,
        }));
      } finally {
        setProfileBusy(null);
      }
    },
    [profiles, profileBusy, flashToast, router, tDev]
  );

  // ── Generic POST helper used by every quick action ──────────────────
  const callAction = useCallback(
    async (
      action: string,
      url: string,
      init: RequestInit,
      onSuccess: (body: unknown) => string
    ) => {
      setActionBusy(action);
      try {
        const res = await fetch(url, init);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            (body as { error?: string }).error ?? `HTTP ${res.status}`;
          flashToast(`✗ ${action}: ${msg}`);
          return;
        }
        flashToast(`✓ ${onSuccess(body)}`);
        router.refresh();
        // Refresh task status so the sync chip updates.
        fetchTask();
      } catch (e) {
        flashToast(
          `✗ ${action}: ${e instanceof Error ? e.message : tDev("failed_word")}`
        );
      } finally {
        setActionBusy(null);
        clearConfirm();
      }
    },
    [router, flashToast, fetchTask, clearConfirm, tDev]
  );

  // ── Specific actions ─────────────────────────────────────────────────
  const setLocaleTo = useCallback(
    async (next: string) => {
      callAction(
        "locale",
        "/api/locale",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: next }),
        },
        (body) =>
          tDev("language_changed", { locale: (body as LocaleInfo).locale })
      );
      // Optimistic update so the picker reflects immediately.
      setLocale((prev) => (prev ? { ...prev, locale: next } : prev));
    },
    [callAction, tDev]
  );

  const startSync = useCallback(() => {
    callAction(
      "sync-start",
      "/api/sync/trigger",
      { method: "POST" },
      (body) => {
        const b = body as {
          synced?: number;
          changes?: number;
          skipped?: boolean;
        };
        if (b.skipped) {
          return tDev("sync_already_running");
        }
        return tDev("synced_summary", {
          synced: b.synced ?? 0,
          changes: b.changes ?? 0,
        });
      }
    );
  }, [callAction, tDev]);

  const stopSync = useCallback(() => {
    callAction("sync-stop", "/api/dev/sync-stop", { method: "POST" }, () =>
      tDev("sync_stop_requested")
    );
  }, [callAction, tDev]);

  const wipeApps = useCallback(() => {
    callAction(
      "wipe-apps",
      "/api/dev/wipe-apps",
      { method: "POST" },
      (body) => {
        const b = body as { rowsRemoved?: number };
        return tDev("wiped_summary", { count: b.rowsRemoved ?? 0 });
      }
    );
  }, [callAction, tDev]);

  const resetChangelog = useCallback(() => {
    callAction(
      "reset-changelog",
      "/api/dev/reset-changelog",
      { method: "POST" },
      (body) => {
        const b = body as { snapshotsRemoved?: number };
        return tDev("reset_changelog_summary", {
          count: b.snapshotsRemoved ?? 0,
        });
      }
    );
  }, [callAction, tDev]);

  const deleteShortlists = useCallback(() => {
    callAction(
      "delete-shortlists",
      "/api/shortlist?all=1",
      { method: "DELETE" },
      (body) => {
        const b = body as { removed?: number };
        return tDev("removed_shortlist_summary", { count: b.removed ?? 0 });
      }
    );
  }, [callAction, tDev]);

  const seedSampleData = useCallback(() => {
    callAction(
      "seed",
      "/api/dev/seed-sample-data",
      { method: "POST" },
      (body) => {
        const b = body as { inserted?: number; skipped?: number };
        return tDev("seeded_summary", {
          inserted: b.inserted ?? 0,
          skipped: b.skipped ?? 0,
        });
      }
    );
  }, [callAction, tDev]);

  // ── Focus picker — POST /api/focus ─────────────────────────────────────
  // Optimistic: stage the change locally, fire the request, then either
  // adopt the canonical server payload (which echoes the saved row) or
  // roll back to the previous focus. router.refresh() is fired in the
  // success path so server-rendered surfaces (HomeView callouts,
  // YourFocusCard chips) re-render against the new audience/goals
  // without a full reload.
  const writeFocus = useCallback(
    async (next: FocusInfo) => {
      if (focusBusy) {
        return;
      }
      const previous = focus;
      setFocusBusy(true);
      setFocus(next); // optimistic
      try {
        const res = await fetch("/api/focus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audience: next.audience,
            understand: next.understand,
            declutter: next.declutter,
            minimal: next.minimal,
            accessibility: next.accessibility,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            (body as { error?: string }).error ?? `HTTP ${res.status}`;
          flashToast(`✗ ${tDev("focus_failed", { message: msg })}`);
          setFocus(previous); // rollback
          return;
        }
        // The server normalises (e.g. promotes `understand=true` when
        // both primary goals are unset); adopt its echo so the picker
        // never drifts from what's actually persisted.
        setFocus({
          ...(body as FocusInfo),
          aiConfigured: previous?.aiConfigured ?? false,
        });
        const audienceLabel = tDev(
          AUDIENCE_OPTIONS.find((o) => o.value === next.audience)?.labelKey ??
            "audience_self"
        );
        const goalsSummary = describeGoalsForToast(tDev, next);
        flashToast(
          "✓ " +
            (goalsSummary
              ? tDev("focus_saved_with_goals", {
                  audience: audienceLabel,
                  goals: goalsSummary,
                })
              : tDev("focus_saved", { audience: audienceLabel }))
        );
        router.refresh();
      } catch (e) {
        flashToast(
          "✗ " +
            tDev("focus_failed", {
              message: e instanceof Error ? e.message : tDev("failed_word"),
            })
        );
        setFocus(previous);
      } finally {
        setFocusBusy(false);
      }
    },
    [focus, focusBusy, flashToast, router, tDev]
  );

  const setAudienceTo = useCallback(
    (next: FocusInfo["audience"]) => {
      if (!focus || focus.audience === next) {
        return;
      }
      writeFocus({ ...focus, audience: next });
    },
    [focus, writeFocus]
  );

  const toggleGoal = useCallback(
    (goal: "understand" | "declutter" | "minimal" | "accessibility") => {
      if (!focus) {
        return;
      }
      const current = focus[goal];
      // Mutual exclusion mirrors the /api/focus normaliser: picking
      // `minimal` clears understand + declutter; checking either of
      // those clears `minimal`. Accessibility is independent.
      let next: FocusInfo = { ...focus, [goal]: !current };
      if (goal === "minimal" && !current) {
        next = { ...next, understand: false, declutter: false };
      } else if ((goal === "understand" || goal === "declutter") && !current) {
        next = { ...next, minimal: false };
      }
      writeFocus(next);
    },
    [focus, writeFocus]
  );

  // ── Kill switch — flag.devopts.feature_flag_system.enabled ────────────
  // Off → resolver short-circuits to hard defaults for every flag (see
  // CLAUDE.md). The override is written through the standard flag
  // override API so it persists, shows up in the regular flag list, and
  // can be cleared from anywhere that interacts with overrides.
  const killSwitchRow = useMemo(
    () => rows?.find((r) => r.key === KILL_SWITCH_KEY) ?? null,
    [rows]
  );
  // We deliberately read the *override* field rather than `currentValue`
  // here. When the kill switch is engaged, resolveFlag short-circuits
  // every flag (including itself) to its hard default — so
  // `currentValue` reads as 'on' even though the override is 'off'.
  // The override field is the only reliable signal that the user has
  // actively pinned the system to disabled.
  const killSwitchActive = killSwitchRow?.override === "off";
  const [killBusy, setKillBusy] = useState(false);

  // ── Export overrides as JSON ─────────────────────────────────────────
  // Produces the exact shape `POST /api/feature-flags/overrides` accepts
  // in its bulk-import path: `{ flags: [{ key, override }] }`. We only
  // include rows whose override is non-null, since the bulk endpoint
  // wipes everything before replaying — leaving the array empty would
  // also clear, which is rarely what an "Export current overrides"
  // user wants. The blob is copied straight to the clipboard so it can
  // be pasted into the Focus × Flags matrix, the rule tables, or a
  // shared doc without juggling a download dialog.
  const exportOverridesJson = useCallback(async () => {
    if (!rows) {
      flashToast(`✗ ${tDev("flags_loading_toast")}`);
      return;
    }
    const overridden = rows.filter((r) => r.override !== null);
    if (overridden.length === 0) {
      flashToast(tDev("no_overrides_to_export"));
      return;
    }
    const blob = {
      generatedAt: new Date().toISOString(),
      flags: overridden.map((r) => ({
        key: r.key,
        override: r.override,
        // Resolved value at export time — handy as a sanity check when
        // pasting into a doc, ignored by the bulk-import POST.
        currentValue: r.currentValue,
      })),
    };
    const text = JSON.stringify(blob, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      flashToast(`✓ ${tDev("copied_overrides", { count: overridden.length })}`);
    } catch {
      // Fallback for environments without async clipboard. We emit a
      // textarea, select-and-copy, then remove it. Won't survive a
      // strict CSP, but is enough for the in-app dev menu.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        flashToast(
          `✓ ${tDev("copied_overrides_short", { count: overridden.length })}`
        );
      } catch {
        flashToast(`✗ ${tDev("clipboard_unavailable")}`);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [rows, flashToast, tDev]);

  const writeKillSwitch = useCallback(
    async (mode: "disable" | "enable") => {
      if (killBusy) {
        return;
      }
      setKillBusy(true);
      try {
        let res: Response;
        if (mode === "disable") {
          res = await fetch("/api/feature-flags/overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: KILL_SWITCH_KEY, value: "off" }),
          });
        } else {
          // Clearing the override snaps the flag back to its hard
          // default ('on'), which re-enables the rule engine.
          res = await fetch(
            `/api/feature-flags/overrides/${encodeURIComponent(KILL_SWITCH_KEY)}`,
            { method: "DELETE" }
          );
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        flashToast(
          "✓ " +
            (mode === "disable"
              ? tDev("kill_disabled_toast")
              : tDev("kill_enabled_toast"))
        );
        await fetchFlags("silent");
        router.refresh();
      } catch (e) {
        flashToast(
          "✗ " +
            tDev("kill_failed", {
              message: e instanceof Error ? e.message : tDev("failed_word"),
            })
        );
      } finally {
        setKillBusy(false);
      }
    },
    [killBusy, fetchFlags, flashToast, router, tDev]
  );

  // ── Flag preference (same as before) ─────────────────────────────────
  const primarySurfaces = useMemo(
    () => primarySurfacesForPath(pathname),
    [pathname]
  );
  const primarySet = useMemo(() => new Set(primarySurfaces), [primarySurfaces]);
  // Per-page key promotions — see `PAGE_PRIMARY_FLAG_KEYS`. Memoised
  // as a Set so the bucket loop below is a fixed lookup per row.
  const pagePrimaryKeys = useMemo(
    () => new Set(pagePrimaryFlagKeysFor(pathname)),
    [pathname]
  );

  const grouped = useMemo(() => {
    if (!rows) {
      return { primary: [], chrome: [], other: [] };
    }
    const primary: FlagRow[] = [];
    const chrome: FlagRow[] = [];
    const other: FlagRow[] = [];
    for (const row of rows) {
      // Per-page key promotion wins first — it pulls a flag into
      // `primary` even when its surface would normally land it
      // elsewhere (chrome / other). Without this branch
      // `flag.devopts.cfgutil_uninstall` would always sit in the
      // chrome group on the review-recommendations page since
      // `devopts` is in ALWAYS_VISIBLE_SURFACES.
      if (pagePrimaryKeys.has(row.key)) {
        primary.push(row);
      } else if (primarySet.has(row.surface)) {
        primary.push(row);
      } else if (ALWAYS_VISIBLE_SURFACES.has(row.surface)) {
        chrome.push(row);
      } else {
        other.push(row);
      }
    }
    return { primary, chrome, other };
  }, [rows, primarySet, pagePrimaryKeys]);

  const setOverride = useCallback(
    async (key: string, value: FlagValue | null) => {
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.key === key
                ? {
                    ...r,
                    override: value,
                    currentValue: value ?? r.hardDefault,
                  }
                : r
            )
          : prev
      );
      try {
        if (value === null) {
          const res = await fetch(
            `/api/feature-flags/overrides/${encodeURIComponent(key)}`,
            {
              method: "DELETE",
            }
          );
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
        } else {
          const res = await fetch("/api/feature-flags/overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value }),
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
        }
        fetchFlags("silent");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : tDev("set_override_failed"));
        fetchFlags("silent");
      }
    },
    [fetchFlags, router, tDev]
  );

  if (!mounted) {
    return null;
  }
  if (!devOptsVisible) {
    return null;
  }
  if (!enabled) {
    return null;
  }

  const primaryLabel =
    primarySurfaces.length === 0
      ? tDev("default_primary_label")
      : primarySurfaces
          .map((s) => (SURFACE_LABEL_KEYS[s] ? tDev(SURFACE_LABEL_KEYS[s]) : s))
          .join(" + ");

  const syncRunning = task?.running ?? false;

  return (
    <div className="dev-menu">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? tDev("close_aria") : tDev("open_aria")}
        className={`dev-menu-trigger${open ? " is-open" : ""}${syncRunning ? " is-busy" : ""}`}
        onClick={() => setOpen((o) => !o)}
        ref={triggerRef}
        title={tDev("trigger_title")}
        type="button"
      >
        {/* Wrench glyph, matched in size to the AccessibilityQuickToggles
            trigger (18px stroke icon inside a 36px button) so the two
            sit visually balanced in the bottom-right stack. */}
        <svg
          aria-hidden="true"
          className="dev-menu-trigger-glyph"
          fill="none"
          height="18"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="18"
        >
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z" />
        </svg>
        {syncRunning && (
          <span aria-hidden="true" className="dev-menu-trigger-busy-dot" />
        )}
      </button>

      {open && (
        <div
          aria-label={tDev("popover_aria")}
          className="dev-menu-popover"
          ref={popoverRef}
          role="dialog"
        >
          {/* Header: row 1 = title + kill-switch toggle + close,
              row 2 = subtitle ("Highlighting flags for ..."). The
              subtitle dropped to its own row so a long primary-label
              page name (e.g. "Settings + Developer options") doesn't
              wrap into the close button. */}
          <div className="dev-menu-popover-header">
            <div className="dev-menu-popover-header-top">
              <strong className="dev-menu-popover-title">
                {tDev("title")}
              </strong>
              <div className="dev-menu-popover-header-controls">
                {/* Kill switch sits in the header so it's reachable
                    without scrolling and visually distinct from the
                    routine quick actions. The switch chrome is the
                    standard `.switch-toggle` shape but tinted orange
                    when ON to flag warning state. ON = system enabled;
                    OFF = every flag forced to its hard default. */}
                <button
                  aria-checked={!killSwitchActive}
                  aria-label={
                    killSwitchActive
                      ? tDev("killswitch_label_off")
                      : tDev("killswitch_label_on")
                  }
                  className={`dev-menu-killswitch-toggle${killSwitchActive ? " is-off" : ""}`}
                  disabled={killBusy || !rows}
                  onClick={() =>
                    writeKillSwitch(killSwitchActive ? "enable" : "disable")
                  }
                  role="switch"
                  title={
                    killSwitchActive
                      ? tDev("killswitch_title_off")
                      : tDev("killswitch_title_on")
                  }
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="dev-menu-killswitch-track"
                  >
                    <span className="dev-menu-killswitch-thumb" />
                  </span>
                  <span
                    aria-hidden="true"
                    className="dev-menu-killswitch-label"
                  >
                    {killSwitchActive
                      ? tDev("flags_off_short")
                      : tDev("flags_on_short")}
                  </span>
                </button>
                <button
                  aria-label={tDev("close_button_aria")}
                  className="dev-menu-popover-close"
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="dev-menu-popover-subtitle">
              {tDev.rich("highlighting_for", {
                label: primaryLabel,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </div>
          </div>

          <div className="dev-menu-popover-body">
            {/* ── Quick actions ─────────────────────────────────────── */}
            <section
              aria-label={tDev("section_quick_actions_aria")}
              className="dev-menu-quick-section"
            >
              {/* Language */}
              <div className="dev-menu-quick-row">
                <label
                  className="dev-menu-quick-label"
                  htmlFor="dev-menu-locale"
                >
                  {tDev("label_language")}
                </label>
                <select
                  className="dev-menu-select"
                  disabled={actionBusy === "locale" || !locale}
                  id="dev-menu-locale"
                  onChange={(e) => setLocaleTo(e.target.value)}
                  value={locale?.locale ?? "en"}
                >
                  {(locale?.supported ?? ["en"]).map((code) => (
                    <option key={code} value={code}>
                      {LOCALE_LABELS[code] ?? code} ({code})
                    </option>
                  ))}
                </select>
              </div>

              {/* App data — collapsed group containing every action that
                  pokes at the user's app catalogue or test scaffolding.
                  Used to be three separate rows (Sync, Test data,
                  Onboarding preview); merged into a single stacked
                  group with the buttons clustered below the label so
                  text never competes with the button row for width.
                  When sync is running the label gains a live progress
                  sublabel ("syncing 3/10 · Instagram"). */}
              <div className="dev-menu-quick-row dev-menu-quick-row-stack">
                <span className="dev-menu-quick-label">
                  {tDev("label_app_data")}
                  {syncRunning && task?.summary && (
                    <span className="dev-menu-quick-sublabel">
                      {" "}
                      ·{" "}
                      {tDev("syncing_progress", {
                        done: task.summary.done,
                        total: task.summary.total,
                      })}
                      {task.currentAppName ? ` · ${task.currentAppName}` : ""}
                    </span>
                  )}
                </span>
                <div
                  aria-label={tDev("app_data_actions_aria")}
                  className="dev-menu-pill-group"
                  role="group"
                >
                  <button
                    className="dev-menu-action-btn"
                    disabled={actionBusy === "sync-start" || syncRunning}
                    onClick={startSync}
                    type="button"
                  >
                    {actionBusy === "sync-start"
                      ? tDev("btn_starting")
                      : tDev("btn_run_sync")}
                  </button>
                  <button
                    className="dev-menu-action-btn dev-menu-action-btn-warn"
                    disabled={actionBusy === "sync-stop" || !syncRunning}
                    onClick={stopSync}
                    type="button"
                  >
                    {actionBusy === "sync-stop"
                      ? tDev("btn_stopping")
                      : tDev("btn_stop")}
                  </button>
                  <button
                    className="dev-menu-action-btn"
                    disabled={actionBusy === "seed"}
                    onClick={seedSampleData}
                    title={tDev("btn_seed_title")}
                    type="button"
                  >
                    {actionBusy === "seed"
                      ? tDev("btn_seeding")
                      : tDev("btn_seed_populate")}
                  </button>
                  {/* Onboarding preview — opens /onboard with
                      ?preview=fresh so the wizard renders as a
                      brand-new user would see it. The wizard reads the
                      param to surface a "preview mode" banner and
                      short-circuits the final submit so devs can click
                      through without committing changes. Useful for
                      screenshots + UX review without wiping the DB. */}
                  <Link
                    className="dev-menu-action-btn"
                    href="/onboard?preview=fresh"
                    onClick={() => setOpen(false)}
                    title={tDev("btn_fresh_user_title")}
                  >
                    {tDev("btn_onboarding")}
                  </Link>
                </div>
              </div>

              {/* ── Configuration accordions ─────────────────────────
                  Audience, Goals, Privacy profile, and Accessibility
                  profile each get their own <details> block so they
                  collapse to a one-line summary by default and expand
                  when the user wants to fiddle. Saves vertical space
                  in the popover (the typical visit toggles a flag,
                  not a focus value). The summary line shows the
                  current value so users don't have to expand to see
                  what's set. */}
              <div className="dev-menu-config-group">
                {/* Audience — drives every audience-keyed rule across
                    the flag system. */}
                <details className="dev-menu-config-row">
                  <summary className="dev-menu-config-summary">
                    <span className="dev-menu-config-label">
                      {tDev("config_audience")}
                    </span>
                    <span className="dev-menu-config-value">
                      {focus
                        ? (() => {
                            const opt = AUDIENCE_OPTIONS.find(
                              (o) => o.value === focus.audience
                            );
                            return opt ? tDev(opt.labelKey) : tDev("dash");
                          })()
                        : "…"}
                    </span>
                  </summary>
                  <div
                    aria-label={tDev("audience_aria")}
                    className="dev-menu-pill-group"
                    role="radiogroup"
                  >
                    {AUDIENCE_OPTIONS.map((opt) => {
                      const active = focus?.audience === opt.value;
                      return (
                        <button
                          aria-checked={active}
                          className={`dev-menu-pick${active ? " is-active" : ""}`}
                          disabled={!focus || focusBusy}
                          key={opt.value}
                          onClick={() => setAudienceTo(opt.value)}
                          role="radio"
                          type="button"
                        >
                          {tDev(opt.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </details>

                {/* Goals — toggleable. The /api/focus normaliser
                    enforces the same mutual-exclusion the onboarding
                    screen does: picking Minimal clears Understand +
                    Declutter, and picking either of those clears
                    Minimal. Accessibility is independent. */}
                <details className="dev-menu-config-row">
                  <summary className="dev-menu-config-summary">
                    <span className="dev-menu-config-label">
                      {tDev("config_goals")}
                    </span>
                    <span className="dev-menu-config-value">
                      {focus ? summariseGoals(tDev, focus) : "…"}
                    </span>
                  </summary>
                  <p className="dev-menu-config-hint">{tDev("goals_hint")}</p>
                  <div
                    aria-label={tDev("goals_aria")}
                    className="dev-menu-pill-group"
                    role="group"
                  >
                    {GOAL_OPTIONS.map((opt) => {
                      const active = !!focus && focus[opt.key];
                      return (
                        <button
                          aria-pressed={active}
                          className={`dev-menu-pick${active ? " is-active" : ""}`}
                          disabled={!focus || focusBusy}
                          key={opt.key}
                          onClick={() => toggleGoal(opt.key)}
                          type="button"
                        >
                          {tDev(opt.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </details>

                {/* Privacy profile — quick on/off. Detailed editing
                    (per-category tier picker) lives in Settings;
                    enabling here writes a `{}` profile (sparse =
                    "no preference everywhere"), so the user gets the
                    "I have a profile" UX without committing to specific
                    thresholds yet. */}
                <details className="dev-menu-config-row">
                  <summary className="dev-menu-config-summary">
                    <span className="dev-menu-config-label">
                      {tDev("config_privacy_profile")}
                    </span>
                    <span
                      className={`dev-menu-config-value${
                        profiles.privacyEnabled ? "is-on" : ""
                      }`}
                    >
                      {profiles.privacyEnabled === null
                        ? "…"
                        : profiles.privacyEnabled
                          ? tDev("value_on")
                          : tDev("value_off")}
                    </span>
                  </summary>
                  <p className="dev-menu-config-hint">
                    {tDev("privacy_profile_hint")}
                  </p>
                  <div className="dev-menu-config-actions">
                    <button
                      aria-checked={!!profiles.privacyEnabled}
                      className={`switch-toggle${profiles.privacyEnabled ? " is-on" : ""}`}
                      disabled={
                        profiles.privacyEnabled === null ||
                        profileBusy === "privacy"
                      }
                      onClick={() => toggleProfile("privacy")}
                      role="switch"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="switch-toggle-thumb"
                      />
                    </button>
                    <Link
                      className="dev-menu-config-link"
                      href="/dashboard/settings#privacy-profile"
                      onClick={() => setOpen(false)}
                    >
                      {tDev("edit_in_settings")}
                    </Link>
                  </div>
                </details>

                {/* Accessibility profile — same pattern as privacy. */}
                <details className="dev-menu-config-row">
                  <summary className="dev-menu-config-summary">
                    <span className="dev-menu-config-label">
                      {tDev("config_a11y_profile")}
                    </span>
                    <span
                      className={`dev-menu-config-value${
                        profiles.accessibilityEnabled ? "is-on" : ""
                      }`}
                    >
                      {profiles.accessibilityEnabled === null
                        ? "…"
                        : profiles.accessibilityEnabled
                          ? tDev("value_on")
                          : tDev("value_off")}
                    </span>
                  </summary>
                  <p className="dev-menu-config-hint">
                    {tDev("a11y_profile_hint")}
                  </p>
                  <div className="dev-menu-config-actions">
                    <button
                      aria-checked={!!profiles.accessibilityEnabled}
                      className={`switch-toggle${profiles.accessibilityEnabled ? " is-on" : ""}`}
                      disabled={
                        profiles.accessibilityEnabled === null ||
                        profileBusy === "accessibility"
                      }
                      onClick={() => toggleProfile("accessibility")}
                      role="switch"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="switch-toggle-thumb"
                      />
                    </button>
                    <Link
                      className="dev-menu-config-link"
                      href="/dashboard/settings#accessibility-profile"
                      onClick={() => setOpen(false)}
                    >
                      {tDev("edit_in_settings")}
                    </Link>
                  </div>
                </details>
              </div>

              {/* Destructive cluster — each button requires a second
                  click within ~6s to fire. Stacked so the three
                  buttons line up cleanly under the "Reset" label
                  without the label being squeezed down to a few
                  characters by three side-by-side confirm buttons. */}
              <div className="dev-menu-quick-row dev-menu-quick-row-stack dev-menu-quick-row-destructive">
                <span className="dev-menu-quick-label">
                  {tDev("label_reset")}
                  <span className="dev-menu-quick-sublabel">
                    {tDev("confirm_hint")}
                  </span>
                </span>
                <div
                  aria-label={tDev("destructive_resets_aria")}
                  className="dev-menu-pill-group"
                  role="group"
                >
                  <ConfirmButton
                    action="wipe-apps"
                    busy={actionBusy === "wipe-apps"}
                    confirming={confirming === "wipe-apps"}
                    confirmLabel={tDev("wipe_apps_confirm")}
                    label={tDev("wipe_apps")}
                    onArm={() => armConfirm("wipe-apps")}
                    onConfirm={wipeApps}
                    workingLabel={tDev("btn_working")}
                  />
                  <ConfirmButton
                    action="reset-changelog"
                    busy={actionBusy === "reset-changelog"}
                    confirming={confirming === "reset-changelog"}
                    confirmLabel={tDev("confirm")}
                    label={tDev("reset_changelog")}
                    onArm={() => armConfirm("reset-changelog")}
                    onConfirm={resetChangelog}
                    workingLabel={tDev("btn_working")}
                  />
                  <ConfirmButton
                    action="delete-shortlists"
                    busy={actionBusy === "delete-shortlists"}
                    confirming={confirming === "delete-shortlists"}
                    confirmLabel={tDev("confirm")}
                    label={tDev("delete_shortlists")}
                    onArm={() => armConfirm("delete-shortlists")}
                    onConfirm={deleteShortlists}
                    workingLabel={tDev("btn_working")}
                  />
                </div>
              </div>

              {actionToast && (
                <div
                  aria-live="polite"
                  className="dev-menu-action-toast"
                  role="status"
                >
                  {actionToast}
                </div>
              )}
            </section>

            {/* ── Feature flags ─────────────────────────────────────── */}
            <section
              aria-label={tDev("feature_flags_aria")}
              className="dev-menu-flags-section"
            >
              <div className="dev-menu-section-heading">
                {tDev("section_feature_flags")}
              </div>
              {loading && !rows && (
                <div className="dev-menu-empty">
                  <span aria-hidden="true" className="spinner-sm" />{" "}
                  {tDev("loading_flags")}
                </div>
              )}
              {error && !rows && (
                <div className="dev-menu-error" role="alert">
                  {error}
                </div>
              )}
              {rows && (
                <>
                  <FlagsSection
                    emptyHint={
                      primarySurfaces.length > 0
                        ? tDev("no_flags_for_surface")
                        : tDev("no_surface_mapping")
                    }
                    highlight
                    onCloseMenu={closeMenu}
                    onSelectKey={setSelectedFlagKey}
                    onSetOverride={setOverride}
                    rows={grouped.primary}
                    selectedKey={selectedFlagKey}
                    title={
                      primarySurfaces.length > 0
                        ? tDev("on_this_page_with_label", {
                            label: primaryLabel,
                          })
                        : tDev("on_this_page")
                    }
                  />
                  <FlagsSection
                    collapsedByDefault
                    emptyHint={null}
                    highlight={false}
                    onCloseMenu={closeMenu}
                    onSelectKey={setSelectedFlagKey}
                    onSetOverride={setOverride}
                    rows={grouped.chrome}
                    selectedKey={selectedFlagKey}
                    title={tDev("global_chrome_title")}
                  />
                  {grouped.other.length > 0 && (
                    <FlagsSection
                      collapsedByDefault
                      emptyHint={null}
                      highlight={false}
                      onCloseMenu={closeMenu}
                      onSelectKey={setSelectedFlagKey}
                      onSetOverride={setOverride}
                      rows={grouped.other}
                      selectedKey={selectedFlagKey}
                      title={tDev("other_surfaces_title")}
                    />
                  )}
                </>
              )}
            </section>
          </div>

          <div className="dev-menu-popover-footer">
            <Link
              className="dev-menu-deep-link"
              href="/dashboard/settings#developer"
              onClick={() => setOpen(false)}
            >
              {tDev("open_full_panel")}
            </Link>
            {/* Diagnostics dashboard — live runtime metrics (event-loop
                lag, V8 heap usage, slow-query log, page-fault counts)
                that the Settings panel doesn't surface. Useful when
                investigating a slow / unresponsive Tauri sidecar
                without attaching a profiler. Plain Link rather than a
                deep-link into Settings because it's a self-contained
                page, not a Settings section. */}
            <Link
              className="dev-menu-deep-link"
              href="/dashboard/diagnostics"
              onClick={() => setOpen(false)}
              title={tDiagLink("title")}
            >
              ⏱ {tDiagLink("label")}
            </Link>
            {/* Quick-export entry. Drops the current override set onto
                the clipboard in the same JSON shape the bulk-import
                POST accepts, so devs can paste it into the Focus ×
                Flags matrix or a shared doc in one click. Disabled
                while the flag list is still loading or has no
                overrides — the helper itself flashes a toast in those
                states, but disabling the button avoids a wasted click.
                The {n} count next to "Export overrides" gives a hint
                that something's actually been authored. */}
            <button
              className="dev-menu-deep-link"
              disabled={!rows}
              onClick={exportOverridesJson}
              style={{
                background: "transparent",
                border: 0,
                padding: 0,
                cursor: rows ? "pointer" : "not-allowed",
                font: "inherit",
                color: "inherit",
              }}
              title={tDev("export_overrides_title")}
              type="button"
            >
              {tDev("export_overrides")}
              {rows?.some((r) => r.override !== null) && (
                <span
                  aria-hidden="true"
                  style={{
                    marginLeft: 4,
                    padding: "0 5px",
                    fontSize: 10,
                    background: "rgba(99, 102, 241, 0.18)",
                    borderRadius: 999,
                  }}
                >
                  {rows.filter((r) => r.override !== null).length}
                </span>
              )}{" "}
              ⧉
            </button>
            <span className="dev-menu-footer-hint">
              {tDev("press_word")} <kbd className="kbd">g</kbd>{" "}
              {tDev("then_word")} <kbd className="kbd">f</kbd>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Build a compact goal summary for the focus toast — "Understand · Declutter"
 * etc. Empty string when no goals are set so the calling format string can
 * skip the separator entirely. Translator-typed first arg keeps the helper
 * locale-aware without becoming React-aware.
 */
type DevT = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;
function describeGoalsForToast(t: DevT, focus: FocusInfo): string {
  const parts: string[] = [];
  if (focus.minimal) {
    parts.push(t("goal_minimal"));
  }
  if (focus.understand) {
    parts.push(t("goal_understand"));
  }
  if (focus.declutter) {
    parts.push(t("goal_declutter"));
  }
  if (focus.accessibility) {
    parts.push(t("goal_accessibility"));
  }
  return parts.join(" · ");
}

/**
 * Goal summary for the closed-state Goals accordion. Identical to
 * `describeGoalsForToast` except it falls back to "—" when no goals
 * are set so the value column never reads as empty.
 */
function summariseGoals(t: DevT, focus: FocusInfo): string {
  const summary = describeGoalsForToast(t, focus);
  return summary || t("dash");
}

/** Two-step confirm button shared across destructive quick actions. */
function ConfirmButton({
  label,
  confirmLabel,
  workingLabel,
  busy,
  confirming,
  onArm,
  onConfirm,
}: {
  action: string;
  label: string;
  confirmLabel: string;
  workingLabel: string;
  busy: boolean;
  confirming: boolean;
  onArm: () => void;
  onConfirm: () => void;
}) {
  return (
    <button
      className={`dev-menu-action-btn dev-menu-action-btn-danger${
        confirming ? "is-confirming" : ""
      }`}
      disabled={busy}
      onClick={confirming ? onConfirm : onArm}
      type="button"
    >
      {busy ? workingLabel : confirming ? confirmLabel : label}
    </button>
  );
}

function FlagsSection({
  title,
  rows,
  emptyHint,
  highlight,
  onSetOverride,
  selectedKey,
  onSelectKey,
  onCloseMenu,
  collapsedByDefault = false,
}: {
  title: string;
  rows: FlagRow[];
  emptyHint: string | null;
  highlight: boolean;
  onSetOverride: (key: string, value: FlagValue | null) => void | Promise<void>;
  /** Single-selection key (lifted from DevMenu so only one row at a time is selected). */
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
  /** Closes the popover after a "Show me where" navigation. */
  onCloseMenu: () => void;
  collapsedByDefault?: boolean;
}) {
  return (
    <details
      className={`dev-menu-section${highlight ? " is-highlighted" : ""}`}
      open={!collapsedByDefault}
    >
      <summary className="dev-menu-section-summary">
        <span>{title}</span>
        <span className="dev-menu-section-count">{rows.length}</span>
      </summary>
      {rows.length === 0 ? (
        emptyHint && <div className="dev-menu-section-empty">{emptyHint}</div>
      ) : (
        <ul className="dev-menu-list">
          {rows.map((row) => (
            <DevFlagRow
              isSelected={selectedKey === row.key}
              key={row.key}
              onCloseMenu={onCloseMenu}
              onSelect={() =>
                onSelectKey(selectedKey === row.key ? null : row.key)
              }
              onSetOverride={onSetOverride}
              row={row}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

function DevFlagRow({
  row,
  onSetOverride,
  isSelected,
  onSelect,
  onCloseMenu,
}: {
  row: FlagRow;
  onSetOverride: (key: string, value: FlagValue | null) => void | Promise<void>;
  isSelected: boolean;
  onSelect: () => void;
  onCloseMenu: () => void;
}) {
  const tDev = useTranslations("dev_menu_panel");
  const isOverridden = row.override !== null;
  // Where-used metadata for the inline preview. Looks the same as the
  // dev panel popover, just sized for the cramped DevMenu layout. Null
  // means "not in the curated registry" — the row still renders, the
  // preview just doesn't.
  const usage = getFlagUsage(row.key);
  // Hover-only preview state so users can peek without committing to a
  // selection. Mouse-out / blur dismisses it.
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false);
  // The preview is shown when the row is selected (sticky) OR when
  // hovering (transient). Both pull the same content.
  const showPreview = !!usage && (isSelected || hoverPreviewOpen);

  return (
    <li
      className={
        "dev-menu-row" +
        (isOverridden ? " is-overridden" : "") +
        (isSelected ? " is-selected" : "")
      }
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHoverPreviewOpen(false);
        }
      }}
      onFocusCapture={() => usage && setHoverPreviewOpen(true)}
      onMouseEnter={() => usage && setHoverPreviewOpen(true)}
      onMouseLeave={() => setHoverPreviewOpen(false)}
    >
      {/*
        Click target for selecting the row. Clicking the key area
        toggles the selection (purple ring + sticky inline preview).
        Toggle picker buttons stay unaffected — they have their own
        handlers below this button. Reuses `.dev-menu-row-meta` so the
        existing CSS (flex row, key + tags layout) keeps working
        unchanged; `dev-menu-row-select` adds button-reset styles.
      */}
      <button
        aria-pressed={isSelected}
        className="dev-menu-row-meta dev-menu-row-select"
        onClick={onSelect}
        title={
          isSelected ? tDev("click_to_deselect") : tDev("click_to_highlight")
        }
        type="button"
      >
        <code className="dev-menu-row-key" title={row.key}>
          {row.key}
        </code>
        <span className="dev-menu-row-tags">
          {!row.wired && (
            <span
              className="dev-menu-row-tag"
              title={tDev("no_component_reads")}
            >
              {tDev("tag_no_effect")}
            </span>
          )}
          {isOverridden && (
            <span className="dev-menu-row-tag dev-menu-row-tag-override">
              {tDev("tag_override")}
            </span>
          )}
        </span>
      </button>
      <div
        aria-label={tDev("set_key_aria", { key: row.key })}
        className="dev-menu-row-picker"
        role="group"
      >
        <button
          aria-pressed={row.override === null}
          className={`dev-menu-pick${row.override === null ? " is-active" : ""}`}
          onClick={() => row.override !== null && onSetOverride(row.key, null)}
          title={tDev("pick_default_title", { default: row.hardDefault })}
          type="button"
        >
          {tDev("pick_default")}
        </button>
        {VALUE_OPTIONS.map((value) => {
          const active = row.override === value;
          return (
            <button
              aria-pressed={active}
              className={`dev-menu-pick dev-menu-pick-${value}${active ? " is-active" : ""}`}
              key={value}
              onClick={() => !active && onSetOverride(row.key, value)}
              title={tDev("pick_value_title", { value })}
              type="button"
            >
              {value}
            </button>
          );
        })}
      </div>

      {/*
        Inline preview — sits below the row chrome rather than as a
        floating popover, because DevMenu's body is already scrollable
        and a floating element would clip against the popover edges.
        Mirrors the structure of the dev-panel preview (hint + files +
        "Show me where" link) with tighter spacing for the cramped
        sidebar layout.
      */}
      {showPreview && usage && (
        <div className="dev-menu-row-preview" role="tooltip">
          <p className="dev-menu-row-preview-hint">{usage.hint}</p>
          {usage.files.length > 0 && (
            <ul className="dev-menu-row-preview-files">
              {usage.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          )}
          {usage.route && (
            <Link
              className="dev-menu-row-preview-link"
              href={{
                pathname: usage.route,
                query: { "flag-highlight": usage.target ?? row.key },
              }}
              onClick={onCloseMenu}
            >
              {tDev("show_me_where")}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
