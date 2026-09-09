"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import DashboardLayoutEditor from "@/app/components/DashboardLayoutEditor";
import Nav from "@/app/components/Nav";
import RequireFlagGate from "@/app/components/RequireFlagGate";
/**
 * /dashboard/settings/layout — server-rendered shell for the editable
 * home-dashboard layout editor. Reads the user's saved layout on the
 * server so the editor hydrates with the right initial state (no
 * post-mount fetch flicker).
 */

export default function DashboardLayoutSettingsContent() {
  // Editor route is gated on `flag.dashboard.layout_editor.visible`. When
  // off, return a 404 — matches the way other flag-gated settings pages
  // disappear from navigation when the feature is disabled. The home
  // dashboard still consumes the user's saved layout regardless; only
  // the editor surface is hidden. `failOpen` keeps the original
  // behaviour of rendering when the flag can't be read at all, rather
  // than mysteriously 404ing a feature whose default is on.
  //
  // Rust-core Phase 0: the saved layout now loads inside
  // DashboardLayoutEditor from GET /api/dashboard/layout, falling back
  // to DEFAULT_LAYOUT — the same tolerance the server read had.
  const t = useTranslations("dashboard.layout_editor");
  return (
    <>
      <Nav />
      <RequireFlagGate failOpen flag="flag.dashboard.layout_editor.visible">
        <div className="page-container">
          <header className="layout-editor-page-header">
            <Link className="layout-editor-back-link" href="/dashboard">
              {t("back_to_dashboard")}
            </Link>
            <h1 className="page-title">{t("page_title")}</h1>
            <p className="page-subtitle">{t("page_subtitle")}</p>
          </header>
          <DashboardLayoutEditor />
        </div>
      </RequireFlagGate>
    </>
  );
}
