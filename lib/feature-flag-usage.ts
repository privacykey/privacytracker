/**
 * Where each feature flag lives in the codebase, plus the route on
 * which its effect is visible. Powers the Developer Options panel's
 * hover-preview popover and the "Show me where" link that navigates
 * to the surface and highlights the gated element.
 *
 * Curated, not auto-generated. We deliberately don't try to cover
 * every flag in the registry — the most-asked-about ones get an
 * entry, and the rest fall through to a "no preview available" copy.
 *
 * Schema:
 *   - hint   — one-line copy describing what the flag controls.
 *              Sentence case, ends with a period for screen readers.
 *   - files  — paths the wiring lives in. Relative to repo root.
 *   - route  — optional route the user can jump to to see the flag's
 *              effect. When present, the panel renders a "Show me
 *              where" link that navigates with `?flag-highlight=<key>`.
 *   - target — optional `data-flag-target` value. The cross-page
 *              highlight handler matches this against rendered
 *              elements to put the purple ring in the right place.
 *              Defaults to the flag key itself when omitted.
 */

import type { FlagKey } from './feature-flag-rules';

export interface FlagUsage {
  hint: string;
  files: string[];
  route?: string;
  target?: string;
}

/**
 * Curated subset. Add entries here as wiring lands. The DevOps panel
 * surfaces a "no preview available yet" hint for flags that aren't
 * in this map, so missing entries are non-breaking.
 */
export const FLAG_USAGE: Partial<Record<FlagKey, FlagUsage>> = {
  // Apps grid surface ────────────────────────────────────────────────
  'flag.appgrid.card.profile_badge': {
    hint: "Privacy-profile match pill on each app card (the green/orange/red 'Matches profile' chip).",
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.card.profile_badge',
  },
  'flag.appgrid.card.risk_pill': {
    hint: 'High/Moderate/Low risk pill on the right rail of each card.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.card.risk_pill',
  },
  'flag.appgrid.card.freshness_chip': {
    hint: '"2d ago" / "Fresh" / "Stale" chip on each card.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.card.freshness_chip',
  },
  'flag.appgrid.card.resync_button': {
    hint: 'Per-card ↻ resync icon button (and its sync-count notification badge).',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.card.resync_button',
  },
  'flag.appgrid.card.delete_button': {
    hint: 'Per-card ✕ stop-tracking icon button.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.card.delete_button',
  },
  'flag.appgrid.filter.profile_mismatch': {
    hint: '"Profile mismatches" filter pill above the grid.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.filter.profile_mismatch',
  },
  'flag.appgrid.filter.search': {
    hint: 'Search box above the apps grid.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.filter.search',
  },
  'flag.appgrid.filter.risk_buttons': {
    hint: 'Risk-level filter buttons (High / Moderate / Low / Minimal / All).',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.filter.risk_buttons',
  },
  'flag.appgrid.actions.add_apps': {
    hint: '+ Add Apps button in the page header.',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.actions.add_apps',
  },
  'flag.appgrid.actions.compare_mode': {
    hint: 'Compare button in the page header (toggles multi-select).',
    files: ['app/components/AppGrid.tsx'],
    route: '/dashboard/apps',
    target: 'flag.appgrid.actions.compare_mode',
  },

  // Audit-bundle / Phase 1 ───────────────────────────────────────────
  'flag.settings.admin.export.audit_bundle': {
    hint: 'Audit-bundle export button in Settings (recommender-flow handoff).',
    files: ['app/components/SettingsView.tsx', 'lib/audit-bundle.ts'],
    route: '/dashboard/settings',
    target: 'flag.settings.admin.export.audit_bundle',
  },
  'flag.onboarding.method.import_audit_bundle': {
    hint: '"Import audit bundle" tile on the onboarding method picker.',
    files: ['app/components/OnboardWizard.tsx', 'lib/audit-bundle-import.ts'],
    route: '/onboard',
    target: 'flag.onboarding.method.import_audit_bundle',
  },

  // Phase 3 destructive surface ──────────────────────────────────────
  'flag.devopts.cfgutil_uninstall': {
    hint: 'Unlocks the Backup + Act steps in /dashboard/review-recommendations. Off by default — destructive opt-in.',
    files: [
      'app/components/ReviewRecommendationsView.tsx',
      'lib/device-actions.ts',
      'src-tauri/src/cfgutil.rs',
    ],
    route: '/dashboard/review-recommendations',
    target: 'flag.devopts.cfgutil_uninstall',
  },

  // App Detail ───────────────────────────────────────────────────────
  'flag.detail.annotations_sidebar': {
    hint: 'Notes sidebar on the right side of the App Detail page.',
    files: ['app/components/AnnotationsSidebar.tsx', 'app/components/AppDetailView.tsx'],
    route: '/dashboard/apps',
    target: 'flag.detail.annotations_sidebar',
  },

  // Detail timeline ──────────────────────────────────────────────────
  'flag.detail.charts.category_trend': {
    hint: 'Change-history chart strip above the timeline rows.',
    files: ['app/components/ChangelogTimeline.tsx', 'app/components/charts/AppChangeTimeline.tsx'],
    route: '/dashboard/apps',
    target: 'flag.detail.charts.category_trend',
  },
};

/** Convenience lookup. Returns null when the flag isn't in the registry. */
export function getFlagUsage(key: string): FlagUsage | null {
  return FLAG_USAGE[key as FlagKey] ?? null;
}
