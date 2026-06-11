"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  localiseBadgeDescription,
  localiseBadgeLabel,
} from "../../lib/i18n-meta";
import type {
  ManualApp,
  ManualAppSource,
  ManualAppSourceMeta,
} from "../../lib/manual-apps";
import type { AppProfileBadge } from "../../lib/privacy-profile";
import type { QueueAppInput } from "../../lib/review-queue";
import BulkSelectBar from "./BulkSelectBar";
import PrivacyTypeIcon from "./PrivacyTypeIcon";
import ReviewQueue from "./ReviewQueue";
import { useTaskCenter } from "./TaskCenter";
import VerdictPill from "./VerdictPill";

interface App {
  /** Count of declared accessibility features. Server-side derived. */
  accessibilityCount?: number;
  categoryCount: number;
  changeCount: number;
  developer?: string;
  /**
   * `1`  — Apple's accessibility shelf lists ≥1 feature for this app.
   * `0`  — shelf present but empty (developer filed nothing).
   * `null` — shelf absent / app never scraped since the accessibility
   *        scraper shipped. Grid filter treats `null` as unknown and
   *        excludes such apps from both "has" and "missing" buckets.
   */
  hasAccessibilityLabels?: number | null;
  /**
   * `0`  — developer explicitly hasn't filled in privacy labels (Apple shows
   *        "No details provided" copy on the listing).
   * `1`  — labels are present.
   * `null` — indeterminate / pre-migration row (treated as `1`).
   */
  hasPrivacyDetails?: number | null;
  iconUrl?: string;
  id: string;
  lastSynced: number;
  linkedCount?: number;
  name: string;
  syncCount: number;
  trackCount?: number;
  unlinkedCount?: number;
  url: string;
}

type SortKey = "name" | "synced" | "permissions" | "risk";

// 'unknown' is a pseudo-level for apps where the developer hasn't filled in
// any privacy labels yet. It's not a real severity — we just can't tell — so
// it renders yellow ("attention") rather than in the red/orange/blue ramp.
type RiskLevel = "high" | "moderate" | "low" | "minimal" | "unknown";

function computeRiskScore(app: App): number {
  // Weights: tracking carries the highest user-impact cost, linked data second,
  // unlinked data is a minor signal.
  const t = app.trackCount ?? 0;
  const l = app.linkedCount ?? 0;
  const u = app.unlinkedCount ?? 0;
  return t * 10 + l * 3 + u * 1;
}

function computeRiskLevel(app: App): RiskLevel {
  // "No details provided" takes precedence over the count-based buckets —
  // zero counts from a missing-labels app are not the same as a real Minimal
  // app that explicitly collects nothing. Return 'unknown' so the UI can
  // surface it as a separate (yellow) attention state.
  if (app.hasPrivacyDetails === 0) {
    return "unknown";
  }
  const t = app.trackCount ?? 0;
  const l = app.linkedCount ?? 0;
  const u = app.unlinkedCount ?? 0;
  if (t >= 1) {
    return "high";
  }
  if (l >= 3) {
    return "moderate";
  }
  if (l >= 1 || u >= 1) {
    return "low";
  }
  return "minimal";
}

const RISK_META: Record<
  RiskLevel,
  { label: string; cls: string; dot: string }
> = {
  high: { label: "High risk", cls: "risk-pill-high", dot: "●" },
  moderate: { label: "Moderate risk", cls: "risk-pill-moderate", dot: "●" },
  low: { label: "Low risk", cls: "risk-pill-low", dot: "●" },
  minimal: { label: "Minimal", cls: "risk-pill-minimal", dot: "○" },
  unknown: { label: "No details", cls: "risk-pill-unknown", dot: "⚠" },
};

function parseRiskParam(raw: string | null): RiskLevel | null {
  if (
    raw === "high" ||
    raw === "moderate" ||
    raw === "low" ||
    raw === "minimal" ||
    raw === "unknown"
  ) {
    return raw;
  }
  return null;
}

/**
 * Three-way accessibility filter.
 *   'has'     — only apps with declared accessibility features
 *   'missing' — only apps with an empty accessibility shelf (Apple showed
 *               it, developer filed nothing). Excludes `null` rows so
 *               pre-migration apps don't pollute the "missing" bucket.
 *   null      — no filter
 */
type AccessibilityFilter = "has" | "missing";

function parseAccessibilityParam(
  raw: string | null
): AccessibilityFilter | null {
  if (raw === "has" || raw === "missing") {
    return raw;
  }
  return null;
}

/**
 * Minimal device shape used by the AppGrid dropdown. Matches the
 * subset of `Device` (lib/devices.ts) the client actually reads —
 * avoids dragging better-sqlite3 type imports into a client bundle.
 */
export interface AppGridDevice {
  id: string;
  isUnknownPlaceholder?: boolean;
  name: string;
}

/** Validate a `?device=<id>` URL param against the supplied list. */
function parseDeviceParam(
  raw: string | null,
  devices: readonly AppGridDevice[]
): string | null {
  if (!raw) {
    return null;
  }
  return devices.some((d) => d.id === raw) ? raw : null;
}

interface AppGridProps {
  /**
   * `appId → deviceId[]` lookup. Apps with no junction-table rows are
   * absent from the map; the filter renders them as "Unattached" so a
   * dropdown that scopes to a specific device hides them. The server
   * always builds this from the `app_devices` junction (lib/devices.ts).
   */
  appDeviceMap?: Record<string, string[]>;
  /** Active audience — drives review-queue guardian variant + copy. */
  audience?: "self" | "loved_one" | "guardian";
  /**
   * Devices the user has connected — drives the device-scope dropdown.
   * Sorted by recency in the server query so the most-recently-synced
   * device sits at the top of the menu. Empty array hides the filter.
   */
  devices?: AppGridDevice[];
  /**
   * Resolved flags for this surface (round 3 wave E). Optional — when not
   * passed, all surfaces default to visible (legacy behaviour).
   */
  flags?: AppGridFlagState;
  /** Whether the user has a privacy profile set (controls mismatch UI). */
  hasProfile?: boolean;
  initialApps: App[];
  /**
   * User-authored "custom" apps (web clips, TestFlight, sideloaded, personal
   * builds). Optional so existing call-sites that haven't been updated still
   * type-check — when omitted, the grid renders exactly as before.
   */
  initialManualApps?: ManualApp[];
  manualSources?: ManualAppSourceMeta[];
  /**
   * Per-app breakdown of which change categories (privacy-label,
   * accessibility, privacy-policy) are currently pending acknowledgement.
   * Drives the colour of the pulsing change-dot on each card: orange for
   * privacy, blue for accessibility, both when mixed. Apps without pending
   * changes are absent from the map — the card falls back to the legacy
   * single orange dot driven by `app.changeCount > 0`.
   */
  pendingChangeCategoriesByApp?: Record<
    string,
    { privacy: boolean; accessibility: boolean; policy: boolean }
  >;
  /**
   * Per-app badge data keyed by `App.id`. Keys are only present when the user
   * has an active privacy profile AND we've computed a comparison for that
   * app. When this map is empty (no profile set, or DB not ready) the card
   * renders without a badge — mirroring the original behaviour pre-profile.
   */
  profileBadges?: Record<string, AppProfileBadge>;
  /**
   * Server-hydrated value of the `track_accessibility_labels` setting. When
   * false, the accessibility filter row is hidden entirely and any existing
   * `?access=…` query param is ignored — matching how the chip / tab are
   * suppressed on the detail page. Defaults to `true` so the filter is
   * visible for users on installs that predate the setting.
   */
  showAccessibilityFilter?: boolean;
  /** Show the progress bar in the queue running header. */
  showQueueProgressBar?: boolean;
  /**
   * Local user's verdict per app — `appId` → `'safe' | 'replace' | 'uninstall'`.
   * Drives the verdict pill on each card. Apps the user hasn't decided on
   * are absent from the map (treated as "undecided"). Imported
   * recommendations don't appear here — they live on the detail page
   * picker so they read as advice, not as the user's own decision.
   */
  userVerdicts?: Record<string, import("../../lib/verdict-types").VerdictValue>;
}

export interface AppGridFlagState {
  actionsAddApps: boolean;
  actionsCompareMode: boolean;
  actionsCustomAppsNav: boolean;
  actionsSyncAll: boolean;
  actionsSyncFiltered: boolean;
  cardAnnotationHighlight: boolean;
  cardChangeDot: boolean;
  cardDeleteButton: boolean;
  cardFreshnessChip: boolean;
  cardProfileBadge: boolean;
  cardResyncButton: boolean;
  cardRiskChips: boolean;
  cardRiskPill: boolean;
  cardVerdictPill: boolean;
  emptyState: boolean;
  filterAccessibility: boolean;
  filterActiveBanners: boolean;
  /** Device-scope dropdown (hidden when fewer than 2 devices). */
  filterDevice: boolean;
  filterProfileMismatch: boolean;
  filterRiskButtons: boolean;
  filterSearch: boolean;
  filterSortTabs: boolean;
  reviewQueueBulkSelect: boolean;
  reviewQueueCfgutilUninstall: boolean;
  reviewQueueEnabled: boolean;
}

export default function AppGrid({
  initialApps,
  initialManualApps = [],
  manualSources = [],
  profileBadges = {},
  userVerdicts = {},
  showAccessibilityFilter = true,
  pendingChangeCategoriesByApp = {},
  flags,
  audience = "self",
  hasProfile = false,
  showQueueProgressBar = true,
  devices = [],
  appDeviceMap = {},
}: AppGridProps) {
  // i18n — first wave covers page title, filter/sort chrome (placeholder,
  // aria-labels, clear-filter buttons, "All risks" pseudo-option),
  // accessibility-filter chips, and the compare/delete-modal aria.
  //
  // Pass 2 adds risk-pill labels + descriptions (`risk.*`) so the per-card
  // severity badge ("High risk", "Moderate risk", …) localises and the
  // filter-button tooltips line up with the active locale. The remaining
  // per-row card-body copy (developer chip, last-changed relative
  // timestamps) is still English; tracked under the broader sweep.
  const tGrid = useTranslations("app_grid");
  const tBadge = useTranslations("profile_badge");
  const tRisk = useTranslations("risk");
  // Manual-source short labels (Web app / TestFlight / Personal /
  // Sideloaded) for the small badge on manual-app cards.
  const tSource = useTranslations("manual_app_source");

  // Resolve effective flags with legacy "all-on" defaults so callers that
  // haven't been wired yet still render exactly as before.
  const f: AppGridFlagState = {
    filterSearch: flags?.filterSearch ?? true,
    filterSortTabs: flags?.filterSortTabs ?? true,
    filterRiskButtons: flags?.filterRiskButtons ?? true,
    filterProfileMismatch: flags?.filterProfileMismatch ?? true,
    filterAccessibility: flags?.filterAccessibility ?? true,
    filterDevice: flags?.filterDevice ?? true,
    filterActiveBanners: flags?.filterActiveBanners ?? true,
    actionsSyncFiltered: flags?.actionsSyncFiltered ?? true,
    actionsSyncAll: flags?.actionsSyncAll ?? true,
    actionsCompareMode: flags?.actionsCompareMode ?? true,
    actionsCustomAppsNav: flags?.actionsCustomAppsNav ?? true,
    actionsAddApps: flags?.actionsAddApps ?? true,
    cardChangeDot: flags?.cardChangeDot ?? true,
    cardProfileBadge: flags?.cardProfileBadge ?? true,
    cardFreshnessChip: flags?.cardFreshnessChip ?? true,
    cardRiskPill: flags?.cardRiskPill ?? true,
    cardRiskChips: flags?.cardRiskChips ?? true,
    cardResyncButton: flags?.cardResyncButton ?? true,
    cardDeleteButton: flags?.cardDeleteButton ?? true,
    cardAnnotationHighlight: flags?.cardAnnotationHighlight ?? true,
    cardVerdictPill: flags?.cardVerdictPill ?? true,
    emptyState: flags?.emptyState ?? true,
    reviewQueueEnabled: flags?.reviewQueueEnabled ?? true,
    reviewQueueBulkSelect: flags?.reviewQueueBulkSelect ?? true,
    reviewQueueCfgutilUninstall: flags?.reviewQueueCfgutilUninstall ?? false,
  };

  const [apps, setApps] = useState<App[]>(initialApps);
  const [manualApps, setManualApps] = useState<ManualApp[]>(initialManualApps);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncingAll, setSyncingAll] = useState(false);
  const [deletingManualId, setDeletingManualId] = useState<string | null>(null);
  const taskCenter = useTaskCenter();

  // O(1) lookup for a source's metadata (icon, short label, etc.) when
  // rendering each custom card. Falls back to the built-in 'sideloaded'
  // icon if a source slips through that we don't know about — mirrors the
  // hydrate() fallback on the server.
  const manualSourceMeta = useMemo(() => {
    const map = new Map<ManualAppSource, ManualAppSourceMeta>();
    for (const meta of manualSources) {
      map.set(meta.value, meta);
    }
    return map;
  }, [manualSources]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const riskFilter = useMemo(
    () => parseRiskParam(searchParams?.get("risk") ?? null),
    [searchParams]
  );
  // URL-backed "only show apps that break my privacy profile" toggle. Same
  // deep-link pattern as `?risk=…` so a user can bookmark "show me the
  // problem apps". Absent / "0" / anything else → false.
  const mismatchOnly = useMemo(
    () => searchParams?.get("mismatch") === "1",
    [searchParams]
  );
  // URL-backed accessibility filter. `?access=has` shows apps declaring at
  // least one accessibility feature; `?access=missing` shows apps where the
  // shelf is empty. Ignored when the feature toggle is off — the setting
  // takes precedence over the URL so a user who turned the feature off in
  // Settings doesn't land on a grid pre-filtered by it.
  const accessibilityFilter = useMemo<AccessibilityFilter | null>(() => {
    if (!showAccessibilityFilter) {
      return null;
    }
    return parseAccessibilityParam(searchParams?.get("access") ?? null);
  }, [searchParams, showAccessibilityFilter]);
  // URL-backed device-scope filter. Validates against the supplied device
  // list so a stale bookmark to a deleted device falls back to "all".
  // Also accepts the sentinel `'unattached'` for apps with no device
  // links (legacy manual entries, pre-junction installs) so users can
  // surface or hide those specifically.
  const deviceFilter = useMemo<string | null>(() => {
    const raw = searchParams?.get("device") ?? null;
    if (raw === "unattached") {
      return "unattached";
    }
    return parseDeviceParam(raw, devices);
  }, [searchParams, devices]);
  // URL-backed sort order. Matches the `?risk=` / `?mismatch=` pattern so
  // navigating into an app and using browser back restores the user's
  // chosen sort instead of snapping to the default. Unknown / missing
  // values fall back to 'risk'.
  const sort: SortKey = useMemo(() => {
    const raw = searchParams?.get("sort") ?? null;
    if (
      raw === "name" ||
      raw === "synced" ||
      raw === "permissions" ||
      raw === "risk"
    ) {
      return raw;
    }
    return "risk";
  }, [searchParams]);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState("");

  // ── Multi-select for side-by-side compare ────────────────────────────
  //
  // Hold Shift/Cmd/Ctrl while clicking a card to toggle it in/out of the
  // compare selection. The "Compare" button in the header also flips a
  // persistent compareMode where regular taps toggle selection too — that
  // path is the touch-friendly fallback for users without modifier keys.
  //
  // `COMPARE_MAX` caps the selection at two because CompareAppsView is a
  // two-slot view (App A vs. App B). We still let the user SELECT three in
  // the UI because `?a=…&b=…` only accepts two — if the user goes beyond we
  // just enforce the cap silently (toggle-off the oldest, or refuse).
  const COMPARE_MAX = 2;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareMode, setCompareMode] = useState(false);

  // ── Review-queue + bulk-select mode ──────────────────────────────────
  //
  // `pageMode` switches the grid between three top-level interactions:
  //   - 'grid'   — normal browsing (default)
  //   - 'select' — bulk-mark mode with checkboxes; bulk toolbar visible
  // Queue mode is a separate full-screen takeover toggled via
  // `queueOpen` so it can co-exist with whatever pageMode is current.
  // Compare mode and Select mode are mutually exclusive — entering one
  // exits the other to keep card-click semantics unambiguous.
  const [pageMode, setPageMode] = useState<"grid" | "select">("grid");
  const [queueOpen, setQueueOpen] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  // Snapshot of verdicts at the moment Select mode was entered — drives
  // the per-app rollback set surfaced by the BulkSelectBar's Undo toast.
  const [bulkPrevVerdicts, setBulkPrevVerdicts] = useState<
    Record<string, import("../../lib/verdict-types").VerdictValue>
  >({});

  const enterSelectMode = useCallback(() => {
    setPageMode("select");
    setCompareMode(false);
    setSelectedIds([]);
    setBulkSelectedIds([]);
    setBulkPrevVerdicts({ ...userVerdicts });
  }, [userVerdicts]);

  const exitSelectMode = useCallback(() => {
    setPageMode("grid");
    setBulkSelectedIds([]);
  }, []);

  const toggleBulkSelection = useCallback((appId: string) => {
    setBulkSelectedIds((prev) =>
      prev.includes(appId)
        ? prev.filter((id) => id !== appId)
        : [...prev, appId]
    );
  }, []);

  const setRiskLevel = useCallback(
    (next: RiskLevel | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next) {
        params.set("risk", next);
      } else {
        params.delete("risk");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const clearRiskFilter = useCallback(() => setRiskLevel(null), [setRiskLevel]);

  // URL writer for the sort selector. Mirrors `setRiskLevel` so the sort
  // tabs write `?sort=...` (or remove it for the default 'risk' to keep
  // URLs clean) via router.replace without a full navigation.
  const setSort = useCallback(
    (next: SortKey) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "risk") {
        params.delete("sort");
      } else {
        params.set("sort", next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const setMismatchOnly = useCallback(
    (next: boolean) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next) {
        params.set("mismatch", "1");
      } else {
        params.delete("mismatch");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // URL writer for the accessibility filter pills. Passing `null` clears
  // the param so the URL stays clean when the filter is off, mirroring the
  // setRiskLevel / setSort behaviour.
  const setAccessibilityFilter = useCallback(
    (next: AccessibilityFilter | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next) {
        params.set("access", next);
      } else {
        params.delete("access");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  /** URL writer for the device-scope dropdown. Accepts a device id, the
   *  string `'unattached'` (apps with no junction rows), or null to clear. */
  const setDeviceFilter = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next) {
        params.set("device", next);
      } else {
        params.delete("device");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // Whether the user has an active privacy profile (i.e. we received any
  // badge data from the server). Drives visibility of the mismatch filter —
  // there's nothing to filter by until a profile exists.
  const hasProfileBadges = useMemo(
    () => Object.keys(profileBadges).length > 0,
    [profileBadges]
  );
  // Tally of apps with at least one category above the user's tolerance.
  // When this is 0 the toggle is hidden entirely — filtering to an empty
  // set from a clean profile state would only ever produce the "all clear"
  // empty state.
  const mismatchCount = useMemo(
    () =>
      apps.reduce(
        (n, a) => ((profileBadges[a.id]?.count ?? 0) > 0 ? n + 1 : n),
        0
      ),
    [apps, profileBadges]
  );

  // Subset the risk-filter tabs count against. The tabs ARE the risk filter,
  // so we deliberately don't apply `riskFilter` here — a tab shows "how many
  // apps would be visible if I clicked this" given every OTHER filter already
  // in effect (text search + profile mismatches). Without this, clicking the
  // "Profile mismatches" toggle left "High risk (12)" showing even when only
  // 3 of those 12 broke the profile, which the user rightly flagged as
  // confusing.
  const prefilteredApps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return apps.filter((a) => {
      if (q) {
        const matches =
          a.name.toLowerCase().includes(q) ||
          (a.developer ? a.developer.toLowerCase().includes(q) : false);
        if (!matches) {
          return false;
        }
      }
      if (mismatchOnly && (profileBadges[a.id]?.count ?? 0) === 0) {
        return false;
      }
      if (deviceFilter) {
        const linkedDevices = appDeviceMap[a.id] ?? [];
        if (deviceFilter === "unattached") {
          if (linkedDevices.length > 0) {
            return false;
          }
        } else if (!linkedDevices.includes(deviceFilter)) {
          return false;
        }
      }
      return true;
    });
  }, [apps, filter, mismatchOnly, profileBadges, deviceFilter, appDeviceMap]);

  // Per-device counts for the dropdown labels. Counting against the full
  // `apps` list (not `prefilteredApps`) so the menu reflects the underlying
  // device totals rather than what's currently filtered — same model as
  // the risk-tab counts.
  const deviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let unattached = 0;
    for (const a of apps) {
      const links = appDeviceMap[a.id] ?? [];
      if (links.length === 0) {
        unattached += 1;
      } else {
        for (const id of links) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    }
    return { perDevice: counts, unattached };
  }, [apps, appDeviceMap]);

  // Show the dropdown whenever there's at least one device row. We
  // previously hid it for single-device users on the theory "a one-item
  // dropdown is noise" — but in practice users who recently imported
  // expected to see *which* device the grid was showing, and the silent
  // hide made them think the feature was broken. The cost of an always-
  // present menu is one extra row in the toolbar; cheap.
  const showDeviceFilter = useMemo(() => {
    if (!f.filterDevice) {
      return false;
    }
    const knownDeviceCount = devices.length;
    const hasUnattached = deviceCounts.unattached > 0;
    return knownDeviceCount + (hasUnattached ? 1 : 0) >= 1;
  }, [f.filterDevice, devices, deviceCounts]);

  // Per-level counts against the prefiltered subset — drives the badge on
  // each risk-filter tab.
  const riskLevelCounts = useMemo(() => {
    const counts: Record<RiskLevel, number> = {
      high: 0,
      moderate: 0,
      low: 0,
      minimal: 0,
      unknown: 0,
    };
    for (const app of prefilteredApps) {
      counts[computeRiskLevel(app)]++;
    }
    return counts;
  }, [prefilteredApps]);
  const [pendingDelete, setPendingDelete] = useState<App | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * Confirm-modal state for the custom-app (ManualApp) delete flow.
   * Shares the `.modal-overlay` / `.modal-card` chrome with the tracked-
   * app delete dialog so the UX is consistent. We can't reuse
   * `pendingDelete` directly because that state's typed as `App` and
   * ManualApps go through their own DELETE endpoint.
   */
  const [pendingDeleteManual, setPendingDeleteManual] =
    useState<ManualApp | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const refreshApps = useCallback(async () => {
    const res = await fetch("/api/apps");
    setApps(await res.json());
  }, []);

  const syncApp = async (appId: string, appUrl: string) => {
    setSyncingIds((prev) => new Set([...prev, appId]));
    const appName =
      apps.find((a) => a.id === appId)?.name ?? tGrid("fallback_app_name");
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: tGrid("task_resync_title", { name: appName }),
      subtitle: tGrid("task_resync_subtitle"),
      kind: "scrape",
      href: `/apps/${appId}`,
      onCancel: () => controller.abort(),
    });
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [appUrl],
          resync: true,
          summarizePolicies: false,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      const result = data.results?.[0];
      if (result?.changesDetected) {
        showToast(tGrid("toast_changes_detected", { name: appName }));
        handle.complete(
          "done",
          tGrid("task_done_changes", { count: result.changeCount })
        );
      } else if (result?.versionChanged && result.currentVersion) {
        showToast(
          tGrid("toast_version_updated", {
            name: appName,
            version: result.currentVersion,
          })
        );
        handle.complete(
          "done",
          tGrid("task_done_version_updated", {
            version: result.currentVersion,
          })
        );
      } else {
        showToast(tGrid("toast_app_up_to_date"));
        handle.complete("done", tGrid("task_done_no_changes"));
      }
      await refreshApps();
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        console.error(`[apps] Re-sync failed for ${appName} (${appId}):`, err);
        showToast(tGrid("toast_sync_failed"));
        handle.complete(
          "error",
          (err as Error)?.message ?? tGrid("task_error_sync_failed")
        );
      }
    } finally {
      setSyncingIds((prev) => {
        const s = new Set(prev);
        s.delete(appId);
        return s;
      });
    }
  };

  const syncAppList = async (
    appList: App[],
    { scope }: { scope: "all" | "filtered" }
  ) => {
    if (appList.length === 0) {
      return;
    }
    setSyncingAll(true);
    const total = appList.length;
    const controller = new AbortController();
    const title =
      scope === "all"
        ? tGrid("task_sync_all_title")
        : tGrid("task_sync_filtered_title");
    const successMsg =
      scope === "all"
        ? tGrid("toast_all_synced")
        : tGrid("toast_n_synced", { count: total });
    const handle = taskCenter.startTask({
      title,
      subtitle: tGrid("task_sync_subtitle_count", { count: total }),
      kind: "sync",
      href: "/dashboard",
      onCancel: () => controller.abort(),
      progress: {
        current: 0,
        total,
        label: tGrid("task_progress_label", { current: 0, total }),
      },
    });
    try {
      await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: appList.map((a) => a.url),
          resync: true,
          summarizePolicies: false,
        }),
        signal: controller.signal,
      });
      await refreshApps();
      showToast(successMsg);
      handle.complete("done", tGrid("task_done_synced", { count: total }));
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        console.error(`[apps] Sync-${scope} failed:`, err);
        showToast(tGrid("toast_sync_failed"));
        handle.complete(
          "error",
          (err as Error)?.message ?? tGrid("task_error_sync_failed")
        );
      }
    }
    setSyncingAll(false);
  };

  const syncAll = () => syncAppList(apps, { scope: "all" });
  const syncFiltered = (list: App[]) =>
    syncAppList(list, { scope: "filtered" });

  const deleteApp = async () => {
    if (!pendingDelete) {
      return;
    }

    setDeletingId(pendingDelete.id);
    try {
      const res = await fetch(`/api/apps?id=${pendingDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setApps((prev) => prev.filter((app) => app.id !== pendingDelete.id));
      setPendingDelete(null);
      showToast(tGrid("toast_app_removed"));
    } catch (error) {
      console.error(`[apps] Delete failed for ${pendingDelete?.id}:`, error);
      showToast(tGrid("toast_delete_failed"));
    } finally {
      setDeletingId(null);
    }
  };

  const daysSince = (ts: number) => {
    const d = Math.floor((Date.now() - ts) / 86_400_000);
    if (d === 0) {
      return tGrid("freshness.today");
    }
    if (d === 1) {
      return tGrid("freshness.yesterday");
    }
    return tGrid("freshness.days_ago", { count: d });
  };

  const freshnessClass = (ts: number) => {
    const d = Math.floor((Date.now() - ts) / 86_400_000);
    if (d > 30) {
      return "stale";
    }
    if (d > 7) {
      return "aging";
    }
    return "fresh";
  };

  const sorted = [...apps]
    .filter((a) => {
      const q = filter.trim().toLowerCase();
      if (!q) {
        return true;
      }
      if (a.name.toLowerCase().includes(q)) {
        return true;
      }
      if (a.developer?.toLowerCase().includes(q)) {
        return true;
      }
      return false;
    })
    .filter((a) => (riskFilter ? computeRiskLevel(a) === riskFilter : true))
    .filter((a) =>
      mismatchOnly ? (profileBadges[a.id]?.count ?? 0) > 0 : true
    )
    .filter((a) => {
      // Accessibility filter is only meaningful for apps we've actually
      // evaluated — `null` rows predate the scraper and shouldn't silently
      // count as "missing" (or as "has"). Exclude them from either bucket.
      if (!accessibilityFilter) {
        return true;
      }
      if (a.hasAccessibilityLabels == null) {
        return false;
      }
      return accessibilityFilter === "has"
        ? a.hasAccessibilityLabels === 1
        : a.hasAccessibilityLabels === 0;
    })
    .sort((a, b) => {
      if (sort === "name") {
        return a.name.localeCompare(b.name);
      }
      if (sort === "synced") {
        return b.lastSynced - a.lastSynced;
      }
      if (sort === "permissions") {
        return b.categoryCount - a.categoryCount;
      }
      if (sort === "risk") {
        const diff = computeRiskScore(b) - computeRiskScore(a);
        return diff === 0 ? a.name.localeCompare(b.name) : diff;
      }
      return 0;
    });

  // Custom apps have no privacy labels of their own, so they only appear when
  // no specific risk filter is active — a "High risk" filter would otherwise
  // imply they had been assessed, which they haven't. Same goes for the
  // profile-mismatch filter: there's nothing to compare against, so hiding
  // them avoids implying they passed the profile when really they weren't
  // evaluated. They also sort alphabetically among themselves regardless of
  // the current sort mode, except for 'synced' which maps naturally to
  // `updatedAt`.
  const filteredManualApps = useMemo(() => {
    if (riskFilter) {
      return [];
    }
    if (mismatchOnly) {
      return [];
    }
    // Manual apps have no App Store listing and therefore no Apple
    // accessibility shelf; surfacing them under a has/missing filter would
    // imply they had been evaluated either way, which they haven't.
    if (accessibilityFilter) {
      return [];
    }
    const q = filter.trim().toLowerCase();
    return [...manualApps]
      .filter((m) => {
        if (!q) {
          return true;
        }
        if (m.name.toLowerCase().includes(q)) {
          return true;
        }
        if (m.developer?.toLowerCase().includes(q)) {
          return true;
        }
        return false;
      })
      .sort((a, b) => {
        if (sort === "synced") {
          return b.updatedAt - a.updatedAt;
        }
        return a.name.localeCompare(b.name);
      });
  }, [manualApps, filter, riskFilter, mismatchOnly, accessibilityFilter, sort]);

  const totalShown = sorted.length + filteredManualApps.length;
  const totalTracked = apps.length + manualApps.length;
  const filterActive =
    Boolean(riskFilter) ||
    mismatchOnly ||
    Boolean(accessibilityFilter) ||
    filter.trim().length > 0 ||
    totalShown !== totalTracked;

  /**
   * Stage-2 of the manual-app delete flow. The Confirm button in the
   * dialog is the only caller; the staging happens via
   * `setPendingDeleteManual(app)` from the row's ✕ click handler.
   */
  const deleteManualConfirmed = async () => {
    const app = pendingDeleteManual;
    if (!app) {
      return;
    }
    setDeletingManualId(app.id);
    try {
      const res = await fetch(`/api/manual-apps/${app.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setManualApps((prev) => prev.filter((m) => m.id !== app.id));
      setPendingDeleteManual(null);
      showToast(tGrid("toast_custom_app_removed"));
    } catch (error) {
      console.error(`[apps] Manual-app delete failed for ${app.id}:`, error);
      showToast(tGrid("toast_delete_failed"));
    } finally {
      setDeletingManualId(null);
    }
  };

  useEffect(() => {
    if (!pendingDelete) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deletingId) {
        setPendingDelete(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, deletingId]);

  const stopCardNavigation = (
    event:
      | React.MouseEvent<HTMLButtonElement>
      | React.PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleActionClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    action: () => void | Promise<void>
  ) => {
    stopCardNavigation(event);
    void action();
  };

  // ── Compare-selection helpers ────────────────────────────────────────

  const toggleSelection = useCallback((appId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(appId)) {
        return prev.filter((id) => id !== appId);
      }
      // Cap at COMPARE_MAX by dropping the OLDEST entry so a stray third
      // click doesn't feel like nothing happened — the newest click always
      // wins.
      const next = [...prev, appId];
      if (next.length > COMPARE_MAX) {
        return next.slice(next.length - COMPARE_MAX);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setCompareMode(false);
  }, []);

  const goToCompare = useCallback(() => {
    if (selectedIds.length < 2) {
      return;
    }
    const [a, b] = selectedIds;
    const qs = new URLSearchParams({ a: `id:${a}`, b: `id:${b}` }).toString();
    router.push(`/dashboard/compare?${qs}`);
  }, [router, selectedIds]);

  const handleCardClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, appId: string) => {
      // Select mode wins over compare — when the user has opted into bulk
      // marking, every click toggles selection. Card body navigation is
      // suspended until they exit Select mode.
      if (pageMode === "select") {
        event.preventDefault();
        event.stopPropagation();
        toggleBulkSelection(appId);
        return;
      }
      // Modifier-click toggles selection on any row, regardless of compareMode.
      const isModifier = event.shiftKey || event.metaKey || event.ctrlKey;
      if (isModifier) {
        event.preventDefault();
        event.stopPropagation();
        // Promote to Select mode when the user shift-clicks a third app —
        // compare only handles two slots, but the gesture clearly signals
        // "I want to multi-select." Move both existing compare picks plus
        // the new click into the bulk selection so nothing is lost.
        if (
          f.reviewQueueBulkSelect &&
          selectedIds.length >= COMPARE_MAX &&
          !selectedIds.includes(appId)
        ) {
          const promoted = [...selectedIds, appId];
          setSelectedIds([]);
          setCompareMode(false);
          setBulkPrevVerdicts({ ...userVerdicts });
          setBulkSelectedIds(promoted);
          setPageMode("select");
          return;
        }
        toggleSelection(appId);
        return;
      }
      // When the user has opted into compare mode via the header button, a
      // plain click also toggles — so touch devices can still multi-select.
      if (compareMode) {
        event.preventDefault();
        event.stopPropagation();
        toggleSelection(appId);
      }
      // Otherwise: fall through and let the <Link> navigate.
    },
    [
      COMPARE_MAX,
      compareMode,
      f.reviewQueueBulkSelect,
      pageMode,
      selectedIds,
      toggleBulkSelection,
      toggleSelection,
      userVerdicts,
    ]
  );

  // ── Keyboard shortcuts for the compare flow ──────────────────────────
  //
  // Escape clears the selection and exits compareMode (layered *before* the
  // delete-modal Escape handler — that one no-ops when pendingDelete is null,
  // so we don't have to coordinate). Enter triggers a comparison once two
  // apps are selected, which mirrors the visible "Compare" primary button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never intercept typing.
      const t = event.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return;
        }
        if (t.isContentEditable) {
          return;
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === "Escape" && (selectedIds.length > 0 || compareMode)) {
        clearSelection();
        return;
      }
      if (event.key === "Enter" && selectedIds.length >= 2 && !pendingDelete) {
        event.preventDefault();
        goToCompare();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds, compareMode, clearSelection, goToCompare, pendingDelete]);

  // If a selected app is removed from the grid (deleted, filtered out for
  // good, or the source list changes), drop it from selection too so the
  // dock doesn't hold on to phantom IDs.
  useEffect(() => {
    if (selectedIds.length === 0) {
      return;
    }
    const stillExists = new Set(apps.map((a) => a.id));
    const cleaned = selectedIds.filter((id) => stillExists.has(id));
    if (cleaned.length !== selectedIds.length) {
      setSelectedIds(cleaned);
    }
  }, [apps, selectedIds]);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tGrid("page_title")}</h1>
          <p className="page-subtitle">
            {filterActive
              ? tGrid("showing_of", { shown: totalShown, total: totalTracked })
              : tGrid("n_tracked", { count: totalTracked })}
          </p>
        </div>
        <div className="header-actions">
          {f.actionsSyncFiltered &&
            (riskFilter || mismatchOnly || filter.trim().length > 0) &&
            sorted.length > 0 &&
            sorted.length < apps.length && (
              <button
                className="btn btn-secondary"
                disabled={syncingAll}
                onClick={() => syncFiltered(sorted)}
                title={tGrid("resync_filter_title", { count: sorted.length })}
                type="button"
              >
                {syncingAll ? <span className="spinner" /> : "↻"}
                {syncingAll
                  ? tGrid("syncing")
                  : tGrid("sync_n_apps", { count: sorted.length })}
              </button>
            )}
          {f.actionsSyncAll && (
            <button
              className="btn btn-secondary"
              disabled={syncingAll || apps.length === 0}
              onClick={syncAll}
              type="button"
            >
              {syncingAll ? <span className="spinner" /> : "↻"}
              {syncingAll ? tGrid("syncing") : tGrid("sync_all")}
            </button>
          )}
          {f.actionsCustomAppsNav && (
            <Link
              className="btn btn-secondary"
              href="/dashboard/manual-apps"
              title={tGrid("untracked_title")}
            >
              {tGrid("custom_apps")}
              {manualApps.length > 0 && (
                <span
                  aria-label={tGrid("custom_count_aria", {
                    count: manualApps.length,
                  })}
                  className="custom-apps-count"
                >
                  {manualApps.length}
                </span>
              )}
            </Link>
          )}
          {/* Enters "Compare mode" — plain clicks toggle selection instead of
              navigating. Mirrors the Shift/Cmd-click power-user path so
              touch devices can reach the same feature. */}
          {f.actionsCompareMode && (
            <button
              aria-pressed={compareMode}
              className={`btn ${compareMode ? "btn-primary" : "btn-secondary"}`}
              data-tour="compare-button"
              onClick={() => {
                if (compareMode) {
                  clearSelection();
                } else {
                  setCompareMode(true);
                }
              }}
              title={
                compareMode
                  ? tGrid("compare_title_on")
                  : tGrid("compare_title_off")
              }
              type="button"
            >
              {compareMode ? tGrid("cancel_compare") : tGrid("compare")}
            </button>
          )}
          {f.reviewQueueEnabled && (
            <button
              className={`btn btn-secondary review-queue-mode-toggle ${queueOpen ? "is-active" : ""}`}
              disabled={apps.length === 0}
              onClick={() => {
                if (pageMode === "select") {
                  exitSelectMode();
                }
                setQueueOpen(true);
              }}
              title={tGrid("mode_toggle_queue_title")}
              type="button"
            >
              {tGrid("mode_toggle_queue")}
            </button>
          )}
          {f.reviewQueueBulkSelect && (
            <button
              aria-pressed={pageMode === "select"}
              className={`btn ${pageMode === "select" ? "btn-primary" : "btn-secondary"}`}
              disabled={apps.length === 0}
              onClick={() => {
                if (pageMode === "select") {
                  exitSelectMode();
                } else {
                  enterSelectMode();
                }
              }}
              title={tGrid("mode_toggle_select_title")}
              type="button"
            >
              {pageMode === "select"
                ? tGrid("mode_toggle_select_exit")
                : tGrid("mode_toggle_select")}
            </button>
          )}
          {f.actionsAddApps && (
            <Link
              className="btn btn-primary"
              data-flag-target="flag.appgrid.actions.add_apps"
              href="/onboard"
            >
              {tGrid("add_apps")}
            </Link>
          )}
        </div>
      </div>

      {/* The "N apps need a decision" CTA renders on the dashboard home
          (see app/dashboard/page.tsx). The `reviewableCount` prop is
          still accepted for back-compat but no longer rendered. */}

      {/* Bulk-select toolbar lives ABOVE the filter row so it's visible
          the moment the user enters Select mode — previously it was
          rendered after the app grid where `position: sticky` only
          revealed it on scroll, leaving users on tall pages with no
          visible bar to interact with. */}
      {pageMode === "select" && f.reviewQueueBulkSelect && (
        <BulkSelectBar
          currentVerdicts={bulkPrevVerdicts}
          onClear={() => setBulkSelectedIds([])}
          onExit={exitSelectMode}
          onSelectAll={() => setBulkSelectedIds(sorted.map((a) => a.id))}
          selectedIds={bulkSelectedIds}
          visibleIds={sorted.map((a) => a.id)}
        />
      )}

      <div className="toolbar">
        {f.filterSearch && (
          <div
            className="search-input-wrap"
            data-flag-target="flag.appgrid.filter.search"
          >
            <span aria-hidden="true" className="search-icon">
              <svg
                aria-hidden="true"
                fill="none"
                focusable="false"
                height="16"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="16"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              aria-label={tGrid("filter_input_aria")}
              className="search-input"
              // Marks this as the primary search target for the menu-bar
              // Edit → Find (Cmd+F) action. MenuActionsBridge listens for
              // the `search:focus` event and focuses+selects this input.
              data-search-focus="true"
              onChange={(e) => setFilter(e.target.value)}
              placeholder={tGrid("filter_input_placeholder")}
              type="search"
              value={filter}
            />
          </div>
        )}
        {/* Sort mode — exposed as a radiogroup (single-select) so screen
            readers announce position & selection state. type="button"
            prevents the enclosing form (if any) from submitting. */}
        {f.filterSortTabs && (
          <div
            aria-label={tGrid("sort_aria")}
            className="sort-tabs"
            role="radiogroup"
          >
            {(["risk", "name", "synced", "permissions"] as const).map((s) => {
              const selected = sort === s;
              return (
                <button
                  aria-checked={selected}
                  className={`sort-tab ${selected ? "active" : ""}`}
                  key={s}
                  onClick={() => setSort(s)}
                  role="radio"
                  type="button"
                >
                  {s === "risk"
                    ? tGrid("sort.highest_risk")
                    : s === "name"
                      ? tGrid("sort.a_z")
                      : s === "synced"
                        ? tGrid("sort.recent")
                        : tGrid("sort.most_categories")}
                </button>
              );
            })}
          </div>
        )}
        {/* Device-scope dropdown. Auto-hidden by `showDeviceFilter` when
            the user only has one device (or only unattached apps) — a
            single-choice dropdown is just noise. Each option carries
            its app-count so users see how much each device contributes
            before clicking. The "Unattached" option is gated on there
            actually being any unattached apps. */}
        {showDeviceFilter && (
          <label
            className="device-filter-wrap"
            data-flag-target="flag.appgrid.filter.device"
          >
            <span className="device-filter-label">
              {tGrid("device_filter_label")}
            </span>
            <select
              aria-label={tGrid("device_filter_aria")}
              className="device-filter-select"
              onChange={(event) => {
                const value = event.target.value;
                setDeviceFilter(value === "" ? null : value);
              }}
              value={deviceFilter ?? ""}
            >
              <option value="">
                {tGrid("device_filter_all", { count: apps.length })}
              </option>
              {devices.map((d) => {
                const count = deviceCounts.perDevice.get(d.id) ?? 0;
                return (
                  <option key={d.id} value={d.id}>
                    {d.name} · {count}
                  </option>
                );
              })}
              {deviceCounts.unattached > 0 && (
                <option value="unattached">
                  {tGrid("device_filter_unattached", {
                    count: deviceCounts.unattached,
                  })}
                </option>
              )}
            </select>
          </label>
        )}
        {/* Privacy-profile filter — only visible once the user has set a
            profile and at least one app falls outside it. A single-purpose
            toggle rather than a radiogroup, so it can stack with the risk
            filter (e.g. "High risk apps that also break my profile"). The
            count in the label makes it obvious how much work a click would
            surface. */}
        {f.filterProfileMismatch &&
          hasProfileBadges &&
          (mismatchCount > 0 || mismatchOnly) && (
            <button
              aria-pressed={mismatchOnly}
              className={`mismatch-toggle ${mismatchOnly ? "active" : ""}`}
              data-flag-target="flag.appgrid.filter.profile_mismatch"
              onClick={() => setMismatchOnly(!mismatchOnly)}
              title={
                mismatchOnly
                  ? tGrid("mismatch_toggle_title_active")
                  : tGrid("mismatch_toggle_title_inactive")
              }
              type="button"
            >
              <span aria-hidden="true" className="mismatch-toggle-icon">
                ⚠
              </span>
              <span className="mismatch-toggle-label">
                {tGrid("profile_mismatches_label")}
              </span>
              <span className="mismatch-toggle-count">{mismatchCount}</span>
            </button>
          )}
      </div>

      {/* Active-filter pills. Hoisted out of the toolbar so they cluster
          predictably regardless of how many are active — keeping them
          inside the toolbar made the flex-wrap scatter individual pills
          to the next line or far edges. Rendered only when at least one
          filter is active so we don't leave an empty row. */}
      {f.filterActiveBanners &&
        (riskFilter || mismatchOnly || accessibilityFilter || deviceFilter) && (
          <div className="active-filters-row" role="region">
            {riskFilter && (
              <div className={`filter-status filter-status-${riskFilter}`}>
                <span className="filter-status-text">
                  <span className="filter-status-label">
                    {tGrid("filtering_by")}
                  </span>
                  <strong>{tRisk(`${riskFilter}_label`).toLowerCase()}</strong>
                </span>
                <button
                  aria-label={tGrid("clear_risk_aria")}
                  className="filter-status-clear"
                  onClick={clearRiskFilter}
                  title={tGrid("clear_filter_title")}
                  type="button"
                >
                  ✕
                </button>
              </div>
            )}
            {mismatchOnly && (
              <div className="filter-status filter-status-mismatch">
                <span className="filter-status-text">
                  <span className="filter-status-label">
                    {tGrid("filtering_by")}
                  </span>
                  <strong>profile mismatches</strong>
                </span>
                <button
                  aria-label={tGrid("clear_mismatch_aria")}
                  className="filter-status-clear"
                  onClick={() => setMismatchOnly(false)}
                  title={tGrid("clear_mismatch_title")}
                  type="button"
                >
                  ✕
                </button>
              </div>
            )}
            {accessibilityFilter && (
              <div
                className={`filter-status filter-status-access-${accessibilityFilter}`}
              >
                <span className="filter-status-text">
                  <span className="filter-status-label">
                    {tGrid("filtering_by")}
                  </span>
                  <strong>
                    {accessibilityFilter === "has"
                      ? "has accessibility features"
                      : "no accessibility features"}
                  </strong>
                </span>
                <button
                  aria-label={tGrid("clear_a11y_aria")}
                  className="filter-status-clear"
                  onClick={() => setAccessibilityFilter(null)}
                  title={tGrid("clear_a11y_title")}
                  type="button"
                >
                  ✕
                </button>
              </div>
            )}
            {deviceFilter && (
              <div className="filter-status filter-status-device">
                <span className="filter-status-text">
                  <span className="filter-status-label">
                    {tGrid("filtering_by")}
                  </span>
                  <strong>
                    {deviceFilter === "unattached"
                      ? tGrid("device_filter_unattached_short")
                      : (devices.find((d) => d.id === deviceFilter)?.name ??
                        deviceFilter)}
                  </strong>
                </span>
                <button
                  aria-label={tGrid("clear_device_aria")}
                  className="filter-status-clear"
                  onClick={() => setDeviceFilter(null)}
                  title={tGrid("clear_device_title")}
                  type="button"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}

      {f.filterRiskButtons && (
        <div className="risk-filter-row">
          <div
            aria-label={tGrid("risk_filter_aria")}
            className="segmented-toggle"
            role="group"
          >
            <button
              aria-pressed={riskFilter === null}
              className={`segmented-toggle-btn ${riskFilter === null ? "is-active" : ""}`}
              onClick={() => setRiskLevel(null)}
              type="button"
            >
              <span>{tGrid("all_risks")}</span>
              <span className="segmented-toggle-btn-count">
                {prefilteredApps.length}
              </span>
            </button>
            {(["high", "moderate", "low", "minimal", "unknown"] as const).map(
              (level) => {
                const count = riskLevelCounts[level];
                const isActive = riskFilter === level;
                return (
                  <button
                    aria-pressed={isActive}
                    className={`segmented-toggle-btn ${isActive ? "is-active" : ""}`}
                    data-level={level}
                    disabled={count === 0 && !isActive}
                    key={level}
                    onClick={() => setRiskLevel(isActive ? null : level)}
                    title={tRisk(`${level}_desc`)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="segmented-toggle-btn-dot"
                    />
                    <span>{tRisk(`${level}_label`)}</span>
                    <span className="segmented-toggle-btn-count">{count}</span>
                  </button>
                );
              }
            )}
          </div>
        </div>
      )}

      {/*
        Accessibility filter row — a separate pill group rather than a 7th
        risk tab because the axis is orthogonal (an app can be high risk AND
        accessible, or low risk AND not). Shown only when the global toggle
        is on, and only when we have at least one evaluated app so it doesn't
        render as 0/0/0 on fresh installs.
      */}
      {f.filterAccessibility &&
        showAccessibilityFilter &&
        (() => {
          let hasCount = 0;
          let missingCount = 0;
          let evaluatedCount = 0;
          for (const app of prefilteredApps) {
            if (app.hasAccessibilityLabels == null) {
              continue;
            }
            evaluatedCount++;
            if (app.hasAccessibilityLabels === 1) {
              hasCount++;
            } else {
              missingCount++;
            }
          }
          if (evaluatedCount === 0) {
            return null;
          }
          return (
            <div className="access-filter-row" data-tour="accessibility-filter">
              <span className="access-filter-label" id="access-filter-label">
                Accessibility
              </span>
              <div
                aria-labelledby="access-filter-label"
                className="segmented-toggle"
                role="group"
              >
                <button
                  aria-pressed={accessibilityFilter === null}
                  className={`segmented-toggle-btn ${accessibilityFilter === null ? "is-active" : ""}`}
                  onClick={() => setAccessibilityFilter(null)}
                  type="button"
                >
                  <span>All</span>
                  <span className="segmented-toggle-btn-count">
                    {evaluatedCount}
                  </span>
                </button>
                <button
                  aria-pressed={accessibilityFilter === "has"}
                  className={`segmented-toggle-btn ${accessibilityFilter === "has" ? "is-active" : ""}`}
                  data-access="has"
                  disabled={hasCount === 0 && accessibilityFilter !== "has"}
                  onClick={() =>
                    setAccessibilityFilter(
                      accessibilityFilter === "has" ? null : "has"
                    )
                  }
                  title={tGrid("has_features_title")}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="segmented-toggle-btn-dot"
                  />
                  <span>{tGrid("has_features_label")}</span>
                  <span className="segmented-toggle-btn-count">{hasCount}</span>
                </button>
                <button
                  aria-pressed={accessibilityFilter === "missing"}
                  className={`segmented-toggle-btn ${accessibilityFilter === "missing" ? "is-active" : ""}`}
                  data-access="missing"
                  disabled={
                    missingCount === 0 && accessibilityFilter !== "missing"
                  }
                  onClick={() =>
                    setAccessibilityFilter(
                      accessibilityFilter === "missing" ? null : "missing"
                    )
                  }
                  title={tGrid("no_features_title")}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="segmented-toggle-btn-dot"
                  />
                  <span>{tGrid("no_features_label")}</span>
                  <span className="segmented-toggle-btn-count">
                    {missingCount}
                  </span>
                </button>
              </div>
            </div>
          );
        })()}

      {totalShown === 0 ? (
        f.emptyState ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              {riskFilter || mismatchOnly ? "✓" : "📭"}
            </div>
            <div className="empty-state-title">
              {mismatchOnly
                ? tGrid("empty_all_clear_profile")
                : riskFilter
                  ? tGrid("empty_no_risk_apps", {
                      level: tRisk(`${riskFilter}_label`).toLowerCase(),
                    })
                  : filter
                    ? tGrid("empty_no_matches")
                    : tGrid("empty_no_apps_tracked")}
            </div>
            <p className="empty-state-text">
              {mismatchOnly
                ? tGrid("empty_text_mismatch")
                : riskFilter === "unknown"
                  ? tGrid("empty_text_unknown_filter")
                  : riskFilter
                    ? tGrid("empty_text_risk_filter")
                    : filter
                      ? tGrid("empty_text_search")
                      : tGrid("empty_text_no_apps")}
            </p>
            {mismatchOnly ? (
              <button
                className="btn btn-secondary"
                onClick={() => setMismatchOnly(false)}
                style={{ marginTop: 18 }}
                type="button"
              >
                {tGrid("btn_clear_filter")}
              </button>
            ) : riskFilter ? (
              <button
                className="btn btn-secondary"
                onClick={clearRiskFilter}
                style={{ marginTop: 18 }}
                type="button"
              >
                {tGrid("btn_clear_filter")}
              </button>
            ) : (
              !filter && (
                <Link
                  className="btn btn-primary"
                  href="/onboard"
                  style={{ marginTop: 18 }}
                >
                  {tGrid("btn_start_onboarding")}
                </Link>
              )
            )}
          </div>
        ) : null
      ) : (
        <div className="app-grid">
          {sorted.map((app, idx) => {
            const risk = computeRiskLevel(app);
            const riskMeta = RISK_META[risk];
            const t = app.trackCount ?? 0;
            const l = app.linkedCount ?? 0;
            const u = app.unlinkedCount ?? 0;
            const selectionIndex = selectedIds.indexOf(app.id);
            const isSelected = selectionIndex >= 0;
            const isBulkSelected = bulkSelectedIds.includes(app.id);
            // Coachmark tour spotlights live on the first card so the
            // tour selectors `[data-tour="app-card-first"]`, `…severity-
            // pill-first`, `…resync-button` resolve to a single
            // unambiguous element. Subsequent cards are unmarked.
            const isTourCard = idx === 0;
            return (
              <div
                className={`app-card app-card-risk-${risk}${isSelected ? " app-card-selected" : ""}${compareMode ? " app-card-selectable" : ""}${pageMode === "select" ? " app-card-bulk-selectable" : ""}${isBulkSelected ? " app-card-bulk-selected" : ""}${
                  // Wave I — gold-border treatment for apps with at least
                  // one non-deleted annotation. Annotation count isn't
                  // threaded into the grid yet, so the class is reserved on
                  // the element with the flag check; CSS provides the
                  // styling hook for when the data lands.
                  f.cardAnnotationHighlight &&
                  (app as { annotationCount?: number }).annotationCount
                    ? " app-card-annotated"
                    : ""
                }`}
                data-tour={isTourCard ? "app-card-first" : undefined}
                key={app.id}
              >
                <Link
                  aria-pressed={compareMode ? isSelected : undefined}
                  className="app-card-link"
                  href={`/apps/${app.id}`}
                  onClick={(event) => handleCardClick(event, app.id)}
                  title={
                    compareMode
                      ? isSelected
                        ? `Deselect ${app.name}`
                        : `Select ${app.name} for comparison`
                      : `Open ${app.name} — Shift-click to add to compare`
                  }
                >
                  <div className="app-card-icon-wrap">
                    {app.iconUrl ? (
                      <Image
                        alt={app.name}
                        className="app-icon"
                        height={56}
                        src={app.iconUrl}
                        style={{ objectFit: "cover" }}
                        unoptimized
                        width={56}
                      />
                    ) : (
                      <div className="app-icon-placeholder">{app.name[0]}</div>
                    )}
                    {app.changeCount > 0 &&
                      (() => {
                        // Split the pending bundle by category so the user can
                        // see at a glance whether a red-flag change was a
                        // privacy-label regression (orange) or an
                        // accessibility-label update (blue, less alarming).
                        // When both are present we render two stacked dots so
                        // neither gets lost. Policy-only changes ride on the
                        // orange dot since they live inside the same
                        // "privacy" mental model.
                        const breakdown = pendingChangeCategoriesByApp[app.id];
                        // Treat the breakdown as privacy-only when it's
                        // missing entirely — that covers the pre-migration
                        // case where changeCount was bumped by an older
                        // snapshot we can't re-parse.
                        const hasPrivacy = breakdown
                          ? breakdown.privacy || breakdown.policy
                          : true;
                        const hasAccessibility = !!breakdown?.accessibility;
                        // Figure out a human-readable tooltip that matches
                        // what the dot(s) actually represent. Falls back to
                        // the old "permission change" wording only when we
                        // have no breakdown at all.
                        const labelParts: string[] = [];
                        if (hasPrivacy) {
                          labelParts.push("privacy");
                        }
                        if (hasAccessibility) {
                          labelParts.push("accessibility");
                        }
                        const title = breakdown
                          ? `${app.changeCount} ${labelParts.join(" and ")} label change${app.changeCount === 1 ? "" : "s"} detected`
                          : `${app.changeCount} permission change${app.changeCount === 1 ? "" : "s"} detected`;
                        if (!f.cardChangeDot) {
                          return null;
                        }
                        return (
                          <div
                            aria-label={title}
                            className="change-dot-group"
                            role="status"
                            title={title}
                          >
                            {hasPrivacy && (
                              <span
                                aria-hidden="true"
                                className="change-dot change-dot-privacy"
                              />
                            )}
                            {hasAccessibility && (
                              <span
                                aria-hidden="true"
                                className="change-dot change-dot-accessibility"
                              />
                            )}
                          </div>
                        );
                      })()}
                    {isSelected && (
                      <div
                        aria-label={tGrid("selected_for_compare_aria", {
                          slot: selectionIndex === 0 ? "A" : "B",
                        })}
                        className="app-card-select-badge"
                      >
                        {selectionIndex === 0 ? "A" : "B"}
                      </div>
                    )}
                    {pageMode === "select" && (
                      <div
                        aria-hidden="true"
                        className={`app-card-bulk-check ${isBulkSelected ? "is-checked" : ""}`}
                      >
                        {isBulkSelected ? "✓" : ""}
                      </div>
                    )}
                  </div>

                  <div className="app-card-body">
                    <div className="app-name">{app.name}</div>
                    {app.developer && (
                      <div className="app-developer">{app.developer}</div>
                    )}
                    {(() => {
                      // Profile badge AND verdict pill share this row so both
                      // signals are visible at a glance without duplicating
                      // the row chrome. The verdict pill always wins the
                      // leading slot when both are present — it's the user's
                      // own decision, which trumps the derived profile-match.
                      const showProfile = f.cardProfileBadge;
                      const badge = showProfile ? profileBadges[app.id] : null;
                      const verdict = f.cardVerdictPill
                        ? userVerdicts[app.id]
                        : undefined;
                      if (!(badge || verdict)) {
                        return null;
                      }
                      return (
                        <div className="app-card-profile-row">
                          {verdict && (
                            <VerdictPill size="sm" verdict={verdict} />
                          )}
                          {badge &&
                            (() => {
                              // Localise via the kind discriminator the
                              // server-side `summariseBadge` now ships. The
                              // `worstMismatchSentence` slot lets the
                              // describeWorstMismatch English fallback ride
                              // through unchanged for the detailed mismatch
                              // case until that helper is migrated; zh users
                              // see the generic "{n} 个类别超出了你的档案"
                              // until then.
                              const localisedLabel = localiseBadgeLabel(
                                tBadge,
                                badge
                              );
                              const localisedDescription =
                                localiseBadgeDescription(tBadge, badge);
                              return (
                                <span
                                  aria-label={tGrid("privacy_profile_aria", {
                                    description: localisedDescription,
                                  })}
                                  className={`app-card-profile-badge match-${badge.tone}`}
                                  title={localisedDescription}
                                >
                                  <span aria-hidden>
                                    {badge.tone === "ok" ? "✓" : "⚠"}
                                  </span>
                                  {localisedLabel}
                                </span>
                              );
                            })()}
                        </div>
                      );
                    })()}
                    <div className="app-meta">
                      {f.cardFreshnessChip && (
                        <span
                          className={`freshness-badge ${freshnessClass(app.lastSynced)}`}
                        >
                          {daysSince(app.lastSynced)}
                        </span>
                      )}
                      {/*
                      Categories count and sync count used to render here but
                      got crowded out on cards with a long mismatch banner.
                      They now live on the risk pill (hover-revealed) and on
                      the resync button (notification-style badge) respectively
                      so the meta row stays a single freshness chip.
                    */}
                    </div>
                  </div>
                </Link>

                <div className="app-card-rail">
                  <div className="app-card-rail-risk">
                    {f.cardRiskPill && (
                      <span
                        className={`risk-pill ${riskMeta.cls}`}
                        data-tour={
                          isTourCard ? "severity-pill-first" : undefined
                        }
                        title={tRisk(`${risk}_desc`)}
                      >
                        <span aria-hidden="true" className="risk-pill-dot">
                          {riskMeta.dot}
                        </span>
                        {tRisk(`${risk}_label`)}
                        {/*
                      Total categories count — hidden by default, revealed on
                      hover of the pill so the number is reachable without
                      permanently crowding the card header. We only show the
                      number here (no trailing "categories" word) because
                      the pill's own `title` attribute already establishes
                      the context; a bare number keeps the hover reveal
                      compact so the pill doesn't double in width.
                    */}
                        {app.categoryCount > 0 && (
                          <span
                            aria-label={tGrid("n_categories_aria", {
                              count: app.categoryCount,
                            })}
                            className="risk-pill-count"
                          >
                            · {app.categoryCount}
                          </span>
                        )}
                      </span>
                    )}
                    {f.cardRiskChips && (t > 0 || l > 0 || u > 0) && (
                      <div
                        aria-label={tGrid("label_breakdown_aria")}
                        className="risk-chip-row"
                      >
                        {u > 0 && (
                          <span
                            className="risk-chip risk-chip-unlinked"
                            title={tGrid("unlinked_chip_title", { count: u })}
                          >
                            <span aria-hidden="true" className="risk-chip-icon">
                              <PrivacyTypeIcon tier="not_linked" />
                            </span>
                            <span className="risk-chip-count">{u}</span>
                          </span>
                        )}
                        {l > 0 && (
                          <span
                            className="risk-chip risk-chip-linked"
                            title={tGrid("linked_chip_title", { count: l })}
                          >
                            <span aria-hidden="true" className="risk-chip-icon">
                              <PrivacyTypeIcon tier="linked" />
                            </span>
                            <span className="risk-chip-count">{l}</span>
                          </span>
                        )}
                        {t > 0 && (
                          <span
                            className="risk-chip risk-chip-track"
                            title={tGrid("track_chip_title", { count: t })}
                          >
                            <span aria-hidden="true" className="risk-chip-icon">
                              <PrivacyTypeIcon tier="tracking" />
                            </span>
                            <span className="risk-chip-count">{t}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="app-card-actions">
                    {f.cardResyncButton && (
                      <button
                        aria-label={
                          syncingIds.has(app.id)
                            ? `${tGrid("syncing")} ${app.name}`
                            : app.syncCount > 1
                              ? tGrid("resync_app_aria_with_count", {
                                  name: app.name,
                                  count: app.syncCount,
                                })
                              : tGrid("resync_app_aria", { name: app.name })
                        }
                        className="icon-btn"
                        data-tour={isTourCard ? "resync-button" : undefined}
                        disabled={syncingIds.has(app.id)}
                        onClick={(event) =>
                          handleActionClick(event, () =>
                            syncApp(app.id, app.url)
                          )
                        }
                        onPointerDown={stopCardNavigation}
                        title={
                          app.syncCount > 1
                            ? tGrid("resync_app_title_with_count", {
                                name: app.name,
                                count: app.syncCount,
                              })
                            : tGrid("resync_app_title", { name: app.name })
                        }
                        type="button"
                      >
                        {syncingIds.has(app.id) ? (
                          <span aria-hidden="true" className="spinner-sm" />
                        ) : (
                          <span aria-hidden="true">↻</span>
                        )}
                        {/*
                      Notification-style badge showing the cumulative sync
                      count. Sits absolutely over the top-right corner of the
                      refresh icon. Only rendered when > 1 so brand-new apps
                      (which have exactly one sync from onboarding) don't
                      display a noisy "1" badge.
                    */}
                        {app.syncCount > 1 && !syncingIds.has(app.id) && (
                          <span aria-hidden="true" className="icon-btn-badge">
                            {app.syncCount}
                          </span>
                        )}
                      </button>
                    )}
                    {f.cardDeleteButton && (
                      <button
                        aria-label={tGrid("remove_app_aria", {
                          name: app.name,
                        })}
                        className="icon-btn danger"
                        onClick={(event) =>
                          handleActionClick(event, () => setPendingDelete(app))
                        }
                        onPointerDown={stopCardNavigation}
                        title={tGrid("remove_app_title", { name: app.name })}
                        type="button"
                      >
                        <span aria-hidden="true">✕</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Custom apps — user-authored entries with no App Store listing.
              They share the grid so users discover them alongside the rest,
              but opt out of risk chips and sync. The card link points at
              the manual-app detail page (`/manual-apps/[id]`) which mirrors
              the App Store apps' `/apps/[id]` shape — the user's mental
              model is "click an app card, see that app", whether it came
              from cfgutil or was hand-added. Deletion is inline via the
              /api/manual-apps DELETE endpoint. */}
          {filteredManualApps.map((m) => {
            const meta = manualSourceMeta.get(m.source);
            const icon = meta?.icon ?? "📦";
            // Localised short label for the manual-source badge. Falls
            // back to the raw `m.source` enum value when meta is
            // missing — defensive guard for legacy rows.
            const sourceLabel = meta
              ? tSource(`${meta.value}_short`)
              : m.source;
            const busy = deletingManualId === m.id;
            return (
              <div className="app-card app-card-custom" key={`manual-${m.id}`}>
                <Link
                  aria-label={tGrid("open_custom_aria", { name: m.name })}
                  className="app-card-link"
                  href={`/manual-apps/${encodeURIComponent(m.id)}`}
                >
                  <div className="app-card-icon-wrap">
                    <div aria-hidden="true" className="app-icon-placeholder">
                      <span style={{ fontSize: 28 }}>{icon}</span>
                    </div>
                  </div>

                  <div className="app-card-body">
                    <div className="app-name">{m.name}</div>
                    {m.developer && (
                      <div className="app-developer">{m.developer}</div>
                    )}
                    <div className="app-meta">
                      <span className="permission-count">{sourceLabel}</span>
                      {m.privacyPolicyUrl && (
                        <span className="permission-count">
                          · Policy linked
                        </span>
                      )}
                    </div>
                  </div>
                </Link>

                <div className="app-card-rail">
                  <div className="app-card-rail-risk">
                    <span
                      className="risk-pill risk-pill-custom"
                      title={tGrid("untracked_no_listing_title")}
                    >
                      <span aria-hidden="true" className="risk-pill-dot">
                        ◆
                      </span>
                      Custom
                    </span>
                  </div>

                  <div className="app-card-actions">
                    <button
                      aria-label={
                        busy
                          ? `Removing ${m.name}`
                          : `Remove ${m.name} from custom apps`
                      }
                      className="icon-btn danger"
                      disabled={busy}
                      onClick={(event) =>
                        handleActionClick(event, () =>
                          setPendingDeleteManual(m)
                        )
                      }
                      onPointerDown={stopCardNavigation}
                      title={tGrid("remove_custom_title", { name: m.name })}
                      type="button"
                    >
                      {busy ? (
                        <span aria-hidden="true" className="spinner-sm" />
                      ) : (
                        <span aria-hidden="true">✕</span>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* Floating compare dock — shows once the user has picked at least one
          app. Lets them see what's selected, compare (when 2 are picked), or
          clear the selection. Rendered *below* the toast in z-order so error
          toasts still win attention.

          Uses the same fixed-bottom-center placement as the toast so the two
          don't fight; the toast auto-dismisses after 3s, the dock sticks
          until the user acts on it. */}
      {(selectedIds.length > 0 || compareMode) && (
        <section
          aria-label={tGrid("compare_selection_aria")}
          aria-live="polite"
          className="compare-dock"
        >
          <div className="compare-dock-info">
            <span className="compare-dock-count">
              {tGrid("compare_dock_count", {
                count: selectedIds.length,
                max: COMPARE_MAX,
              })}
            </span>
            <span className="compare-dock-hint">
              {selectedIds.length === 0
                ? tGrid("compare_dock_hint_empty")
                : selectedIds.length === 1
                  ? tGrid("compare_dock_hint_one")
                  : tGrid("compare_dock_hint_ready")}
            </span>
          </div>

          <div className="compare-dock-chips">
            {selectedIds.map((id, index) => {
              const app = apps.find((a) => a.id === id);
              if (!app) {
                return null;
              }
              return (
                <div className="compare-dock-chip" key={id}>
                  <span className="compare-dock-chip-slot">
                    {index === 0 ? "A" : "B"}
                  </span>
                  {app.iconUrl ? (
                    <Image
                      alt=""
                      aria-hidden="true"
                      className="compare-dock-chip-icon"
                      height={20}
                      src={app.iconUrl}
                      unoptimized
                      width={20}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="compare-dock-chip-icon compare-dock-chip-icon-fallback"
                    >
                      {app.name[0]}
                    </span>
                  )}
                  <span className="compare-dock-chip-name">{app.name}</span>
                  <button
                    aria-label={tGrid("deselect_app_aria", { name: app.name })}
                    className="compare-dock-chip-remove"
                    onClick={() => toggleSelection(id)}
                    title={tGrid("deselect_app_title", { name: app.name })}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          <div className="compare-dock-actions">
            <button
              className="btn btn-secondary"
              onClick={clearSelection}
              type="button"
            >
              {tGrid("compare_dock_clear")}
            </button>
            <button
              className="btn btn-primary"
              disabled={selectedIds.length < 2}
              onClick={goToCompare}
              title={
                selectedIds.length < 2
                  ? tGrid("compare_dock_title_disabled")
                  : tGrid("compare_dock_title_enabled")
              }
              type="button"
            >
              {tGrid("compare_dock_compare")}
            </button>
          </div>
        </section>
      )}

      {pendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deletingId) {
              setPendingDelete(null);
            }
          }}
        >
          <div
            aria-describedby="delete-app-copy"
            aria-labelledby="delete-app-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingId) {
                setPendingDelete(null);
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{tGrid("modal_badge_remove")}</div>
            <h2 className="modal-title" id="delete-app-title">
              {tGrid("modal_stop_tracking_title", { name: pendingDelete.name })}
            </h2>
            <p className="modal-copy" id="delete-app-copy">
              {tGrid("modal_stop_tracking_body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={Boolean(deletingId)}
                onClick={() => setPendingDelete(null)}
                type="button"
              >
                {tGrid("modal_cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={Boolean(deletingId)}
                onClick={() => void deleteApp()}
                type="button"
              >
                {deletingId ? (
                  <>
                    <span className="spinner-sm" /> {tGrid("modal_removing")}
                  </>
                ) : (
                  tGrid("modal_remove_app")
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {queueOpen && f.reviewQueueEnabled && (
        <ReviewQueue
          apps={sorted as QueueAppInput[]}
          audience={audience}
          changedAppIds={
            new Set(sorted.filter((a) => a.changeCount > 0).map((a) => a.id))
          }
          hasProfile={hasProfile}
          onClose={() => setQueueOpen(false)}
          profileBadges={profileBadges}
          showCfgutilOffer={f.reviewQueueCfgutilUninstall}
          showProgressBar={showQueueProgressBar}
          userVerdicts={userVerdicts}
        />
      )}

      {/*
        Confirm modal for the custom-app (ManualApp) delete flow.
        Mirrors the tracked-app dialog above so the UX is identical;
        copy is tailored for custom apps (no privacy snapshot to lose,
        but the source URL + notes go too).
      */}
      {pendingDeleteManual && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!deletingManualId) {
              setPendingDeleteManual(null);
            }
          }}
        >
          <div
            aria-describedby="delete-manual-copy"
            aria-labelledby="delete-manual-title"
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingManualId) {
                setPendingDeleteManual(null);
              }
            }}
            role="dialog"
          >
            <div className="modal-badge">{tGrid("modal_badge_remove")}</div>
            <h2 className="modal-title" id="delete-manual-title">
              {tGrid("modal_remove_custom_title", {
                name: pendingDeleteManual.name,
              })}
            </h2>
            <p className="modal-copy" id="delete-manual-copy">
              {tGrid("modal_remove_custom_body")}
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={Boolean(deletingManualId)}
                onClick={() => setPendingDeleteManual(null)}
                type="button"
              >
                {tGrid("modal_cancel")}
              </button>
              <button
                autoFocus
                className="btn btn-danger"
                disabled={Boolean(deletingManualId)}
                onClick={() => void deleteManualConfirmed()}
                type="button"
              >
                {deletingManualId ? (
                  <>
                    <span className="spinner-sm" /> {tGrid("modal_removing")}
                  </>
                ) : (
                  tGrid("modal_remove_app")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
