"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
/**
 * Compact per-app severity strips.
 *
 * Layout:
 *   ┌──────────────────────────────────────┬───────────────┐
 *   │  📇 📍 🆔 📈   (icon header, sticky) │  [toggle]     │
 *   ├──────────────────────────────────────┤  🟨 Not linked│
 *   │  Instagram       ⬛ ⬛ ⬛ ⬛           │  🟧 Linked    │
 *   │  Duolingo        .  .  ⬛ .           │  🟥 Tracking  │
 *   │  ...                                   │  HOVER INFO  │
 *   └──────────────────────────────────────┴───────────────┘
 *
 * Layout decisions:
 *   - The category icon header is pinned just below the site nav (sticky,
 *     top = --nav-h). Users scanning the strips always have the column
 *     headers in view, no matter how far they've scrolled.
 *   - The severity colour key + "show profile on rows" toggle + hover info
 *     all live in a sticky side panel on the right. Keeping the key in the
 *     side column means it never fights the matrix for vertical space, and
 *     it sits immediately next to the hover details that use the same
 *     colours.
 *   - The "show profile" toggle gates every profile-derived visual at once
 *     (preference bar, mismatch borders, tooltip preference row) so users
 *     can fall back to a clean "raw severity only" view in one click.
 *   - Crosshair highlighting: instead of drawing an outline on every cell
 *     in the hovered row + column (which flashed white between cells when
 *     the mouse crossed the gap), we highlight the app label on the left
 *     and the category icon above. No per-cell outline, no flash.
 *   - Mismatch border: cells whose severity exceeds the user's profile
 *     tolerance get an inset white ring via box-shadow (not `border`, which
 *     would shift the cell's size by 2px). Only applied when the "show
 *     profile" toggle is on.
 *   - Pure HTML/CSS — ECharts would be overkill for a matrix of coloured
 *     squares and would cost us a canvas per app.
 */
import { useEffect, useMemo, useState } from "react";
import { CATEGORY_META } from "../../../lib/privacy-meta";
import {
  type PrivacyProfile,
  type ProfileTier,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
} from "../../../lib/privacy-profile";
import type { MatrixData } from "../../../lib/stats-views-shared";

const SEV_COLOR: Record<string, string> = {
  DATA_NOT_LINKED_TO_YOU: "#d8c7a3",
  DATA_LINKED_TO_YOU: "#ff9f0a",
  DATA_USED_TO_TRACK_YOU: "#ff453a",
};
/** Severity → translation-key map. The actual labels come from
 *  `stats.charts.swatch_*` so they stay in sync with the heatmap legend. */
const SEV_LABEL_KEY: Record<string, string> = {
  DATA_NOT_LINKED_TO_YOU: "swatch_not_linked",
  DATA_LINKED_TO_YOU: "swatch_linked",
  DATA_USED_TO_TRACK_YOU: "swatch_track",
};
const EMPTY = "#1d1d25";

// Preference-tier colour. Reuses the severity palette so "your tolerance"
// speaks the same colour language as the cells below it — if the bar under
// Health & Fitness is cream, any cell in that column warmer than cream
// (orange/red) is a mismatch.
const PREF_COLOR: Record<ProfileTier, string> = {
  not_collected: "var(--text-3)",
  not_linked: "#d8c7a3",
  linked: "#ff9f0a",
  tracking: "#ff453a",
};

interface HoverState {
  app: string;
  catId: string;
  catLabel: string;
  sev: string | null;
}

export default function SmallMultiples() {
  const tCharts = useTranslations("stats.charts");
  const tTier = useTranslations("privacy_profile_tier_short");
  const [data, setData] = useState<MatrixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [profile, setProfile] = useState<PrivacyProfile | null>(null);
  // "Show Privacy Profile on rows" toggle — gates the preference bar under
  // each icon, the mismatch ring on cells, and the preference line in the
  // hover panel. Default on so users with a profile immediately see the
  // overlay; they can toggle it off for a clean severity-only view.
  const [showPref, setShowPref] = useState(true);
  // "Hide apps with no categories" filter — matches the equivalent toggle
  // on the heatmap view so the two compare-pages behave the same. Default
  // on because apps Apple hasn't mapped labels for are pure visual noise.
  const [hideEmpty, setHideEmpty] = useState(true);

  useEffect(() => {
    let live = true;
    fetch("/api/stats/matrix")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((d) => {
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
  }, []);

  // Profile is optional — component remains fully usable without one. We
  // swallow errors so a 404 or offline state just hides the preference row.
  useEffect(() => {
    let live = true;
    fetch("/api/privacy-profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live) {
          setProfile(d?.profile ?? null);
        }
      })
      .catch(() => {
        /* no profile — fine */
      });
    return () => {
      live = false;
    };
  }, []);

  const profileActive =
    !!profile && Object.values(profile).some((v) => typeof v === "string");
  // Any profile-dependent visual is gated on BOTH the profile being active
  // AND the toggle being on. Centralising the flag here keeps the
  // conditionals in JSX short and prevents drift.
  const prefOverlay = profileActive && showPref;

  // Sort apps by category count descending so the busiest apps sit at the
  // top — matches what users care about first on a "compare" page. Apply
  // the hide-empty filter here so downstream rendering / hover / the total
  // count in the sticky header all agree on the same app list.
  const sorted = useMemo(() => {
    if (!data) {
      return null;
    }
    const filtered = hideEmpty
      ? data.apps.filter((a) => a.categoryCount > 0)
      : data.apps;
    return [...filtered].sort(
      (a, b) =>
        b.categoryCount - a.categoryCount || a.name.localeCompare(b.name)
    );
  }, [data, hideEmpty]);

  if (error) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        {tCharts("matrix_load_failed", { error })}
      </div>
    );
  }
  if (!(data && sorted)) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        <span className="spinner-sm" /> {tCharts("loading")}
      </div>
    );
  }
  // Distinguish "no apps at all" from "everything filtered out" so users
  // can still see/toggle the filter controls instead of a hard empty wall.
  if (data.apps.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 24 }}>
        {tCharts("no_apps_tracked")}
      </div>
    );
  }

  const hiddenCount = data.apps.length - sorted.length;
  const cols = data.categories.length;
  // Use a CSS grid: first column for the app name, then one column per category.
  const gridTemplate = `minmax(140px, 1fr) repeat(${cols}, minmax(14px, 28px))`;

  return (
    <div className="sm-wrap">
      {/* ── Matrix column (left) ─────────────────────────────────────────
          onMouseLeave lives on the whole matrix column, not individual
          cells, so moving the mouse between adjacent cells doesn't blink
          the row/column highlight off and on again. */}
      <div className="sm-matrix-col" onMouseLeave={() => setHover(null)}>
        {/* Sticky category icon header. Pinned below the site nav so
            column headers stay visible while scanning the rows below. */}
        <div className="sm-sticky-stack">
          <div
            className="sm-header"
            style={{
              display: "grid",
              gridTemplateColumns: gridTemplate,
              gap: 2,
              alignItems: "center",
              paddingBottom: 4,
            }}
          >
            {/* First grid cell: matrix-size caption so it aligns with the
                app-name column below. */}
            <div
              className="sm-legend-count"
              title={
                hiddenCount > 0
                  ? tCharts("matrix_hidden_by_filter", { count: hiddenCount })
                  : undefined
              }
            >
              {tCharts("matrix_size", {
                shown: sorted.length,
                total: data.apps.length,
                cols,
              })}
            </div>
            {data.categories.map((cat) => {
              const meta = CATEGORY_META[cat.identifier];
              const isHoverCol = hover?.catId === cat.identifier;
              const pref = profile?.[cat.identifier];
              // Tooltip gets an extra line about the user's preference when
              // one is set — keeps the in-cell hover explanatory without
              // needing a separate on-hover popover for the header.
              const prefTitle = prefOverlay
                ? pref
                  ? `\n${tCharts("matrix_pref_line", { label: tTier(pref) })}`
                  : `\n${tCharts("matrix_no_pref_line")}`
                : "";
              return (
                <div
                  className={`sm-category-cell ${isHoverCol ? "sm-category-cell--hover" : ""}`}
                  key={cat.identifier}
                  onMouseEnter={() =>
                    setHover({
                      app: "",
                      catId: cat.identifier,
                      catLabel: cat.label,
                      sev: null,
                    })
                  }
                  title={`${cat.label}${meta?.description ? ` — ${meta.description}` : ""}\n${tCharts("matrix_collect_count", { count: cat.appCount })}${prefTitle}`}
                >
                  <div className="sm-category-icon">{meta?.icon ?? "•"}</div>
                  {/* Preference bar directly below the icon. Renders only
                      when the overlay toggle is on; when the category has
                      no explicit preference we still reserve the slot with
                      a faint empty marker so the grid height doesn't
                      shift column by column. */}
                  {prefOverlay &&
                    (pref ? (
                      <div
                        aria-label={tCharts("matrix_pref_line", {
                          label: tTier(pref),
                        })}
                        className="sm-category-pref"
                        // `data-tier` is what the shape-mode CSS hooks
                        // onto when `html[data-a11y-shapes="on"]` is set;
                        // the per-tier gradient overlays the flat colour
                        // so colour-blind users get a texture cue on
                        // each preference bar.
                        data-tier={pref}
                        style={{ backgroundColor: PREF_COLOR[pref] }}
                      />
                    ) : (
                      <div
                        aria-label={tCharts("no_pref_aria")}
                        className="sm-category-pref sm-category-pref--none"
                      />
                    ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Body rows — or an inline empty-state when filters hid everything.
            We keep the sticky header and sidebar rendered above so the user
            can always reach the toggle to reverse their filter. */}
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
            <div>{tCharts("no_apps_match")}</div>
            <div style={{ fontSize: 13, marginTop: 4, color: "var(--text-3)" }}>
              {tCharts("matrix_empty_hint", {
                label: tCharts("filter_hide_no_categories"),
              })}
            </div>
          </div>
        ) : (
          <div className="sm-body" style={{ display: "grid", gap: 3 }}>
            {sorted.map((app) => {
              const row = data.cells[app.id] ?? {};
              const isHoverRow = hover?.app === app.name;
              return (
                <div
                  key={app.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: gridTemplate,
                    gap: 2,
                    alignItems: "center",
                    padding: "3px 0",
                  }}
                >
                  {/* App label is a link to /apps/[id] so the strip doubles as
                    a nav jump — users were hovering the name expecting a
                    click target. Highlighted when any cell in this row is
                    under the cursor (crosshair-left). */}
                  <Link
                    className={`sm-app-link ${isHoverRow ? "sm-app-link--hover" : ""}`}
                    href={`/apps/${app.id}`}
                    onMouseEnter={() =>
                      setHover({
                        app: app.name,
                        catId: "",
                        catLabel: "",
                        sev: null,
                      })
                    }
                    title={tCharts("matrix_open_app_title", {
                      name: app.name,
                    })}
                  >
                    <span className="sm-app-link-name">{app.name}</span>
                    <span className="sm-app-link-count">
                      {app.categoryCount}
                    </span>
                  </Link>
                  {data.categories.map((cat) => {
                    const sev = row[cat.identifier];
                    const bg = sev ? SEV_COLOR[sev] : EMPTY;
                    const meta = CATEGORY_META[cat.identifier];
                    // Mismatch border — cell severity exceeds the user's
                    // stated preference for this category. Uses inset
                    // box-shadow instead of `border` so enabling the overlay
                    // doesn't change the cell's layout size.
                    const pref = profile?.[cat.identifier];
                    const observedTier = sev
                      ? TYPE_IDENTIFIER_TO_TIER[
                          sev as keyof typeof TYPE_IDENTIFIER_TO_TIER
                        ]
                      : undefined;
                    const isMismatch = !!(
                      prefOverlay &&
                      pref &&
                      observedTier &&
                      TIER_RANK[observedTier] > TIER_RANK[pref]
                    );
                    return (
                      <div
                        aria-label={`${app.name}, ${cat.label}${meta?.description ? `, ${meta.description}` : ""}${isMismatch ? `, ${tCharts("matrix_exceeds_pref")}` : ""}`}
                        className="sm-cell"
                        // `data-sev` exposes the severity tier to the
                        // shape-mode CSS so colour-blind users get a
                        // per-tier gradient overlay (diagonal stripes /
                        // dots / cross-hatch) on top of the existing
                        // red / orange / cream fill. Omitted on empty
                        // cells so the no-data styling stays untouched.
                        data-sev={sev || undefined}
                        key={cat.identifier}
                        onMouseEnter={() =>
                          setHover({
                            app: app.name,
                            catId: cat.identifier,
                            catLabel: cat.label,
                            sev: sev ?? null,
                          })
                        }
                        style={{
                          aspectRatio: "1",
                          borderRadius: 3,
                          // `backgroundColor` (not the `background`
                          // shorthand) so the shape-mode CSS rule can
                          // layer `background-image: <gradient>` on top
                          // without the inline declaration nuking it.
                          backgroundColor: bg,
                          border: sev
                            ? "none"
                            : "1px solid rgba(255,255,255,0.03)",
                          boxShadow: isMismatch
                            ? "inset 0 0 0 2px #fff"
                            : "none",
                          cursor: "default",
                        }}
                        title={
                          sev
                            ? `${app.name} — ${cat.label}: ${tCharts(SEV_LABEL_KEY[sev])}`
                            : `${app.name} — ${cat.label}: ${tCharts("tooltip_not_collected")}`
                        }
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Side panel (right): toggles, colour key, and hover info ────── */}
      <aside aria-live="polite" className="sm-sidebar">
        {/* Filter/overlay toggles group. Profile-overlay only rendered when
            the user actually has a profile set — without one, the toggle
            would do nothing. hide-empty always available because it does
            not depend on any user-set state. */}
        <div className="sm-sidebar-toggles">
          {profileActive && (
            <label
              className={`sm-pref-toggle ${showPref ? "is-on" : ""}`}
              title={tCharts("filter_show_profile_title")}
            >
              <input
                checked={showPref}
                onChange={(e) => setShowPref(e.target.checked)}
                type="checkbox"
              />
              <span>{tCharts("filter_show_profile_rows")}</span>
            </label>
          )}
          <label
            className={`sm-pref-toggle ${hideEmpty ? "is-on" : ""}`}
            title={tCharts("filter_hide_no_categories_title")}
          >
            <input
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
              type="checkbox"
            />
            <span>{tCharts("filter_hide_no_categories")}</span>
          </label>
          {hiddenCount > 0 && (
            <div className="sm-sidebar-hidden-count">
              {tCharts("sidebar_hidden_count", { count: hiddenCount })}
            </div>
          )}
        </div>

        {/* Colour key — moved from the matrix column to here so it sits
            next to the hover detail that uses the same colours. */}
        <div aria-label={tCharts("severity_legend_aria")} className="sm-legend">
          <span className="sm-legend-item">
            <span
              className="sm-legend-swatch"
              data-sev="DATA_NOT_LINKED_TO_YOU"
              style={{ backgroundColor: SEV_COLOR.DATA_NOT_LINKED_TO_YOU }}
            />
            {tTier("not_linked")}
          </span>
          <span className="sm-legend-item">
            <span
              className="sm-legend-swatch"
              data-sev="DATA_LINKED_TO_YOU"
              style={{ backgroundColor: SEV_COLOR.DATA_LINKED_TO_YOU }}
            />
            {tTier("linked")}
          </span>
          <span className="sm-legend-item">
            <span
              className="sm-legend-swatch"
              data-sev="DATA_USED_TO_TRACK_YOU"
              style={{ backgroundColor: SEV_COLOR.DATA_USED_TO_TRACK_YOU }}
            />
            {tTier("tracking")}
          </span>
          {prefOverlay && (
            <span className="sm-legend-item sm-legend-item--mismatch">
              <span className="sm-legend-swatch sm-legend-swatch--mismatch" />
              {tCharts("legend_exceeds_profile")}
            </span>
          )}
        </div>

        <div className="sm-tooltip-panel">
          {hover ? (
            (() => {
              // Compute preference + mismatch once per render. Kept inline in the
              // IIFE so the JSX below stays flat and doesn't fight with hooks
              // rules (can't useMemo here — we're inside a conditional).
              const pref = profile?.[hover.catId];
              const observedTier = hover.sev
                ? TYPE_IDENTIFIER_TO_TIER[
                    hover.sev as keyof typeof TYPE_IDENTIFIER_TO_TIER
                  ]
                : undefined;
              const isMismatch = !!(
                prefOverlay &&
                pref &&
                observedTier &&
                TIER_RANK[observedTier] > TIER_RANK[pref]
              );
              return (
                <>
                  {hover.app ? (
                    <div className="sm-tooltip-app">{hover.app}</div>
                  ) : (
                    <div className="sm-tooltip-app sm-tooltip-app--muted">
                      {tCharts("tooltip_category")}
                    </div>
                  )}
                  {hover.catLabel && (
                    <div className="sm-tooltip-category">{hover.catLabel}</div>
                  )}
                  {hover.sev ? (
                    <div className="sm-tooltip-sev">
                      <span
                        className="sm-tooltip-dot"
                        style={{ background: SEV_COLOR[hover.sev] }}
                      />
                      <span style={{ color: SEV_COLOR[hover.sev] }}>
                        {SEV_LABEL_KEY[hover.sev]
                          ? tCharts(SEV_LABEL_KEY[hover.sev])
                          : hover.sev}
                      </span>
                    </div>
                  ) : hover.app && hover.catLabel ? (
                    <div className="sm-tooltip-sev sm-tooltip-sev--empty">
                      {tCharts("tooltip_not_collected")}
                    </div>
                  ) : null}
                  {/* Preference + mismatch row. Gated on the overlay toggle so
                    turning off the overlay gives a true severity-only view. */}
                  {prefOverlay && hover.catId && (
                    <div className="sm-tooltip-pref">
                      <span className="sm-tooltip-pref-label">
                        {tCharts("tooltip_your_preference")}
                      </span>
                      <span className="sm-tooltip-pref-value">
                        {pref ? (
                          <>
                            <span
                              className="sm-tooltip-dot"
                              style={{ background: PREF_COLOR[pref] }}
                            />
                            {tCharts("tooltip_pref_at_most", {
                              label: tTier(pref),
                            })}
                          </>
                        ) : (
                          <span className="sm-tooltip-pref-none">
                            {tCharts("tooltip_no_preference")}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {isMismatch && (
                    <div className="sm-tooltip-mismatch">
                      ⚠ {tCharts("tooltip_exceeds_pref")}
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            <div className="sm-tooltip-empty">
              <div className="sm-tooltip-empty-title">
                {tCharts("tooltip_hover_inspect")}
              </div>
              <div className="sm-tooltip-empty-hint">
                {tCharts("tooltip_hover_hint")}
                {prefOverlay && ` ${tCharts("tooltip_hover_hint_pref")}`}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
