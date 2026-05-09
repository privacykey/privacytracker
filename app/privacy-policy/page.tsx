import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { resolveFlagFromDb } from '@/lib/feature-flags-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Privacy Policy — privacytracker',
  description:
    'privacytracker runs locally and does not collect, store, or transmit any personal data. This page details every third-party endpoint the app may contact while you use it.',
};

/**
 * /privacy-policy — plain-language statement of what data the app does (and
 * does not) collect, plus a transparent list of every third-party endpoint
 * the running service may contact. Mirrors the two-column sticky-sidebar
 * layout used on /legal so the two disclosure pages feel like one family.
 *
 * Server component — renders without JS so readers with scripts disabled
 * still get the full text. Anchor navigation is pure <a href="#…"> links,
 * no JS required. Only cross-page jumps into /dashboard/settings#ai-summaries
 * rely on client-side code (the pulse is nice-to-have — the scroll is
 * handled by the browser).
 */

// Canonical GitHub repo — referenced from README / SECURITY / Homebrew tap.
// If the repo is ever renamed, update both places.
const GITHUB_REPO = 'https://github.com/privacykey/privacytracker';

// Deep-link into Settings with a hash the SettingsView pulse handler
// recognises. Kept as a named constant so the two places we reference it
// (the "Going fully offline" prose + the sidebar entry, if we ever add one)
// don't drift apart.
const SETTINGS_AI_HASH = '/dashboard/settings#ai-summaries';

// One third-party endpoint the app may call, plus the purpose / trigger /
// data shape. Kept as a typed record so the renderer can group them by
// category and the SSR output stays deterministic.
interface Subprocessor {
  name: string;
  endpoint: string;
  /** When the call fires. Helps readers see what they can disable. */
  trigger: string;
  /** What's sent in the request body / query string. */
  sends: string;
  /** What's received back. */
  receives: string;
  /** Whether calling it is required for the core loop or only optional. */
  necessity: 'required' | 'optional' | 'on-demand';
  /** Link to the third party's own privacy policy, if they publish one. */
  policyUrl?: string;
}

const APP_STORE_SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Apple — iTunes Search API',
    endpoint: 'itunes.apple.com/search, itunes.apple.com/lookup',
    trigger:
      'Whenever you search for an app by name during onboarding, or when the app syncs metadata (version, developer, icon).',
    sends:
      'The app name you typed, or a known Apple track ID, plus the country code you picked (default AU).',
    receives:
      'A public-catalogue JSON payload: track ID, name, developer, icon URL, App Store URL, current version.',
    necessity: 'required',
    policyUrl: 'https://www.apple.com/legal/privacy/en-ww/',
  },
  {
    name: 'Apple — App Store web listing',
    endpoint: 'apps.apple.com/<country>/app/<slug>/id<id>',
    trigger:
      'During every privacy-label scrape — initial import, manual resync, and the 30-minute background sync.',
    sends:
      'A standard browser-style HTTP GET with a Referer of apps.apple.com. No cookies, no identifiers.',
    receives:
      "The App Store page HTML, which the app parses for the privacy label JSON blob and developer's privacy policy link.",
    necessity: 'required',
  },
  {
    name: 'Apple — mzstatic image CDN',
    endpoint: 'is1-ssl.mzstatic.com (and siblings)',
    trigger:
      'Only when your browser renders an app icon returned by the Apple lookup — Apple host the icons here directly.',
    sends: 'Nothing beyond a standard image request.',
    receives: 'PNG / JPG icon bytes.',
    necessity: 'required',
  },
];

const POLICY_SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Developer-published privacy policy URLs',
    endpoint: 'Whatever host the developer links to on the App Store page',
    trigger:
      'Each time you resync an app or the 30-minute background sync runs, we follow the privacy-policy link Apple publishes on the App Store page for that app.',
    sends: 'A standard HTTP GET. No cookies, no identifiers.',
    receives: 'The HTML of the developer’s published privacy policy.',
    necessity: 'required',
  },
];

const ARCHIVE_SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Internet Archive — Wayback availability API',
    endpoint: 'archive.org/wayback/available',
    trigger:
      'Only when you explicitly run a historical Wayback import (once per app, per calendar quarter).',
    sends:
      'The App Store URL you’re trying to back-fill, plus a target timestamp. No cookies, no identifiers.',
    receives: 'The closest available Wayback capture URL for that timestamp.',
    necessity: 'on-demand',
    policyUrl: 'https://archive.org/about/terms.php',
  },
  {
    name: 'Internet Archive — Wayback Machine replay',
    endpoint: 'web.archive.org/web/<timestamp>id_/<original>',
    trigger:
      'Follow-up to the availability API — downloads the archived App Store HTML so we can re-parse it against the same schema as a live scrape.',
    sends: 'A standard HTTP GET.',
    receives: 'The archived HTML with Wayback’s toolbar injector disabled (`id_` suffix).',
    necessity: 'on-demand',
  },
  {
    name: 'Internet Archive — Save Page Now',
    endpoint: 'web.archive.org/save/<url>',
    trigger:
      'Only fired when a historical import finds an empty quarter with no existing capture — we ask the Archive to create one for future runs.',
    sends: 'The public App Store URL of the app. Nothing else.',
    receives:
      'An HTTP response indicating whether the snapshot request was accepted; no data stored client-side.',
    necessity: 'on-demand',
  },
];

// Update-availability check. Runs at most once per 24h on the server,
// caches the result in app_settings, and powers the in-app UpdateBanner.
// Disclosed here because it's the first endpoint we contact that the user
// didn't directly *ask* for — the App Store / Wayback / AI calls all fire
// from explicit user actions, but this one ticks on a timer. Disable it
// from Settings → Updates (toggles `update_check_enabled` to "false").
const UPDATE_CHECK_SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'GitHub Releases API',
    endpoint: 'api.github.com/repos/privacykey/privacytracker/releases/latest',
    trigger:
      'Once every 24 hours by default, or when you press "Check for updates" in Settings → Updates. Disable entirely with the same toggle.',
    sends:
      'A standard HTTP GET with a User-Agent identifying the running version. No cookies, no API token, no machine identifier.',
    receives:
      'JSON metadata for the most recent published release: tag, body (release notes), download URLs.',
    necessity: 'optional',
    policyUrl: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
  },
];

const AI_SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'OpenAI API',
    endpoint: 'api.openai.com',
    trigger:
      "Only if you set the AI provider to “OpenAI” in Settings → AI and supply your own API key.",
    sends:
      'The scraped developer privacy policy text plus a structured-summary prompt. No app data beyond what’s in the policy.',
    receives: 'A JSON summary keyed by the lenses defined in lib/privacy-policy.ts.',
    necessity: 'optional',
    policyUrl: 'https://openai.com/policies/privacy-policy',
  },
  {
    name: 'Anthropic API',
    endpoint: 'api.anthropic.com',
    trigger:
      "Only if you explicitly set the AI provider to “Anthropic” in Settings → AI and supply your own API key.",
    sends: 'The same scraped policy text + summary prompt.',
    receives: 'A JSON summary.',
    necessity: 'optional',
    policyUrl: 'https://www.anthropic.com/legal/privacy',
  },
  {
    name: 'Custom / local AI endpoint (Ollama, OpenAI-compatible self-host, etc.)',
    endpoint: 'Whatever base URL you configure (default 127.0.0.1:11434)',
    trigger:
      'Only if you set the AI provider to “Custom” in Settings → AI. Intended for local models — no data leaves your network if the endpoint is local.',
    sends: 'Scraped policy text + summary prompt.',
    receives: 'A JSON summary.',
    necessity: 'optional',
  },
];

// "What we collect from you" is intentionally short. The long list used to
// enumerate every category we don't touch (ads, data brokers, tracking
// pixels, cookies, etc.) but that became noise — the meta-statement here
// is enough, and the detail lives in the subprocessor table below.
const OUT_OF_SCOPE: { title: string; detail: string }[] = [
  {
    title: 'No analytics, telemetry, or tracking cookies',
    detail:
      "There's no Google Analytics, Plausible, Mixpanel, Sentry, PostHog, Segment, or any other telemetry pipeline. No tracking pixels, no advertising cookies, and no crash-reporting backend. The app doesn't phone home about your usage, device, or errors. Accessibility preferences (theme, font scale, dyslexic font) are stored in your browser's localStorage so they survive reloads — those preferences never leave your device.",
  },
  {
    title: 'No user accounts, no sign-in',
    detail:
      "The app has no login system and no user accounts. Everything — the apps you track, the privacy-label history, any AI settings — lives in a single SQLite file on the machine running privacytracker.",
  },
];

// Sidebar entries. Kept here so the sidebar renders in a stable order and
// so the "Jump to" links stay in sync with the section IDs used below.
//
// Labels carry translation keys (under `privacy_policy_page.sections.*`)
// instead of pre-rendered strings so the sidebar localises with the
// active locale. The `hint` for the third-parties row stays inline
// because it's a numeric count (locale-agnostic).
const SIDEBAR_SECTIONS: { id: string; labelKey: string; hintKey?: string; hint?: string }[] = [
  { id: 'priv-nothing', labelKey: 'what_we_collect', hintKey: 'what_we_collect_hint' },
  {
    id: 'priv-subprocessors',
    labelKey: 'third_parties',
    hint: `${APP_STORE_SUBPROCESSORS.length + POLICY_SUBPROCESSORS.length + ARCHIVE_SUBPROCESSORS.length + AI_SUBPROCESSORS.length + UPDATE_CHECK_SUBPROCESSORS.length}`,
  },
  { id: 'priv-self-host', labelKey: 'going_offline' },
  { id: 'priv-alternatives', labelKey: 'other_summarisers' },
  { id: 'priv-questions', labelKey: 'questions' },
];

/**
 * Necessity chip — Required / Optional / On-demand. Async because it
 * calls `getTranslations`, which is fine: this is a server component
 * and React's RSC pipeline awaits async children transparently.
 */
async function NecessityChip({ value }: { value: Subprocessor['necessity'] }) {
  const tField = await getTranslations('privacy_policy_page.subproc_field');
  const label =
    value === 'required'
      ? tField('necessity_required')
      : value === 'optional'
        ? tField('necessity_optional')
        : tField('necessity_on_demand');
  return <span className={`priv-nec-chip priv-nec-${value}`}>{label}</span>;
}

async function SubprocessorCard({ s }: { s: Subprocessor }) {
  // Field labels translate; the per-row `s.trigger`/`s.sends`/`s.receives`
  // copy is dense per-endpoint commentary that stays English in v1 (they
  // describe network behaviour with technical jargon — separate
  // translation pass alongside copy review).
  const tField = await getTranslations('privacy_policy_page.subproc_field');
  return (
    <article className="priv-subproc-card">
      <header className="priv-subproc-head">
        <h3 className="priv-subproc-name">{s.name}</h3>
        <NecessityChip value={s.necessity} />
      </header>
      <code className="priv-subproc-endpoint">{s.endpoint}</code>
      <dl className="priv-subproc-grid">
        <dt>{tField('trigger')}</dt>
        <dd>{s.trigger}</dd>
        <dt>{tField('sends')}</dt>
        <dd>{s.sends}</dd>
        <dt>{tField('receives')}</dt>
        <dd>{s.receives}</dd>
      </dl>
      {s.policyUrl && (
        <p className="priv-subproc-policy">
          <a href={s.policyUrl} target="_blank" rel="noopener noreferrer">
            {tField('policy_link')}
          </a>
        </p>
      )}
    </article>
  );
}

export default async function PrivacyPolicyPage() {
  // Round 3 PR 6.1: gate on `flag.legal.privacy_policy_page`. Default
  // behaviour is on (the page is universal); toggling off in Dev Options
  // returns a 404. Note: this is gateable but in practice should stay on
  // for every focus to avoid shipping a privacy auditor without a
  // privacy-policy disclosure of its own. The flag exists so OEM /
  // embedded builds can hide the route if needed.
  if (resolveFlagFromDb('flag.legal.privacy_policy_page') !== 'on') {
    notFound();
  }

  // i18n — server-side translations. The page chrome (back link,
  // hero title/subtitle, sidebar, section headings) reads from the
  // `privacy_policy_page` namespace. Section bodies + sub-section
  // ledes pull from `bodies.*`; subprocessor card field labels
  // come from `subproc_field.*`.
  const t = await getTranslations('privacy_policy_page');
  const tSec = await getTranslations('privacy_policy_page.sections');
  const tBody = await getTranslations('privacy_policy_page.bodies');

  const lastUpdated = 'April 2026';

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
  const SOURCE_PAGE = '/privacy-policy';
  const issueUrl =
    `${GITHUB_REPO}/issues/new` +
    `?template=bug_report.yml` +
    `&report-type=${encodeURIComponent('Privacy policy concern or correction')}` +
    `&source-page=${encodeURIComponent(SOURCE_PAGE)}`;

  return (
    <div className="privacy-policy-page">
      <header className="priv-page-hero">
        <Link href="/" className="priv-back-link">{t('back_to_app')}</Link>
        <p className="priv-eyebrow">{t('eyebrow')}</p>
        <h1 className="priv-page-title">{t('title')}</h1>
        <p className="priv-page-sub">{t('subtitle')}</p>
        <p className="priv-page-meta">{t('last_updated', { date: lastUpdated })}</p>
      </header>

      <div className="legal-layout">
        <aside className="legal-sidebar" aria-label={t('sidebar_aria')}>
          <p className="legal-sidebar-title">{t('sidebar_jump')}</p>
          <ul className="legal-sidebar-list">
            {SIDEBAR_SECTIONS.map(section => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="legal-sidebar-link">
                  <span>{tSec(section.labelKey)}</span>
                  {section.hintKey && <span className="legal-sidebar-count">{tSec(section.hintKey)}</span>}
                  {section.hint && !section.hintKey && <span className="legal-sidebar-count">{section.hint}</span>}
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
            className="priv-disclosure-callout"
            role="img"
            aria-label={t('disclosure.aria')}
          >
            <svg
              className="priv-disclosure-tick"
              width="52"
              height="52"
              viewBox="0 0 52 52"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="26" cy="26" r="23" stroke="currentColor" strokeWidth="3" />
              <path
                d="M15 27 L22 34 L37 19"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            <h2 className="priv-disclosure-title">{t('disclosure.title')}</h2>
            <p className="priv-disclosure-body">{t('disclosure.body')}</p>
          </div>

          <section id="priv-nothing" className="priv-section" aria-labelledby="priv-nothing-heading">
            <h2 id="priv-nothing-heading" className="priv-section-title">{tSec('what_we_collect_full')}</h2>
            <p className="priv-section-lede priv-section-lede-strong">{tBody('nothing_lede')}</p>
            <p className="priv-section-body">
              {tBody.rich('nothing_body', { code: (chunks) => <code>{chunks}</code> })}
            </p>
            <ul className="priv-out-of-scope-list">
              {OUT_OF_SCOPE.map(item => (
                <li key={item.title} className="priv-out-of-scope-item">
                  <div className="priv-out-of-scope-title">{item.title}</div>
                  <div className="priv-out-of-scope-detail">{item.detail}</div>
                </li>
              ))}
            </ul>
          </section>

          <section id="priv-subprocessors" className="priv-section" aria-labelledby="priv-subprocessors-heading">
            <h2 id="priv-subprocessors-heading" className="priv-section-title">{tSec('third_parties_full')}</h2>
            <p className="priv-section-lede">{tBody('third_parties_lede')}</p>
            <p className="priv-section-body">
              {tBody.rich('third_parties_body', { em: (chunks) => <em>{chunks}</em> })}
            </p>

            <h3 className="priv-subsection-title">{tSec('appstore_metadata')}</h3>
            <p className="priv-subsection-sub">{tBody('appstore_sub')}</p>
            <div className="priv-subproc-grid-wrap">
              {APP_STORE_SUBPROCESSORS.map(s => <SubprocessorCard key={s.name} s={s} />)}
            </div>

            <h3 className="priv-subsection-title">{tSec('developer_policies')}</h3>
            <p className="priv-subsection-sub">{tBody('developer_sub')}</p>
            <div className="priv-subproc-grid-wrap">
              {POLICY_SUBPROCESSORS.map(s => <SubprocessorCard key={s.name} s={s} />)}
            </div>

            <h3 className="priv-subsection-title">{tSec('historical_archives')}</h3>
            <p className="priv-subsection-sub">{tBody('archives_sub')}</p>
            <div className="priv-subproc-grid-wrap">
              {ARCHIVE_SUBPROCESSORS.map(s => <SubprocessorCard key={s.name} s={s} />)}
            </div>

            <h3 className="priv-subsection-title">{tSec('ai_providers')}</h3>
            <p className="priv-subsection-sub">
              {tBody('ai_sub_prefix')}{' '}
              <Link href={SETTINGS_AI_HASH} className="priv-inline-link">
                {tBody('ai_sub_settings_link')}
              </Link>
              {tBody('ai_sub_suffix')}
            </p>
            <div className="priv-subproc-grid-wrap">
              {AI_SUBPROCESSORS.map(s => <SubprocessorCard key={s.name} s={s} />)}
            </div>

            <h3 className="priv-subsection-title">{tSec('update_check')}</h3>
            <p className="priv-subsection-sub">{tBody('update_check_sub')}</p>
            <div className="priv-subproc-grid-wrap">
              {UPDATE_CHECK_SUBPROCESSORS.map(s => <SubprocessorCard key={s.name} s={s} />)}
            </div>
          </section>

          <section id="priv-self-host" className="priv-section" aria-labelledby="priv-self-host-heading">
            <h2 id="priv-self-host-heading" className="priv-section-title">{tSec('going_offline_full')}</h2>
            <p className="priv-section-body">
              {tBody.rich('going_offline_p1', { code: (chunks) => <code>{chunks}</code> })}
            </p>
            <p className="priv-section-body">{tBody('going_offline_p2')}</p>
            <ul className="priv-offline-steps">
              <li>
                {tBody.rich('going_offline_step_ai', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  settings: (chunks) => (
                    <Link href={SETTINGS_AI_HASH} className="priv-inline-link priv-inline-link-settings">
                      {chunks}
                    </Link>
                  ),
                })}
              </li>
              <li>
                {tBody.rich('going_offline_step_wayback', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </li>
            </ul>
            <p className="priv-section-body">{tBody('going_offline_p3')}</p>
          </section>

          <section id="priv-alternatives" className="priv-section" aria-labelledby="priv-alternatives-heading">
            <h2 id="priv-alternatives-heading" className="priv-section-title">{tSec('other_summarisers_full')}</h2>
            <p className="priv-section-body">{tBody('alternatives_p1')}</p>
            <ul className="priv-offline-steps">
              <li>
                {tBody.rich('alternatives_tosdr', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  tosdr: (chunks) => (
                    <a
                      href="https://tosdr.org/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="priv-inline-link"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </li>
              <li>
                {tBody.rich('alternatives_privacyspy', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  privacyspy: (chunks) => (
                    <a
                      href="https://privacyspy.org/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="priv-inline-link"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </li>
            </ul>
            <p className="priv-section-body">
              {tBody.rich('alternatives_p2', {
                strong: (chunks) => <strong>{chunks}</strong>,
                em: (chunks) => <em>{chunks}</em>,
                tosdr: (chunks) => (
                  <a
                    href="https://tosdr.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="priv-inline-link"
                  >
                    {chunks}
                  </a>
                ),
                privacyspy: (chunks) => (
                  <a
                    href="https://privacyspy.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="priv-inline-link"
                  >
                    {chunks}
                  </a>
                ),
              })}
            </p>
          </section>

          <section id="priv-questions" className="priv-section" aria-labelledby="priv-questions-heading">
            <h2 id="priv-questions-heading" className="priv-section-title">{tSec('questions_full')}</h2>
            <p className="priv-section-body">
              {tBody.rich('questions_p1', { code: (chunks) => <code>{chunks}</code> })}
            </p>
            <p className="priv-section-body">
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="priv-cta-button"
              >
                Open an issue on GitHub ↗
              </a>
            </p>
            <p className="priv-section-body" style={{ marginTop: 12 }}>
              The full list of bundled libraries and their licences is on the{' '}
              <Link href="/legal" className="priv-inline-link">Legal page</Link>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
