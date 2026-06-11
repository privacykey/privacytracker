/**
 * Live runtime-diagnostics dashboard.
 *
 * Server shell — hands off to a client component that polls
 * /api/diagnostics/runtime every 2s. Kept dynamic so the SSR pass
 * doesn't pre-render stale numbers; the client takes over instantly
 * after hydration.
 *
 * No `redirect('/onboard')` guard like settings/page.tsx — diagnostics
 * is meant to be reachable even when the DB is in a weird state, since
 * "weird state" is exactly when the user wants to look at it.
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import DiagnosticsView from "../../components/DiagnosticsView";
import Nav from "../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("diagnostics_title"),
    description: t("diagnostics_description"),
  };
}

export default function DiagnosticsPage() {
  return (
    <>
      <Nav />
      <DiagnosticsView />
    </>
  );
}
