import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ManualAppsView from "../../components/ManualAppsView";
import Nav from "../../components/Nav";
import RequireFlagGate from "../../components/RequireFlagGate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("manual_apps_title"),
    description: t("manual_apps_description"),
  };
}

/**
 * Entry point for the manual-apps editor. The list + forms live in a
 * client component so editing can be stateful.
 *
 * Rust-core Phase 0: the flag gate (`flag.page.manual_apps`) and the
 * initial list both used to be resolved here against the DB. They now
 * come from the API — the flag through RequireFlagGate, and the list
 * plus source-type metadata through `GET /api/manual-apps`, which
 * already returned exactly the `{ apps, sources }` pair this page was
 * assembling by hand.
 */
export default function ManualAppsPage() {
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.page.manual_apps">
        <ManualAppsView />
      </RequireFlagGate>
    </>
  );
}
