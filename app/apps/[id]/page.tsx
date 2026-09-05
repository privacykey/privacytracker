import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AppDetailLoader from "../../components/AppDetailLoader";

/**
 * App detail.
 *
 * Rust-core Phase 0: the page's seventeen server reads moved behind
 * `GET /api/apps/[id]/detail` (one aggregate — three of the reads had no
 * route at all) and the flag bundle; see AppDetailLoader for the five
 * behaviours that had to be preserved deliberately (all-or-nothing
 * mount, fail-open flags, the tri-state sidebar flag, task-visit only
 * after the 404, refetch instead of router.refresh()).
 *
 * The per-app title is set client-side once the payload lands, with the
 * same ICU key generateMetadata used; a dynamic route can't prerender a
 * per-id title in a static export anyway.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return { title: t("app_detail_fallback") };
}

export default function AppDetailPage() {
  return <AppDetailLoader />;
}
