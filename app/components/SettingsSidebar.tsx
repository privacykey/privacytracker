'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFlag } from '../../lib/feature-flags-hooks';
import AccessibilityFigureGlyph from './AccessibilityFigureGlyph';

/**
 * Sticky left-column navigation for the Settings page. Renders a list of
 * anchor links to each top-level section, grouped by the same buckets the
 * main column uses (You / Data sync / Privacy policies & AI / Admin), and
 * uses a scroll listener + IntersectionObserver to highlight whichever
 * section is currently visible.
 *
 * Kept structurally independent of SettingsView — it finds sections in the
 * DOM by id rather than receiving them as props. That way, adding or
 * reordering settings sections only requires updating `SECTION_GROUPS`
 * below, not rewiring state between components.
 */

interface SectionLink {
  id: string;
  label: string;
  icon: string; // single emoji; cheap visual anchor without pulling in an icon lib
  /** Optional override key into `settings.sections.*`. When present, the
   *  rendered label reads from i18n at runtime instead of the static
   *  `label` field above. The static label is still kept as a fallback /
   *  documentation hint so the table reads naturally. */
  i18nKey?: string;
}

interface SectionGroup {
  label: string;
  /** Optional override key into `settings.sidebar.group_*` so the
   *  sidebar's group dividers match the rest of the localised UI. */
  i18nGroupKey?: string;
  links: SectionLink[];
}

// Group order and section order here mirror the top-to-bottom order of
// sections in SettingsView. Reorder here AND in SettingsView if you change
// the layout.
const SECTION_GROUPS: SectionGroup[] = [
  {
    label: 'You',
    i18nGroupKey: 'group_you',
    links: [
      { id: 'focus',                  label: 'Your Focus',                  icon: '🎯', i18nKey: 'your_focus' },
      { id: 'language',               label: 'Language',                    icon: '🌐', i18nKey: 'language' },
      { id: 'privacy-profile',        label: 'Privacy Profile',             icon: '🛡', i18nKey: 'privacy_profile' },
      { id: 'accessibility-profile',  label: 'Accessibility Profile',       icon: '♿', i18nKey: 'accessibility_profile' },
      { id: 'notifications',          label: 'Notifications',               icon: '🔔', i18nKey: 'notifications' },
    ],
  },
  {
    label: 'Data sync',
    i18nGroupKey: 'group_data_sync',
    links: [
      { id: 'sync-schedule',          label: 'Sync Schedule',               icon: '⏱', i18nKey: 'sync_schedule' },
      { id: 'region',                 label: 'App Store Region',            icon: '🌐', i18nKey: 'app_store_region' },
      { id: 'sync-status',            label: 'App Store Sync',              icon: '↻', i18nKey: 'app_store_sync_status' },
    ],
  },
  {
    label: 'Privacy policies & AI',
    i18nGroupKey: 'group_policies_ai',
    links: [
      { id: 'ai-summaries',           label: 'AI Policy Summaries',         icon: '✨', i18nKey: 'ai_summaries' },
      { id: 'privacy-policies-bulk',  label: 'Privacy Policies',            icon: '📄', i18nKey: 'privacy_policies' },
      { id: 'policy-alerts',          label: 'Policy Change Alerts',        icon: '📣', i18nKey: 'policy_change_alerts' },
      { id: 'policy-scrape-throttle', label: 'Policy Scrape Throttle',      icon: '🐢', i18nKey: 'policy_scrape_throttle' },
    ],
  },
  {
    label: 'Admin',
    i18nGroupKey: 'group_admin',
    links: [
      { id: 'import-history',         label: 'Import History',              icon: '📥', i18nKey: 'import_history' },
      { id: 'deployment-diagnostics', label: 'Deployment Diagnostics',      icon: '📡', i18nKey: 'deployment_diagnostics' },
      { id: 'backup',                 label: 'Backup & Restore',            icon: '💾', i18nKey: 'backup_restore' },
      { id: 'wayback-import',         label: 'Historical Import',           icon: '🕰', i18nKey: 'historical_import' },
      { id: 'export',                 label: 'Export Data',                 icon: '⬇', i18nKey: 'export_data' },
      { id: 'reset',                  label: 'Reset App',                   icon: '⚠', i18nKey: 'reset_app' },
      { id: 'developer',              label: 'Developer Options',           icon: '⚙', i18nKey: 'developer_options' },
    ],
  },
];

export default function SettingsSidebar() {
  // i18n — sidebar entries that have an `i18nKey` resolve their label
  // through `settings.sections.*` so the labels match the translated
  // section headings on the right. Group dividers + chrome (title /
  // aria-label) come from the smaller `settings.sidebar.*` namespace.
  const tSections = useTranslations('settings.sections');
  const tSidebar = useTranslations('settings.sidebar');

  // Wave I: gate the Developer Options entry (and only that entry) on
  // `flag.devopts.visible`. Other links are always visible — the rest of
  // the sidebar is the user's settings home, while Dev Options is the
  // only group whose visibility is profile-specific.
  const devOptsVisible = useFlag('flag.devopts.visible') === 'on';

  // Flattened link list — useful for scroll-spy, where the group structure
  // is irrelevant. Drop the `developer` link when its flag is off so the
  // observer never tries to attach to a section that isn't rendered in
  // the main column either (the entry is still in the markup of the
  // unfiltered groups so anchor-only deep links keep resolving — we just
  // remove the link from the visible list).
  const groups = useMemo(
    () =>
      SECTION_GROUPS.map(g => ({
        ...g,
        links: g.links.filter(link => link.id !== 'developer' || devOptsVisible),
      })),
    [devOptsVisible],
  );
  const flatLinks = useMemo(
    () => groups.flatMap(group => group.links),
    [groups],
  );

  const [activeId, setActiveId] = useState<string>(flatLinks[0].id);
  // Click-driven focus: when the user clicks a link, suppress the observer
  // briefly so it doesn't flicker the active state to whichever section
  // happens to be highest on screen before the scroll completes.
  const clickLockUntil = useRef<number>(0);

  // Scroll-spy using IntersectionObserver. We pick the section whose top is
  // closest to — but still above — the nav bottom, which roughly matches
  // the reading position the user is actually looking at.
  useEffect(() => {
    const sections = flatLinks
      .map(link => document.getElementById(link.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (sections.length === 0) return;

    // Track intersection ratios in a map keyed by id. The "active" section
    // is the lowest-indexed one whose top has scrolled past the nav line.
    const visibility = new Map<string, number>();

    const observer = new IntersectionObserver(
      entries => {
        if (Date.now() < clickLockUntil.current) return;
        for (const entry of entries) {
          visibility.set(entry.target.id, entry.intersectionRatio);
        }
        // Walk the section list in order; the last section whose top has
        // crossed into (or above) the observer zone wins.
        let next = flatLinks[0].id;
        for (const link of flatLinks) {
          const el = document.getElementById(link.id);
          if (!el) continue;
          const top = el.getBoundingClientRect().top;
          // 120 ≈ nav height (60) + a bit of breathing room so the active
          // row swaps just before the heading crosses the top.
          if (top - 120 <= 0) {
            next = link.id;
          }
        }
        setActiveId(prev => (prev === next ? prev : next));
      },
      {
        threshold: Array.from({ length: 11 }, (_, i) => i / 10),
        rootMargin: '-64px 0px -55% 0px',
      },
    );

    sections.forEach(section => observer.observe(section));

    const onScroll = () => {
      if (Date.now() < clickLockUntil.current) return;
      let next = flatLinks[0].id;
      for (const link of flatLinks) {
        const el = document.getElementById(link.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - 120 <= 0) {
          next = link.id;
        }
      }
      setActiveId(prev => (prev === next ? prev : next));
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [flatLinks]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
      event.preventDefault();
      const el = document.getElementById(id);
      if (!el) return;
      setActiveId(id);
      clickLockUntil.current = Date.now() + 700;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof window !== 'undefined' && window.history) {
        window.history.replaceState(null, '', `#${id}`);
      }
    },
    [],
  );

  // Honour the URL hash on first mount AND when it changes via a real
  // `hashchange` event. Because SettingsView loads several sections
  // asynchronously, a single rAF after mount can land before the page has
  // its final layout — so we re-run the scroll a couple of times at short
  // intervals to snap to the correct final offset.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const validIds = new Set(flatLinks.map(link => link.id));
    const scrollToHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      if (!validIds.has(hash)) return;
      const el = document.getElementById(hash);
      if (!el) return;
      setActiveId(hash);
      clickLockUntil.current = Date.now() + 700;
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
    };

    const rafId = requestAnimationFrame(scrollToHash);
    const retries = [120, 320, 700].map(delay =>
      window.setTimeout(scrollToHash, delay),
    );
    window.addEventListener('hashchange', scrollToHash);

    return () => {
      cancelAnimationFrame(rafId);
      retries.forEach(id => window.clearTimeout(id));
      window.removeEventListener('hashchange', scrollToHash);
    };
  }, [flatLinks]);

  return (
    <aside className="settings-sidebar" aria-label={tSidebar('aria')}>
      <div className="settings-sidebar-inner">
        <div className="settings-sidebar-title">{tSidebar('title')}</div>
        <nav className="settings-sidebar-nav">
          {groups.map(group => (
            <div key={group.label} className="settings-sidebar-group">
              <div className="settings-sidebar-group-label">
                {group.i18nGroupKey ? tSidebar(group.i18nGroupKey) : group.label}
              </div>
              {group.links.map(link => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  onClick={event => handleClick(event, link.id)}
                  className={`settings-sidebar-link${activeId === link.id ? ' is-active' : ''}`}
                  aria-current={activeId === link.id ? 'true' : undefined}
                >
                  {/* The accessibility-profile entry renders the
                      figure-in-circle SVG instead of the wheelchair
                      pictogram so it picks up the same vocabulary as
                      every other accessibility surface in the app
                      (footer trigger, detail chip, focus modifier
                      chip). Every other link still uses its emoji
                      string. */}
                  <span className="settings-sidebar-icon" aria-hidden="true">
                    {link.id === 'accessibility-profile'
                      ? <AccessibilityFigureGlyph size={16} />
                      : link.icon}
                  </span>
                  <span className="settings-sidebar-label">
                    {link.i18nKey ? tSections(link.i18nKey) : link.label}
                  </span>
                </a>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
