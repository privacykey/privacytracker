'use client';

/**
 * Policy-fingerprint radar. Each axis is one of the 8 POLICY_LENSES; each
 * series is one app's lens ratings mapped to a numeric score via RATING_SCORE.
 * Higher = more concerning, so a *larger* shape = more privacy red flags.
 *
 * Which apps to plot:
 *   - Up to 6 at once (readability ceiling)
 *   - Default = the latest-synced apps with populated summaries
 *   - User can toggle any tracked app with a policy summary via chips
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import EChart from './EChart';
import type { RadarData, RadarApp } from '../../../lib/stats-views-shared';
import { RADAR_MAX } from '../../../lib/stats-views-shared';

const SERIES_COLORS = ['#ff453a', '#ff9f0a', '#0a84ff', '#30d158', '#bf5af2', '#ffd60a'];
const MAX_SERIES = 6;

interface AppOption { id: string; name: string; iconUrl: string; hasPolicy: boolean; }

export interface PrivacyRadarStatus {
  /**
   * True if at least one app in the default radar response has a policy
   * summary. Parents can use this to hide the whole panel chrome when the
   * user hasn't run any summaries yet — avoids an awkward "big heading /
   * empty body" state.
   */
  hasAnyPolicy: boolean;
  /** Total apps in the default radar response (plotted + missing). */
  totalApps: number;
}

interface PrivacyRadarProps {
  onStatusChange?: (status: PrivacyRadarStatus) => void;
}

export default function PrivacyRadar({ onStatusChange }: PrivacyRadarProps = {}) {
  const tRadar = useTranslations('privacy_radar');
  const [data, setData] = useState<RadarData | null>(null);
  const [available, setAvailable] = useState<AppOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Stash the callback in a ref so the initial-load effect doesn't have to
  // include it in its deps (parents might pass a fresh callback each render).
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  // Initial load: default radar (top apps with summaries).
  useEffect(() => {
    let live = true;
    fetch('/api/stats/radar')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: RadarData) => {
        if (!live) return;
        setData(d);
        setSelected(d.apps.map(a => a.id));
        onStatusChangeRef.current?.({
          hasAnyPolicy: d.apps.some(a => a.hasPolicy),
          totalApps: d.apps.length,
        });
      })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  // Full picker list: all apps. The radar route silently drops apps without
  // summaries, but we still list them as disabled chips so the user knows
  // which ones need "Regenerate policy".
  useEffect(() => {
    let live = true;
    fetch('/api/apps')
      .then(r => r.ok ? r.json() : null)
      .then((apps: any[] | null) => {
        if (!live || !Array.isArray(apps)) return;
        setAvailable(apps.map(a => ({
          id: String(a.id),
          name: String(a.name),
          iconUrl: String(a.iconUrl ?? ''),
          // /api/apps doesn't hydrate the policy status — we infer: if the
          // initial radar response included this ID, it has a summary.
          hasPolicy: false,
        })));
      })
      .catch(() => { /* optional */ });
    return () => { live = false; };
  }, []);

  // When selection changes, refetch with explicit IDs.
  useEffect(() => {
    if (!selected.length) return;
    let live = true;
    const qs = selected.join(',');
    fetch(`/api/stats/radar?apps=${encodeURIComponent(qs)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: RadarData) => { if (live) setData(d); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [selected]);

  const option = useMemo(() => {
    if (!data) return {};
    const appsToPlot: RadarApp[] = data.apps.filter(a => a.hasPolicy).slice(0, MAX_SERIES);
    if (!appsToPlot.length) return { __empty: true };

    return {
      tooltip: {},
      legend: {
        data: appsToPlot.map(a => a.name),
        bottom: 0,
        textStyle: { color: '#a0a0b0' },
        icon: 'circle',
      },
      radar: {
        shape: 'polygon',
        indicator: data.axes.map(axis => ({ name: axis.label, max: RADAR_MAX })),
        axisName: { color: '#a0a0b0', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
        splitArea: { areaStyle: { color: ['transparent', 'rgba(255,255,255,0.02)'] } },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      series: [{
        type: 'radar',
        data: appsToPlot.map((app, i) => ({
          name: app.name,
          // ECharts radar requires a number per axis; null becomes 0 which
          // looks like "favorable" — use RADAR_MAX/2 for missing so it
          // doesn't visually dominate either direction.
          value: app.lenses.map(l => l.score ?? RADAR_MAX / 2),
          lineStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length], width: 2 },
          itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
          areaStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] + '33' },
        })),
      }],
    };
  }, [data]);

  if (error) return <div className="empty-state" style={{ padding: 24 }}>{tRadar('load_failed', { message: error })}</div>;
  if (!data) return <div className="empty-state" style={{ padding: 24 }}><span className="spinner-sm" /> {tRadar('loading')}</div>;

  const plotted = data.apps.filter(a => a.hasPolicy);
  const missing = data.apps.filter(a => !a.hasPolicy);

  return (
    <div>
      {plotted.length === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          <div style={{ marginBottom: 6 }}>{tRadar('empty_title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {tRadar('empty_body')}
          </div>
        </div>
      ) : (
        <EChart option={option} height={440} />
      )}

      {/* App chip row — click to toggle. Capped at MAX_SERIES active. */}
      {available.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {available.map(app => {
            const active = selected.includes(app.id);
            const disabled = !active && selected.length >= MAX_SERIES;
            return (
              <button
                key={app.id}
                type="button"
                disabled={disabled}
                onClick={() => setSelected(s =>
                  s.includes(app.id) ? s.filter(x => x !== app.id) : [...s, app.id]
                )}
                className="radar-chip"
                data-active={active}
                style={{
                  border: '1px solid',
                  borderColor: active ? 'var(--blue)' : 'var(--border)',
                  background: active ? 'rgba(10,132,255,0.14)' : 'var(--surface)',
                  color: active ? 'var(--text)' : 'var(--text-2)',
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.45 : 1,
                }}
              >
                {app.name}
              </button>
            );
          })}
        </div>
      )}

      {missing.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)' }}>
          {missing.length === 1
            ? tRadar('missing_summary_one', { count: missing.length })
            : tRadar('missing_summary_other', { count: missing.length })}
        </div>
      )}
    </div>
  );
}
