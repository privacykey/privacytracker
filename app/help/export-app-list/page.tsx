import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help_export");
  return {
    title: t("metadata_title"),
    description: t("metadata_description"),
  };
}

function Step({
  number,
  children,
}: {
  number: number;
  children: React.ReactNode;
}) {
  return (
    <div className="help-step">
      <span className="help-step-num">{number}</span>
      <div>{children}</div>
    </div>
  );
}

export default async function ExportAppListHelpPage() {
  if (resolveFlagFromDb("flag.help.export_guide") !== "on") {
    notFound();
  }
  const t = await getTranslations("help_export");
  return (
    <div className="help-shell">
      <div className="help-card">
        <div className="help-hero">
          <div>
            <div className="help-kicker">{t("kicker")}</div>
            <h1 className="help-title">{t("title")}</h1>
            <p className="help-subtitle">{t("subtitle")}</p>
          </div>
          <Link className="btn btn-secondary" href="/onboard">
            {t("back_to_onboarding")}
          </Link>
        </div>

        <div className="help-grid">
          <section className="help-section">
            <h2 className="help-section-title">{t("mac_section_title")}</h2>
            <p className="help-section-copy">{t("mac_section_copy")}</p>
            <div className="help-steps">
              <Step number={1}>{t("mac_step_1")}</Step>
              <Step number={2}>{t("mac_step_2")}</Step>
              <Step number={3}>{t("mac_step_3")}</Step>
              <Step number={4}>{t("mac_step_4")}</Step>
            </div>
          </section>

          <section className="help-section">
            <h2 className="help-section-title">{t("windows_section_title")}</h2>
            <p className="help-section-copy">{t("windows_section_copy")}</p>
            <div className="help-steps">
              <Step number={1}>{t("windows_step_1")}</Step>
              <Step number={2}>{t("windows_step_2")}</Step>
              <Step number={3}>{t("windows_step_3")}</Step>
              <Step number={4}>{t("windows_step_4")}</Step>
            </div>
          </section>

          <section className="help-section help-section-wide">
            <h2 className="help-section-title">{t("helper_section_title")}</h2>
            <p className="help-section-copy">{t("helper_section_copy")}</p>
            <pre className="help-code">
              <code>
                python3 tools/ios-app-import/export_ios_apps.py --mode backup
              </code>
            </pre>
          </section>

          <section className="help-section help-section-wide">
            <h2 className="help-section-title">{t("device_section_title")}</h2>
            <p className="help-section-copy">{t("device_section_copy")}</p>
            <pre className="help-code">
              <code>
                python3 tools/ios-app-import/export_ios_apps.py --mode device
              </code>
            </pre>
          </section>

          <section className="help-section help-section-wide">
            <h2 className="help-section-title">{t("upload_section_title")}</h2>
            <p className="help-section-copy">{t("upload_section_copy")}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
