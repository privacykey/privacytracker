"use client";

import { useTranslations } from "next-intl";
import { isSafeExternalHref } from "../../../lib/safe-href";

/**
 * Fallback "other privacy ratings" links. Whenever the developer's own
 * policy page is blocked, redirected to a cookie-wall, or too short to
 * summarize, we still want the user to reach a curated second-opinion
 * source without hand-crafting a search. ToS;DR and PrivacySpy are both
 * community-maintained registries of privacy policies and each accepts a
 * search query in its URL, so we can deep-link directly to the app's
 * candidate page in either service.
 *
 * The URL shapes here are intentionally the public search pages — not the
 * REST APIs — so these links keep working even if the services reshape
 * their JSON schemas.
 */
interface FallbackReferenceLink {
  label: string;
  source: "tosdr" | "privacyspy";
  summary: string;
  url: string;
}

type FallbackT = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

function buildFallbackReferenceLinks(
  t: FallbackT,
  app: {
    name: string;
    developer?: string;
  }
): FallbackReferenceLink[] {
  const rawName = (app.name || "").trim();
  const rawDev = (app.developer || "").trim();
  const query = (rawName || rawDev).trim();
  if (!query) {
    return [];
  }
  const q = encodeURIComponent(query);
  // ToS;DR / PrivacySpy are brand names — kept verbatim. The localised
  // {subject} fallback ("this service" / "此服务") flows through when the
  // app row has no name or developer to plug into the summary line.
  const subject = rawName || rawDev || t("fallback_subject_default");

  return [
    {
      source: "tosdr",
      label: "ToS;DR",
      url: `https://tosdr.org/en/search?query=${q}`,
      summary: t("fallback_summary_tosdr", { subject }),
    },
    {
      source: "privacyspy",
      label: "PrivacySpy",
      url: `https://privacyspy.org/?search=${q}`,
      summary: t("fallback_summary_privacyspy", { subject }),
    },
  ];
}

export default function PolicyFallbackReferences({
  app,
  hasSummary,
}: {
  app: { name: string; developer?: string };
  hasSummary: boolean;
}) {
  const tDetail = useTranslations("app_detail");
  const tPolicyMeta = useTranslations("app_detail.policy_meta");
  const links = buildFallbackReferenceLinks(tPolicyMeta, app);
  if (links.length === 0) {
    return null;
  }

  return (
    <div className="policy-fallback-references">
      <div className="policy-fallback-heading">
        {hasSummary
          ? tDetail("policy_meta.fallback_with_summary")
          : tDetail("policy_meta.fallback_no_summary")}
      </div>
      <div className="policy-reference-list">
        {links
          .filter((link) => isSafeExternalHref(link.url))
          .map((link) => (
            <a
              className={`policy-reference-card policy-reference-card-${link.source}`}
              href={link.url}
              key={link.source}
              rel="noopener noreferrer"
              target="_blank"
            >
              <div className="policy-reference-top">
                <span className="policy-reference-label">{link.label}</span>
                <span className="policy-reference-score">
                  {tDetail("policy_search_link")}
                </span>
              </div>
              <p className="policy-reference-copy">{link.summary}</p>
            </a>
          ))}
      </div>
    </div>
  );
}
