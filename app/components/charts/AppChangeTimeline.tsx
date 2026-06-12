"use client";

import { useTranslations } from "next-intl";
/**
 * Per-app variant of the stats-page Change Timeline. Drives the
 * "Category trend" slot in the Change History strip on the app detail
 * page. Data source is the same `/api/stats/timeline` endpoint the
 * site-wide chart uses; we just pass `?appId=<id>` to scope to one app.
 *
 * The chart is a stacked area with four bands — added / removed /
 * modified / policy — colour-matched to the changelog row icons so users
 * get a visual link between a spike on the graph and the corresponding
 * row below the timeline. Two additional *non-stacked* overlay lines
 * ride on top of that stack: `syncs` (every scrape that landed,
 * regardless of whether it detected changes) and `reviews` (every time
 * the user reviewed/dismissed/snoozed the change badge). These are
 * contextual counters, not change types, so they deliberately aren't
 * part of the stack — adding them there would inflate the "total
 * changes" shape even in quiet weeks full of no-op syncs.
 *
 * The top-right reuses the +N / −N summary the previous widget had so
 * the diff-style totals stay glanceable; syncs and reviews only appear
 * there when their count is > 0.
 *
 * Preset buttons (30d / 90d / 6m / YTD / All) let users zoom the window
 * in-place without touching the global stats page. We deliberately drop
 * the 7d preset here because most tracked apps won't have a weekly
 * cadence of changes and an empty chart looks broken; the detail page
 * already shows the individual rows so a fine-grained preset wouldn't
 * add much.
 *
 * The whole widget is an accordion — header always rendered, body
 * (presets + chart + legend) toggled via `aria-expanded`. Users who
 * don't care about the macro view can collapse it so the individual
 * changelog rows own more of the viewport.
 */
import { useEffect, useMemo, useState } from "react";
import { withAlpha } from "../../../lib/chart-colors";
import type { TimelineData } from "../../../lib/stats-views-shared";
import { useChartColors } from "../../../lib/use-chart-colors";
import { useShapesMode } from "../../../lib/use-shapes-mode";
import EChart from "./EChart";

type PresetKey = "30d" | "90d" | "6m" | "ytd" | "all";

// Preset labels are intentionally short ("30d", "YTD", "All") — these
// already read the same in zh-CN as in en, so they stay as raw constants.
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "6m", label: "6m" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

function resolveRange(preset: PresetKey): { from: number; to: number } {
  const now = Date.now();
  switch (preset) {
    case "30d":
      return { from: now - 30 * 86_400_000, to: now };
    case "90d":
      return { from: now - 90 * 86_400_000, to: now };
    case "6m":
      return { from: now - 180 * 86_400_000, to: now };
    case "ytd": {
      const y = new Date().getUTCFullYear();
      return { from: Date.UTC(y, 0, 1), to: now };
    }
    case "all":
      return { from: 0, to: now };
  }
}

function formatBucketLabel(bucket: string, kind: string): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  if (kind === "month") {
    return d.toLocaleDateString(undefined, {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Colour palette — privacy added/removed are deliberately INVERTED from
// the standard "green=added, red=removed" diff convention because more
// privacy categories being collected isn't actually a good thing. A
// chart that paints "newly tracked Sensitive Info" green sends the
// wrong signal to the people doing the audit. So:
//
//   - PRIVACY added   → red    (a new category is being collected — bad)
//   - PRIVACY removed → green  (an existing category stopped — good)
//   - PRIVACY modified → amber (neutral / "look at this")
//
// Accessibility runs the other way (more accessibility = better) so the
// blue-family pair we already used for a11y stays put — adding an
// accessibility feature reads as positive, removing reads as the
// concerning case. Policy text diffs (in `.policy-diff-*-chip`) keep
// the textbook green/red convention because that's where the diff
// reading is "what changed in the document text" — there's no
// good/bad axis to invert.
const COLORS = {
  added: "#ef4444", // red — privacy category newly collected
  removed: "#10b981", // green — privacy category no longer collected
  modified: "#f59e0b", // amber — same as before, neutral attention tone
  policy: "#2563eb",
  // Accessibility bands sit in the same blue family the rest of the UI
  // uses for a11y (grid filter pill, change-dot, detail-page chip). Two
  // distinct shades so added vs removed read apart on the stack without
  // clashing with the policy band above them. The "added" cyan resolves
  // the --cyan token at the band() call site (theme-aware, dark value
  // #64d2ff); only the indigo lives here because no token exists for it.
  accessibilityRemoved: "#5e5ce6",
  syncs: "#94a3b8", // slate-400 — quiet grey for the ambient activity line
  reviews: "#a855f7", // purple-500 — distinct from any change-type band
} as const;

// Per-band ECharts decals applied to `areaStyle.decal` when shape mode
// (`html[data-a11y-shapes="on"]`) is on. The stacked-area chart relies
// entirely on colour to tell six bands apart, which collapses to a
// near-monochrome blob in protanopia / deuteranopia simulation. Layering
// a distinct texture on each band's fill restores the per-band signal:
//
//   - added (privacy added, red)          → -45° dense stripes
//     (matches the "track" tier in PrivacyHeatmap / SmallMultiples — the
//     two most attention-worthy "this got worse" patterns share one
//     visual)
//   - removed (privacy removed, green)    → dot grid
//     (matches the "linked" tier — neutral attention)
//   - modified (amber)                    → cross-hatch
//     (matches the "not linked" tier — least-severe attention)
//   - policy (blue)                       → horizontal stripes (0°)
//   - accessibilityAdded (cyan)           → vertical stripes (90°)
//   - accessibilityRemoved (purple-blue)  → triangle dot grid
//
// Decal `color` uses a low-alpha black so the texture appears as a
// shadow on top of the band's translucent fill colour — preserves the
// underlying colour signal for sighted users while adding a perceptual
// shape cue for everyone else.
const BAND_DECALS = {
  added: {
    symbol: "rect",
    rotation: -Math.PI / 4,
    dashArrayX: [[3, 0]],
    dashArrayY: [3, 4],
    color: "rgba(0, 0, 0, 0.40)",
  },
  removed: {
    symbol: "circle",
    symbolSize: 0.5,
    dashArrayX: [4, 4],
    dashArrayY: [4, 4],
    color: "rgba(0, 0, 0, 0.35)",
  },
  modified: {
    symbol: "rect",
    rotation: Math.PI / 4,
    dashArrayX: [[3, 3]],
    dashArrayY: [3, 3],
    color: "rgba(0, 0, 0, 0.30)",
  },
  policy: {
    symbol: "rect",
    rotation: 0,
    dashArrayX: [[3, 0]],
    dashArrayY: [2, 4],
    color: "rgba(0, 0, 0, 0.35)",
  },
  accessibilityAdded: {
    symbol: "rect",
    rotation: Math.PI / 2,
    dashArrayX: [[3, 0]],
    dashArrayY: [2, 4],
    color: "rgba(0, 0, 0, 0.35)",
  },
  accessibilityRemoved: {
    symbol: "triangle",
    symbolSize: 0.6,
    dashArrayX: [5, 5],
    dashArrayY: [5, 5],
    color: "rgba(0, 0, 0, 0.35)",
  },
} as const;

// Overlay-line symbol differentiation. Both `syncs` and `reviews` are
// already drawn as DASHED lines (and that wasn't going to change), but
// dashed-vs-dashed alone fails when colour is muted. Pinning each line
// to a distinct marker glyph means the two series still read apart at
// a glance even when their stroke colours are similar after a
// colour-blind transform. `circle` is the default ECharts symbol so
// `syncs` stays visually neutral; `diamond` is a clearly different
// silhouette for `reviews`. Applied unconditionally — these markers
// look fine in default mode too, so we don't gate them on shape mode.
const OVERLAY_SYMBOLS = {
  syncs: "circle",
  reviews: "diamond",
} as const;

export default function AppChangeTimeline({
  appId,
  showPresets = true,
  showLegend = true,
}: {
  /**
   * Tracked-app id to scope the chart to. When omitted, the chart
   * runs in "global" mode — the stats-timeline endpoint already
   * handles a missing appId by aggregating across every tracked
   * app, so the universal /changelog page reuses this exact
   * component as its hero.
   */
  appId?: string;
  /**
   * Wave I — `flag.detail.charts.trend_presets`. When false the 30d/90d/
   * 6m/YTD/All preset row is hidden; the chart renders against the user's
   * current selection (default 'all') so existing state still applies.
   */
  showPresets?: boolean;
  /**
   * Wave I — `flag.detail.charts.trend_legend`. Hides the inline ECharts
   * legend so the chart renders the data area without the colour key.
   */
  showLegend?: boolean;
}) {
  const tChart = useTranslations("app_change_timeline");
  // "All" default — the detail page is explicitly historical; users
  // arriving here almost always want to see the full span, and can
  // narrow the window via presets if they want to zoom in.
  const [preset, setPreset] = useState<PresetKey>("all");
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const shapesMode = useShapesMode();
  // Theme-resolved CSS tokens for the chart chrome + the a11y-added cyan
  // band. The change-type band palette above stays literal (deliberately
  // inverted semantics, documented at COLORS).
  const colors = useChartColors();
  // Collapsed by default would hide information the user just clicked
  // into, but the feature request was "can be hidden", not "hidden by
  // default" — so we open on mount and let them collapse if they want.
  const [expanded, setExpanded] = useState(true);

  const range = useMemo(() => resolveRange(preset), [preset]);

  useEffect(() => {
    // Skip the network round-trip entirely while the accordion is
    // collapsed. Re-opening re-runs this effect and fetches fresh data.
    if (!expanded) {
      return;
    }
    let live = true;
    setLoading(true);
    // Build the query string conditionally — leaving `appId` off when
    // the parent didn't pass one is what flips the endpoint into
    // global / aggregate mode.
    const qs = new URLSearchParams({
      from: String(range.from),
      to: String(range.to),
    });
    if (appId) {
      qs.set("appId", appId);
    }
    fetch(`/api/stats/timeline?${qs}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((d: TimelineData) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e instanceof Error ? e.message : tChart("failed_load"));
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [range.from, range.to, appId, expanded, tChart]);

  // Fold per-bucket counts into summary totals for the top-right diff
  // chip. Done on the client so the preset toggles update the summary
  // without a round-trip (the endpoint doesn't return per-series totals).
  const totals = useMemo(() => {
    const zero = {
      added: 0,
      removed: 0,
      modified: 0,
      policy: 0,
      accessibilityAdded: 0,
      accessibilityRemoved: 0,
      syncs: 0,
      reviews: 0,
    };
    if (!data) {
      return zero;
    }
    return data.points.reduce(
      (acc, p) => ({
        added: acc.added + p.added,
        removed: acc.removed + p.removed,
        modified: acc.modified + p.modified,
        policy: acc.policy + p.policy,
        accessibilityAdded:
          acc.accessibilityAdded + (p.accessibilityAdded ?? 0),
        accessibilityRemoved:
          acc.accessibilityRemoved + (p.accessibilityRemoved ?? 0),
        syncs: acc.syncs + (p.syncs ?? 0),
        reviews: acc.reviews + (p.reviews ?? 0),
      }),
      zero
    );
  }, [data]);

  const option = useMemo(() => {
    if (!data) {
      return {};
    }
    const labels = data.points.map((p) =>
      formatBucketLabel(p.bucket, data.bucketType)
    );
    // Stacked area band — the change-type series (privacy added /
    // removed / modified / policy + the two accessibility splits). The
    // `?? 0` guard handles the accessibility fields, which are optional
    // on `TimelinePoint` for back-compat with old serialised payloads.
    const band = (
      key:
        | "added"
        | "removed"
        | "modified"
        | "policy"
        | "accessibilityAdded"
        | "accessibilityRemoved",
      color: string,
      label: string
    ) => ({
      name: label,
      type: "line",
      stack: "changes",
      smooth: true,
      showSymbol: false,
      data: data.points.map((p) => p[key] ?? 0),
      itemStyle: { color },
      lineStyle: { color },
      // Slightly translucent fill lets the user read a thin band at the
      // top of the stack without it being washed out by the one beneath.
      // When shape mode is on, layer the per-band decal texture on top
      // of the translucent fill so the six stacked bands stay
      // distinguishable in monochrome / colour-blind simulation.
      // withAlpha replaces the old `${color}55` suffix (85/255) so the
      // fill keeps working when the colour is a resolved token.
      areaStyle: shapesMode
        ? { color: withAlpha(color, 85 / 255), decal: BAND_DECALS[key] }
        : { color: withAlpha(color, 85 / 255) },
    });
    // Overlay line — deliberately NOT in the `changes` stack, so the
    // contextual counter rides alongside without inflating the area.
    // Dashed stroke + small symbol markers differentiate it from the
    // smooth filled bands at a glance.
    const overlay = (
      key: "syncs" | "reviews",
      color: string,
      label: string
    ) => ({
      name: label,
      type: "line",
      smooth: false,
      showSymbol: true,
      symbolSize: 5,
      // Distinct symbol per overlay (`circle` for syncs, `diamond` for
      // reviews) so the two ambient lines read apart at a glance even
      // when their stroke colours are flattened by a colour-blind
      // transform. Applied unconditionally — the markers look fine in
      // default mode too.
      symbol: OVERLAY_SYMBOLS[key],
      data: data.points.map((p) => p[key] ?? 0),
      itemStyle: { color },
      lineStyle: { color, type: "dashed", width: 1 },
      emphasis: { focus: "series" },
    });
    // NB: ECharts' canvas renderer doesn't resolve CSS `var()` strings,
    // so chrome colours come pre-resolved from useChartColors() — same
    // text/border tokens the stats-page PrivacyTimeline uses, so the two
    // charts stay in sync across themes.
    const lastIndex = labels.length - 1;
    return {
      // ECharts treats per-series `areaStyle.decal` as part of its `aria`
      // accessibility feature — the option is silently ignored unless
      // `aria.decal.show` is true. Gate the whole `aria` block on shape
      // mode so default-mode renders stay byte-identical to before this
      // change (no behaviour shift for users who don't opt in). When
      // shape mode is on, `enabled: true` + `decal.show: true` lights
      // up the per-band `BAND_DECALS` patterns configured in `band()`.
      aria: shapesMode ? { enabled: true, decal: { show: true } } : undefined,
      tooltip: {
        trigger: "axis",
        // `confine: true` keeps the tooltip inside the chart container
        // so it can't spill above the widget header. Without this, the
        // default behaviour would float the box right on the cursor and
        // it ended up clipped at the top of the card — unreadable when
        // hovering near the upper edge of the plot area.
        confine: true,
        // Pin the tooltip to just below the cursor's x position, but
        // always at a fixed offset from the top of the chart — far
        // enough down that the values list isn't crammed against the
        // accordion header. The `size.viewSize[1]` bound keeps it
        // inside the chart if the body is short (small presets).
        position: (
          point: number[],
          _params: unknown,
          _dom: unknown,
          _rect: unknown,
          size: { viewSize: number[]; contentSize: number[] }
        ) => {
          const [x] = point;
          const offsetY = 42; // pushes below the header line; tweakable
          const maxY = Math.max(0, size.viewSize[1] - size.contentSize[1] - 6);
          return [x + 12, Math.min(offsetY, maxY)];
        },
        extraCssText: "max-width: 240px;",
      },
      legend: showLegend
        ? {
            bottom: 0,
            textStyle: { color: colors.text2, fontSize: 10 },
            icon: "circle",
            itemHeight: 8,
            itemGap: 10,
          }
        : { show: false },
      grid: { left: 36, right: 28, top: 10, bottom: 40 },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: false,
        axisLabel: {
          color: colors.text2,
          fontSize: 10,
          // Override only the last tick so the right edge always reads
          // "Today" regardless of preset window. ECharts strips each
          // label through this formatter once per render; we leave
          // every other tick alone so date context is preserved.
          formatter: (value: string, index: number) =>
            index === lastIndex ? tChart("chart_today") : value,
        },
        axisLine: { lineStyle: { color: colors.border } },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: colors.text2, fontSize: 10 },
        splitLine: { lineStyle: { color: colors.border } },
      },
      series: [
        band("added", COLORS.added, tChart("band_added")),
        band("removed", COLORS.removed, tChart("band_removed")),
        band("modified", COLORS.modified, tChart("band_modified")),
        band("policy", COLORS.policy, tChart("band_policy")),
        band("accessibilityAdded", colors.cyan, tChart("band_a11y_added")),
        band(
          "accessibilityRemoved",
          COLORS.accessibilityRemoved,
          tChart("band_a11y_removed")
        ),
        overlay("syncs", COLORS.syncs, tChart("overlay_syncs")),
        overlay("reviews", COLORS.reviews, tChart("overlay_reviews")),
      ],
    };
  }, [data, showLegend, shapesMode, tChart, colors]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      <button
        aria-controls="app-change-timeline-body"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          width: "100%",
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          color: "var(--text-1)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        type="button"
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s ease",
              color: "var(--text-3)",
              fontSize: 10,
              width: 10,
            }}
          >
            ▶
          </span>
          <span style={{ fontWeight: 600, color: "var(--text-2)" }}>
            {tChart("title")}
          </span>
        </span>
        {/*
          Diff-style totals stay in the header even when the body is
          collapsed, so the user can see the net activity at a glance
          without expanding. Added and removed always render so the
          +0 / −0 placeholder is visible on apps with no history in
          this window; modified / policy / syncs / reviews only show
          up when they have a count so the strip stays tidy for apps
          that never trigger those events.
        */}
        <span
          style={{
            color: "var(--text-3)",
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "baseline",
            fontSize: 11,
          }}
        >
          <span>
            <span style={{ color: COLORS.added, fontWeight: 600 }}>
              +{totals.added}
            </span>
            <span style={{ marginLeft: 4 }}>{tChart("summary_added")}</span>
          </span>
          <span>
            <span style={{ color: COLORS.removed, fontWeight: 600 }}>
              −{totals.removed}
            </span>
            <span style={{ marginLeft: 4 }}>{tChart("summary_removed")}</span>
          </span>
          {totals.modified > 0 && (
            <span>
              <span style={{ color: COLORS.modified, fontWeight: 600 }}>
                ~{totals.modified}
              </span>
              <span style={{ marginLeft: 4 }}>
                {tChart("summary_modified")}
              </span>
            </span>
          )}
          {totals.policy > 0 && (
            <span>
              <span style={{ color: COLORS.policy, fontWeight: 600 }}>
                {totals.policy}
              </span>
              <span style={{ marginLeft: 4 }}>{tChart("summary_policy")}</span>
            </span>
          )}
          {totals.accessibilityAdded > 0 && (
            <span>
              {/* DOM-painted (unlike the canvas band) so var() tracks the
                  --cyan token directly. */}
              <span style={{ color: "var(--cyan, #64d2ff)", fontWeight: 600 }}>
                +{totals.accessibilityAdded}
              </span>
              <span style={{ marginLeft: 4 }}>{tChart("summary_a11y")}</span>
            </span>
          )}
          {totals.accessibilityRemoved > 0 && (
            <span>
              <span
                style={{ color: COLORS.accessibilityRemoved, fontWeight: 600 }}
              >
                −{totals.accessibilityRemoved}
              </span>
              <span style={{ marginLeft: 4 }}>{tChart("summary_a11y")}</span>
            </span>
          )}
          {totals.syncs > 0 && (
            <span>
              <span style={{ color: COLORS.syncs, fontWeight: 600 }}>
                {totals.syncs}
              </span>
              <span style={{ marginLeft: 4 }}>{tChart("summary_syncs")}</span>
            </span>
          )}
          {totals.reviews > 0 && (
            <span>
              <span style={{ color: COLORS.reviews, fontWeight: 600 }}>
                {totals.reviews}
              </span>
              <span style={{ marginLeft: 4 }}>{tChart("summary_reviews")}</span>
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div id="app-change-timeline-body" style={{ padding: "0 12px 10px" }}>
          {showPresets && (
            <div
              style={{
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
                marginBottom: 8,
                alignItems: "center",
              }}
            >
              {PRESETS.map((p) => (
                <button
                  aria-pressed={preset === p.key}
                  key={p.key}
                  onClick={() => setPreset(p.key)}
                  style={{
                    position: "relative",
                    padding: "3px 10px",
                    borderRadius: 6,
                    fontSize: 11,
                    border: "1px solid",
                    borderColor:
                      preset === p.key
                        ? "var(--accent, #2563eb)"
                        : "var(--border)",
                    background:
                      preset === p.key
                        ? "var(--accent-soft, rgba(37,99,235,0.10))"
                        : "var(--surface)",
                    color: preset === p.key ? "var(--text-1)" : "var(--text-2)",
                    cursor: "pointer",
                    fontWeight: preset === p.key ? 600 : 400,
                  }}
                  type="button"
                >
                  {p.label}
                  {/* WCAG 2.2 SC 2.5.8 — the painted pill is ~22px tall.
                      Invisible overlay grows the clickable box to ≥24px
                      (vertical only — presets sit 4px apart). -3px because
                      absolute positioning resolves against the padding box,
                      1px inside the pill's border. */}
                  <span
                    aria-hidden="true"
                    style={{ position: "absolute", inset: "-3px 0" }}
                  />
                </button>
              ))}
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--text-3)",
                }}
              >
                {loading
                  ? tChart("loading")
                  : data
                    ? tChart(
                        data.bucketType === "day"
                          ? "summary_buckets_daily"
                          : data.bucketType === "week"
                            ? "summary_buckets_weekly"
                            : "summary_buckets_monthly",
                        { count: data.total }
                      )
                    : ""}
              </span>
            </div>
          )}

          {error && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-3)",
                padding: 16,
                textAlign: "center",
              }}
            >
              {tChart("error", { message: error })}
            </div>
          )}
          {!error &&
            data &&
            data.total === 0 &&
            totals.syncs === 0 &&
            totals.reviews === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-3)",
                  padding: 20,
                  textAlign: "center",
                }}
              >
                {tChart("empty_title")}
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  {tChart("empty_hint")}
                </div>
              </div>
            )}
          {!error &&
            data &&
            (data.total > 0 || totals.syncs > 0 || totals.reviews > 0) && (
              <EChart height={220} option={option} />
            )}
        </div>
      )}
    </div>
  );
}
