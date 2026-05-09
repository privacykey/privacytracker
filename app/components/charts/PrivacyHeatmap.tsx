'use client';

/**
 * Apps × categories heatmap, cell colour = severity.
 *   track  → red, linked → orange, unlinked → yellow, empty → transparent.
 *
 * Shares the `MatrixData` payload with PrivacySankey and SmallMultiples —
 * they all hit /api/stats/matrix and stay consistent that way.
 *
 * Once a library accumulates more than ~20 apps the x-axis becomes a blur of
 * rotated labels, so this component adds three navigability features on top
 * of the raw chart:
 *   1. A "hide apps with no data" toggle (on by default). Apps Apple hasn't
 *      mapped privacy labels for just render as blank columns — they're the
 *      biggest source of visual noise.
 *   2. An "only off-profile apps" toggle (gated on the user having an active
 *      privacy profile). Reuses the same `computeProfileMismatch` helper the
 *      dashboard badge relies on, so what gets filtered here matches what the
 *      rest of the app considers a mismatch.
 *   3. Page-by-page pagination (20 apps per page) with prev/next + page label.
 *      Pagination, rather than a scrollbar, keeps labels readable and makes
 *      "how many apps are there" obvious at a glance.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import EChart from './EChart';
import type { MatrixData, SeverityId } from '../../../lib/stats-views-shared';
import {
  type PrivacyProfile,
  type AppProfileFootprint,
  type ProfileTier,
  TYPE_IDENTIFIER_TO_TIER,
  TIER_RANK,
  computeProfileMismatch,
} from '../../../lib/privacy-profile';

const SEV_COLOR: Record<string, string> = {
  DATA_USED_TO_TRACK_YOU: '#ff453a',
  DATA_LINKED_TO_YOU: '#ff9f0a',
  DATA_NOT_LINKED_TO_YOU: '#ffd60a',
};
const SEV_VALUE: Record<string, number> = {
  DATA_USED_TO_TRACK_YOU: 3,
  DATA_LINKED_TO_YOU: 2,
  DATA_NOT_LINKED_TO_YOU: 1,
};

// Fixed page size. Chosen so the x-axis labels at 40° rotation stay readable
// on a ~900px-wide panel without overlap, and so the user can sweep through a
// ~100-app library in a handful of clicks.
const PAGE_SIZE = 20;

// Data shape for a single cell. Using an object with explicit `itemStyle`
// instead of a tuple so we can colour each cell directly and sidestep
// ECharts' visualMap dimension auto-detection, which silently picks the
// last array dimension (our severity string) on Safari/Firefox and ends
// up mapping nothing. Explicit colours render identically in every browser.
//
// The value tuple's 5th element is a string-encoded mismatch flag ('mm' or
// '') so the tooltip formatter can tell apart "just a cell" from "this
// cell exceeds the user's profile" without having to re-derive the check.
// itemStyle is optional on the borders because we only override when the
// cell is a mismatch; non-mismatches inherit the series defaults.
interface HeatmapCell {
  value: [number, number, number, string, string];
  itemStyle: { color: string; borderColor?: string; borderWidth?: number };
}

/**
 * Collapse a single app's row of cells into the {@link AppProfileFootprint}
 * shape `computeProfileMismatch` expects. The matrix already uses the
 * canonical CATEGORY_META keys ("LOCATION" etc) and the DATA_* severity
 * identifiers, so no translation beyond TYPE_IDENTIFIER_TO_TIER is needed.
 */
function buildFootprintFromCells(
  appId: string,
  cells: MatrixData['cells'],
): AppProfileFootprint {
  const worst: Partial<Record<string, Exclude<ProfileTier, 'not_collected'>>> = {};
  const row = cells[appId] ?? {};
  for (const [categoryKey, severityId] of Object.entries(row)) {
    const tier = TYPE_IDENTIFIER_TO_TIER[severityId as SeverityId];
    if (!tier || tier === 'not_collected') continue;
    const existing = worst[categoryKey];
    if (!existing || TIER_RANK[tier] > TIER_RANK[existing]) {
      worst[categoryKey] = tier as Exclude<ProfileTier, 'not_collected'>;
    }
  }
  return { worstByCategory: worst };
}

export default function PrivacyHeatmap() {
  const tCharts = useTranslations('stats.charts');
  const [data, setData]       = useState<MatrixData | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [profile, setProfile] = useState<PrivacyProfile | null>(null);

  // Filter state — persisted only within the component; resetting the page
  // when they change is handled by the effect below.
  const [hideEmpty, setHideEmpty]             = useState(true);
  const [onlyOffProfile, setOnlyOffProfile]   = useState(false);
  const [page, setPage]                       = useState(0);
  // "Show Privacy Profile on rows" — when on, cells whose severity exceeds
  // the user's profile tolerance for that category get a white inset ring
  // (drawn via ECharts itemStyle.borderColor). Mirrors the identical
  // toggle on the SmallMultiples view so the two compare-pages behave the
  // same. Default on so users with a profile immediately see the overlay.
  const [showPref, setShowPref]               = useState(true);

  useEffect(() => {
    let live = true;
    fetch('/api/stats/matrix')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    // Profile is optional — a 404 or error just means "no profile set", which
    // we already handle gracefully by disabling the off-profile toggle.
    let live = true;
    fetch('/api/privacy-profile')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (live) setProfile(d?.profile ?? null); })
      .catch(() => { /* swallow — filter just stays disabled */ });
    return () => { live = false; };
  }, []);

  const profileActive = !!profile && Object.values(profile).some(v => typeof v === 'string');

  const filteredApps = useMemo(() => {
    if (!data) return [];
    return data.apps.filter(app => {
      if (hideEmpty && app.categoryCount === 0) return false;
      if (onlyOffProfile && profileActive) {
        const footprint = buildFootprintFromCells(app.id, data.cells);
        const mismatch = computeProfileMismatch(profile, footprint);
        if (mismatch.count === 0) return false;
      }
      return true;
    });
  }, [data, hideEmpty, onlyOffProfile, profile, profileActive]);

  // Reset to page 0 whenever filters change so the user never ends up staring
  // at a blank page because the filter shrank the dataset below their offset.
  useEffect(() => { setPage(0); }, [hideEmpty, onlyOffProfile]);

  const totalPages    = Math.max(1, Math.ceil(filteredApps.length / PAGE_SIZE));
  const effectivePage = Math.min(page, totalPages - 1);
  const pageStart     = effectivePage * PAGE_SIZE;
  const pageApps      = filteredApps.slice(pageStart, pageStart + PAGE_SIZE);

  const option = useMemo(() => {
    if (!data) return {};
    const appNames  = pageApps.map(a => a.name);
    const catLabels = data.categories.map(c => c.label);

    // Build sparse heatmap data, colouring each cell directly. When the
    // profile overlay is on, mark cells that exceed the user's preference
    // with a white inset border — same visual language as the "exceeds
    // profile" ring on the SmallMultiples view.
    const overlay = showPref && profileActive;
    const cells: HeatmapCell[] = [];
    pageApps.forEach((app, x) => {
      data.categories.forEach((cat, y) => {
        const sev = data.cells[app.id]?.[cat.identifier];
        if (!sev) return;
        const pref = profile?.[cat.identifier];
        const observedTier = TYPE_IDENTIFIER_TO_TIER[sev as keyof typeof TYPE_IDENTIFIER_TO_TIER];
        const mismatch = !!(overlay && pref && observedTier && TIER_RANK[observedTier] > TIER_RANK[pref]);
        cells.push({
          value: [x, y, SEV_VALUE[sev] ?? 0, sev, mismatch ? 'mm' : ''],
          itemStyle: mismatch
            ? { color: SEV_COLOR[sev] ?? '#555', borderColor: '#ffffff', borderWidth: 2 }
            : { color: SEV_COLOR[sev] ?? '#555' },
        });
      });
    });

    return {
      tooltip: {
        formatter: (p: any) => {
          const [x, y, , sev, mm] = p.value;
          const appName  = appNames[x];
          const catName  = catLabels[y];
          const sevLabel = data.severities.find(s => s.identifier === sev)?.label ?? sev;
          const mismatchLine = mm === 'mm'
            ? `<br/><span style="color:#ff8a80">⚠ Exceeds your Privacy Profile</span>`
            : '';
          return `<b>${appName}</b><br/>${catName}<br/><span style="color:${SEV_COLOR[sev]}">● ${sevLabel}</span>${mismatchLine}`;
        },
      },
      // outerBoundsMode: 'none' restores echarts v5's behaviour of letting
      // the developer's left/right/top/bottom values be the source of
      // truth for the grid frame. echarts v6 changed the default to
      // 'auto', which silently re-shrinks the grid to keep rotated x-axis
      // labels (40°, see axisLabel.rotate below) inside the canvas — that
      // shifts the heatmap a few pixels and squashes the legend's bottom
      // gutter. Pinning to 'none' keeps the visual layout identical to
      // what we had on echarts 5.6 with no other changes.
      grid: { left: 140, right: 20, top: 10, bottom: 80, outerBoundsMode: 'none' },
      xAxis: {
        type: 'category',
        data: appNames,
        axisLabel: { color: '#a0a0b0', rotate: 40, fontSize: 11 },
        axisLine:  { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
        axisTick:  { show: false },
        splitArea: { show: false },
      },
      yAxis: {
        type: 'category',
        data: catLabels,
        axisLabel: { color: '#a0a0b0', fontSize: 11 },
        axisLine:  { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
        axisTick:  { show: false },
        splitArea: { show: false },
      },
      // No visualMap — cells carry their own itemStyle.color, which renders
      // reliably across Chrome/Safari/Firefox. visualMap's default dimension
      // picking was colouring-by-severity-string on non-Chromium engines and
      // silently falling back to the theme's default colour.
      series: [{
        type: 'heatmap',
        data: cells,
        itemStyle: {
          borderRadius: 3,
          borderColor: '#08080f',
          borderWidth: 1,
        },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(255,255,255,0.3)' } },
      }],
    };
  }, [data, pageApps, showPref, profileActive, profile]);

  if (error) return <div className="empty-state" style={{ padding: 24 }}>Couldn&apos;t load matrix: {error}</div>;
  if (!data) return <div className="empty-state" style={{ padding: 24 }}><span className="spinner-sm" /> {tCharts('loading')}</div>;
  if (data.apps.length === 0) return <div className="empty-state" style={{ padding: 24 }}>{tCharts('no_apps_tracked')}</div>;

  // Height grows with category count so cells stay square-ish. Only category
  // count matters — per-page app count is clamped to PAGE_SIZE — so the chart
  // height is stable across pages.
  const height = Math.max(320, 28 + data.categories.length * 26);

  const hiddenCount = data.apps.length - filteredApps.length;

  return (
    <div>
      <div className="heatmap-toolbar">
        <div className="heatmap-toolbar-filters">
          <label className="heatmap-filter-toggle">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={e => setHideEmpty(e.target.checked)}
            />
            <span>{tCharts('filter_hide_no_data')}</span>
          </label>
          <label
            className={`heatmap-filter-toggle ${profileActive ? '' : 'is-disabled'}`}
            title={profileActive ? undefined : tCharts('filter_off_profile_disabled')}
          >
            <input
              type="checkbox"
              checked={onlyOffProfile && profileActive}
              disabled={!profileActive}
              onChange={e => setOnlyOffProfile(e.target.checked)}
            />
            <span>{tCharts('filter_off_profile_only')}</span>
          </label>
          {/* "Show Privacy Profile on rows" — when on, cells that exceed
              the user's profile tolerance get a white inset ring. Same
              label + behaviour as the SmallMultiples view for consistency. */}
          <label
            className={`heatmap-filter-toggle ${profileActive ? '' : 'is-disabled'}`}
            title={profileActive ? tCharts('filter_show_profile_title') : tCharts('filter_show_profile_disabled')}
          >
            <input
              type="checkbox"
              checked={showPref && profileActive}
              disabled={!profileActive}
              onChange={e => setShowPref(e.target.checked)}
            />
            <span>{tCharts('filter_show_profile_rows')}</span>
          </label>
        </div>
        <div className="heatmap-toolbar-status">
          Showing <strong>{filteredApps.length}</strong> of {data.apps.length} apps
          {hiddenCount > 0 && <span className="heatmap-toolbar-muted"> · {hiddenCount} hidden by filters</span>}
        </div>
      </div>

      {filteredApps.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
          <div>{tCharts('no_apps_match')}</div>
          <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text-3)' }}>
            Toggle a filter off above to bring apps back.
          </div>
        </div>
      ) : (
        <>
          <EChart option={option} height={height} />

          {totalPages > 1 && (
            <div className="heatmap-pager">
              <button
                className="btn btn-secondary btn-sm"
                disabled={effectivePage === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                aria-label={tCharts('prev_page_aria')}
              >
                ‹ Prev
              </button>
              <div className="heatmap-pager-label">
                Apps <strong>{pageStart + 1}</strong>–<strong>{pageStart + pageApps.length}</strong>
                <span className="heatmap-toolbar-muted"> · page {effectivePage + 1} of {totalPages}</span>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                disabled={effectivePage >= totalPages - 1}
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                aria-label={tCharts('next_page_aria')}
              >
                Next ›
              </button>
            </div>
          )}
        </>
      )}

      <div className="legend" style={{ display:'flex', gap:16, marginTop:10, fontSize:12, color:'var(--text-3)', flexWrap:'wrap' }}>
        <span><span style={swatch('#ff453a')} />{tCharts('swatch_track')}</span>
        <span><span style={swatch('#ff9f0a')} />{tCharts('swatch_linked')}</span>
        <span><span style={swatch('#ffd60a')} />{tCharts('swatch_not_linked')}</span>
        {/* Mismatch swatch mirrors the inset white border drawn on the
            actual cells so users can tie the legend back to what they see. */}
        {showPref && profileActive && (
          <span><span style={swatchMismatch('#ff453a')} />{tCharts('swatch_exceeds_profile')}</span>
        )}
      </div>
    </div>
  );
}

const swatch = (c: string): React.CSSProperties => ({
  display:'inline-block', width:10, height:10, borderRadius:2, background:c, marginRight:6, verticalAlign:'middle',
});

// Same geometry as `swatch` but with a white inset ring to mirror the cell
// decoration applied when a cell exceeds the user's Privacy Profile.
const swatchMismatch = (c: string): React.CSSProperties => ({
  display:'inline-block', width:10, height:10, borderRadius:2, background:c,
  boxShadow: 'inset 0 0 0 2px #fff',
  marginRight:6, verticalAlign:'middle',
});
