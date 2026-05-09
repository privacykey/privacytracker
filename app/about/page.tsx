import type { Metadata } from 'next';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import pkg from '../../package.json';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('about_page');
  return {
    title: t('metadata_title'),
  };
}

/**
 * /about — custom About page replacing macOS's tiny standard about-panel.
 *
 * Reached via the App > About privacytracker menu item (see
 * src-tauri/src/app_menu.rs::handle_event "menu.app.about"). Layout
 * mirrors privacycommand's about page: centred app icon, two-tone
 * wordmark, version + build, one-line tagline, two-column feature
 * grid with green check icons, and a GitHub source link in the
 * footer. Everything renders inside the existing webview — no new
 * Tauri window is needed.
 *
 * The version string reads from `package.json` so a `npm version
 * patch` (or any direct edit) lights up here on the next build with
 * no manual sync.
 */

const GITHUB_REPO_URL = 'https://github.com/privacykey/privacytracker';

const FEATURE_KEYS = [
  'labels',
  'policies',
  'wayback',
  'cfgutil',
  'audit',
  'notes',
  'local',
] as const;

export default async function AboutPage() {
  const version = pkg.version;
  const t = await getTranslations('about_page');

  return (
    <main className="about-page">
      <div className="about-card">
        {/* App icon. /icon.png is the standard Next.js icon convention
            (app/icon.png) and works in both the desktop webview and
            the Docker / web builds without needing platform-specific
            asset paths. */}
        <Image
          src="/icon.png"
          alt=""
          width={144}
          height={144}
          className="about-icon"
          priority
        />

        {/* Two-tone wordmark — matches the .privacytracker-wordmark
            split treatment from globals.css. "privacy" muted, "tracker"
            in the brand blue. */}
        <h1 className="about-wordmark">
          <span className="about-wordmark-prefix">{t('wordmark_prefix')}</span>
          <span className="about-wordmark-accent">{t('wordmark_accent')}</span>
        </h1>

        <p className="about-version">{t('version', { version })}</p>

        <p className="about-tagline">
          {t('tagline')}
        </p>

        <hr className="about-divider" />

        <ul className="about-features">
          {FEATURE_KEYS.map((key) => (
            <li key={key} className="about-feature">
              <span className="about-feature-tick" aria-hidden="true">✓</span>
              <div className="about-feature-body">
                <strong className="about-feature-title">{t(`feature_${key}_title`)}</strong>
                <p className="about-feature-blurb">{t(`feature_${key}_blurb`)}</p>
              </div>
            </li>
          ))}
        </ul>

        <hr className="about-divider" />

        <p className="about-source">
          <a
            href={GITHUB_REPO_URL}
            className="about-source-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="about-source-octocat" aria-hidden="true">GH</span>
            {t('source_link')}
          </a>
        </p>

        <p className="about-source-url">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {GITHUB_REPO_URL.replace('https://', '')}
          </a>
        </p>
      </div>
    </main>
  );
}
