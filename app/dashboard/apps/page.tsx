import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AppsGridLoader from "../../components/AppsGridLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("apps_title"),
  };
}

/**
 * Tracked-apps grid.
 *
 * Rust-core Phase 0: all sixteen server reads moved to AppsGridLoader,
 * which needed no new endpoints —
 * `/api/apps?limit=250&offset=0&meta=grid` already returned the page
 * slice, the total and the four side-band maps (the same
 * `buildAppGridMeta` output), and the rest had exact twins.
 *
 * The 250-app initial page size lives in the loader now. It caps what
 * the first request carries — this view was the app's only real scaling
 * bottleneck (21.8 MB at 5,000 apps) — while AppGrid streams the
 * remainder in chunks, exactly as before.
 *
 * Note Nav renders inside the loader: its badge counts App Store apps
 * PLUS manual apps, so it needs both fetches.
 */
export default function AppsPage() {
  return <AppsGridLoader />;
}
