'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTaskCenter } from './TaskCenter';
import BackgroundModeCallout from './BackgroundModeCallout';
import type {
  TriageApp,
  TriageData,
  ReviewableApp,
  ReviewableChangeCategory,
  RecentActivityEntry,
} from '../../lib/triage';
import { INTENT_META, type UserIntent } from '../../lib/preferences';
import {
  CATEGORY_META,
} from '../../lib/privacy-meta';
import {
  TIER_META,
  describeWorstMismatchLocalised,
  type AppMismatchSummary,
} from '../../lib/privacy-profile';
import { categoryLabel as i18nCategoryLabel } from '../../lib/i18n-meta';

// ─────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────

/** Smooth-scroll to an in-page anchor and briefly flash it so the user sees
 *  "something happened" even when the target is already in view. */
function handleHashClick(
  e: React.MouseEvent<HTMLAnchorElement>,
  hash: string,
): void {
  if (!hash.startsWith('#')) return;
  const id = hash.slice(1);
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Also shift keyboard focus to the destination so tabbing continues
  // from there and screen readers announce the new landing point. If
  // the target isn't naturally focusable, give it a temporary
  // tabindex="-1" for programmatic focus only.
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
  }
  el.focus({ preventScroll: true });
  el.classList.remove('home-pulse');
  // Reflow so the animation re-triggers if the class was already present.
  void el.offsetWidth;
  el.classList.add('home-pulse');
  window.setTimeout(() => el.classList.remove('home-pulse'), 1400);
  if (history?.replaceState) {
    history.replaceState(null, '', hash);
  }
}

type RelT = (key: string, values?: Record<string, string | number | Date>) => string;

function relativeTime(t: RelT, ts: number): string {
  if (!ts) return t('dash');
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t('just_now');
  if (s < 3600) return t('minutes_ago', { count: Math.floor(s / 60) });
  if (s < 86_400) return t('hours_ago', { count: Math.floor(s / 3600) });
  const d = Math.floor(s / 86_400);
  if (d === 1) return t('yesterday');
  if (d < 30) return t('days_ago', { count: d });
  const months = Math.floor(d / 30);
  return t('months_ago', { count: months });
}

const RISK_CLS: Record<TriageApp['riskLevel'], string> = {
  high: 'risk-pill-high',
  moderate: 'risk-pill-moderate',
  low: 'risk-pill-low',
  minimal: 'risk-pill-minimal',
};

// ─────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────

/**
 * Resolved dashboard flag values consumed by HomeView. Computed server-side in
 * `app/dashboard/page.tsx` via `resolveFlagFromDb` so the rendered markup is
 * correct on first paint. Round 3 wave D widened this from the four callouts
 * to cover every `flag.dashboard.*` plus the `flag.global.*` flags HomeView
 * cares about; PRs after wave D add more if new sections appear.
 */
export interface DashboardFlagState {
  callout: {
    declutter: boolean;
    guardian: boolean;
    understand_declutter: boolean;
    understand_only: boolean;
  };
  /** Top-of-page chip strip showing the current focus. */
  focusStrip: boolean;
  /** "Nothing new to review" hero variant. */
  heroQuiet: boolean;
  /** "⚡ Things need attention" hero variant. */
  heroAttention: boolean;
  /** "Not everything lives on the App Store" promo card. */
  manualAppsBanner: boolean;
  /** Risk-section watchlist block. */
  riskSection: boolean;
  /** At-a-glance stats grid (apps tracked, categories, high-risk, changes). */
  glanceSection: boolean;
  /** "Changes to review" block. */
  reviewSection: boolean;
  /** "Consider replacing" — privacy-profile mismatches. */
  profileMismatchSection: boolean;
  /** Stale apps (not synced in 30+ days). */
  staleSection: boolean;
  /** "This week's activity" feed. */
  activitySection: boolean;
  /** Collapsible risk-tier reference legend. */
  riskTierLegend: boolean;
  /** Tauri-only "Set up background mode" callout, sits in the focus
   *  strip area. Runtime-gated on `isDesktop()` so the web build never
   *  renders it even when the flag is on. */
  backgroundModeWizard: boolean;
  /** Audience-aware "tasks worth trying" panel at the very top. Off
   *  hides the inline panel only; the nav icon has a separate flag. */
  taskList: boolean;
}

export default function HomeView({
  triage,
  userIntent,
  manualAppsCount,
  manualAppsBannerDismissed,
  mismatchedApps = [],
  flags,
  backgroundCalloutVisible = false,
  taskListSlot,
}: {
  triage: TriageData;
  /**
   * Archetype the user picked on the welcome splash. `null` while the
   * feature is being rolled out or if the user skipped — in that case the
   * dashboard falls back to the original neutral ordering.
   *
   * Round 3 PR 3: kept as a prop because several intent-driven branches
   * inside HomeView (stale-section elevation, glance-section ordering,
   * focus-strip rendering) still consume it via the back-compat shim in
   * lib/preferences-server.ts. Round 4+ swaps these branches to flags
   * and removes the prop.
   */
  userIntent: UserIntent | null;
  /**
   * How many manual apps (web clips, TestFlight, sideloaded, own-build)
   * the user has tracked. Used to decide whether the "consider adding
   * manual apps" banner is still relevant — once there's one on file we
   * assume the user has discovered the feature.
   */
  manualAppsCount: number;
  /**
   * Sticky dismissal flag persisted via `/api/preferences`. Once set to
   * true the banner stays hidden even if the user later deletes all of
   * their manual apps. Can be cleared from Settings (future work) if we
   * want to let them resurface it.
   */
  manualAppsBannerDismissed: boolean;
  /**
   * Apps whose worst-observed privacy tier exceeds the user's profile. Empty
   * when no profile is set or no app mismatches — the section stays hidden
   * in that case. Already sorted worst-first by the server.
   */
  mismatchedApps?: AppMismatchSummary[];
  /**
   * Resolved dashboard-flag values from the server. Drives the four
   * callouts under §5.3 and (in subsequent PRs) the wider dashboard
   * surface. See `DashboardFlagState` above for the shape.
   */
  flags?: DashboardFlagState;
  /** Server-side gate for the Tauri "Set up background mode" callout —
   *  `true` only when the flag is on AND the user hasn't already
   *  completed or dismissed the wizard. The component still
   *  runtime-checks `isDesktop()` so the web build never renders it. */
  backgroundCalloutVisible?: boolean;
  /** Pre-resolved tasks panel from the server. Passed as a React node so
   *  the server component renders inside the client component's tree
   *  without HomeView depending on next-intl's server runtime. Render in
   *  place at the top of the page — gated on `flags.taskList`. */
  taskListSlot?: ReactNode;
}) {
  const taskCenter = useTaskCenter();
  const [syncingAll, setSyncingAll] = useState(false);
  const [toast, setToast] = useState('');
  // Local override so the banner disappears immediately on dismiss without
  // a round-trip refresh. Seeded from the server-persisted flag.
  const [bannerDismissed, setBannerDismissed] = useState(manualAppsBannerDismissed);
  const [dismissingBanner, setDismissingBanner] = useState(false);
  const showManualAppsBanner = !bannerDismissed && manualAppsCount === 0;

  const dismissManualAppsBanner = async () => {
    if (dismissingBanner) return;
    // Optimistic: hide immediately, re-surface on failure so the user
    // knows we didn't persist their intent.
    setBannerDismissed(true);
    setDismissingBanner(true);
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissManualAppsBanner: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn('[home] dismiss manual-apps banner failed:', err);
      setBannerDismissed(false);
      showToast(tToasts('dismiss_save_failed'));
    } finally {
      setDismissingBanner(false);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Translation handles for heads-up labels and the sync-all toast
  // copy below. Captured at the top of the component so the useMemo +
  // syncAllStale closure can both depend on stable references.
  const tHeadsUp = useTranslations('dashboard.headsup');
  const tSyncAll = useTranslations('dashboard.sync_all');
  const tToasts = useTranslations('dashboard.toasts');

  const headsUps = useMemo(() => {
    // "Heads up" is only for things that need *action* right now. High-risk
    // apps are ongoing state, not an alert — they live in their own reference
    // block above the hero. Both labels run through the
    // `dashboard.headsup.*` ICU plurals so the count agrees with the
    // active locale.
    const items: { key: string; label: string; cls: string; href: string }[] = [];
    if (triage.reviewable.length > 0) {
      items.push({
        key: 'review',
        label: tHeadsUp('review_label', { count: triage.reviewable.length }),
        cls: 'headsup-review',
        href: '#changes-to-review',
      });
    }
    if (triage.staleCount > 0) {
      items.push({
        key: 'stale',
        label: tHeadsUp('stale_label', { count: triage.staleCount }),
        cls: 'headsup-stale',
        href: '#stale-apps',
      });
    }
    return items;
  }, [triage, tHeadsUp]);

  const syncAllStale = async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    const total = triage.stale.length || triage.totalApps;
    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title: total === triage.totalApps ? tSyncAll('title_all_apps') : tSyncAll('title_stale_apps'),
      subtitle: tSyncAll('subtitle_count', { count: total }),
      kind: 'sync',
      href: '/dashboard',
      onCancel: () => controller.abort(),
    });
    try {
      const res = await fetch('/api/apps');
      const all = (await res.json()) as Array<{ id: string; url: string; lastSynced: number }>;
      const pool =
        triage.stale.length > 0
          ? all.filter(a => triage.stale.some(s => s.id === a.id))
          : all;
      await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: pool.map(a => a.url), resync: true }),
        signal: controller.signal,
      });
      showToast(tSyncAll('toast_complete'));
      handle.complete('done', tSyncAll('complete_summary', { count: pool.length }));
      // Refresh the server-rendered view to pick up new triage data.
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        console.error('[home] Sync-all failed:', err);
        showToast(tSyncAll('toast_failed'));
        handle.complete('error', (err as Error)?.message ?? tSyncAll('toast_failed').replace('❌ ', ''));
      }
    } finally {
      setSyncingAll(false);
    }
  };

  // Intent-driven tailoring. We never *hide* sections — we only reorder and
  // sprinkle in archetype-specific callouts so the dashboard feels relevant
  // to what the user told us on the welcome splash. The switch intentionally
  // falls through to a neutral default when `userIntent` is null so the page
  // still renders fine for people who skipped onboarding on an older build.
  // Round 3 PR 3: callout visibility is flag-driven when `flags` is supplied
  // (the server pre-resolves the four callout flags from the rule engine).
  // Falls back to the legacy intent check when `flags` is missing — keeps
  // older render paths working until PR 5 makes the prop required.
  const statsFirst = userIntent === 'curious';
  const showThirdPartyCallout = flags?.callout.understand_declutter ?? (userIntent === 'hygiene');
  const showCleanupCallout = flags?.callout.declutter ?? (userIntent === 'cleanup');
  const showFamilyCallout = flags?.callout.guardian ?? (userIntent === 'family');
  const showDefinitionsCallout = flags?.callout.understand_only ?? (userIntent === 'curious');
  const elevateStale = userIntent === 'hygiene';

  // Round 3 wave D: each section's flag-driven visibility. Falls back to
  // the legacy intent-driven render when `flags` isn't passed (mostly for
  // back-compat with any pages that haven't been wired yet).
  const showFocusStrip = flags?.focusStrip ?? true;
  const showManualBannerFlag = flags?.manualAppsBanner ?? true;
  const showRiskFlag = flags?.riskSection ?? true;
  const showHeroQuiet = flags?.heroQuiet ?? true;
  const showHeroAttention = flags?.heroAttention ?? true;
  const showGlance = flags?.glanceSection ?? true;
  const showReview = flags?.reviewSection ?? true;
  const showProfileMismatch = flags?.profileMismatchSection ?? true;
  const showStale = flags?.staleSection ?? true;
  const showActivity = flags?.activitySection ?? true;
  const showRiskTierLegend = flags?.riskTierLegend ?? true;
  const showTaskList = flags?.taskList ?? true;

  return (
    <div className="page-container home-page">
      {showTaskList && taskListSlot}
      {showFocusStrip && userIntent && <FocusStrip intent={userIntent} />}
      {/* Tauri-only callout. The component itself runtime-gates on
          `isDesktop()` (the web build's window.__TAURI_INTERNALS__
          is undefined), and the parent passes
          `backgroundCalloutVisible=true` only when the flag is on AND
          the user hasn't already completed / dismissed the wizard.
          Lives in the focus-strip area so it shares visual weight with
          the audience/goals chips rather than dominating the page. */}
      {(flags?.backgroundModeWizard ?? false) && backgroundCalloutVisible && (
        <BackgroundModeCallout initiallyVisible={true} />
      )}

      {showManualAppsBanner && showManualBannerFlag && <ManualAppsBanner
        onDismiss={dismissManualAppsBanner}
        dismissing={dismissingBanner}
      />}

      {/* Risk section — at the top for cleanup / family. Hero variant
          chooses the visual treatment based on the active callout. */}
      {showRiskFlag && triage.higherRisk.length > 0 && (
        <RiskSection
          id="higher-risk"
          apps={triage.higherRisk}
          variant={showCleanupCallout ? 'cleanup' : showFamilyCallout ? 'family' : 'default'}
        />
      )}

      {/* Hero — quiet vs attention variants are picked by the component
          based on triage data; the flags gate the whole hero. Either-or
          rather than both, so we render the hero block when at least one
          variant is enabled. */}
      {(showHeroQuiet || showHeroAttention) && (
        <Hero triage={triage} headsUps={headsUps} onSyncAll={syncAllStale} syncing={syncingAll} />
      )}

      {showCleanupCallout && <CleanupCallout count={triage.highRiskCount} />}
      {showFamilyCallout && <FamilyCallout count={triage.highRiskCount} />}
      {showThirdPartyCallout && <ThirdPartyCallout triage={triage} />}

      {/* 'curious' mode surfaces the at-a-glance stats block up here. */}
      {statsFirst && showGlance && <GlanceSection triage={triage} />}

      {showDefinitionsCallout && <DefinitionsCallout />}

      {showReview && triage.reviewable.length > 0 && (
        <ReviewSection id="changes-to-review" reviewable={triage.reviewable} />
      )}

      {showProfileMismatch && mismatchedApps.length > 0 && (
        <ConsiderReplacingSection id="consider-replacing" apps={mismatchedApps} />
      )}

      {showStale && triage.stale.length > 0 && (
        <StaleSection id="stale-apps" apps={triage.stale} elevated={elevateStale} />
      )}

      {showActivity && triage.recentActivity.length > 0 && (
        <ActivitySection activity={triage.recentActivity} />
      )}

      {showRiskTierLegend && <RiskTierLegend id="risk-tiers" />}

      {!statsFirst && showGlance && <GlanceSection triage={triage} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Focus strip — compact "you chose X" header with link to Settings
// ─────────────────────────────────────────────

function FocusStrip({ intent }: { intent: UserIntent }) {
  const meta = INTENT_META[intent];
  // i18n: chrome copy from `dashboard.focus_strip.*`, intent label from
  // the shared `intent.<key>` namespace (one of the four legacy archetypes).
  // Icon stays sourced from INTENT_META — emoji is language-agnostic.
  const t = useTranslations('dashboard.focus_strip');
  const tIntent = useTranslations('intent');
  return (
    <div className="focus-strip" role="note" data-tour="focus-card">
      <span className="focus-strip-icon" aria-hidden="true">
        {meta.icon}
      </span>
      <div className="focus-strip-body">
        <div className="focus-strip-label">{t('label')}</div>
        <div className="focus-strip-value">{tIntent(intent)}</div>
      </div>
      <Link href="/dashboard/settings#focus" className="focus-strip-change">
        {t('change')}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────
// Intent-specific callouts
// ─────────────────────────────────────────────

function CleanupCallout({ count }: { count: number }) {
  // i18n — quiet/alert bodies + the alert pluralised title +
  // the "Review high-risk apps →" link, all from `dashboard.callouts.*`.
  const tCallouts = useTranslations('dashboard.callouts');
  if (count === 0) {
    return (
      <div className="intent-callout intent-callout-quiet">
        <div className="intent-callout-title">{tCallouts('nothing_urgent_title')}</div>
        <p className="intent-callout-copy">{tCallouts('nothing_urgent_body')}</p>
      </div>
    );
  }
  return (
    <div className="intent-callout intent-callout-alert">
      <div className="intent-callout-title">{tCallouts('cleanup_title', { count })}</div>
      <p className="intent-callout-copy">{tCallouts('cleanup_body')}</p>
      <Link href="#higher-risk" className="intent-callout-link">
        {tCallouts('cleanup_link')}
      </Link>
    </div>
  );
}

function FamilyCallout({ count }: { count: number }) {
  const tCallouts = useTranslations('dashboard.callouts');
  return (
    <div className="intent-callout intent-callout-info">
      <div className="intent-callout-title">{tCallouts('looking_out_for_family_title')}</div>
      <p className="intent-callout-copy">
        {tCallouts('looking_out_for_family_body')}
        {count > 0 && ` ${tCallouts('looking_out_for_family_count', { count })}`}
      </p>
    </div>
  );
}

function ThirdPartyCallout({ triage }: { triage: TriageData }) {
  const stale = triage.staleCount;
  const tCallouts = useTranslations('dashboard.callouts');
  return (
    <div className="intent-callout intent-callout-info">
      <div className="intent-callout-title">{tCallouts('security_hygiene_title')}</div>
      <p className="intent-callout-copy">
        {tCallouts('security_hygiene_body')}
        {stale > 0 && ` ${tCallouts('security_hygiene_stale', { count: stale })}`}
      </p>
      {stale > 0 && (
        <Link href="#stale-apps" className="intent-callout-link">
          {tCallouts('security_hygiene_jump')}
        </Link>
      )}
    </div>
  );
}

function DefinitionsCallout() {
  const tCallouts = useTranslations('dashboard.callouts');
  return (
    <div className="intent-callout intent-callout-quiet intent-callout-tall">
      <div className="intent-callout-title">{tCallouts('new_to_privacy_labels_title')}</div>
      <p className="intent-callout-copy">{tCallouts('new_to_privacy_labels_body')}</p>
      <Link href="/help/definitions" className="intent-callout-link intent-callout-link-prominent">
        {tCallouts('definitions_link')}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────
// Risk tier legend — reference panel explaining the risk pill
// ─────────────────────────────────────────────

/**
 * Four-tier legend matching the thresholds in lib/triage.ts (`riskLevel`).
 * Keep the thresholds in sync with that function — the copy here is the
 * user-facing version of the same rules. Examples are deliberately
 * generic (no named apps) because the user's library varies and we don't
 * want to editorialise about specific brands from the dashboard.
 */
const RISK_TIER_ENTRIES: Array<{
  key: TriageApp['riskLevel'];
  label: string;
  rule: string;
  meaning: string;
  example: string;
}> = [
  {
    key: 'high',
    label: 'High risk',
    rule: 'At least one data type declared as "Data Used to Track You".',
    meaning:
      'The developer admits the app follows you across other apps and websites — usually for advertising or profiling.',
    example:
      'Typical of large social networks and ad-supported free apps that share identifiers with data brokers.',
  },
  {
    key: 'moderate',
    label: 'Moderate risk',
    rule: 'No cross-app tracking, but three or more data types linked to your identity.',
    meaning:
      'The app ties a lot of data to your account. It stays inside the app, but the developer still holds a rich profile of you.',
    example:
      'Typical of banking, shopping, streaming and communication apps where a lot is tied to your sign-in.',
  },
  {
    key: 'low',
    label: 'Low risk',
    rule: 'Some data collected, but only a small amount is linked to your identity.',
    meaning:
      'The app collects something — often diagnostics, optional usage stats, or a single linked category — without building a full profile.',
    example:
      'Typical of light-touch utilities, calculators, or reference apps that collect a crash log or optional analytics.',
  },
  {
    key: 'minimal',
    label: 'Minimal',
    rule: 'The developer declares no data collection at all.',
    meaning:
      "Apple's privacy labels show an empty sheet. Nothing the app says it collects, linked or otherwise.",
    example:
      'Typical of single-player offline games, simple reference tools, and some privacy-focused utilities.',
  },
];

/**
 * Promo card pointing first-time users at /dashboard/manual-apps. Pulled
 * out of HomeView's render so the translation hook can live inside the
 * component without complicating the parent's hook layout.
 */
function ManualAppsBanner({
  onDismiss,
  dismissing,
}: {
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const t = useTranslations('dashboard.manual_apps_banner');
  return (
    <div className="manual-apps-banner" role="note">
      <div className="manual-apps-banner-icon" aria-hidden="true">🔖</div>
      <div className="manual-apps-banner-body">
        <div className="manual-apps-banner-title">{t('title')}</div>
        <p className="manual-apps-banner-copy">{t('body')}</p>
      </div>
      <div className="manual-apps-banner-actions">
        <Link href="/dashboard/manual-apps" className="btn btn-primary btn-sm">
          {t('set_them_up')}
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onDismiss}
          disabled={dismissing}
        >
          {t('dismiss')}
        </button>
      </div>
    </div>
  );
}

function RiskTierLegend({ id }: { id: string }) {
  // i18n — legend chrome from `dashboard.risk_tier_legend.*`, the four
  // tier explainer cards from `dashboard.risk_tiers.${key}_{rule|meaning|example}`,
  // and the pill labels themselves from the shared `risk.*_label`
  // namespace so the legend pill matches the per-card pill verbatim.
  const t = useTranslations('dashboard.risk_tier_legend');
  const tTier = useTranslations('dashboard.risk_tiers');
  const tRisk = useTranslations('risk');
  return (
    <section
      id={id}
      className="home-section home-section-legend"
    >
      <details className="risk-tier-legend">
        <summary className="risk-tier-legend-summary">
          <span className="risk-tier-legend-kicker">{t('kicker')}</span>
          <span className="risk-tier-legend-hint">{t('hint')}</span>
        </summary>
        <p className="risk-tier-legend-intro">{t('intro')}</p>
        <div className="risk-tier-grid">
          {RISK_TIER_ENTRIES.map(tier => (
            <div key={tier.key} className={`risk-tier-card risk-tier-${tier.key}`}>
              <div className="risk-tier-card-head">
                <span className={`risk-pill ${RISK_CLS[tier.key]}`}>
                  {tRisk(`${tier.key}_label`)}
                </span>
              </div>
              <div className="risk-tier-card-rule">{tTier(`${tier.key}_rule`)}</div>
              <p className="risk-tier-card-meaning">{tTier(`${tier.key}_meaning`)}</p>
              <p className="risk-tier-card-example">
                <span className="risk-tier-card-example-kicker">{t('example_kicker')}</span>
                {tTier(`${tier.key}_example`)}
              </p>
            </div>
          ))}
        </div>
        <p className="risk-tier-legend-footer">{t('footer')}</p>
      </details>
    </section>
  );
}

// ─────────────────────────────────────────────
// Hero — either "quiet state" or "heads up"
// ─────────────────────────────────────────────

function Hero({
  triage,
  headsUps,
  onSyncAll,
  syncing,
}: {
  triage: TriageData;
  headsUps: { key: string; label: string; cls: string; href: string }[];
  onSyncAll: () => void;
  syncing: boolean;
}) {
  // i18n: hero structural strings (title, action buttons, links) plus
  // the rich `<strong>{apps}</strong>` / `<strong>{categories}</strong>` /
  // `<strong>{relative}</strong>` interpolations on the quiet variant.
  // Both bundles include the rich-tag markup so `t.rich` resolves them
  // identically; the `chunks => <strong>{chunks}</strong>` callback at
  // each call site is what makes the emphasis render in either locale.
  const tHero = useTranslations('dashboard.hero');
  const tRel = useTranslations('dashboard.relative_time');
  if (triage.quiet) {
    return (
      <section className="home-hero home-hero-quiet">
        <div className="home-hero-icon home-hero-icon-quiet" aria-hidden="true">
          ✓
        </div>
        <div className="home-hero-body">
          <h1 className="home-hero-title">{tHero('nothing_new')}</h1>
          <p className="home-hero-copy">
            {tHero.rich('quiet_tracking', {
              strong: (chunks) => <strong>{chunks}</strong>,
              apps: tHero('quiet_n_apps', { count: triage.totalApps }),
              categories: tHero('quiet_n_categories', { count: triage.totalCategories }),
            })}
            {triage.lastSyncedAt > 0 && (
              <>
                {' '}
                {tHero.rich('quiet_last_refreshed', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  relative: relativeTime(tRel, triage.lastSyncedAt),
                })}
              </>
            )}
          </p>
          <div className="home-hero-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onSyncAll}
              disabled={syncing}
            >
              {syncing ? <span className="spinner" /> : '↻'}
              {syncing ? tHero('syncing') : tHero('resync_now')}
            </button>
            <Link href="/dashboard/apps" className="btn btn-ghost">
              {tHero('view_all_apps')} →
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="home-hero home-hero-attention">
      <div className="home-hero-icon home-hero-icon-attention" aria-hidden="true">
        ⚡
      </div>
      <div className="home-hero-body">
        <h1 className="home-hero-title">
          {tHero('needs_attention_title', { count: headsUps.length })}
        </h1>
        <ul className="home-headsup-list">
          {headsUps.map(item => (
            <li key={item.key} className={`home-headsup-item ${item.cls}`}>
              <a
                href={item.href}
                className="home-headsup-link"
                onClick={e => handleHashClick(e, item.href)}
              >
                {item.label}
                <span className="home-headsup-arrow" aria-hidden="true">
                  ↓
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Changes to review
// ─────────────────────────────────────────────

/**
 * Build a dynamic subtitle phrase that reflects which kinds of changes
 * are actually in the current reviewable set. Examples:
 *
 *   only privacy-label             → "privacy labels"
 *   only accessibility             → "accessibility labels"
 *   privacy-label + accessibility  → "privacy and accessibility labels"
 *   all three                      → "privacy labels, accessibility labels, or privacy policies"
 *
 * We collapse the common "privacy labels + accessibility labels" pairing
 * into "privacy and accessibility labels" because the word "labels"
 * duplicates otherwise. Falls back to the safe generic "privacy labels"
 * phrasing when the category set is empty — e.g. pre-migration rows that
 * were written before categories were tracked at all.
 *
 * Translator-typed first arg keeps the helper locale-aware while staying
 * out of React's hook ordering — call sites already have `tReviewSummary`
 * in scope from the parent component.
 */
type ReviewSummaryT = (key: string) => string;

function buildReviewableSummaryPhrase(
  t: ReviewSummaryT,
  reviewable: ReviewableApp[],
): string {
  const present = new Set<ReviewableChangeCategory>();
  for (const app of reviewable) {
    for (const c of app.categories) present.add(c);
  }

  const hasLabel = present.has('privacy-label');
  const hasA11y = present.has('accessibility');
  const hasPolicy = present.has('privacy-policy');

  // Common pairings get a tighter phrasing so the sentence doesn't read
  // like a checklist. The "privacy + accessibility labels" pairing was
  // the one the original copy specifically asked for.
  if (hasLabel && hasA11y && !hasPolicy) {
    return t('privacy_and_accessibility_labels');
  }
  if (hasLabel && hasPolicy && !hasA11y) {
    return t('privacy_labels_or_policies');
  }
  if (hasA11y && hasPolicy && !hasLabel) {
    return t('accessibility_or_policies');
  }
  if (hasLabel && hasA11y && hasPolicy) {
    return t('all_three');
  }

  // Singletons — or the empty fallback, which reads the same as the
  // legacy "privacy labels" copy so pre-migration installs keep their
  // wording.
  if (hasA11y) return t('accessibility_labels');
  if (hasPolicy) return t('privacy_policies');
  return t('privacy_labels');
}

function ReviewSection({ id, reviewable }: { id: string; reviewable: ReviewableApp[] }) {
  const tSections = useTranslations('dashboard.sections');
  const tRowMeta = useTranslations('dashboard.row_meta');
  const tRisk = useTranslations('risk');
  const tRel = useTranslations('dashboard.relative_time');
  const tReviewSummary = useTranslations('dashboard.review_summary');
  const summaryPhrase = buildReviewableSummaryPhrase(tReviewSummary, reviewable);
  return (
    <section id={id} className="home-section home-section-review">
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">{tSections('review_kicker')}</span>
        </h2>
        <p className="home-section-sub">
          {tSections('review_sub', { summary: summaryPhrase, count: reviewable.length })}
        </p>
      </div>

      <div className="home-row-list">
        {reviewable.map(app => {
          // If the only change we detected on this scrape was an
          // accessibility-label update, suppress the privacy-risk pill.
          // The pill is derived from privacy labels alone (tracking /
          // linked / unlinked counts) so rendering it next to an
          // accessibility-only change reads as editorial about the
          // change, which is misleading. Instead we swap in a neutral
          // "Accessibility" pill so the row doesn't lose its trailing
          // chip (which keeps the grid visually aligned). Rows with
          // mixed categories — e.g. accessibility + privacy-label — keep
          // the risk pill because the privacy posture *is* relevant.
          const isAccessibilityOnly =
            app.categories.length === 1 &&
            app.categories[0] === 'accessibility';
          return (
            <Link
              key={app.id}
              href={`/apps/${app.id}#what-changed`}
              className="home-row home-row-review"
            >
              <AppIcon app={app} size={44} />
              <div className="home-row-body">
                <div className="home-row-title">{app.name}</div>
                <div className="home-row-sub">
                  {app.changeCount} change{app.changeCount !== 1 ? 's' : ''} ·{' '}
                  {relativeTime(tRel, app.lastChangeAt)}
                  {app.topChange && (
                    <span className="home-row-topchange"> · {app.topChange}</span>
                  )}
                </div>
              </div>
              {isAccessibilityOnly ? (
                <span
                  className="risk-pill risk-pill-accessibility"
                  title={tRowMeta('accessibility_only_change_tooltip')}
                >
                  {tRowMeta('accessibility_chip')}
                </span>
              ) : (
                <span className={`risk-pill ${RISK_CLS[app.riskLevel]}`}>
                  {tRisk(`${app.riskLevel}_label`)}
                </span>
              )}
              <span className="home-row-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Consider replacing (privacy-profile mismatches)
//
// Purely opt-in — only renders when the user has a privacy profile set AND
// at least one app exceeds it. Rows are already sorted worst-first on the
// server (by totalGap desc), so the first few entries are the most-egregious
// mismatches. Each row deep-links to the app's detail page so the user can
// decide whether to delete / replace it.
// ─────────────────────────────────────────────

function ConsiderReplacingSection({
  id,
  apps,
}: {
  id: string;
  apps: AppMismatchSummary[];
}) {
  const tCategory = useTranslations('category');
  const tTier = useTranslations('privacy_profile_tier_short');
  const tMismatch = useTranslations('privacy_profile_mismatch_sentence');
  const tBadge = useTranslations('profile_badge');
  // Cap the visible list to keep the section scannable. Users with many
  // mismatches get a "see all" footer that routes to the apps grid with
  // the "bad match" filter implicitly applied via the badge (which is now
  // present on every card).
  const MAX_VISIBLE = 6;
  const visible = apps.slice(0, MAX_VISIBLE);
  const hidden = Math.max(0, apps.length - visible.length);

  return (
    <section id={id} className="home-section profile-replace-section">
      <div className="profile-replace-section-title">
        <span aria-hidden>🛡</span>
        Consider replacing
        <span className="home-section-count" style={{ marginLeft: 6 }}>
          {apps.length} app{apps.length !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="profile-replace-section-subtitle">
        These apps go further than your privacy profile allows. Open one to see
        which categories mismatch, and decide whether to keep, replace, or
        delete.
      </p>

      <div className="profile-replace-list">
        {visible.map(entry => {
          const top = entry.mismatch.mismatches[0];
          // Fallback description in the (practically impossible) case where
          // the mismatch array is empty — we only surface apps with count>0,
          // so the localised mismatch helper should rarely return null.
          const desc =
            describeWorstMismatchLocalised(
              entry.mismatch,
              (key) => i18nCategoryLabel(tCategory, key),
              (key) => tTier(key),
              (key, values) => tMismatch(key, values),
            ) ??
            tBadge('mismatches_description', { count: entry.mismatch.count });
          // The tier chip colour mirrors the worst observed tier. We reuse
          // the existing severity-* classes from globals.css (via TIER_META)
          // so the palette stays consistent with every other privacy surface.
          const tierCls = top ? TIER_META[top.observed].severityCls : '';
          const topCategory = top ? (CATEGORY_META[top.category]?.icon ?? '•') : '•';
          return (
            <Link
              key={entry.appId}
              href={`/apps/${entry.appId}`}
              className="profile-replace-row"
              title={`Open ${entry.appName}`}
            >
              {entry.iconUrl ? (
                <Image
                  src={entry.iconUrl}
                  alt=""
                  width={36}
                  height={36}
                  className="profile-replace-row-icon"
                  unoptimized
                  style={{ objectFit: 'cover' }}
                />
              ) : (
                <div className="profile-replace-row-icon" aria-hidden>
                  <span style={{ fontSize: 22 }}>{topCategory}</span>
                </div>
              )}
              <div className="profile-replace-row-body">
                <div className="profile-replace-row-name">{entry.appName}</div>
                <div className="profile-replace-row-desc">{desc}</div>
              </div>
              {tierCls && (
                <span className={`risk-chip ${tierCls}`} aria-hidden>
                  {top ? TIER_META[top.observed].icon : ''}
                </span>
              )}
              <span className="profile-replace-row-count">
                {entry.mismatch.count} mismatch
                {entry.mismatch.count === 1 ? '' : 'es'}
              </span>
            </Link>
          );
        })}
      </div>

      {hidden > 0 && (
        <p className="settings-field-help" style={{ marginTop: 10 }}>
          +{hidden} more on the{' '}
          <Link href="/dashboard/apps" className="welcome-link">
            apps page
          </Link>
          {' '}(look for the warning badge).
        </p>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Higher-risk apps
// ─────────────────────────────────────────────

function RiskSection({
  id,
  apps,
  variant = 'default',
}: {
  id: string;
  apps: TriageApp[];
  /** Intent-driven wording. `cleanup` frames this as a delete-list, `family`
   *  frames it as a review-with-kids list, `default` is the neutral watchlist. */
  variant?: 'default' | 'cleanup' | 'family';
}) {
  const tSections = useTranslations('dashboard.sections');
  const tRisk = useTranslations('risk');
  const kicker =
    variant === 'cleanup'
      ? tSections('cleanup_kicker')
      : variant === 'family'
        ? tSections('family_kicker')
        : tSections('watchlist_kicker');
  const sub =
    variant === 'cleanup'
      ? tSections('cleanup_sub')
      : variant === 'family'
        ? tSections('family_sub')
        : tSections('watchlist_sub');
  return (
    <section id={id} className="home-section home-section-risk home-section-watchlist">
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">{kicker}</span>
          <span className="home-section-count">
            {tSections('watchlist_count', { count: apps.length })}
          </span>
        </h2>
        <p className="home-section-sub">{sub}</p>
      </div>

      <div className="home-row-list">
        {apps.map(app => (
          <Link key={app.id} href={`/apps/${app.id}`} className="home-row home-row-risk">
            <AppIcon app={app} size={40} />
            <div className="home-row-body">
              <div className="home-row-title">{app.name}</div>
              <div className="home-row-sub">
                {app.trackCount > 0 && (
                  <span className="home-row-chip home-row-chip-track">
                    👁 {app.trackCount} track
                  </span>
                )}
                {app.linkedCount > 0 && (
                  <span className="home-row-chip home-row-chip-linked">
                    🔗 {app.linkedCount} linked
                  </span>
                )}
                {app.unlinkedCount > 0 && (
                  <span className="home-row-chip home-row-chip-unlinked">
                    🔓 {app.unlinkedCount} unlinked
                  </span>
                )}
              </div>
            </div>
            <span className={`risk-pill ${RISK_CLS[app.riskLevel]}`}>
              {tRisk(`${app.riskLevel}_label`)}
            </span>
            <span className="home-row-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>

      <div className="home-section-footer">
        <Link href="/dashboard/apps" className="btn btn-ghost btn-sm">
          See all apps sorted by risk →
        </Link>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Stale apps
// ─────────────────────────────────────────────

function StaleSection({
  id,
  apps,
  elevated = false,
}: {
  id: string;
  apps: TriageApp[];
  /** Hygiene mode elevates this with a distinct colour so stale-policy health
   *  gets the user's attention. */
  elevated?: boolean;
}) {
  const tSections = useTranslations('dashboard.sections');
  const tRowMeta = useTranslations('dashboard.row_meta');
  const tRel = useTranslations('dashboard.relative_time');
  return (
    <section
      id={id}
      className={`home-section home-section-stale${elevated ? ' home-section-stale-elevated' : ''}`}
    >
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">{tSections('stale_kicker')}</span>
        </h2>
        <p className="home-section-sub">
          {elevated
            ? tSections('stale_sub_elevated')
            : tSections('stale_sub_short')}
        </p>
      </div>

      <div className="home-row-list">
        {apps.map(app => (
          <Link key={app.id} href={`/apps/${app.id}`} className="home-row home-row-stale">
            <AppIcon app={app} size={40} />
            <div className="home-row-body">
              <div className="home-row-title">{app.name}</div>
              <div className="home-row-sub">{tRowMeta('last_synced', { relative: relativeTime(tRel, app.lastSynced) })}</div>
            </div>
            <span className="home-row-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: Recent activity feed
// ─────────────────────────────────────────────

function ActivitySection({ activity }: { activity: RecentActivityEntry[] }) {
  const tSections = useTranslations('dashboard.sections');
  const tRel = useTranslations('dashboard.relative_time');
  return (
    <section className="home-section home-section-activity">
      <div className="home-section-header">
        <h2 className="home-section-title">
          <span className="home-section-kicker">{tSections('activity_kicker')}</span>
        </h2>
      </div>
      <ul className="home-activity-list">
        {activity.map((a, i) => (
          <li key={`${a.appId}-${i}`} className="home-activity-item">
            <AppIcon
              app={{ iconUrl: a.iconUrl, name: a.appName }}
              size={28}
              className="home-activity-icon"
            />
            <div className="home-activity-body">
              <Link href={`/apps/${a.appId}#what-changed`} className="home-activity-app">
                {a.appName}
              </Link>
              <span className="home-activity-meta">
                {a.addedCount > 0 && <span className="home-activity-added">+{a.addedCount}</span>}
                {a.removedCount > 0 && (
                  <span className="home-activity-removed">−{a.removedCount}</span>
                )}
                {a.modifiedCount > 0 && (
                  <span className="home-activity-modified">✎{a.modifiedCount}</span>
                )}
                {a.topChange && <span className="home-activity-top"> · {a.topChange}</span>}
              </span>
            </div>
            <span className="home-activity-date">{relativeTime(tRel, a.scrapedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────
// Section: At-a-glance stats
// ─────────────────────────────────────────────

function GlanceSection({ triage }: { triage: TriageData }) {
  const hasChanges = triage.changesThisWeek > 0;
  return (
    <section className="home-section home-section-glance">
      <div className="home-glance-grid">
        <GlanceStat
          label="Apps tracked"
          value={triage.totalApps}
          href="/dashboard/apps"
          subtitle="View full app list"
        />
        <GlanceStat
          label="Privacy categories"
          value={triage.totalCategories}
          href="/dashboard/privacy"
          subtitle="Open Privacy Map"
        />
        <GlanceStat
          label="High risk"
          value={triage.highRiskCount}
          tone={triage.highRiskCount > 0 ? 'warn' : 'ok'}
          href={triage.highRiskCount > 0 ? '/dashboard/apps?risk=high' : '/dashboard/apps'}
          subtitle={
            triage.highRiskCount > 0
              ? 'Tracking or sensitive data'
              : 'No tracking detected'
          }
        />
        <GlanceStat
          label="Changes this week"
          value={triage.changesThisWeek}
          tone={hasChanges ? 'warn' : 'ok'}
          href={hasChanges ? '#changes-to-review' : '/dashboard/stats'}
          subtitle={hasChanges ? 'Review what shifted' : 'Nothing new detected'}
        />
      </div>
    </section>
  );
}

function GlanceStat({
  label,
  value,
  tone = 'neutral',
  href,
  subtitle,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'neutral';
  href?: string;
  subtitle?: string;
}) {
  const content = (
    <>
      <div className="home-glance-value">{value}</div>
      <div className="home-glance-label">{label}</div>
      {subtitle && <div className="home-glance-sub">{subtitle}</div>}
      {href && <span className="home-glance-arrow" aria-hidden="true">→</span>}
    </>
  );

  if (href && href.startsWith('#')) {
    return (
      <a
        href={href}
        className={`home-glance-stat home-glance-${tone} home-glance-link`}
        onClick={e => handleHashClick(e, href)}
      >
        {content}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} className={`home-glance-stat home-glance-${tone} home-glance-link`}>
        {content}
      </Link>
    );
  }
  return <div className={`home-glance-stat home-glance-${tone}`}>{content}</div>;
}

// ─────────────────────────────────────────────
// App icon helper
// ─────────────────────────────────────────────

function AppIcon({
  app,
  size,
  className = '',
}: {
  app: { iconUrl?: string; name: string };
  size: number;
  className?: string;
}) {
  if (app.iconUrl) {
    return (
      <Image
        src={app.iconUrl}
        alt=""
        width={size}
        height={size}
        className={`home-app-icon ${className}`}
        unoptimized
        style={{ objectFit: 'cover', borderRadius: Math.round(size * 0.22) }}
      />
    );
  }
  return (
    <div
      className={`home-app-icon home-app-icon-placeholder ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        fontSize: Math.round(size * 0.4),
      }}
    >
      {app.name[0]}
    </div>
  );
}
