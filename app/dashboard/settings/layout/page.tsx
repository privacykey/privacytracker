import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import DashboardLayoutEditor from "@/app/components/DashboardLayoutEditor";
import Nav from "@/app/components/Nav";
import { DEFAULT_LAYOUT } from "@/lib/dashboard-layout";
import { getDashboardLayout } from "@/lib/dashboard-layout-server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";

/**
 * /dashboard/settings/layout — server-rendered shell for the editable
 * home-dashboard layout editor. Reads the user's saved layout on the
 * server so the editor hydrates with the right initial state (no
 * post-mount fetch flicker).
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("layout_edit_title"),
    description: t("layout_edit_description"),
  };
}

export default async function DashboardLayoutSettingsPage() {
  // Editor route is gated on `flag.dashboard.layout_editor.visible`. When
  // off, return a 404 — matches the way other flag-gated settings pages
  // disappear from navigation when the feature is disabled. The home
  // dashboard still consumes the user's saved layout regardless; only
  // the editor surface is hidden.
  const editorVisible = (() => {
    try {
      return resolveFlagFromDb("flag.dashboard.layout_editor.visible") === "on";
    } catch {
      // Default to visible on resolver failure — safer for a feature
      // whose default is 'on' to render than to mysteriously 404.
      return true;
    }
  })();
  if (!editorVisible) {
    notFound();
  }

  const t = await getTranslations("dashboard.layout_editor");
  // Swallow DB errors so a fresh install or mid-migration boot still
  // renders the editor with the canonical default — matches the
  // defensive style of every other read on the dashboard server pages.
  const layout = (() => {
    try {
      return getDashboardLayout();
    } catch (error) {
      console.warn("[settings/layout] getDashboardLayout failed:", error);
      return DEFAULT_LAYOUT;
    }
  })();

  return (
    <>
      <Nav />
      <div className="page-container">
        <header className="layout-editor-page-header">
          <Link className="layout-editor-back-link" href="/dashboard">
            {t("back_to_dashboard")}
          </Link>
          <h1 className="page-title">{t("page_title")}</h1>
          <p className="page-subtitle">{t("page_subtitle")}</p>
        </header>
        <DashboardLayoutEditor initialLayout={layout} />
      </div>
    </>
  );
}
