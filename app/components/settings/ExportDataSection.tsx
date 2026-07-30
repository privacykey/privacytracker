"use client";

/**
 * Data-export card: raw CSV/JSON dumps plus the audit-bundle export.
 *
 * The outer `flag.settings.admin.export` gate stays in SettingsView with
 * the other section gates — this component assumes it is being rendered.
 * `AuditBundleExport` runs its own client-side flag probe (the client
 * `useFlag` cache returns hard defaults on a fresh load), and the server
 * enforces the same gate authoritatively, so the UI gate is cosmetic.
 *
 * Anchor id `export-data` matches the SettingsSidebar entry — see
 * ./README.md.
 */

import { useTranslations } from "next-intl";
import AuditBundleExport from "../AuditBundleExport";

export default function ExportDataSection({
  auditPdfOn,
}: {
  /** `flag.settings.admin.export.audit_pdf` — a Wave I placeholder. The
   *  flag is wired so anyone who flips it on sees a "coming soon"
   *  affordance and the rendering path stays exercised. */
  auditPdfOn: boolean;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tExportCard = useTranslations("settings.export_card");

  return (
    <div className="settings-section" id="export-data">
      <h2 className="settings-section-title">{tSections("export_data")}</h2>
      <p className="settings-section-subtitle">{tSub("export_data")}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <a className="btn btn-secondary" download href="/api/export?format=csv">
          {tExportCard("csv")}
        </a>
        <a
          className="btn btn-secondary"
          download
          href="/api/export?format=json"
        >
          {tExportCard("json")}
        </a>
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--text-3)",
          marginTop: 12,
        }}
      >
        {tExportCard("formats_note")}
      </p>

      <AuditBundleExport />
      {auditPdfOn && (
        <button
          className="btn btn-secondary"
          disabled
          style={{ marginLeft: 8 }}
          title={tExportCard("audit_pdf_unavailable_title")}
          type="button"
        >
          {tExportCard("audit_pdf_coming_soon")}
        </button>
      )}
    </div>
  );
}
