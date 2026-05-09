'use client';

/**
 * Stacked-area timeline of privacy changes. Bands = change type
 * (added / removed / modified / policy). Time window is driven by preset
 * buttons (7d / 30d / 90d / YTD / All) or a Custom range picker that falls
 * back to <input type="date"> so we don't pull in a date-picker dependency.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import EChart from './EChart';
import type { TimelineData } from '../../../lib/stats-views-shared';

type PresetKey = '7d' | '30d' | '90d' | 'ytd' | 'all' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: '7d',  label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Custom…' },
];

function resolveRange(preset: PresetKey, custom: { from: string; to: string }): { from: number; to: number } | null {
  const now = Date.now();
  switch (preset) {
    case '7d':   return { from: now - 7  * 86_400_000, to: now };
    case '30d':  return { from: now - 30 * 86_400_000, to: now };
    case '90d':  return { from: now - 90 * 86_400_000, to: now };
    case 'ytd': {
      const y = new Date().getUTCFullYear();
      return { from: Date.UTC(y, 0, 1), to: now };
    }
    case 'all':  return { from: 0, to: now };
    case 'custom': {
      if (!custom.from || !custom.to) return null;
      const from = Date.parse(custom.from + 'T00:00:00Z');
      const to = Date.parse(custom.to + 'T23:59:59Z');
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
      return { from, to };
    }
  }
}

function formatBucketLabel(bucket: string, kind: string): string {
  // bucket is 'YYYY-MM-DD' UTC
  const d = new Date(bucket + 'T00:00:00Z');
  if (kind === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  if (kind === 'week') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function PrivacyTimeline() {
  const tCharts = useTranslations('stats.charts');
  const [preset, setPreset] = useState<PresetKey>('90d');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => resolveRange(preset, custom), [preset, custom]);

  useEffect(() => {
    if (!range) return;
    let live = true;
    setLoading(true);
    const qs = new URLSearchParams({ from: String(range.from), to: String(range.to) });
    fetch(`/api/stats/timeline?${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: TimelineData) => { if (live) { setData(d); setError(null); } })
      .catch(e => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- range is handled separately via destructure
  }, [range?.from, range?.to]);

  const option = useMemo(() => {
    if (!data) return {};
    const labels = data.points.map(p => formatBucketLabel(p.bucket, data.bucketType));
    // A single band helper that tolerates the optional accessibility
    // counters (they're `?: number | undefined` on TimelinePoint, so we
    // need the `?? 0` coercion to keep ECharts happy).
    const band = (
      key: 'added' | 'removed' | 'modified' | 'policy' | 'accessibilityAdded' | 'accessibilityRemoved',
      color: string,
      label: string,
    ) => ({
      name: label,
      type: 'line',
      stack: 'changes',
      smooth: true,
      showSymbol: false,
      data: data.points.map(p => p[key] ?? 0),
      itemStyle: { color }, lineStyle: { color },
      areaStyle: { color: color + '55' },
    });
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: '#a0a0b0' }, icon: 'circle' },
      grid: { left: 40, right: 16, top: 16, bottom: 60 },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLabel: { color: '#a0a0b0', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      yAxis: {
        type: 'value',
        name: 'changes',
        nameTextStyle: { color: '#8e8e93' },
        axisLabel: { color: '#a0a0b0' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      },
      // Legend labels spell out "privacy" vs "accessibility" so the two
      // green bands (added privacy categories vs added accessibility
      // labels) aren't visually confusable. Privacy bands keep their
      // original green/red/amber/blue palette; accessibility bands
      // borrow the same blue family used everywhere else in the UI
      // (filter row, change dot, risk pill) but shifted in lightness so
      // "added a11y" and "removed a11y" can be distinguished on the
      // stacked area without colliding with the blue privacy-policy band.
      series: [
        band('added',                 '#30d158', tCharts('timeline_band_added')),
        band('removed',               '#ff453a', tCharts('timeline_band_removed')),
        band('modified',              '#ff9f0a', tCharts('timeline_band_modified')),
        band('policy',                '#0a84ff', tCharts('timeline_band_policy')),
        band('accessibilityAdded',    '#64d2ff', tCharts('timeline_band_a11y_added')),
        band('accessibilityRemoved',  '#5e5ce6', tCharts('timeline_band_a11y_removed')),
      ],
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [data]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            style={{
              padding: '4px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid',
              borderColor: preset === p.key ? 'var(--blue)' : 'var(--border)',
              background: preset === p.key ? 'rgba(10,132,255,0.14)' : 'var(--surface)',
              color: preset === p.key ? 'var(--text)' : 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}

        {preset === 'custom' && (
          <div style={{ display:'flex', gap:6, alignItems:'center', marginLeft:8 }}>
            <input
              type="date"
              value={custom.from}
              onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
              style={dateInputStyle}
              aria-label={tCharts('timeline_from_aria')}
            />
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>→</span>
            <input
              type="date"
              value={custom.to}
              onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
              style={dateInputStyle}
              aria-label={tCharts('timeline_to_aria')}
            />
          </div>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {loading ? tCharts('loading') : data ? tCharts('timeline_summary', { count: data.total, bucket: data.bucketType }) : ''}
        </span>
      </div>

      {error && <div className="empty-state" style={{ padding: 24 }}>Couldn&apos;t load timeline: {error}</div>}
      {!error && data && data.total === 0 && (
        <div className="empty-state" style={{ padding: 32 }}>
          <div>{tCharts('timeline_empty_title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{tCharts('timeline_empty_body')}</div>
        </div>
      )}
      {!error && data && data.total > 0 && <EChart option={option} height={320} />}
    </div>
  );
}

const dateInputStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
};
