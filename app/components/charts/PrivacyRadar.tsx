"use client";

import { useTranslations } from "next-intl";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { withAlpha } from "../../../lib/chart-colors";
import type { RadarApp, RadarData } from "../../../lib/stats-views-shared";
import { RADAR_MAX } from "../../../lib/stats-views-shared";
import { useChartColors } from "../../../lib/use-chart-colors";
import EChart from "./EChart";

const MAX_SERIES = 6;

interface AppOption {
  hasPolicy: boolean;
  iconUrl: string;
  id: string;
  name: string;
}

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

export default function PrivacyRadar({
  onStatusChange,
}: PrivacyRadarProps = {}) {
  const tRadar = useTranslations("privacy_radar");
  const [data, setData] = useState<RadarData | null>(null);
  const [available, setAvailable] = useState<AppOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Theme-resolved CSS tokens — the per-app series colours track the
  // light / high-contrast palettes instead of pinning the dark brights.
  const colors = useChartColors();

  // Stash the callback in a ref so the initial-load effect doesn't have to
  // include it in its deps (parents might pass a fresh callback each render).
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  // Initial load: default radar (top apps with summaries).
  useEffect(() => {
    let live = true;
    fetch("/api/stats/radar")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((d: RadarData) => {
        if (!live) {
          return;
        }
        setData(d);
        setSelected(d.apps.map((a) => a.id));
        onStatusChangeRef.current?.({
          hasAnyPolicy: d.apps.some((a) => a.hasPolicy),
          totalApps: d.apps.length,
        });
      })
      .catch((e) => {
        if (live) {
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // Full picker list: all apps. The radar route silently drops apps without
  // summaries, but we still list them as disabled chips so the user knows
  // which ones need "Regenerate policy".
  useEffect(() => {
    let live = true;
    fetch("/api/apps")
      .then((r) => (r.ok ? r.json() : null))
      .then((apps: any[] | null) => {
        if (!(live && Array.isArray(apps))) {
          return;
        }
        setAvailable(
          apps.map((a) => ({
            id: String(a.id),
            name: String(a.name),
            iconUrl: String(a.iconUrl ?? ""),
            // /api/apps doesn't hydrate the policy status — we infer: if the
            // initial radar response included this ID, it has a summary.
            hasPolicy: false,
          }))
        );
      })
      .catch(() => {
        /* optional */
      });
    return () => {
      live = false;
    };
  }, []);

  // When selection changes, refetch with explicit IDs.
  useEffect(() => {
    if (!selected.length) {
      return;
    }
    let live = true;
    const qs = selected.join(",");
    fetch(`/api/stats/radar?apps=${encodeURIComponent(qs)}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((d: RadarData) => {
        if (live) {
          setData(d);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [selected]);

  const option = useMemo(() => {
    if (!data) {
      return {};
    }
    const appsToPlot: RadarApp[] = data.apps
      .filter((a) => a.hasPolicy)
      .slice(0, MAX_SERIES);
    if (!appsToPlot.length) {
      return { __empty: true };
    }

    // Per-app series palette, resolved from the CSS tokens so the lines
    // stay ≥3:1 against the light surface and pick up the HC boosts. Same
    // order as the old hardcoded list; the purple slot moves from the
    // unthemed #bf5af2 to the --purple token (#af52de in dark) so it can
    // follow the HC neon-violet override.
    const seriesColors = [
      colors.red,
      colors.orange,
      colors.blue,
      colors.green,
      colors.purple,
      colors.yellow,
    ];

    return {
      tooltip: {},
      // Legend/axis chrome reads the text/border tokens — identical to the
      // old hardcoded values in dark mode, readable greys in light mode.
      legend: {
        data: appsToPlot.map((a) => a.name),
        bottom: 0,
        textStyle: { color: colors.text2 },
        icon: "circle",
      },
      radar: {
        shape: "polygon",
        indicator: data.axes.map((axis) => ({
          name: axis.label,
          max: RADAR_MAX,
        })),
        axisName: { color: colors.text2, fontSize: 11 },
        splitLine: { lineStyle: { color: colors.border } },
        splitArea: {
          // Alternating ring tint derived from the text token — a barely-
          // there white wash in dark mode (as before), a dark wash in
          // light mode where white would be invisible.
          areaStyle: { color: ["transparent", withAlpha(colors.text, 0.02)] },
        },
        axisLine: { lineStyle: { color: colors.border } },
      },
      series: [
        {
          type: "radar",
          data: appsToPlot.map((app, i) => ({
            name: app.name,
            // ECharts radar requires a number per axis; null becomes 0 which
            // looks like "favorable" — use RADAR_MAX/2 for missing so it
            // doesn't visually dominate either direction.
            value: app.lenses.map((l) => l.score ?? RADAR_MAX / 2),
            lineStyle: {
              color: seriesColors[i % seriesColors.length],
              width: 2,
            },
            itemStyle: { color: seriesColors[i % seriesColors.length] },
            areaStyle: {
              // 0.2 matches the old `${hex}33` suffix (0x33 / 255).
              color: withAlpha(seriesColors[i % seriesColors.length], 0.2),
            },
          })),
        },
      ],
    };
  }, [data, colors]);

  if (error) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        {tRadar("load_failed", { message: error })}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        <span className="spinner-sm" /> {tRadar("loading")}
      </div>
    );
  }

  const plotted = data.apps.filter((a) => a.hasPolicy);
  const missing = data.apps.filter((a) => !a.hasPolicy);

  return (
    <div>
      {plotted.length === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          <div style={{ marginBottom: 6 }}>{tRadar("empty_title")}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>
            {tRadar("empty_body")}
          </div>
        </div>
      ) : (
        <EChart height={440} option={option} />
      )}

      {/* App chip row — click to toggle. Capped at MAX_SERIES active. */}
      {available.length > 0 && (
        <div
          style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}
        >
          {available.map((app) => {
            const active = selected.includes(app.id);
            const disabled = !active && selected.length >= MAX_SERIES;
            return (
              <button
                className="radar-chip"
                data-active={active}
                disabled={disabled}
                key={app.id}
                onClick={() =>
                  setSelected((s) =>
                    s.includes(app.id)
                      ? s.filter((x) => x !== app.id)
                      : [...s, app.id]
                  )
                }
                style={{
                  border: "1px solid",
                  borderColor: active ? "var(--blue)" : "var(--border)",
                  background: active
                    ? "rgba(10,132,255,0.14)"
                    : "var(--surface)",
                  color: active ? "var(--text)" : "var(--text-2)",
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                }}
                type="button"
              >
                {app.name}
              </button>
            );
          })}
        </div>
      )}

      {missing.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-3)" }}>
          {missing.length === 1
            ? tRadar("missing_summary_one", { count: missing.length })
            : tRadar("missing_summary_other", { count: missing.length })}
        </div>
      )}
    </div>
  );
}
