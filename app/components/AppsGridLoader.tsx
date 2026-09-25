"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type AgeBandKey, isValidAgeBand } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import { useFlagBundle, useFlagBundleStatus } from "@/lib/use-flag-bundle";
import AppGrid, { type AppGridFlagState } from "./AppGrid";
import { useDeviceScope, withScopeParam } from "./DeviceScopeProvider";
import LoaderError from "./LoaderError";
import { PageSkeleton } from "./LoadingShell";
import Nav from "./Nav";

/**
 * Client loader for /dashboard/apps (Rust-core Phase 0).
 *
 * The page did sixteen server reads; every one has an exact existing API
 * twin, so this batch adds no endpoints. `/api/apps?limit=250&offset=0
 * &meta=grid` alone covers the page slice, the total, and all four
 * side-band maps — the same `buildAppGridMeta` output, from the route
 * that already served AppGrid's background hydration.
 *
 * Four behaviours are preserved deliberately, each of which a
 * straightforward port would have broken:
 *
 * 1. THE GATE IS NOT RequireAppsGate. The page bounced to /onboard only
 *    when there were no App Store apps AND no manual apps — an install
 *    with only custom apps must reach the grid. RequireAppsGate checks
 *    the App Store count alone and would send those users away.
 * 2. FLAGS FAIL OPEN. The page wrapped its 26 resolver calls in a
 *    try/catch returning `undefined`, and AppGrid reads `undefined` as
 *    "everything visible". useFlagBundle fails CLOSED, so on a flag-read
 *    failure we pass `undefined` rather than a map of falses — otherwise
 *    an unreachable flag endpoint would strip the grid to nothing.
 * 3. RENDER IS HELD until every input has landed. AppGrid seeds all of
 *    its state from props via useState and its hydration effect is
 *    mount-only, so anything arriving late is ignored for the lifetime
 *    of the page — including `devices`, which `?device=<id>` deep links
 *    are validated against.
 * 4. PER-READ DEFAULTS ARE INDEPENDENT. The page had six separate
 *    try/catch blocks with different fallbacks; each fetch here degrades
 *    on its own rather than one failure blanking the page. The one
 *    exception is the apps page itself: without it there is nothing to
 *    show and no way to tell an empty install from a failed read, so a
 *    failure renders LoaderError (Try again), never the onboarding bounce.
 */

const APPGRID_FLAG_KEYS = [
  "flag.appgrid.filter.search",
  "flag.appgrid.filter.sort_tabs",
  "flag.appgrid.filter.risk_buttons",
  "flag.appgrid.filter.profile_mismatch",
  "flag.appgrid.filter.accessibility",
  "flag.appgrid.filter.device",
  "flag.appgrid.filter.active_banners",
  "flag.appgrid.actions.sync_filtered",
  "flag.appgrid.actions.sync_all",
  "flag.appgrid.actions.compare_mode",
  "flag.appgrid.actions.custom_apps_nav",
  "flag.appgrid.actions.add_apps",
  "flag.appgrid.card.change_dot",
  "flag.appgrid.card.profile_badge",
  "flag.appgrid.card.freshness_chip",
  "flag.appgrid.card.risk_pill",
  "flag.appgrid.card.risk_chips",
  "flag.appgrid.card.resync_button",
  "flag.appgrid.card.delete_button",
  "flag.appgrid.card.annotation_highlight",
  "flag.appgrid.card.verdict_pill",
  "flag.appgrid.empty_state",
  "flag.guardian.age_rating",
  "flag.appgrid.review_queue.enabled",
  "flag.appgrid.review_queue.bulk_select",
  "flag.appgrid.review_queue.cfgutil_uninstall",
] as const;

const GRID_INITIAL_PAGE_SIZE = 250;

type GridProps = Parameters<typeof AppGrid>[0];

interface LoadedState {
  appDeviceMap: GridProps["appDeviceMap"];
  apps: GridProps["initialApps"];
  audience: Audience;
  childAgeBand: AgeBandKey | null;
  devices: GridProps["devices"];
  hasProfile: boolean;
  manualApps: GridProps["initialManualApps"];
  manualSources: GridProps["manualSources"];
  pendingChangeCategoriesByApp: GridProps["pendingChangeCategoriesByApp"];
  profileBadges: GridProps["profileBadges"];
  /**
   * The scope this payload was fetched under.
   *
   * The React key on <AppGrid> is taken from HERE, not from the live
   * scope. Keying on the live scope remounts the moment the user picks a
   * device — while `state` still holds the previous scope's apps — and
   * because AppGrid seeds all of its state at mount and ignores later
   * props, that stale payload is what it keeps for good. Keying on the
   * scope the data actually belongs to means the remount happens when
   * the matching data arrives, and exactly once.
   */
  scopeKey: string;
  showAccessibilityFilter: boolean;
  showQueueProgressBar: boolean;
  total: number;
  userVerdicts: GridProps["userVerdicts"];
}

const json = (url: string) =>
  fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

/** A read the page cannot stand in for: a failure rejects, never `null`. */
const requiredJson = (url: string) =>
  fetch(url).then((res) =>
    res.ok
      ? res.json()
      : Promise.reject(new Error(`HTTP ${res.status}: ${url}`))
  );

export default function AppsGridLoader() {
  const router = useRouter();
  const [state, setState] = useState<LoadedState | null>(null);
  // A failed apps read is not an empty install. It used to come back as
  // `null`, read as `total ?? 0`, and bounce a user with a full library
  // to onboarding. It now shows a retryable error instead.
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const flagValues = useFlagBundle(APPGRID_FLAG_KEYS);
  const { failedToLoad } = useFlagBundleStatus();
  // The device scope decides which apps this page is even about, so the
  // first page has to be fetched under it — not fetched unscoped and
  // then narrowed, which would flash the whole fleet and make `total`
  // (the number the hydration loop pages against) wrong.
  const { ready: scopeReady, scopeKey, scopeParam } = useDeviceScope();

  useEffect(() => {
    // Hold until the scope has landed. `ready` also goes true when the
    // read FAILS, in which case the scope is the unrestricted default —
    // so a broken scope endpoint costs the user nothing here.
    if (!scopeReady) {
      return;
    }
    let live = true;
    setFailed(false);
    Promise.all([
      requiredJson(
        withScopeParam(
          `/api/apps?limit=${GRID_INITIAL_PAGE_SIZE}&offset=0&meta=grid`,
          scopeParam
        )
      ),
      json("/api/manual-apps"),
      json("/api/settings"),
      json("/api/focus"),
      json("/api/privacy-profile"),
      json("/api/devices"),
    ])
      .then(([grid, manual, settings, focus, profileJson, devicesJson]) => {
        if (!live) {
          return;
        }
        if (typeof grid?.total !== "number") {
          throw new Error("Invalid apps page");
        }
        const total: number = grid.total;
        const manualApps = manual?.apps ?? [];

        // The page's own guard: only bounce when BOTH lists are empty.
        //
        // `!scopeParam` is load-bearing. Scoped to a device that happens
        // to have no App Store apps, `total` is legitimately 0 — bouncing
        // would throw a user with a full library out to onboarding
        // because they picked the wrong phone in the nav. Only an
        // unscoped empty read means "this install has nothing in it".
        //
        // And both reads must have SUCCEEDED to say so: an unreadable
        // manual-apps list cannot prove there are no custom apps, and an
        // install with only custom apps must reach the grid.
        if (total === 0 && !scopeParam) {
          if (!manual) {
            throw new Error("Could not read custom apps");
          }
          if (manualApps.length === 0) {
            router.replace("/onboard");
            return;
          }
        }

        const profile = profileJson?.profile;
        setState({
          apps: grid.apps ?? [],
          total,
          profileBadges: grid.meta?.profileBadges ?? {},
          pendingChangeCategoriesByApp:
            grid.meta?.pendingChangeCategoriesByApp ?? {},
          userVerdicts: grid.meta?.userVerdicts ?? {},
          appDeviceMap: grid.meta?.appDeviceMap ?? {},
          manualApps,
          manualSources: manual?.sources ?? [],
          // Each default matches the server page's individual fallback.
          showAccessibilityFilter:
            settings?.track_accessibility_labels !== false,
          showQueueProgressBar: settings?.queue_show_progress_bar !== false,
          audience: (focus?.audience ?? "self") as Audience,
          childAgeBand: isValidAgeBand(focus?.childAgeBand ?? "")
            ? (focus.childAgeBand as AgeBandKey)
            : null,
          // Key-count, not truthiness — the same expression the page used.
          hasProfile: Boolean(profile) && Object.keys(profile).length > 0,
          devices: devicesJson?.devices ?? [],
          scopeKey,
        } as LoadedState);
      })
      .catch((error) => {
        console.warn("[apps] grid load failed:", error);
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [router, scopeReady, scopeParam, retry]);

  // Nav renders above the hold guard so the chrome (and its app-count
  // badge) is present while the grid loads, as it was server-side.
  const appCount = state
    ? state.total + (state.manualApps?.length ?? 0)
    : undefined;

  const flags: AppGridFlagState | undefined =
    failedToLoad || !flagValues
      ? undefined
      : {
          filterSearch: flagValues["flag.appgrid.filter.search"],
          filterSortTabs: flagValues["flag.appgrid.filter.sort_tabs"],
          filterRiskButtons: flagValues["flag.appgrid.filter.risk_buttons"],
          filterProfileMismatch:
            flagValues["flag.appgrid.filter.profile_mismatch"],
          filterAccessibility: flagValues["flag.appgrid.filter.accessibility"],
          filterDevice: flagValues["flag.appgrid.filter.device"],
          filterActiveBanners: flagValues["flag.appgrid.filter.active_banners"],
          actionsSyncFiltered: flagValues["flag.appgrid.actions.sync_filtered"],
          actionsSyncAll: flagValues["flag.appgrid.actions.sync_all"],
          actionsCompareMode: flagValues["flag.appgrid.actions.compare_mode"],
          actionsCustomAppsNav:
            flagValues["flag.appgrid.actions.custom_apps_nav"],
          actionsAddApps: flagValues["flag.appgrid.actions.add_apps"],
          cardChangeDot: flagValues["flag.appgrid.card.change_dot"],
          cardProfileBadge: flagValues["flag.appgrid.card.profile_badge"],
          cardFreshnessChip: flagValues["flag.appgrid.card.freshness_chip"],
          cardRiskPill: flagValues["flag.appgrid.card.risk_pill"],
          cardRiskChips: flagValues["flag.appgrid.card.risk_chips"],
          cardResyncButton: flagValues["flag.appgrid.card.resync_button"],
          cardDeleteButton: flagValues["flag.appgrid.card.delete_button"],
          cardAnnotationHighlight:
            flagValues["flag.appgrid.card.annotation_highlight"],
          cardVerdictPill: flagValues["flag.appgrid.card.verdict_pill"],
          emptyState: flagValues["flag.appgrid.empty_state"],
          guardianAgeRating: flagValues["flag.guardian.age_rating"],
          reviewQueueEnabled: flagValues["flag.appgrid.review_queue.enabled"],
          reviewQueueBulkSelect:
            flagValues["flag.appgrid.review_queue.bulk_select"],
          reviewQueueCfgutilUninstall:
            flagValues["flag.appgrid.review_queue.cfgutil_uninstall"],
        };

  if (failed) {
    return (
      <>
        <Nav />
        <LoaderError onRetry={() => setRetry((value) => value + 1)} />
      </>
    );
  }

  return (
    <>
      <Nav appCount={appCount} />
      {state && (flagValues || failedToLoad) ? (
        <AppGrid
          appDeviceMap={state.appDeviceMap}
          audience={state.audience}
          childAgeBand={state.childAgeBand}
          devices={state.devices}
          flags={flags}
          hasProfile={state.hasProfile}
          initialApps={state.apps}
          initialManualApps={state.manualApps}
          initialTotal={state.total}
          /* Remount when a new scope's data lands. AppGrid seeds every
             piece of state from props via useState and its hydration
             effect is mount-only, so the new page would otherwise be
             ignored for the life of the page. Remounting also resets
             filters, selection and the render window — all of which
             describe a set of apps that no longer exists.
             `state.scopeKey`, not the live scope: see LoadedState. */
          key={state.scopeKey}
          manualSources={state.manualSources}
          pendingChangeCategoriesByApp={state.pendingChangeCategoriesByApp}
          profileBadges={state.profileBadges}
          showAccessibilityFilter={state.showAccessibilityFilter}
          showQueueProgressBar={state.showQueueProgressBar}
          userVerdicts={state.userVerdicts}
        />
      ) : (
        <PageSkeleton />
      )}
    </>
  );
}
