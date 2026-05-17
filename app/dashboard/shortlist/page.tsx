import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import type { PrivacyProfile } from "../../../lib/privacy-profile";
import { getPrivacyProfile } from "../../../lib/privacy-profile-server";
import { listShortlistGroups } from "../../../lib/shortlist";
import Nav from "../../components/Nav";
import ShortlistView, {
  type ShortlistFlagState,
} from "../../components/ShortlistView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("shortlist_title"),
    description: t("shortlist_description"),
  };
}

/**
 * Entry point for the shortlist review page. Hydrates the initial grouped
 * list server-side so the page paints without a spinner, then ShortlistView
 * takes over for the mutable list state (add-from-preview, remove, export,
 * drawer preview).
 */
export default function ShortlistPage() {
  if (resolveFlagFromDb("flag.page.shortlist") !== "on") {
    notFound();
  }

  let initialGroups: ReturnType<typeof listShortlistGroups> = [];
  let initialProfile: PrivacyProfile | null = null;
  try {
    initialGroups = listShortlistGroups();
  } catch (error) {
    // DB not ready (first boot) — render the empty state rather than 500.
    console.warn("[shortlist-page] listShortlistGroups failed:", error);
  }
  try {
    // Profile hydration is best-effort — if the settings row isn't there
    // yet (fresh install) we still want to render groups.
    initialProfile = getPrivacyProfile();
  } catch (error) {
    console.warn("[shortlist-page] getPrivacyProfile failed:", error);
  }

  // Round 3 wave I: resolve every flag.shortlist.* into a single object so
  // the client component can render its toolbar / row affordances against a
  // stable shape. Wrapped in a try/catch so a resolver hiccup doesn't 500
  // the whole page — falls back to undefined which ShortlistView treats as
  // "everything visible" (legacy behaviour).
  const flags: ShortlistFlagState | undefined = (() => {
    try {
      const r = (k: Parameters<typeof resolveFlagFromDb>[0]) =>
        resolveFlagFromDb(k) === "on";
      return {
        actionsRemove: r("flag.shortlist.actions.remove"),
        actionsPreview: r("flag.shortlist.actions.preview"),
        actionsShare: r("flag.shortlist.actions.share"),
        actionsExport: r("flag.shortlist.actions.export"),
        actionsPrint: r("flag.shortlist.actions.print"),
        actionsReset: r("flag.shortlist.actions.reset"),
        actionsUndo: r("flag.shortlist.actions.undo"),
        detailedView: r("flag.shortlist.detailed_view"),
        liveBadgePrefetch: r("flag.shortlist.live_badge_prefetch"),
        profileMismatchPill: r("flag.shortlist.profile_mismatch_pill"),
        installedGrouping: r("flag.shortlist.installed_grouping"),
      };
    } catch (e) {
      console.warn("[shortlist-page] flag resolution failed:", e);
      return;
    }
  })();

  return (
    <>
      <Nav />
      <ShortlistView
        flags={flags}
        initialGroups={initialGroups}
        initialProfile={initialProfile}
      />
    </>
  );
}
