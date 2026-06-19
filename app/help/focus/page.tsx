import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import PurposeCardScene from "../../components/PurposeCardScene";

export const metadata: Metadata = {
  title: "Your Focus — privacytracker",
  description:
    "How the choices you make on the welcome screen — what you want to do, who it's for, and which features you want — tailor the dashboard, what each option means, and how to change it.",
};

/**
 * /help/focus — explainer for the two-axis focus system.
 *
 * Layout mirrors /legal and /privacy-policy: a hero (eyebrow + title +
 * lede), a sticky sidebar with anchor links to each section, and a wide
 * content column. Reusing the `.legal-page` / `.legal-layout` /
 * `.legal-sidebar` / `.legal-license-group` primitives keeps the help
 * surface visually inside the same family as the disclosure pages so
 * users moving between them don't get tonal whiplash.
 *
 * The class names trace back to /legal where these primitives were
 * defined; they're layout-only (margin, sticky sidebar, divider rules,
 * h2 sizing) so reusing them for help content is fine — the
 * `.legal-license-*` names are historical, not load-bearing.
 *
 * Static content — no DB reads, can render at build time. We keep
 * `force-dynamic` off so the page is fast on first paint.
 */

interface SidebarSection {
  id: string;
  /** Translation key under `help_focus_page.sections.*` so the sidebar
   *  localises with the active locale. Each id below intentionally
   *  matches an existing section heading id in the page body. */
  labelKey: "what_is" | "audiences" | "goals" | "accessibility" | "tour";
}

const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: "what-is", labelKey: "what_is" },
  { id: "audiences", labelKey: "audiences" },
  { id: "goals", labelKey: "goals" },
  { id: "accessibility", labelKey: "accessibility" },
  { id: "tour", labelKey: "tour" },
];

export default async function HelpFocusPage() {
  // i18n — page chrome (back link, eyebrow, title, subtitle, sidebar
  // aria + heading list). Section bodies remain English for now;
  // they're dense explanatory copy that warrants a careful content
  // pass, tracked separately under deferred long-form translations.
  const t = await getTranslations("help_focus_page");
  const tSec = await getTranslations("help_focus_page.sections");
  // Reuse the /welcome purpose animations to illustrate the goals section.
  const tPurpose = await getTranslations("focus_purpose");
  const tAnim = await getTranslations("focus_purpose.animation");
  // The live form randomises the monitor scene's "what changed" line; here
  // one representative example is enough.
  const sceneProps = {
    deleteLabel: tAnim("cleanup.delete"),
    helpDetail: tAnim("help.detail"),
    helpTitle: tAnim("help.title"),
    monitorChangeText: tAnim("monitor.change", {
      app: "ShoeDrop",
      label: tAnim("labels.location"),
    }),
    monitorTitle: tAnim("monitor.title"),
  };
  return (
    <div className="legal-page">
      <header className="legal-page-hero">
        <Link className="priv-back-link" href="/dashboard">
          {t("back_to_dashboard")}
        </Link>
        <p className="priv-eyebrow">{t("eyebrow")}</p>
        <h1 className="legal-page-title">{t("title")}</h1>
        <p className="legal-page-sub">
          {t.rich("subtitle", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <div className="legal-layout">
        <aside aria-label={t("sidebar_aria")} className="legal-sidebar">
          <p className="legal-sidebar-title">{t("sidebar_jump")}</p>
          <ul className="legal-sidebar-list">
            {SIDEBAR_SECTIONS.map((s) => (
              <li key={s.id}>
                <a className="legal-sidebar-link" href={`#${s.id}`}>
                  <span>{tSec(s.labelKey)}</span>
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <div className="legal-content">
          <section
            aria-labelledby="what-is-heading"
            className="legal-license-group"
            id="what-is"
          >
            <header className="legal-license-head">
              <h2 className="legal-license-name" id="what-is-heading">
                {tSec("what_is")}
              </h2>
              <p className="legal-license-blurb">
                A small bundle of preferences — what you want to do, who
                it&rsquo;s for, and which individual features you want — that
                the app uses to decide what to show, what to hide, and what to
                highlight.
              </p>
            </header>
            <p>
              You set it on the welcome screen (or skip and accept the
              defaults), and you can change it any time from{" "}
              <Link href="/dashboard/settings#focus">
                Settings → Your focus
              </Link>
              .
            </p>
            <p>
              Every individual feature is also yours to flip. The focus screen
              has a row of feature toggles for the common ones (AI summaries,
              Compare, Privacy Map, and so on), and you can change any feature
              under{" "}
              <Link href="/dashboard/settings#feature-flags">
                Developer Options → Feature flags
              </Link>
              . A feature you switch on or off there wins over what your goals
              would set.
            </p>
          </section>

          <section
            aria-labelledby="audiences-heading"
            className="legal-license-group"
            id="audiences"
          >
            <header className="legal-license-head">
              <h2 className="legal-license-name" id="audiences-heading">
                {tSec("audiences")}
              </h2>
              <p className="legal-license-blurb">
                Who the apps you&rsquo;re auditing belong to. Picks the default
                surface area — power-user controls vs. simpler maintenance view.
              </p>
            </header>
            <ul className="legal-bullets">
              <li>
                <strong>For me</strong> — you&rsquo;re auditing your own apps
                and you&rsquo;ll act on what you find. Default: full surface,
                all power-user controls available.
              </li>
              <li>
                <strong>For someone I care about</strong> — you&rsquo;re
                checking apps for another adult who&rsquo;ll make their own
                call. Default: share/export features elevated so you can hand
                recommendations over; the audit-bundle export is enabled,
                letting you ship findings as a JSON file the recipient imports
                into their own copy of the app.
              </li>
              <li>
                <strong>For a child or dependant</strong> — you&rsquo;re
                responsible for someone else&rsquo;s device. Default: simpler
                surface — keyboard shortcuts, the Compare page, debug logs, and
                the technical-feeling parts of the app are hidden so casual
                maintenance is straightforward. None of it is locked, though;
                flip anything back on via Developer Options.
              </li>
            </ul>
          </section>

          <section
            aria-labelledby="goals-heading"
            className="legal-license-group"
            id="goals"
          >
            <header className="legal-license-head">
              <h2 className="legal-license-name" id="goals-heading">
                {tSec("goals")}
              </h2>
              <p className="legal-license-blurb">
                What you want out of the app. Pick more than one if you like —
                except &ldquo;just the basics&rdquo;, which is mutually
                exclusive with the others.
              </p>
            </header>
            <div className="help-focus-scenes">
              {(["monitor", "cleanup", "help"] as const).map((p) => (
                <figure className="help-focus-scene" key={p}>
                  <PurposeCardScene {...sceneProps} purpose={p} />
                  <figcaption>{tPurpose(`primary.${p}.title`)}</figcaption>
                </figure>
              ))}
            </div>
            <p>
              On the welcome screen you pick{" "}
              <strong>what you&rsquo;d like to do</strong> — and you can choose
              more than one. <em>Monitor my apps for changes</em> and{" "}
              <em>Clean up my phone</em> each switch on the tools below.{" "}
              <em>Help a friend</em> is about <em>who</em> you&rsquo;re checking
              for rather than a tool — it sets the audience to someone else (see{" "}
              <a href="#audiences">Audiences</a> above).{" "}
              <strong>Keep it minimal</strong> is a separate switch that strips
              things back, so it can&rsquo;t be combined with the others.
            </p>
            <ul className="legal-bullets">
              <li>
                <strong>Monitor my apps for changes</strong> — we keep an eye on
                your apps and tell you when one starts asking for more. You get
                a timeline, plain-language policy summaries, history charts, and
                notifications.
              </li>
              <li>
                <strong>Clean up my phone</strong> — we spot the apps that take
                the most and put them first, with risk labels, profile-mismatch
                flags, and a hand to remove or replace them. Low-severity apps
                tuck away so the decisions worth making stay up top.
              </li>
              <li>
                <strong>Keep it minimal</strong> — a deliberately quiet view.
                Hides the extras — Compare, Privacy Map, Manual Apps, the Task
                Center, and most of the chrome — so you get a quick health
                check, not a deep dive.
              </li>
            </ul>
          </section>

          <section
            aria-labelledby="accessibility-heading"
            className="legal-license-group"
            id="accessibility"
          >
            <header className="legal-license-head">
              <h2 className="legal-license-name" id="accessibility-heading">
                {tSec("accessibility")}
              </h2>
              <p className="legal-license-blurb">
                Sits on top of any goal combination above and elevates
                accessibility-related surfaces independently.
              </p>
            </header>
            <p>
              Tick <strong>I also need accessibility info for my apps</strong>.
              This elevates the accessibility panel on app detail pages, turns
              on the accessibility filter row in the app grid, auto-shows the
              accessibility-profile setup step in onboarding, and enables the
              accessibility-changes notification type. It works alongside any
              primary goal, and accessibility wins locally even when &ldquo;just
              the basics&rdquo; would otherwise hide it.
            </p>
          </section>

          <section
            aria-labelledby="tour-heading"
            className="legal-license-group"
            id="tour"
          >
            <header className="legal-license-head">
              <h2 className="legal-license-name" id="tour-heading">
                {tSec("tour")}
              </h2>
              <p className="legal-license-blurb">
                Want a refresher on what you&rsquo;re looking at?
              </p>
            </header>
            <p>
              <Link className="welcome-link" href="/dashboard?tour=1">
                Replay the dashboard tour →
              </Link>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
