import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import Nav from "../../../components/Nav";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ai_disclosure_page");
  return {
    title: t("metadata_title"),
    description: t("metadata_description"),
  };
}

export default async function AiDisclosurePage() {
  if (resolveFlagFromDb("flag.about.ai_disclosure") !== "on") {
    notFound();
  }
  const t = await getTranslations("ai_disclosure_page");
  return (
    <>
      <Nav />
      <div className="ai-disclosure-page">
        <div className="ai-disclosure-shell">
          <nav
            aria-label={t("breadcrumb_aria")}
            className="ai-disclosure-crumbs"
          >
            <Link href="/dashboard">{t("breadcrumb_home")}</Link>
            <span aria-hidden="true">›</span>
            <span>{t("breadcrumb_current")}</span>
          </nav>

          <header className="ai-disclosure-header">
            <h1>{t("title")}</h1>
            <p className="ai-disclosure-lede">{t("lede")}</p>
          </header>

          <section className="ai-disclosure-section">
            <h2>{t("section_used_for_title")}</h2>
            <p>{t("section_used_for_p1")}</p>
            <p>{t("section_used_for_p2")}</p>
          </section>

          <section className="ai-disclosure-section">
            <h2>{t("section_provider_title")}</h2>
            <p>{t("section_provider_intro")}</p>
            <ul className="ai-disclosure-list">
              <li>
                <strong>{t("provider_disabled_label")}</strong>
                {t("provider_disabled_text")}
              </li>
              <li>
                <strong>{t("provider_openai_label")}</strong>
                {t("provider_openai_text")}
              </li>
              <li>
                <strong>{t("provider_anthropic_label")}</strong>
                {t("provider_anthropic_text")}
              </li>
              <li>
                <strong>{t("provider_custom_label")}</strong>
                {t("provider_custom_text")}
              </li>
            </ul>
            <p>
              {t("section_provider_footer_pre")}
              <code>{t("section_provider_footer_code")}</code>
              {t("section_provider_footer_post")}
            </p>
          </section>

          <section className="ai-disclosure-section">
            <h2>{t("section_data_title")}</h2>
            <p>{t("section_data_p1")}</p>
            <p>{t("section_data_p2")}</p>
          </section>

          <section className="ai-disclosure-section">
            <h2>{t("section_accuracy_title")}</h2>
            <p>{t("section_accuracy_p1")}</p>
            <p>{t("section_accuracy_p2")}</p>
          </section>

          <section className="ai-disclosure-section">
            <h2>{t("section_built_title")}</h2>
            <p>{t("section_built_p1")}</p>
            <ul className="ai-disclosure-list">
              <li>
                <strong>{t("model_claude")}</strong>
              </li>
              <li>
                <strong>{t("model_gemini")}</strong>
              </li>
              <li>
                <strong>{t("model_gpt")}</strong>
              </li>
            </ul>
            <p>{t("section_built_p2")}</p>
            <p>{t("section_built_p3")}</p>
          </section>

          <section className="ai-disclosure-section">
            <h2>{t("section_off_title")}</h2>
            <p>
              {t("section_off_pre")}
              <Link
                className="ai-disclosure-inline-link"
                href="/dashboard/settings"
              >
                {t("section_off_settings_link")}
              </Link>
              {t("section_off_post_pre")}
              <strong>{t("section_off_disabled")}</strong>
              {t("section_off_post_suffix")}
            </p>
          </section>

          <footer className="ai-disclosure-footer">
            <p>
              {t("footer_pre")}
              <a
                className="ai-disclosure-inline-link"
                href="https://github.com/privacykey/privacytracker"
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("footer_link")}
              </a>
              {t("footer_post")}
            </p>
          </footer>
        </div>
      </div>
    </>
  );
}
