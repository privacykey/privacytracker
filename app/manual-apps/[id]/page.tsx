import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getCurrentManualAppPolicyVersion,
  listManualAppEvents,
} from "../../../lib/manual-app-history";
import { MANUAL_APP_SOURCE_META } from "../../../lib/manual-apps";
import { getManualApp } from "../../../lib/manual-apps-server";
import ManualAppDetailView from "../../components/ManualAppDetailView";
import Nav from "../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  try {
    const { id } = await params;
    const app = getManualApp(id);
    if (app) {
      return { title: t("manual_app_detail_title", { name: app.name }) };
    }
  } catch (error) {
    console.warn("[manual-app-detail] generateMetadata failed:", error);
  }
  return { title: t("manual_app_detail_fallback_alt") };
}

export default async function ManualAppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = getManualApp(id);
  if (!app) {
    notFound();
  }

  // Both calls are synchronous better-sqlite3 reads, so we don't defer
  // them to the client. The page is force-dynamic already, so this lands
  // in an SSR render every visit — the timeline is always fresh.
  const events = listManualAppEvents(id);
  const currentVersion = getCurrentManualAppPolicyVersion(id);
  const meta = MANUAL_APP_SOURCE_META[app.source];

  return (
    <>
      <Nav />
      <ManualAppDetailView
        app={app}
        currentVersion={currentVersion}
        events={events}
        meta={meta}
      />
    </>
  );
}
