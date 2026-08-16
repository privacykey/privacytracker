import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Nav from "../../components/Nav";
import RequireFlagGate from "../../components/RequireFlagGate";
import ShortlistLoader from "../../components/ShortlistLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("shortlist_title"),
    description: t("shortlist_description"),
  };
}

/**
 * Entry point for the shortlist review page. Hydrates the initial grouped
 * list, the saved privacy profile and eleven flag.shortlist.* values from
 * the API (Rust-core Phase 0 — see ShortlistLoader), then ShortlistView
 * takes over for the mutable list state (add-from-preview, remove, export,
 * drawer preview).
 */
export default function ShortlistPage() {
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.page.shortlist">
        <ShortlistLoader />
      </RequireFlagGate>
    </>
  );
}
