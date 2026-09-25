"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import RequireFlagGate from "@/app/components/RequireFlagGate";

/**
 * When the page was last checked against the code. Bump it whenever a card
 * or a body string changes what the page claims. Rendered through the
 * locale's own month format, so a translated page does not show an English
 * month name.
 */
const LAST_UPDATED = new Date(Date.UTC(2026, 8, 25));

/**
 * /privacy-policy — plain-language statement of what data the app does (and
 * does not) collect, plus a transparent list of every third-party endpoint
 * the running service may contact. Mirrors the two-column sticky-sidebar
 * layout used on /legal so the two disclosure pages feel like one family.
 *
 * A client component since the Phase 0 layout batch: the route prerenders
 * as a static shell and the copy follows the client-resolved locale.
 * Anchor navigation is plain <a href="#…"> links. Cross-page jumps into
 * Settings (#ai-summaries, #policy-scrape-disabled) scroll by hash; the
 * pulse on arrival is a nice-to-have.
 *
 * The card copy (trigger / sends / receives) is English by design; the
 * page chrome, section ledes and "going offline" steps are translated.
 */

// Canonical GitHub repo — referenced from README / SECURITY / Homebrew tap.
// If the repo is ever renamed, update both places.
const GITHUB_REPO = "https://github.com/privacykey/privacytracker";

// Deep-link into Settings with a hash the SettingsView pulse handler
// recognises. Kept as a named constant so the two places we reference it
// (the "Going fully offline" prose + the sidebar entry, if we ever add one)
// don't drift apart.
const SETTINGS_AI_HASH = "/dashboard/settings/policies#ai-summaries";

// The "Disable policy scraping" card. Its id is in GROUP_SECTIONS
// (app/components/settings/section-groups.ts), so the group route scrolls
// straight to it.
const SETTINGS_POLICY_SCRAPING_HASH =
  "/dashboard/settings/policies#policy-scrape-disabled";

// One third-party endpoint the app may call, plus the purpose / trigger /
// data shape. Kept as a typed record so the renderer can group them by
// category and the SSR output stays deterministic.
interface Subprocessor {
  endpoint: string;
  name: string;
  /**
   * "required": the app's main job (checking App Store labels and
   * policies) needs it. "optional": an extra that runs automatically or
   * once configured, which the main job does not need. "on-demand": only
   * when you start it.
   */
  necessity: "required" | "optional" | "on-demand";
  /** Link to the third party's own privacy policy, if they publish one. */
  policyUrl?: string;
  /** What's received back. */
  receives: string;
  /** What's sent in the request body / query string. */
  sends: string;
  /** When the call fires. Helps readers see what they can disable. */
  trigger: string;
}

// Every card below was checked against the code that makes the request
// (September 2026). When you change who the app talks to, when, or what it
// sends, update the matching card in the same PR: the page is only useful
// while it matches the code. Pointers per group:
//   App Store     lib/scraper.ts, lib/compare-scrape.ts, app/api/related-apps
//   Policies      lib/privacy-policy.ts (fetchPolicyRaw, the Wayback copy
//                 step after a fetch), lib/post-app-update-policy-fetch.ts,
//                 app/api/favicon
//   Archives      lib/wayback.ts, lib/historical-import.ts
//   AI            lib/ai-config.ts
//   Webhooks      lib/notification-webhooks.ts
//   Updates       lib/update-check.ts, lib/tauri-updater.ts,
//                 src-tauri/tauri.conf.json (plugins.updater)
// The Rust core (core/src) makes the same requests under the same rules.
const APP_STORE_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Apple iTunes Search API",
    endpoint:
      "itunes.apple.com/search, itunes.apple.com/lookup, itunes.apple.com/<region>/rss/…",
    trigger:
      "When you search for an app by name, when you import apps by bundle identifier (from a connected device, a device backup or an exported app list), when an app's details are refreshed, and when the Compare page suggests top apps in the same category.",
    sends:
      "The name you typed, the bundle identifiers of the apps you import (for example com.example.app), an Apple app ID, or a category ID, plus the App Store region you chose. No cookies, no account or device identifiers.",
    receives:
      "Public App Store catalogue data: app ID, name, developer, icon URL, App Store URL, version, category and price.",
    necessity: "required",
    policyUrl: "https://www.apple.com/legal/privacy/en-ww/",
  },
  {
    name: "Apple App Store web pages",
    endpoint: "apps.apple.com/<region>/app/<slug>/id<id>",
    trigger:
      "Every privacy-label check: when you add an app, when you sync one app or all of them, on the scheduled sync if you turn one on (daily or weekly, in Settings → Sync Schedule or the background setup; off by default), and when the Compare page previews an app you have not added.",
    sends:
      "A standard HTTP GET with a Safari User-Agent. No cookies, no identifiers.",
    receives:
      "The App Store page HTML, which the app reads for the privacy label and the link to the developer's privacy policy.",
    necessity: "required",
  },
  {
    name: "Apple image servers (mzstatic)",
    endpoint: "is1-ssl.mzstatic.com to is5-ssl.mzstatic.com",
    trigger:
      "When your browser shows an app icon. Icons load straight from Apple's servers, not through privacytracker.",
    sends:
      "A standard image request made by your browser. Apple sees your IP address, your browser's User-Agent and at most the web address of your privacytracker install, never which page you were on.",
    receives: "PNG or JPEG icon files.",
    necessity: "required",
  },
];

const POLICY_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Developer privacy policy pages",
    endpoint:
      "Whatever host the developer links to on the App Store page, or the policy link you enter for a manual app",
    trigger:
      "Automatically, a few seconds after an import or App Store sync finishes (including a scheduled sync); when you run a fetch from Settings → Privacy Policies; when you refresh one app from its AI Policy tab; and when you press Scrape privacy policy now on a manual app. Automatic and bulk fetches skip an app whose policy was fetched within the Policy Scrape Throttle window (60 minutes by default). While Disable policy scraping is on (Settings → Policy Scraping), no App Store app's policy is fetched at all; a manual app's Scrape privacy policy now button still works because you press it yourself.",
    sends:
      "A standard HTTP GET with a Safari User-Agent. If the site refuses it, one retry with Chrome browser headers and a Referer of apps.apple.com. No cookies, no identifiers.",
    receives: "The HTML or text of the developer's published privacy policy.",
    necessity: "required",
  },
  {
    name: "Internet Archive: copies of privacy policies",
    endpoint:
      "archive.org/wayback/available, web.archive.org/save/<policy URL>, web.archive.org/web/<timestamp>/<policy URL>",
    trigger:
      "After each successful policy fetch for an App Store app, the app looks up the newest Wayback Machine copy of that policy and asks the Archive to save a fresh one, so the AI Policy and Change History tabs can link to an archived copy. If a developer's site refuses both direct requests, the app reads the policy from the newest Wayback copy instead. None of this happens while policy scraping is disabled.",
    sends:
      "The public address of the developer's privacy policy. No cookies, no identifiers.",
    receives:
      "The address of an archived copy, whether the save request was accepted, or the archived policy page.",
    necessity: "optional",
    policyUrl: "https://archive.org/about/terms.php",
  },
  {
    name: "Website icons for manual apps",
    endpoint:
      "The host of a policy or source link you entered for a manual app",
    trigger:
      "When the Manual Apps list or a manual app's page shows the small site icon beside its links. The privacytracker server fetches the icon, not your browser, and remembers the result for up to a day.",
    sends:
      "A standard HTTP GET for the site's home page (to find its icon) and for the icon itself, with a User-Agent naming privacytracker. No cookies, no identifiers.",
    receives: "The site's home page HTML and its icon image.",
    necessity: "optional",
  },
];

const ARCHIVE_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Internet Archive: Wayback CDX index",
    endpoint: "web.archive.org/cdx/search/cdx",
    trigger:
      "When you run a label-history import (Settings → Historical Import, or Check the archive on an app's Change History tab), including an import that resumes after a restart. One request per app lists the archived copies of its App Store page.",
    sends:
      "The App Store URL of the app being back-filled. No cookies, no identifiers.",
    receives: "A list of the dates the Archive captured that page.",
    necessity: "on-demand",
    policyUrl: "https://archive.org/about/terms.php",
  },
  {
    name: "Internet Archive: Wayback availability API",
    endpoint: "archive.org/wayback/available",
    trigger:
      "During a label-history import, only when the CDX index cannot be read: the import then asks for the capture closest to each target date instead.",
    sends:
      "The App Store URL being back-filled and a target date. No cookies, no identifiers.",
    receives: "The address of the capture closest to that date.",
    necessity: "on-demand",
  },
  {
    name: "Internet Archive: Wayback Machine replay",
    endpoint: "web.archive.org/web/<timestamp>id_/<original>",
    trigger:
      "During a label-history import, to download each chosen capture so it can be read like a live App Store page.",
    sends: "A standard HTTP GET.",
    receives:
      "The archived App Store HTML, without the Wayback toolbar (the id_ suffix).",
    necessity: "on-demand",
  },
  {
    name: "Internet Archive: Save Page Now",
    endpoint: "web.archive.org/save/<url>",
    trigger:
      "At the end of a label-history import, at most once per app, and only when the Archive has no copy of that app's page from the last 45 days. The app asks the Archive to capture today's page for future imports.",
    sends: "The public App Store URL of the app. Nothing else.",
    receives:
      "Whether the Archive accepted the request. Nothing is stored beyond a note on the app's Change History tab.",
    necessity: "on-demand",
  },
];

// Update checks. The server-side check runs on a timer with no switch in
// Settings; `update_check_enabled = false` in app_settings is the only way
// to stop it (lib/update-check.ts). The desktop updater is reached only
// from the update banner's Install & restart button, which the banner shows
// only when that server-side check found a newer release.
const UPDATE_CHECK_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "GitHub Releases API",
    endpoint: "api.github.com/repos/privacykey/privacytracker/releases/latest",
    trigger:
      "Automatically, while the server runs: it looks about 25 seconds after start-up and then every 6 hours, but only asks GitHub again once the last successful answer is more than 24 hours old (after a failure it waits 15 minutes, then longer). There is no switch in Settings yet; it stops when update_check_enabled is set to false in the app's database.",
    sends:
      "A standard HTTP GET with a User-Agent naming privacytracker and the version you run. No cookies, no API token, no machine identifier.",
    receives:
      "Details of the newest published release: version, release notes and links.",
    necessity: "optional",
    policyUrl:
      "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
  },
  {
    name: "GitHub release downloads (desktop app updater)",
    endpoint:
      "github.com/privacykey/privacytracker/releases/latest/download/latest-v2.json, then the update file from github.com",
    trigger:
      "Desktop app only, and only when you press Install & restart on the update banner. The banner appears only after the release check above finds a newer version, so turning that check off turns this off too.",
    sends:
      "A standard HTTPS GET for the update manifest, then one for the update file, which GitHub may serve from its own download host. The addresses carry no version, device or user identifier.",
    receives:
      "The update manifest (version, notes, download address and signature), then the signed update. The app checks the signature and refuses any version that is not newer than the one you run.",
    necessity: "on-demand",
    policyUrl:
      "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
  },
];

const AI_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "OpenAI API",
    endpoint: "api.openai.com",
    trigger:
      "Only after you choose OpenAI in Settings → AI Policy Summaries and enter your own API key. Then a policy is sent when you ask for its summary, from an app's AI Policy tab or Settings → Privacy Policies, and during your first import if Summarize policies during first import is on.",
    sends:
      "The app's name, its developer and its policy address, the fetched policy text, and a structured-summary prompt (which also asks for a child-safety summary when your focus is on a child), with your API key in the request header. Nothing about your other apps or your device.",
    receives:
      "A JSON summary keyed by the lenses defined in lib/privacy-policy.ts.",
    necessity: "optional",
    policyUrl: "https://openai.com/policies/privacy-policy",
  },
  {
    name: "Anthropic API",
    endpoint: "api.anthropic.com",
    trigger:
      "Only after you choose Anthropic in Settings → AI Policy Summaries and enter your own API key, at the same moments as above.",
    sends:
      "The same as for OpenAI: app name, developer, policy address, policy text and summary prompt, with your API key in the request header.",
    receives: "A JSON summary.",
    necessity: "optional",
    policyUrl: "https://www.anthropic.com/legal/privacy",
  },
  {
    name: "Custom or local AI endpoint (Ollama or any OpenAI-compatible server)",
    endpoint: "Whatever base URL you configure (default 127.0.0.1:11434)",
    trigger:
      "Only after you choose Own Model in Settings → AI Policy Summaries. Meant for local models: when the endpoint runs on your own machine or network, the policy text stays there.",
    sends: "The same as for OpenAI, plus the API key if you entered one.",
    receives: "A JSON summary.",
    necessity: "optional",
  },
];

// Webhooks the user adds in the background setup wizard
// (BackgroundModeWizard). Unlike every other card, these requests carry the
// user's own data (app names and change summaries) by design, so the card
// says so plainly.
const WEBHOOK_SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Your notification webhook (Slack, Discord, Microsoft Teams or any URL)",
    endpoint: "The webhook URL you paste",
    trigger:
      "Only if you add a webhook while setting up background mode (Keep privacytracker running in the background). It posts each change as it happens, or a daily or weekly summary, depending on the frequency you pick, plus one test message when you press Test webhook. Clear the URL to stop it.",
    sends:
      "The notifications themselves: the names of the apps that changed and a short summary of each change, formatted for the service you picked.",
    receives: "A status code, used only to tell you whether the post worked.",
    necessity: "optional",
  },
];

// "What we collect from you" is intentionally short. The long list used to
// enumerate every category we don't touch (ads, data brokers, tracking
// pixels, cookies, etc.) but that became noise; the meta-statement here
// is enough, and the detail lives in the subprocessor table below.
const OUT_OF_SCOPE: { title: string; detail: string }[] = [
  {
    title: "No analytics, telemetry, or tracking cookies",
    detail:
      "There's no Google Analytics, Plausible, Mixpanel, Sentry, PostHog, Segment, or any other telemetry pipeline. No tracking pixels, no advertising cookies, and no crash-reporting backend. The app doesn't phone home about your usage, device, or errors. Accessibility preferences (theme, font scale, dyslexic font) are stored in your browser's localStorage and your language choice in a cookie, so they survive reloads; they never leave your device.",
  },
  {
    title: "No user accounts",
    detail:
      "There is nothing to register: no user list, no email, no profile. The desktop app, and a local install that only listens on this computer, open without signing in. A Docker install, an install other devices on your network can reach, or any install whose operator set an admin token (AUDITOR_ADMIN_TOKEN) shows a sign-in page that asks for that token. It is one shared password for the install, not an account. After you sign in, the token is kept in a cookie that only this install reads, and the sign-in is written to an audit log in the same local database (with your browser's User-Agent, and an IP address only when a trusted proxy supplies one). Nothing about signing in is sent anywhere else. Everything else, from the apps you track to the privacy-label history and your AI settings, lives in a single SQLite file on the machine running privacytracker.",
  },
];

// Every card group rendered below, so the sidebar count cannot miss one.
const ALL_SUBPROCESSOR_GROUPS: Subprocessor[][] = [
  APP_STORE_SUBPROCESSORS,
  POLICY_SUBPROCESSORS,
  ARCHIVE_SUBPROCESSORS,
  AI_SUBPROCESSORS,
  WEBHOOK_SUBPROCESSORS,
  UPDATE_CHECK_SUBPROCESSORS,
];

// Sidebar entries. Kept here so the sidebar renders in a stable order and
// so the "Jump to" links stay in sync with the section IDs used below.
//
// Labels carry translation keys (under `privacy_policy_page.sections.*`)
// instead of pre-rendered strings so the sidebar localises with the
// active locale. The `hint` for the third-parties row stays inline
// because it's a numeric count (locale-agnostic).
const SIDEBAR_SECTIONS: {
  id: string;
  labelKey: string;
  hintKey?: string;
  hint?: string;
}[] = [
  {
    id: "priv-nothing",
    labelKey: "what_we_collect",
    hintKey: "what_we_collect_hint",
  },
  {
    id: "priv-subprocessors",
    labelKey: "third_parties",
    hint: `${ALL_SUBPROCESSOR_GROUPS.reduce((n, group) => n + group.length, 0)}`,
  },
  { id: "priv-self-host", labelKey: "going_offline" },
  { id: "priv-alternatives", labelKey: "other_summarisers" },
  { id: "priv-questions", labelKey: "questions" },
];

/** Necessity chip: Required / Optional / On demand. */
function NecessityChip({ value }: { value: Subprocessor["necessity"] }) {
  const tField = useTranslations("privacy_policy_page.subproc_field");
  const label =
    value === "required"
      ? tField("necessity_required")
      : value === "optional"
        ? tField("necessity_optional")
        : tField("necessity_on_demand");
  return <span className={`priv-nec-chip priv-nec-${value}`}>{label}</span>;
}

function SubprocessorCard({ s }: { s: Subprocessor }) {
  // Field labels translate; the per-row `s.trigger`/`s.sends`/`s.receives`
  // copy is dense per-endpoint commentary that stays English in v1 (they
  // describe network behaviour with technical jargon — separate
  // translation pass alongside copy review).
  const tField = useTranslations("privacy_policy_page.subproc_field");
  return (
    <article className="priv-subproc-card">
      <header className="priv-subproc-head">
        <h3 className="priv-subproc-name">{s.name}</h3>
        <NecessityChip value={s.necessity} />
      </header>
      <code className="priv-subproc-endpoint">{s.endpoint}</code>
      <dl className="priv-subproc-grid">
        <dt>{tField("trigger")}</dt>
        <dd>{s.trigger}</dd>
        <dt>{tField("sends")}</dt>
        <dd>{s.sends}</dd>
        <dt>{tField("receives")}</dt>
        <dd>{s.receives}</dd>
      </dl>
      {s.policyUrl && (
        <p className="priv-subproc-policy">
          <a href={s.policyUrl} rel="noopener noreferrer" target="_blank">
            {tField("policy_link")}
          </a>
        </p>
      )}
    </article>
  );
}

export default function PrivacyPolicyContent() {
  // Round 3 PR 6.1: gate on `flag.legal.privacy_policy_page`. Default
  // behaviour is on (the page is universal); toggling off in Dev Options
  // returns a 404. Note: this is gateable but in practice should stay on
  // for every focus to avoid shipping a privacy auditor without a
  // privacy-policy disclosure of its own. The flag exists so OEM /
  // embedded builds can hide the route if needed.
  // i18n — server-side translations. The page chrome (back link,
  // hero title/subtitle, sidebar, section headings) reads from the
  // `privacy_policy_page` namespace. Section bodies + sub-section
  // ledes pull from `bodies.*`; subprocessor card field labels
  // come from `subproc_field.*`.
  const t = useTranslations("privacy_policy_page");
  const tSec = useTranslations("privacy_policy_page.sections");
  const tBody = useTranslations("privacy_policy_page.bodies");

  const format = useFormatter();
  const lastUpdated = format.dateTime(LAST_UPDATED, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // Pre-filled issue URL. Round 3 PR 5: the standalone `privacy-policy.yml`
  // template merged into the main `bug_report.yml`, which now has a
  // `report-type` dropdown ("Privacy policy concern or correction" et al.).
  // We route through that template so GitHub renders the structured form
  // and pre-select the privacy-policy concern via the dropdown's prefill
  // param. `source-page` survives as a free-text breadcrumb. Avoid
  // stuffing title/body with HTML-shaped strings (e.g. `<!-- comment -->`)
  // — browser XSS heuristics and some corporate proxies flag `<!--` in
  // URL query params and block the click, even though GitHub would have
  // rendered it as an innocuous comment.
  const SOURCE_PAGE = "/privacy-policy";
  const issueUrl =
    `${GITHUB_REPO}/issues/new` +
    "?template=bug_report.yml" +
    `&report-type=${encodeURIComponent("Privacy policy concern or correction")}` +
    `&source-page=${encodeURIComponent(SOURCE_PAGE)}`;

  return (
    <RequireFlagGate flag="flag.legal.privacy_policy_page">
      <div className="privacy-policy-page">
        <header className="priv-page-hero">
          <Link className="priv-back-link" href="/">
            {t("back_to_app")}
          </Link>
          <p className="priv-eyebrow">{t("eyebrow")}</p>
          <h1 className="priv-page-title">{t("title")}</h1>
          <p className="priv-page-sub">{t("subtitle")}</p>
          <p className="priv-page-meta">
            {t("last_updated", { date: lastUpdated })}
          </p>
        </header>

        <div className="legal-layout">
          <aside aria-label={t("sidebar_aria")} className="legal-sidebar">
            <p className="legal-sidebar-title">{t("sidebar_jump")}</p>
            <ul className="legal-sidebar-list">
              {SIDEBAR_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a className="legal-sidebar-link" href={`#${section.id}`}>
                    <span>{tSec(section.labelKey)}</span>
                    {section.hintKey && (
                      <span className="legal-sidebar-count">
                        {tSec(section.hintKey)}
                      </span>
                    )}
                    {section.hint && !section.hintKey && (
                      <span className="legal-sidebar-count">
                        {section.hint}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </aside>

          <div className="legal-content">
            {/* App Store-style "Data Not Collected" callout. Mirrors the
              shape of Apple's privacy nutrition card on the App Store
              listing so the page opens with the exact disclosure users
              already trust. Centred above the prose, role="img" with an
              aria-label so screen readers announce the disclosure as a
              single unit instead of three orphan strings. The same card
              shape lives on the marketing site
              (privacytracker website/privacy.html) — keep them in sync. */}
            <div
              aria-label={t("disclosure.aria")}
              className="priv-disclosure-callout"
              role="img"
            >
              <svg
                aria-hidden="true"
                className="priv-disclosure-tick"
                fill="none"
                focusable="false"
                height="52"
                viewBox="0 0 52 52"
                width="52"
              >
                <circle
                  cx="26"
                  cy="26"
                  r="23"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  d="M15 27 L22 34 L37 19"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="4"
                />
              </svg>
              <h2 className="priv-disclosure-title">{t("disclosure.title")}</h2>
              <p className="priv-disclosure-body">{t("disclosure.body")}</p>
            </div>

            <section
              aria-labelledby="priv-nothing-heading"
              className="priv-section"
              id="priv-nothing"
            >
              <h2 className="priv-section-title" id="priv-nothing-heading">
                {tSec("what_we_collect_full")}
              </h2>
              <p className="priv-section-lede priv-section-lede-strong">
                {tBody("nothing_lede")}
              </p>
              <p className="priv-section-body">
                {tBody.rich("nothing_body", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
              <ul className="priv-out-of-scope-list">
                {OUT_OF_SCOPE.map((item) => (
                  <li className="priv-out-of-scope-item" key={item.title}>
                    <div className="priv-out-of-scope-title">{item.title}</div>
                    <div className="priv-out-of-scope-detail">
                      {item.detail}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section
              aria-labelledby="priv-subprocessors-heading"
              className="priv-section"
              id="priv-subprocessors"
            >
              <h2
                className="priv-section-title"
                id="priv-subprocessors-heading"
              >
                {tSec("third_parties_full")}
              </h2>
              <p className="priv-section-lede">{tBody("third_parties_lede")}</p>
              <p className="priv-section-body">
                {tBody.rich("third_parties_body", {
                  em: (chunks) => <em>{chunks}</em>,
                })}
              </p>

              <h3 className="priv-subsection-title">
                {tSec("appstore_metadata")}
              </h3>
              <p className="priv-subsection-sub">{tBody("appstore_sub")}</p>
              <div className="priv-subproc-grid-wrap">
                {APP_STORE_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>

              <h3 className="priv-subsection-title">
                {tSec("developer_policies")}
              </h3>
              <p className="priv-subsection-sub">{tBody("developer_sub")}</p>
              <div className="priv-subproc-grid-wrap">
                {POLICY_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>

              <h3 className="priv-subsection-title">
                {tSec("historical_archives")}
              </h3>
              <p className="priv-subsection-sub">{tBody("archives_sub")}</p>
              <div className="priv-subproc-grid-wrap">
                {ARCHIVE_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>

              <h3 className="priv-subsection-title">{tSec("ai_providers")}</h3>
              <p className="priv-subsection-sub">
                {tBody("ai_sub_prefix")}{" "}
                <Link className="priv-inline-link" href={SETTINGS_AI_HASH}>
                  {tBody("ai_sub_settings_link")}
                </Link>
                {tBody("ai_sub_suffix")}
              </p>
              <div className="priv-subproc-grid-wrap">
                {AI_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>

              <h3 className="priv-subsection-title">{tSec("webhooks")}</h3>
              <p className="priv-subsection-sub">{tBody("webhooks_sub")}</p>
              <div className="priv-subproc-grid-wrap">
                {WEBHOOK_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>

              <h3 className="priv-subsection-title">{tSec("update_check")}</h3>
              <p className="priv-subsection-sub">
                {tBody.rich("update_check_sub", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
              <div className="priv-subproc-grid-wrap">
                {UPDATE_CHECK_SUBPROCESSORS.map((s) => (
                  <SubprocessorCard key={s.name} s={s} />
                ))}
              </div>
            </section>

            <section
              aria-labelledby="priv-self-host-heading"
              className="priv-section"
              id="priv-self-host"
            >
              <h2 className="priv-section-title" id="priv-self-host-heading">
                {tSec("going_offline_full")}
              </h2>
              <p className="priv-section-body">
                {tBody.rich("going_offline_p1", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
              <p className="priv-section-body">{tBody("going_offline_p2")}</p>
              <ul className="priv-offline-steps">
                <li>
                  {tBody.rich("going_offline_step_ai", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    settings: (chunks) => (
                      <Link
                        className="priv-inline-link priv-inline-link-settings"
                        href={SETTINGS_AI_HASH}
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </li>
                <li>
                  {tBody.rich("going_offline_step_policies", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    settings: (chunks) => (
                      <Link
                        className="priv-inline-link priv-inline-link-settings"
                        href={SETTINGS_POLICY_SCRAPING_HASH}
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </li>
                <li>
                  {tBody.rich("going_offline_step_wayback", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </li>
                <li>
                  {tBody.rich("going_offline_step_webhooks", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </li>
                <li>
                  {tBody.rich("going_offline_step_updates", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    code: (chunks) => <code>{chunks}</code>,
                  })}
                </li>
              </ul>
              <p className="priv-section-body">{tBody("going_offline_p3")}</p>
            </section>

            <section
              aria-labelledby="priv-alternatives-heading"
              className="priv-section"
              id="priv-alternatives"
            >
              <h2 className="priv-section-title" id="priv-alternatives-heading">
                {tSec("other_summarisers_full")}
              </h2>
              <p className="priv-section-body">{tBody("alternatives_p1")}</p>
              <ul className="priv-offline-steps">
                <li>
                  {tBody.rich("alternatives_tosdr", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    tosdr: (chunks) => (
                      <a
                        className="priv-inline-link"
                        href="https://tosdr.org/"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {chunks}
                      </a>
                    ),
                  })}
                </li>
                <li>
                  {tBody.rich("alternatives_privacyspy", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    privacyspy: (chunks) => (
                      <a
                        className="priv-inline-link"
                        href="https://privacyspy.org/"
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {chunks}
                      </a>
                    ),
                  })}
                </li>
              </ul>
              <p className="priv-section-body">
                {tBody.rich("alternatives_p2", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  em: (chunks) => <em>{chunks}</em>,
                  tosdr: (chunks) => (
                    <a
                      className="priv-inline-link"
                      href="https://tosdr.org/"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {chunks}
                    </a>
                  ),
                  privacyspy: (chunks) => (
                    <a
                      className="priv-inline-link"
                      href="https://privacyspy.org/"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </p>
            </section>

            <section
              aria-labelledby="priv-questions-heading"
              className="priv-section"
              id="priv-questions"
            >
              <h2 className="priv-section-title" id="priv-questions-heading">
                {tSec("questions_full")}
              </h2>
              <p className="priv-section-body">
                {tBody.rich("questions_p1", {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
              <p className="priv-section-body">
                <a
                  className="priv-cta-button"
                  href={issueUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open an issue on GitHub ↗
                </a>
              </p>
              <p className="priv-section-body" style={{ marginTop: 12 }}>
                The full list of bundled libraries and their licences is on the{" "}
                <Link className="priv-inline-link" href="/legal">
                  Legal page
                </Link>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
    </RequireFlagGate>
  );
}
