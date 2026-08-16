import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ManualAppDetailLoader from "../../components/ManualAppDetailLoader";
import Nav from "../../components/Nav";

/**
 * Manual-app detail.
 *
 * Rust-core Phase 0: the app row, its event history, the current policy
 * version and the source metadata all came from synchronous DB reads
 * here, plus a `notFound()` for unknown ids. They now arrive in one
 * payload from `GET /api/manual-apps/[id]` inside
 * ManualAppDetailLoader, which also 404s on a missing row.
 *
 * `generateMetadata` no longer reads the DB for the app name: a dynamic
 * route can't prerender a per-id title in a static export (ids can't be
 * enumerated at build time), so the loader sets `document.title` on the
 * client and the static metadata keeps the generic fallback.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return { title: t("manual_app_detail_fallback_alt") };
}

export default function ManualAppDetailPage() {
  return (
    <>
      <Nav />
      <ManualAppDetailLoader />
    </>
  );
}
