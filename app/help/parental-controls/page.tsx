import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PARENTAL_RESOURCES } from "@/lib/parental-resources";

export const dynamic = "force-dynamic";

/*
 * Deliberately NOT gated on `flag.guardian.age_rating`: the onboarding band
 * picker links here while the guardian focus is still unsaved (the flag
 * would resolve off and 404 the click). The flag gates every surface that
 * links here; the guide itself is static reference content.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help_parental");
  return {
    title: t("metadata_title"),
    description: t("metadata_description"),
  };
}

export default async function ParentalControlsHelpPage() {
  const t = await getTranslations("help_parental");
  return (
    <div className="help-shell">
      <div className="help-card">
        <div className="help-hero">
          <div>
            <div className="help-kicker">{t("kicker")}</div>
            <h1 className="help-title">{t("title")}</h1>
            <p className="help-subtitle">{t("subtitle")}</p>
          </div>
          <Link className="btn btn-secondary" href="/dashboard">
            {t("back_to_dashboard")}
          </Link>
        </div>

        <div className="help-grid">
          {PARENTAL_RESOURCES.map((resource) => (
            <section className="help-section" key={resource.key}>
              <h2 className="help-section-title">
                {t(`${resource.key}_title`)}
              </h2>
              <p className="help-section-copy">{t(`${resource.key}_copy`)}</p>
              <a
                className="btn btn-ghost btn-sm"
                href={resource.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t(`${resource.key}_link`)} ↗
              </a>
            </section>
          ))}

          <section className="help-section help-section-wide">
            <h2 className="help-section-title">{t("how_we_flag_title")}</h2>
            <p className="help-section-copy">{t("how_we_flag_copy")}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
