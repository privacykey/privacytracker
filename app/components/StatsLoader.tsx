"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useFlagBundle } from "@/lib/use-flag-bundle";
import RequireAppsGate from "./RequireAppsGate";
import StatsView, { type StatsFlagState } from "./StatsView";

/**
 * Client loader for the Statistics page (Rust-core Phase 0).
 *
 * `/dashboard/stats` used to do four server reads: the page flag gate,
 * `getStats()`, the `track_accessibility_labels` setting, and ten
 * `flag.stats.*` resolutions. All four now come from the API — the gate
 * and the flag bundle share one `/api/feature-flags` fetch through
 * `useFlagBundle`, the summary from the new `GET /api/stats`, and the
 * setting from `GET /api/settings`.
 *
 * The empty-install bounce (`stats.totalApps === 0 → /onboard`) is
 * RequireAppsGate, wrapped around this by the page.
 */

const STATS_FLAG_KEYS = [
  "flag.stats.viz.heatmap",
  "flag.stats.viz.timeline",
  "flag.stats.viz.compare",
  "flag.stats.viz.small_multiples",
  "flag.stats.viz.sankey",
  "flag.stats.viz.radar",
  "flag.stats.viz.category_bars",
  "flag.stats.viz.accessibility_bars",
  "flag.stats.recent_changes.filter",
  "flag.stats.off_profile_card",
] as const;

export default function StatsLoader() {
  const [stats, setStats] = useState<
    Parameters<typeof StatsView>[0]["stats"] | null
  >(null);
  const [trackAccessibility, setTrackAccessibility] = useState(true);
  const flagValues = useFlagBundle(STATS_FLAG_KEYS);
  const [failed, setFailed] = useState(false);
  const tError = useTranslations("loader_error");

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/stats").then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      ),
      fetch("/api/settings")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
      .then(([statsJson, settings]) => {
        if (!live) {
          return;
        }
        setStats(statsJson);
        // Absent / unreadable settings keep the pre-Phase-0 default of
        // `true`, matching the server page's try/catch.
        if (
          settings &&
          typeof settings.track_accessibility_labels === "boolean"
        ) {
          setTrackAccessibility(settings.track_accessibility_labels);
        }
      })
      .catch((error) => {
        console.warn("[stats] load failed:", error);
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // A failed /api/stats used to leave this page blank forever (the old
  // server page bounced to /onboard, which was hardly better for an
  // install WITH apps whose stats read hiccuped). Offer a retry instead.
  if (failed) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <div className="empty-state-title">{tError("title")}</div>
          <p className="empty-state-text">
            <button
              className="btn btn-secondary"
              onClick={() => window.location.reload()}
              type="button"
            >
              {tError("retry")}
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (!(stats && flagValues)) {
    return null;
  }

  const flags: StatsFlagState = {
    vizHeatmap: flagValues["flag.stats.viz.heatmap"],
    vizTimeline: flagValues["flag.stats.viz.timeline"],
    vizCompare: flagValues["flag.stats.viz.compare"],
    vizSmallMultiples: flagValues["flag.stats.viz.small_multiples"],
    vizSankey: flagValues["flag.stats.viz.sankey"],
    vizRadar: flagValues["flag.stats.viz.radar"],
    vizCategoryBars: flagValues["flag.stats.viz.category_bars"],
    vizAccessibilityBars: flagValues["flag.stats.viz.accessibility_bars"],
    recentChangesFilter: flagValues["flag.stats.recent_changes.filter"],
    offProfileCard: flagValues["flag.stats.off_profile_card"],
  };

  return (
    <RequireAppsGate>
      <StatsView
        flags={flags}
        stats={stats}
        trackAccessibility={trackAccessibility}
      />
    </RequireAppsGate>
  );
}
