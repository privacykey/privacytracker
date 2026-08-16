import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Nav from "../../components/Nav";
import PrivacyGroupedView from "../../components/PrivacyGroupedView";
import RecordTaskVisit from "../../components/RecordTaskVisit";
import RequireAppsGate from "../../components/RequireAppsGate";
import RequireFlagGate from "../../components/RequireFlagGate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("privacy_map_title"),
  };
}

/**
 * Privacy Map.
 *
 * Rust-core Phase 0: the page flag gate, the grouped-view query, the
 * empty-install bounce and the first-visit checklist marker were all
 * server-side. They map to RequireFlagGate, PrivacyGroupedView's own
 * fetch of `/api/apps?view=grouped` (the endpoint that already served
 * `getGroupedPrivacyView()`), RequireAppsGate, and RecordTaskVisit —
 * which posts the same `task_visit.privacy_map_at` marker
 * `lib/tasks-server.ts` reads, with the same first-write-wins
 * semantics.
 */
export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.page.privacy_map">
        <RequireAppsGate>
          <RecordTaskVisit surface="privacy_map" />
          <PrivacyGroupedView />
        </RequireAppsGate>
      </RequireFlagGate>
    </>
  );
}
