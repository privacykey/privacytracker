import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * Bottom-LEFT mirror of {@link KeyboardHint}. Holds the two "site info"
 * disclosures the user asked for:
 *
 *   • Privacy policy — we don't collect any personal data; the page also
 *     lists every third-party endpoint the running service may contact.
 *   • Legal — every bundled dependency and its licence, grouped by
 *     SPDX identifier with a sticky sidebar.
 *
 * Visually mirrors .kbd-hint-anchor (same pill, same blur, same hover)
 * but pinned to the opposite corner so the two hovering footers don't
 * overlap. Hides on narrow viewports for the same reason — the bottom
 * row is already crowded on phones.
 *
 * Server component — pure Link markup, no window access. We want this
 * rendered in the initial HTML so the pages it points at are reachable
 * even before React hydrates, and because these are statutory-style
 * disclosures that shouldn't wait on JS. `getTranslations` is the
 * server-side counterpart of `useTranslations` so the component stays
 * server-rendered.
 */
export default async function SiteInfoHint() {
  const t = await getTranslations("footer");
  return (
    // The parent <footer> in app/layout.tsx already supplies the
    // contentinfo landmark, so this wrapper is just a styled
    // positioning anchor — matching KeyboardHint on the right.
    <div aria-label={t("site_info_aria")} className="site-info-hint-anchor">
      <Link
        className="site-info-hint-link"
        href="/privacy-policy"
        title={t("privacy_policy_title")}
      >
        {t("privacy_policy")}
      </Link>
      <span aria-hidden="true" className="site-info-hint-divider" />
      <Link
        className="site-info-hint-link"
        href="/legal"
        title={t("legal_title")}
      >
        {t("legal")}
      </Link>
      <span aria-hidden="true" className="site-info-hint-divider" />
      {/* Consistent help entry point (WCAG 3.2.6): the bug-report form
          was previously reachable only from /privacy-policy and the 404
          page. Plain template URL with no prefill — GithubIssueLink
          builds a 404-specific title, so it isn't reusable here. Repo
          path duplicated per the GITHUB_REPO convention (see
          app/privacy-policy/page.tsx + GithubIssueLink.tsx); keep all
          of them in sync if the repo is ever renamed. */}
      <a
        className="site-info-hint-link"
        href="https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml"
        rel="noopener noreferrer"
        target="_blank"
        title={t("feedback_title")}
      >
        {t("feedback")}
      </a>
    </div>
  );
}
