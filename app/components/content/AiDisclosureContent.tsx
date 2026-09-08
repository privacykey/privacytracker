"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import Nav from "@/app/components/Nav";
import RequireFlagGate from "@/app/components/RequireFlagGate";

/**
 * Models that co-authored this codebase, oldest first so the list reads as a
 * project timeline.
 *
 * `areas` is how many `area_N` keys the model has under
 * `ai_disclosure_page.built_models.<id>` in the locale bundles. The count
 * lives here rather than in JSON because the bundles hold no arrays — see the
 * flatten() in scripts/check-i18n-parity.mjs, which treats an array as a leaf
 * and would let translated entries silently drift in length. A model with no
 * per-feature breakdown (attribution wasn't recorded in the git trailers) gets
 * 0 and renders as summary copy only.
 *
 * The breakdown itself is derived by hand from Co-Authored-By trailers in the
 * git history; it is not generated at build time, so adding a model here means
 * adding its keys to every locale bundle too.
 */
const BUILT_MODELS: ReadonlyArray<{ id: string; areas: number }> = [
  { id: "opus_4_7", areas: 5 },
  { id: "opus_4_8", areas: 5 },
  { id: "fable_5", areas: 5 },
  { id: "opus_5", areas: 6 },
  { id: "fable_5_1", areas: 2 },
  { id: "gemini", areas: 0 },
  { id: "gpt", areas: 0 },
];

function areaKeys(id: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${id}.area_${i + 1}`);
}

export default function AiDisclosureContent() {
  const t = useTranslations("ai_disclosure_page");
  const tModels = useTranslations("ai_disclosure_page.built_models");
  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.about.ai_disclosure">
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
              {/* Native <details> so the breakdown stays expandable with no
                  JavaScript — this page prerenders statically. */}
              <ul className="ai-disclosure-models">
                {BUILT_MODELS.map(({ id, areas }) => (
                  <li key={id}>
                    <details className="ai-disclosure-model">
                      <summary className="ai-disclosure-model-summary">
                        <span className="ai-disclosure-model-heading">
                          <span className="ai-disclosure-model-name">
                            {tModels(`${id}.name`)}
                          </span>
                          <span className="ai-disclosure-model-role">
                            {tModels(`${id}.role`)}
                          </span>
                        </span>
                      </summary>
                      <div className="ai-disclosure-model-body">
                        <p>{tModels(`${id}.summary`)}</p>
                        {areas > 0 && (
                          <ul className="ai-disclosure-model-areas">
                            {areaKeys(id, areas).map((key) => (
                              <li key={key}>{tModels(key)}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
              <p className="ai-disclosure-note">
                {t("section_built_attribution")}
              </p>
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
      </RequireFlagGate>
    </>
  );
}
