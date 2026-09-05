import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import NotFoundContent from "./components/content/NotFoundContent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("not_found_title"),
    description: t("not_found_description"),
  };
}

/**
 * App Router catches every unknown URL here. Static since the layout
 * batch (Rust-core Phase 0): the Referer-based back link moved to the
 * client (document.referrer) so this route no longer reads headers().
 */
export default function NotFound() {
  return <NotFoundContent />;
}
