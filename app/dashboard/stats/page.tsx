import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import { getSetting } from "../../../lib/scheduler";
import { getStats } from "../../../lib/stats";
import Nav from "../../components/Nav";
import StatsView, { type StatsFlagState } from "../../components/StatsView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("stats_title"),
    description: t("stats_description"),
  };
}

export default function StatsPage() {
  if (resolveFlagFromDb("flag.page.stats") !== "on") {
    notFound();
  }

  let stats: any = null;
  try {
    stats = getStats();
  } catch (error) {
    // DB not yet ready
    console.warn("[stats] getStats failed:", error);
  }

  if (!stats || stats.totalApps === 0) {
    redirect("/onboard");
  }

  // Server-hydrated accessibility toggle. When disabled in Settings the
  // whole Accessibility summary card + chart section are hidden, keeping
  // the Stats page consistent with the grid filter / app detail behaviour.
  let trackAccessibility = true;
  try {
    trackAccessibility =
      getSetting("track_accessibility_labels", "true") !== "false";
  } catch (error) {
    console.warn("[stats] reading track_accessibility_labels failed:", error);
  }

  // Round 3 wave G — resolve every flag.stats.* value server-side.
  const statsFlags: StatsFlagState | undefined = (() => {
    try {
      const r = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === "on";
      return {
        vizHeatmap: r("flag.stats.viz.heatmap"),
        vizTimeline: r("flag.stats.viz.timeline"),
        vizCompare: r("flag.stats.viz.compare"),
        vizSmallMultiples: r("flag.stats.viz.small_multiples"),
        vizSankey: r("flag.stats.viz.sankey"),
        vizRadar: r("flag.stats.viz.radar"),
        vizCategoryBars: r("flag.stats.viz.category_bars"),
        vizAccessibilityBars: r("flag.stats.viz.accessibility_bars"),
        recentChangesFilter: r("flag.stats.recent_changes.filter"),
        offProfileCard: r("flag.stats.off_profile_card"),
      };
    } catch {
      return;
    }
  })();

  return (
    <>
      <Nav />
      <StatsView
        flags={statsFlags}
        stats={stats}
        trackAccessibility={trackAccessibility}
      />
    </>
  );
}
