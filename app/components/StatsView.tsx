'use client';

import { useCallback, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { StatsData } from '../../lib/stats';
import InfoTooltip from './InfoTooltip';

import { CATEGORY_META } from '../../lib/privacy-meta';
import PrivacyHeatmap from './charts/PrivacyHeatmap';
import PrivacySankey from './charts/PrivacySankey';
import PrivacyTimeline from './charts/PrivacyTimeline';
import PrivacyRadar, { type PrivacyRadarStatus } from './charts/PrivacyRadar';
import SmallMultiples from './charts/SmallMultiples';
import CompareAppsView from './CompareAppsView';
import AccessibilityFigureGlyph from './AccessibilityFigureGlyph';

type TimeT = (key: string, values?: Record<string, string | number>) => string;
function timeAgo(t: TimeT, ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  if (d === 0) return t('today');
  if (d === 1) return t('yesterday');
  return t('days_ago', { count: d });
}

// Synthetic app_ids mirrored from lib/notifications.ts. Recent Changes pulls
// straight from the `notifications` table, so rows raised against these
// pseudo-apps must be routed to the matching Settings section instead of
// `/apps/<synthetic-id>` (which 404s). Kept in sync by the same contract
// that NotificationBell uses — if a new synthetic id is added upstream,
// both renderers have to learn about it.
const AI_TIMEOUT_NOTIFICATION_APP_ID = '__ai_timeout__';
const MANUAL_APPS_NOTIFICATION_APP_ID = '__manual_apps__';
const IMPORT_COMPLETION_NOTIFICATION_APP_ID = '__import__';
const WAYBACK_RESUME_NOTIFICATION_APP_ID = '__wayback_resume__';
const SYNC_RESUME_NOTIFICATION_APP_ID = '__sync_resume__';
const POLICY_RESUME_NOTIFICATION_APP_ID = '__policy_resume__';

/**
 * Resolve the href + display headline for a recent-change row. Mirrors the
 * routing table in NotificationBell so the two surfaces stay consistent:
 * click a row in the bell and click the same row in "View all" should land
 * the user in the same place. Returns the original app_name as the headline
 * for real-app rows so nothing changes for the common case.
 */
/**
 * Pure router for recent-change rows. Maps a notification's
 * `change_summary[0].type` (and a handful of synthetic app ids) to
 * the deep-link path + visible headline. The caller supplies a
 * `tHeadlines` translator so this stays pure (no React hook calls)
 * while still localising the headline against the active locale.
 */
function resolveRecentChangeDestination(
  n: {
    app_id: string;
    app_name: string;
    change_summary: { type?: string; status?: 'ok' | 'partial' | 'error' }[];
  },
  tHeadlines: (key: string) => string,
): { href: string; headline: string } {
  const firstType = n.change_summary[0]?.type;
  if (n.app_id === AI_TIMEOUT_NOTIFICATION_APP_ID || firstType === 'ai_timeout') {
    return { href: '/dashboard/settings#ai-timeouts', headline: tHeadlines('ai_timeout') };
  }
  if (n.app_id === MANUAL_APPS_NOTIFICATION_APP_ID || firstType === 'manual_apps_prompt') {
    return {
      href: '/dashboard/settings/import-history?filter=unmatched',
      headline: tHeadlines('unmatched_apps'),
    };
  }
  if (n.app_id === IMPORT_COMPLETION_NOTIFICATION_APP_ID || firstType === 'import_completed') {
    const status = n.change_summary[0]?.status;
    return {
      href: status === 'ok'
        ? '/dashboard/settings/import-history'
        : '/dashboard/settings/import-history?filter=problems',
      headline: status === 'ok'
        ? tHeadlines('import_finished')
        : status === 'partial'
          ? tHeadlines('import_partially_finished')
          : tHeadlines('import_needs_attention'),
    };
  }
  if (
    n.app_id === WAYBACK_RESUME_NOTIFICATION_APP_ID
    || firstType === 'wayback_resumed'
    || firstType === 'wayback_stale_cleared'
  ) {
    return {
      href: '/dashboard/settings#wayback-import',
      headline: firstType === 'wayback_stale_cleared'
        ? tHeadlines('wayback_lock_cleared')
        : tHeadlines('wayback_resumed'),
    };
  }
  if (
    n.app_id === SYNC_RESUME_NOTIFICATION_APP_ID
    || firstType === 'sync_resumed'
    || firstType === 'sync_stale_cleared'
  ) {
    return {
      href: '/dashboard/settings#sync-status',
      headline: firstType === 'sync_stale_cleared'
        ? tHeadlines('sync_lock_cleared')
        : tHeadlines('sync_resumed'),
    };
  }
  if (
    n.app_id === POLICY_RESUME_NOTIFICATION_APP_ID
    || firstType === 'policy_resumed'
    || firstType === 'policy_stale_cleared'
  ) {
    return {
      href: '/dashboard/settings#privacy-policies-bulk',
      headline: firstType === 'policy_stale_cleared'
        ? tHeadlines('policy_lock_cleared')
        : tHeadlines('policy_resumed'),
    };
  }
  return { href: `/apps/${n.app_id}`, headline: n.app_name };
}

// Synthetic/system notification types — rows whose primary entry carries
// one of these type strings aren't privacy-label diffs, so the "Privacy
// label changes only" filter hides them. Wayback imports show up here too
// (type: 'wayback') so they get filtered out, which is the whole point of
// the toggle the user asked for. Kept outside the component so the list
// survives renders without getting rebuilt.
const NON_PRIVACY_LABEL_TYPES = new Set<string>([
  'ai_timeout',
  'manual_apps_prompt',
  'import_completed',
  'wayback_resumed', 'wayback_stale_cleared',
  'sync_resumed',    'sync_stale_cleared',
  'policy_resumed',  'policy_stale_cleared',
  'wayback',         // wayback snapshot imports
  'policy',          // privacy-policy updates — still useful, but not a label change
]);

export interface StatsFlagState {
  vizHeatmap: boolean;
  vizTimeline: boolean;
  vizCompare: boolean;
  vizSmallMultiples: boolean;
  vizSankey: boolean;
  vizRadar: boolean;
  vizCategoryBars: boolean;
  vizAccessibilityBars: boolean;
  recentChangesFilter: boolean;
  offProfileCard: boolean;
}

export default function StatsView({
  stats,
  trackAccessibility = true,
  flags,
}: {
  stats: StatsData;
  /**
   * Server-hydrated mirror of the `track_accessibility_labels` setting.
   * When false, the accessibility summary card and feature-coverage chart
   * are hidden entirely so users who've opted out of the feature don't see
   * a dangling zero stat or an empty panel.
   */
  trackAccessibility?: boolean;
  /** Round 3 wave G — flag.stats.* values resolved server-side. */
  flags?: StatsFlagState;
}) {
  // i18n — page title + the eleven panel headings. The dense per-panel
  // chart labels and tooltips remain English in v1; tracked under the
  // broader sweep.
  const tStats = useTranslations('stats');
  const tPanels = useTranslations('stats.panels');
  const tSubs = useTranslations('stats.subs');
  const tFilter = useTranslations('stats.filter');
  // Recent-change row headlines share the bell's `notifications.headlines.*`
  // namespace so a copy edit ripples to both surfaces.
  const tNotifHeadlines = useTranslations('notifications.headlines');

  // All-on defaults so legacy callers without a flags prop render the same
  // pre-flag stats page.
  const f: StatsFlagState = {
    vizHeatmap: flags?.vizHeatmap ?? true,
    vizTimeline: flags?.vizTimeline ?? true,
    vizCompare: flags?.vizCompare ?? true,
    vizSmallMultiples: flags?.vizSmallMultiples ?? true,
    vizSankey: flags?.vizSankey ?? true,
    vizRadar: flags?.vizRadar ?? true,
    vizCategoryBars: flags?.vizCategoryBars ?? true,
    vizAccessibilityBars: flags?.vizAccessibilityBars ?? true,
    recentChangesFilter: flags?.recentChangesFilter ?? true,
    offProfileCard: flags?.offProfileCard ?? true,
  };

  const [reSyncing, setReSyncing] = useState<string | null>(null);
  const [toast, setToast]         = useState('');
  // null = radar hasn't reported yet (still loading); true = keep panel;
  // false = no app has a policy summary, hide the whole panel chrome so
  // the Stats page doesn't end on a heading with no content.
  const [radarHasAnyPolicy, setRadarHasAnyPolicy] = useState<boolean | null>(null);
  // Single-select filter on the Recent Changes feed. The three options
  // are mutually-exclusive because privacy-label and accessibility are
  // different categories on the same row — "both on" never matches
  // anything. Modelling as a 3-way segmented toggle (All / Privacy /
  // Accessibility) makes that exclusivity visible in the UI and removes
  // the "empty when both on" recovery state we needed with checkboxes.
  //
  //   'all'           → every recent change row.
  //   'privacy'       → only added/removed/modified rows with
  //                     category === 'privacy-label' (NOT accessibility,
  //                     policy, wayback, or system).
  //   'accessibility' → only added/removed/modified rows with
  //                     category === 'accessibility'.
  type RecentChangesFilter = 'all' | 'privacy' | 'accessibility';
  const [recentChangesFilter, setRecentChangesFilter] = useState<RecentChangesFilter>('all');

  const visibleChanges = useMemo(() => {
    if (recentChangesFilter === 'all') return stats.recentChanges;
    return stats.recentChanges.filter(n => {
      const first = n.change_summary?.[0];
      if (!first) return false;
      // System notifications never match either filter — they're not
      // label diffs at all. Same logic for wayback-sourced entries and
      // policy rows that previously snuck through the privacy-only
      // filter.
      if (first.category === 'wayback-attempt') return false;
      if (first.type && NON_PRIVACY_LABEL_TYPES.has(first.type)) return false;

      const isLabelDiff =
        first.type === 'added' ||
        first.type === 'removed' ||
        first.type === 'modified';
      if (!isLabelDiff) return false;

      // Legacy rows (written before `category` existed) default to
      // 'privacy-label' so they stay visible under the privacy filter,
      // matching how the rest of the app treats unlabelled entries.
      const category = first.category ?? 'privacy-label';

      if (recentChangesFilter === 'privacy') return category === 'privacy-label';
      if (recentChangesFilter === 'accessibility') return category === 'accessibility';
      return true;
    });
  }, [stats.recentChanges, recentChangesFilter]);
  const hiddenChangesCount = stats.recentChanges.length - visibleChanges.length;

  const handleRadarStatus = useCallback((status: PrivacyRadarStatus) => {
    setRadarHasAnyPolicy(status.hasAnyPolicy);
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const reSyncApp = async (url: string, name: string, id: string) => {
    setReSyncing(id);
    try {
      await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [url], resync: true }),
      });
      showToast(`✓ ${name} synced`);
      setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      console.error(`[stats] Re-sync failed for ${name} (${url}):`, error);
      showToast('❌ Sync failed');
    }
    setReSyncing(null);
  };

  const maxCategoryCount = stats.categoryFrequency[0]?.appCount ?? 1;

  // Accessibility headline stat — shown as "X% accessible" with the
  // evaluated denominator on the secondary line. Gated on the feature
  // toggle AND on the denominator being non-zero, so a brand-new library
  // where no app has been re-scraped under the accessibility-aware scraper
  // yet doesn't show a meaningless 0/0.
  const showAccessibilityCard =
    trackAccessibility && stats.appsEvaluatedForAccessibility > 0;
  const accessibilityPct = showAccessibilityCard
    ? Math.round(
        (stats.appsWithAccessibilityLabels / stats.appsEvaluatedForAccessibility) * 100,
      )
    : 0;
  // The accessibility chart scales bars against the evaluated denominator,
  // not the top feature's count, so a feature supported by 3 / 10 apps
  // reads as 30% — matching the "out of N apps" label rather than "out of
  // the most-supported feature". `1` guards against divide-by-zero in the
  // (already-suppressed) empty case.
  const accessibilityDenominator =
    stats.appsEvaluatedForAccessibility > 0
      ? stats.appsEvaluatedForAccessibility
      : 1;
  // Show the accessibility panel whenever the feature is on. Even when no
  // app claims any feature yet, the panel renders the canonical list at 0
  // bars so the user can see what Apple exposes.
  const showAccessibilityPanel = trackAccessibility;

  const summaryCards = [
    { label: tStats('tile_apps_label'),         value: stats.totalApps,             sub: tStats('tile_apps_sub'),           color: 'var(--blue)'   },
    { label: tStats('tile_categories_label'),      value: stats.totalCategories,       sub: tStats('tile_categories_sub', { count: stats.totalUniqueCategories }), color: 'var(--orange)' },
    { label: tStats('tile_changes_label'),         value: stats.appsWithChanges,       sub: tStats('tile_changes_sub'),          color: stats.appsWithChanges > 0 ? 'var(--red)' : 'var(--green)' },
    { label: tStats('tile_resync_label'),         value: stats.staleApps,             sub: tStats('tile_resync_sub'),          color: stats.staleApps > 0 ? 'var(--yellow)' : 'var(--green)' },
    // Privacy-profile mismatch card: only shown when a profile is active, so
    // users without one don't see a permanently-zero "Off Profile" stat.
    // Wave I: also gated by `flag.stats.off_profile_card` so users can hide
    // the card without disabling the underlying profile feature.
    ...(f.offProfileCard && stats.profileActive ? [{
      label: tStats('tile_off_profile_label'),
      value: stats.appsNotMatchingProfile,
      sub: stats.appsNotMatchingProfile === 0
        ? 'all apps match your profile'
        : `exceed your privacy preferences`,
      color: stats.appsNotMatchingProfile > 0 ? 'var(--red)' : 'var(--green)',
    }] : []),
    // Accessibility card: only when the toggle is on and we actually have
    // ≥1 evaluated app. "Accessible" here means Apple has published at
    // least one accessibility feature for the app — it's a floor, not a
    // ceiling, as Apple itself warns in the disclaimer on the detail page.
    ...(showAccessibilityCard ? [{
      label: tStats('tile_a11y_label'),
      value: `${accessibilityPct}%`,
      sub: `${stats.appsWithAccessibilityLabels} of ${stats.appsEvaluatedForAccessibility} evaluated`,
      color: accessibilityPct >= 50 ? 'var(--green)' : accessibilityPct > 0 ? 'var(--yellow)' : 'var(--red)',
    }] : []),
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tStats('page_title')}</h1>
          <p className="page-subtitle">
            {stats.totalSyncs} total sync{stats.totalSyncs !== 1 ? 's' : ''} recorded
          </p>
        </div>

        {/* Export dropdown */}
        <div style={{ position: 'relative', display: 'flex', gap: 10 }}>
          <a href="/api/export?format=csv" className="btn btn-secondary" download>
            ⬇ Export CSV
          </a>
          <a href="/api/export?format=json" className="btn btn-secondary" download>
            ⬇ Export JSON
          </a>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-cards">
        {summaryCards.map(c => (
          <div key={c.label} className="stat-card">
            <div className="stat-card-value" style={{ color: c.color }}>{c.value}</div>
            <div className="stat-card-label">{c.label}</div>
            <div className="stat-card-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="stats-grid">
        {/* Category frequency chart */}
        {f.vizCategoryBars && <section className="glass-card stats-panel">
          <h2 className="stats-panel-title">{tPanels('most_collected')}</h2>
          <p className="stats-panel-sub">{tSubs('most_collected')}</p>

          {stats.categoryFrequency.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 0' }}>
              <div>{tStats('empty_no_data')}</div>
            </div>
          ) : (
            <div className="bar-chart">
              {stats.categoryFrequency.map(c => {
                const pct = Math.round((c.appCount / maxCategoryCount) * 100);
                const color = CATEGORY_META[c.identifier]?.color ?? 'var(--blue)';
                const meta = CATEGORY_META[c.identifier];
                
                return (
                  <div key={c.identifier} className="bar-row">
                    <div className="bar-label-wrap">
                      <div className="bar-label">{c.title}</div>
                      {meta?.description && <InfoTooltip text={meta.description} side="right" />}
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{ width: `${pct}%`, background: color }}
                      >
                        <span className="bar-count">{tStats('n_apps', { count: c.appCount })}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>}

        {/* Recent changes */}
        <section className="glass-card stats-panel">
          <h2 className="stats-panel-title">{tPanels('recent_changes')}</h2>
          <p className="stats-panel-sub">{tSubs('recent_changes')}</p>

          {/* Filter toolbar — a single-select segmented toggle that
              mirrors the Risks and Accessibility filters on the
              dashboard grid so every "scope this list" control across
              the app feels identical. Only rendered once we have rows,
              since it's meaningless on an empty list. */}
          {f.recentChangesFilter && stats.recentChanges.length > 0 && (
            <div className="recent-changes-toolbar">
              <div
                className="segmented-toggle"
                role="group"
                aria-label={tFilter('aria')}
              >
                <button
                  type="button"
                  className={`segmented-toggle-btn ${recentChangesFilter === 'all' ? 'is-active' : ''}`}
                  onClick={() => setRecentChangesFilter('all')}
                  aria-pressed={recentChangesFilter === 'all'}
                  title={tFilter('all_title')}
                >
                  <span>{tFilter('all_label')}</span>
                </button>
                <button
                  type="button"
                  className={`segmented-toggle-btn ${recentChangesFilter === 'privacy' ? 'is-active' : ''}`}
                  onClick={() => setRecentChangesFilter('privacy')}
                  aria-pressed={recentChangesFilter === 'privacy'}
                  title={tFilter('privacy_title')}
                >
                  <span>{tFilter('privacy_label')}</span>
                </button>
                {trackAccessibility && (
                  <button
                    type="button"
                    className={`segmented-toggle-btn ${recentChangesFilter === 'accessibility' ? 'is-active' : ''}`}
                    onClick={() => setRecentChangesFilter('accessibility')}
                    aria-pressed={recentChangesFilter === 'accessibility'}
                    title={tFilter('accessibility_title')}
                  >
                    <span>{tStats('filter_accessibility')}</span>
                  </button>
                )}
              </div>
              <span className="recent-changes-count">
                {visibleChanges.length} of {stats.recentChanges.length}
                {hiddenChangesCount > 0 && (
                  <span className="recent-changes-count-muted"> · {hiddenChangesCount} hidden</span>
                )}
              </span>
            </div>
          )}

          {stats.recentChanges.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
              <div>{tStats('empty_no_changes')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{tStats('empty_no_changes_sub')}</div>
            </div>
          ) : visibleChanges.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🔍</div>
              {recentChangesFilter === 'accessibility' ? (
                <>
                  <div>{tStats('empty_no_a11y_changes')}</div>
                  <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text-3)' }}>
                    Switch back to All to see privacy labels and other events.
                  </div>
                </>
              ) : (
                <>
                  <div>{tStats('empty_no_privacy_changes')}</div>
                  <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text-3)' }}>
                    Switch back to All to see accessibility, wayback imports
                    and other events.
                  </div>
                </>
              )}
            </div>
          ) : (
            /* Scrollable body. Keeps the Recent Changes panel's footprint
               bounded so a busy library can't push everything below it off
               the fold — users scroll *within* the panel instead. */
            <div className="recent-changes-scroll">
              {visibleChanges.map(n => {
                const { href, headline } = resolveRecentChangeDestination(n, tNotifHeadlines);
                // Real-app rows fall through the resolver unchanged, so
                // they keep the existing icon/description copy. Synthetic
                // rows (AI timeout, resume, import completion, etc.) don't
                // have an iconUrl, so the first-letter placeholder becomes
                // the generic fallback — the headline itself is distinct.
                const firstType = n.change_summary[0]?.type as string | undefined;
                const isSynthetic = href.startsWith('/dashboard/');
                const descLine = isSynthetic && n.change_summary[0]?.description
                  ? n.change_summary[0].description
                  : `${n.change_summary.length} change${n.change_summary.length !== 1 ? 's' : ''}${n.change_summary[0] ? ` · ${n.change_summary[0].description}` : ''}`;
                return (
                  <Link key={n.id} href={href} className="recent-change-row">
                    {n.iconUrl ? (
                      <Image src={n.iconUrl} alt={n.app_name} width={36} height={36} className="recent-change-icon" unoptimized />
                    ) : (
                      <div className="recent-change-icon-placeholder">
                        {firstType === 'ai_timeout' ? '⏱'
                          : firstType === 'manual_apps_prompt' ? '🔖'
                          : firstType === 'import_completed' ? '✓'
                          : firstType === 'wayback_resumed' || firstType === 'sync_resumed' || firstType === 'policy_resumed' ? '↻'
                          : firstType === 'wayback_stale_cleared' || firstType === 'sync_stale_cleared' || firstType === 'policy_stale_cleared' ? '⚠'
                          : headline[0] ?? '·'}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="recent-change-app">{headline}</div>
                      <div className="recent-change-desc">{descLine}</div>
                    </div>
                    <div className="recent-change-date">{timeAgo(tStats, n.created_at)}</div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Accessibility coverage — how many tracked apps claim each feature.
          Sits here, directly under the privacy categories chart, so the
          two "what do apps declare?" breakdowns live side-by-side in the
          reading order. Gated on the Settings toggle so users who've
          opted out of the feature don't see a chart of zero bars. */}
      {f.vizAccessibilityBars && showAccessibilityPanel && (
        <section
          className="glass-card stats-panel"
          style={{ marginTop: 24 }}
          id="accessibility-coverage"
        >
          <h2 className="stats-panel-title">{tPanels('accessibility_features')}</h2>
          <p className="stats-panel-sub">
            How many of your tracked apps claim each accessibility feature,
            out of {stats.appsEvaluatedForAccessibility} evaluated app
            {stats.appsEvaluatedForAccessibility === 1 ? '' : 's'}. Apple
            lets developers self-declare — test before you rely on it.
          </p>

          {stats.appsEvaluatedForAccessibility === 0 ? (
            <div className="empty-state" style={{ padding: '32px 0' }}>
              <div style={{ marginBottom: 8, color: 'var(--text-3)' }}>
                <AccessibilityFigureGlyph size={28} />
              </div>
              <div>{tStats('empty_no_apps_evaluated')}</div>
              <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text-3)' }}>
                Re-sync your apps to pull Apple&apos;s accessibility labels.
              </div>
            </div>
          ) : (
            <div className="bar-chart a11y-bar-chart">
              {stats.accessibilityFeatureFrequency.map(f => {
                const pct = Math.round((f.appCount / accessibilityDenominator) * 100);
                return (
                  <div key={f.identifier} className="bar-row">
                    <div className="bar-label-wrap">
                      <div className="bar-label">{f.title}</div>
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(pct, f.appCount > 0 ? 2 : 0)}%`,
                          background: 'var(--blue)',
                        }}
                      >
                        <span className="bar-count">
                          {f.appCount} app{f.appCount !== 1 ? 's' : ''}
                          {f.appCount > 0 ? ` · ${pct}%` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Privacy Heatmap — apps × categories, coloured by severity */}
      {f.vizHeatmap && <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
        <h2 className="stats-panel-title">{tPanels('privacy_heatmap')}</h2>
        <p className="stats-panel-sub">{tSubs('privacy_heatmap')}</p>
        <PrivacyHeatmap />
      </section>}

      {/* Stacked area timeline — privacy changes over a configurable window */}
      {f.vizTimeline && <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
        <h2 className="stats-panel-title">{tPanels('change_timeline')}</h2>
        <p className="stats-panel-sub">{tSubs('change_timeline')}</p>
        <PrivacyTimeline />
      </section>}

      {/* Compare Apps — sits below Timeline so the flow is:
          big-picture overview → historical changes → side-by-side drill-down. */}
      {f.vizCompare && <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
        <h2 className="stats-panel-title">{tPanels('compare_apps')}</h2>
        <p className="stats-panel-sub">{tSubs('compare_apps')}</p>
        <CompareAppsView />
      </section>}

      {/* Small multiples — compact per-app severity strips with category header */}
      {f.vizSmallMultiples && <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
        <h2 className="stats-panel-title">{tPanels('per_app_severity')}</h2>
        <p className="stats-panel-sub">{tSubs('per_app_severity')}</p>
        <SmallMultiples />
      </section>}

      {/* Sankey — app → severity → category */}
      {f.vizSankey && <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
        <h2 className="stats-panel-title">{tPanels('severity_flow')}</h2>
        <p className="stats-panel-sub">{tSubs('severity_flow')}</p>
        <PrivacySankey />
      </section>}

      {/* Policy radar — compare policy-summary lenses across a few tracked apps. */}
      {f.vizRadar && radarHasAnyPolicy !== false && (
        <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
          <h2 className="stats-panel-title">{tPanels('policy_fingerprint')}</h2>
          <p className="stats-panel-sub">{tSubs('policy_fingerprint')}</p>
          <PrivacyRadar onStatusChange={handleRadarStatus} />
        </section>
      )}

      {/* Stale apps */}
      {stats.staleAppsList.length > 0 && (
        <section className="glass-card stats-panel" style={{ marginTop: 24 }}>
          <h2 className="stats-panel-title">{tPanels('needs_resync')}</h2>
          <p className="stats-panel-sub">{tSubs('needs_resync')}</p>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {stats.staleAppsList.map(app => (
              <div key={app.id} className="stale-row">
                {app.iconUrl ? (
                  <Image src={app.iconUrl} alt={app.name} width={40} height={40} className="stale-icon" unoptimized />
                ) : (
                  <div className="stale-icon-placeholder">{app.name[0]}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{app.name}</div>
                  {app.developer && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{app.developer}</div>}
                  <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 2 }}>
                    Last synced {timeAgo(tStats, app.lastSynced)}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => reSyncApp(app.url, app.name, app.id)}
                  disabled={reSyncing === app.id}
                >
                  {reSyncing === app.id ? <span className="spinner-sm" /> : '↻'} Sync
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
