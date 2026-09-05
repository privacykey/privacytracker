import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Nav from "../../components/Nav";
import RequireFlagGate from "../../components/RequireFlagGate";
import StatsLoader from "../../components/StatsLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("stats_title"),
    description: t("stats_description"),
  };
}

/**
 * Statistics page.
 *
 * Rust-core Phase 0: the four server reads this page used to do — the
 * page flag gate, `getStats()`, the `track_accessibility_labels`
 * setting, and ten `flag.stats.*` resolutions — moved to the API.
 * StatsLoader owns the data and the flag bundle (sharing one
 * /api/feature-flags fetch with the gate above it) and wraps the view
 * in RequireAppsGate, which replaces the old
 * `stats.totalApps === 0 → redirect("/onboard")`.
 */
export default function StatsPage() {
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.page.stats">
        <StatsLoader />
      </RequireFlagGate>
    </>
  );
}
