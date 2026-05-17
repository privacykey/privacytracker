"use client";

/**
 * Client view for /changelog. Owns:
 *
 *   - filter state (type, category, app, from/to)
 *   - paginated fetch from /api/changelog
 *   - hero chart (AppChangeTimeline in global mode)
 *   - the per-row feed
 *
 * The server page above hands in the apps list once at mount; we don't
 * refetch it because it's small and the filter dropdown doesn't need
 * live updates. Filter state is local React state — we don't persist
 * to the URL in v1 to keep the implementation tight, but `useState`
 * is encapsulated on `filters` so a future commit can swap to
 * `useSearchParams` without touching the rest of the component.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEntry } from "../../lib/changelog-types";
import { formatDate } from "../../lib/date-format";
import { useDateFormat } from "../../lib/date-format-hook";
import AppChangeTimeline from "./charts/AppChangeTimeline";

interface AppForFilter {
  id: string;
  name: string;
}

/**
 * Mirrors the `UniversalChangeRow` shape returned by /api/changelog.
 * Kept inline rather than importing from `lib/changelog.ts` so the
 * client bundle doesn't drag in the server-only DB code path.
 */
interface UniversalChangeRow {
  appDeveloper: string | null;
  appIconUrl: string | null;
  appId: string;
  appName: string;
  entry: ChangeEntry;
  id: string;
  scrapedAt: number;
  source: "live" | "wayback";
  /**
   * Mirrors the server's `SyncTrigger` union — includes `'sample'` for
   * demo-seed rows so the JSON we deserialize fits the type cleanly.
   * The UI doesn't render a pill for the value yet, but the union has
   * to admit `'sample'` to match what the API can return.
   */
  triggeredBy: "scheduled" | "manual" | "import" | "wayback" | "sample" | null;
}

interface ApiResponse {
  rows: UniversalChangeRow[];
  total: number;
}

/**
 * Filter chip set. The "all_changes" preset clears the type/category
 * filter; the rest are mutually exclusive presets that map onto
 * specific (type, category) tuples. Single-select keeps the UX
 * obvious — multi-select on the same dimension would need union
 * semantics that aren't worth the complexity for v1.
 */
type Preset =
  | "all"
  | "privacy_added"
  | "privacy_removed"
  | "privacy_modified"
  | "accessibility"
  | "policy"
  | "wayback";

interface FilterState {
  appId: string; // '' = all apps
  from: string; // ISO yyyy-mm-dd or ''
  preset: Preset;
  to: string;
}

const INITIAL_FILTERS: FilterState = {
  preset: "all",
  appId: "",
  from: "",
  to: "",
};

const PAGE_SIZE = 50;

/**
 * Map a Preset → the (type, category) query-string params for the API.
 * Empty arrays mean "no constraint on this dimension".
 */
function presetToFilter(preset: Preset): {
  types: string[];
  categories: string[];
} {
  switch (preset) {
    case "all":
      return { types: [], categories: [] };
    case "privacy_added":
      return { types: ["added"], categories: ["privacy-label"] };
    case "privacy_removed":
      return { types: ["removed"], categories: ["privacy-label"] };
    case "privacy_modified":
      return { types: ["modified"], categories: ["privacy-label"] };
    case "accessibility":
      return { types: [], categories: ["accessibility"] };
    case "policy":
      return { types: [], categories: ["privacy-policy"] };
    case "wayback":
      return { types: [], categories: ["wayback-attempt"] };
  }
}

/**
 * Convert a yyyy-mm-dd input value to epoch ms (UTC midnight). Empty
 * string → undefined so we don't send a 0 lower bound.
 */
function isoDateToMs(iso: string, atEndOfDay = false): number | undefined {
  if (!iso) {
    return;
  }
  const d = new Date(iso + (atEndOfDay ? "T23:59:59Z" : "T00:00:00Z"));
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

// Local thin wrapper that forwards to the shared formatter so callers
// don't have to know about the `withTime` opt — every changelog row
// shows the time-of-day suffix.
function formatRowDate(
  ms: number,
  mode: Parameters<typeof formatDate>[1]
): string {
  return formatDate(ms, mode, { withTime: true });
}

/**
 * Render a settings-formatted preview for a `<input type="date">`'s
 * current value.
 *
 * Native browser date pickers always render the visual format from
 * the browser's locale (you cannot CSS-override it, you cannot
 * attribute-override it). The input's `value` is also locked to ISO
 * `YYYY-MM-DD` regardless of what the user sees in the picker UI.
 *
 * To honour the user's "Date format" setting we keep the native
 * input AND show a small companion preview underneath that re-renders
 * the same calendar date through the shared `formatDate(...)` helper.
 *
 * Two subtleties:
 *   1. We parse the ISO string with explicit Y/M/D extraction rather
 *      than `new Date(iso)`. The latter interprets `'YYYY-MM-DD'` as
 *      UTC midnight, which shifts a day in negative timezones (e.g.
 *      a user in PST sees yesterday for a date they just picked).
 *      Building via `new Date(y, mo - 1, d)` anchors to local
 *      midnight — the same date the picker shows.
 *   2. Returns `null` for empty / malformed values so the caller can
 *      render nothing rather than a placeholder dash.
 */
function formatIsoDatePreview(
  iso: string,
  mode: Parameters<typeof formatDate>[1]
): string | null {
  if (!iso) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d))) {
    return null;
  }
  const ms = new Date(y, mo - 1, d).getTime();
  return formatDate(ms, mode);
}

/**
 * Pick the row icon glyph + class. Mirrors the convention used by the
 * per-app ChangelogTimeline (`.timeline-change-icon.added` etc.) so
 * colours pick up the inverted privacy palette for free — added is
 * red, removed is green, etc., per the recolour we shipped alongside
 * this page.
 */
function iconForEntry(entry: ChangeEntry): { glyph: string; cls: string } {
  if (entry.category === "privacy-policy") {
    return {
      glyph: entry.policy_event === "error" ? "⚠" : "📄",
      cls: `timeline-change-icon policy${entry.policy_event === "error" ? " policy-error" : ""}`,
    };
  }
  if (entry.category === "wayback-attempt") {
    const failed =
      entry.wayback_event === "no_capture" ||
      entry.wayback_event === "save_now_failed";
    return {
      glyph: "🕰",
      cls: `timeline-change-icon wayback${failed ? " wayback-failed" : ""}`,
    };
  }
  if (entry.category === "accessibility") {
    return {
      glyph:
        entry.type === "removed" ? "−" : entry.type === "added" ? "+" : "↻",
      cls: `timeline-change-icon ${entry.type} accessibility`,
    };
  }
  // Default: privacy label.
  switch (entry.type) {
    case "added":
      return { glyph: "+", cls: "timeline-change-icon added" };
    case "removed":
      return { glyph: "−", cls: "timeline-change-icon removed" };
    case "modified":
      return { glyph: "↻", cls: "timeline-change-icon modified" };
    case "policy":
      return { glyph: "📄", cls: "timeline-change-icon policy" };
    case "wayback":
      return { glyph: "🕰", cls: "timeline-change-icon wayback" };
  }
}

export default function UniversalChangelogView({
  apps,
}: {
  apps: AppForFilter[];
}) {
  const t = useTranslations("changelog_page");
  const tFilters = useTranslations("changelog_page.filters");
  const tRow = useTranslations("changelog_page.row");
  // Picks up the user's date-format preference from /api/date-format
  // and re-renders dates whenever the preference is broadcast (Settings
  // → Appearance → Date format).
  const dateMode = useDateFormat();

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [rows, setRows] = useState<UniversalChangeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build the query string from filters + offset. Memoised so the
  // useEffect dependency is stable when nothing's changed.
  const buildQuery = useCallback(
    (off: number) => {
      const { types, categories } = presetToFilter(filters.preset);
      const params = new URLSearchParams();
      if (types.length > 0) {
        params.set("type", types.join(","));
      }
      if (categories.length > 0) {
        params.set("category", categories.join(","));
      }
      if (filters.appId) {
        params.set("appId", filters.appId);
      }
      const fromMs = isoDateToMs(filters.from);
      if (fromMs !== undefined) {
        params.set("from", String(fromMs));
      }
      const toMs = isoDateToMs(filters.to, true);
      if (toMs !== undefined) {
        params.set("to", String(toMs));
      }
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(off));
      return params.toString();
    },
    [filters]
  );

  // Whenever the filter changes, reset to page 0 and refetch. Uses an
  // AbortController so a quick filter flip doesn't stack two fetches
  // and clobber state out of order.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/changelog?${buildQuery(0)}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) {
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return body as ApiResponse;
      })
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
        setOffset(data.rows.length);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") {
          return;
        }
        setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [buildQuery]);

  const loadMore = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/changelog?${buildQuery(offset)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) {
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return body as ApiResponse;
      })
      .then((data) => {
        setRows((prev) => [...prev, ...data.rows]);
        setTotal(data.total);
        setOffset((prev) => prev + data.rows.length);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [buildQuery, offset]);

  const presetButtons: Array<{ id: Preset; label: string }> = useMemo(
    () => [
      { id: "all", label: tFilters("all_changes") },
      { id: "privacy_added", label: tFilters("privacy_added") },
      { id: "privacy_removed", label: tFilters("privacy_removed") },
      { id: "privacy_modified", label: tFilters("privacy_modified") },
      { id: "accessibility", label: tFilters("accessibility") },
      { id: "policy", label: tFilters("policy_updates") },
      { id: "wayback", label: tFilters("wayback") },
    ],
    [tFilters]
  );

  return (
    <>
      {/* Hero chart — global mode (no appId), so the existing
          /api/stats/timeline aggregator returns site-wide buckets. */}
      <section aria-label={t("hero_chart_title")} className="changelog-hero">
        <div className="changelog-hero-head">
          <h2 className="changelog-hero-title">{t("hero_chart_title")}</h2>
          <p className="changelog-hero-sub">{t("hero_chart_sub")}</p>
        </div>
        <AppChangeTimeline showLegend showPresets />
      </section>

      {/* Filters */}
      <section
        aria-label={tFilters("section_aria")}
        className="changelog-filters"
      >
        <div className="changelog-filter-row">
          <div className="changelog-filter-presets" role="tablist">
            {presetButtons.map((b) => {
              const active = filters.preset === b.id;
              return (
                <button
                  aria-selected={active}
                  className={`changelog-filter-preset${active ? " is-active" : ""}`}
                  key={b.id}
                  onClick={() =>
                    setFilters((prev) => ({ ...prev, preset: b.id }))
                  }
                  role="tab"
                  type="button"
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="changelog-filter-row">
          <label className="changelog-filter-field">
            <span>{tFilters("app_label")}</span>
            <select
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, appId: e.target.value }))
              }
              value={filters.appId}
            >
              <option value="">{tFilters("app_all")}</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="changelog-filter-field">
            <span>{tFilters("from_label")}</span>
            <input
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, from: e.target.value }))
              }
              type="date"
              value={filters.from}
            />
            {/* Settings-aware preview. Native <input type="date"> always
                renders the picker UI in the browser's locale and exposes
                the value as ISO `YYYY-MM-DD` — neither overridable from
                CSS or markup. We keep the native picker (best UX) AND
                show a parallel preview rendered through the user's
                chosen date format, so a user who set the preference to
                DMY sees `31/12/2025` underneath, ISO sees `2025-12-31`,
                etc. Empty input → no preview (the helper returns null). */}
            {filters.from && (
              <span aria-live="polite" className="changelog-filter-preview">
                {formatIsoDatePreview(filters.from, dateMode)}
              </span>
            )}
          </label>

          <label className="changelog-filter-field">
            <span>{tFilters("to_label")}</span>
            <input
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, to: e.target.value }))
              }
              type="date"
              value={filters.to}
            />
            {filters.to && (
              <span aria-live="polite" className="changelog-filter-preview">
                {formatIsoDatePreview(filters.to, dateMode)}
              </span>
            )}
          </label>

          <button
            className="btn btn-ghost changelog-filter-reset"
            onClick={() => setFilters(INITIAL_FILTERS)}
            type="button"
          >
            {tFilters("reset")}
          </button>
        </div>
      </section>

      {/* Feed */}
      <section className="changelog-feed">
        {loading && rows.length === 0 && (
          <p className="changelog-status">{t("loading")}</p>
        )}
        {!loading && error && (
          <p className="changelog-status changelog-status-err" role="alert">
            {t("error")}
          </p>
        )}
        {!(loading || error) && rows.length === 0 && (
          <p className="changelog-status">{t("empty")}</p>
        )}
        {rows.length > 0 && (
          <ul className="changelog-rows">
            {rows.map((r) => (
              <UniversalChangelogRow
                dateMode={dateMode}
                detailsMore={(count) => tRow("details_more", { count })}
                key={r.id}
                openAppAria={(name) => tRow("open_app_aria", { name })}
                row={r}
                viewAppLabel={tRow("view_app_link")}
                waybackLinkLabel={tRow("wayback_link")}
              />
            ))}
          </ul>
        )}
        {(rows.length > 0 || total > 0) && (
          <footer className="changelog-feed-foot">
            <span className="changelog-feed-count">
              {t("footer_count", { shown: rows.length, total })}
            </span>
            {rows.length < total && (
              <button
                className="btn btn-secondary"
                disabled={loading}
                onClick={loadMore}
                type="button"
              >
                {t("load_more")}
              </button>
            )}
          </footer>
        )}
      </section>
    </>
  );
}

/**
 * One row in the universal feed. Pulled out so the parent's render
 * stays scannable. Strings are threaded as props because re-hooking
 * `useTranslations` per row would re-instantiate the t-fn on every
 * render — keeping the helper pure is cheaper.
 */
function UniversalChangelogRow({
  row,
  dateMode,
  viewAppLabel,
  openAppAria,
  waybackLinkLabel,
  detailsMore,
}: {
  row: UniversalChangeRow;
  dateMode: Parameters<typeof formatDate>[1];
  viewAppLabel: string;
  openAppAria: (name: string) => string;
  waybackLinkLabel: string;
  detailsMore: (count: number) => string;
}) {
  const icon = iconForEntry(row.entry);
  // Show at most three detail-list items inline so a single row never
  // dominates the feed. The "+ N more" line picks up the leftover.
  const details = row.entry.details ?? [];
  const visibleDetails = details.slice(0, 3);
  const overflow = details.length - visibleDetails.length;
  const waybackUrl =
    row.source === "wayback" && row.entry.wayback_event === "requested_snapshot"
      ? row.entry.save_now_url
      : null;

  return (
    <li className="changelog-row">
      <span aria-hidden="true" className={icon.cls}>
        {icon.glyph}
      </span>
      <div className="changelog-row-body">
        <div className="changelog-row-head">
          <Link
            aria-label={openAppAria(row.appName)}
            className="changelog-row-app"
            href={`/apps/${row.appId}`}
          >
            {row.appIconUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                alt=""
                className="changelog-row-app-icon"
                height={20}
                src={row.appIconUrl}
                width={20}
              />
            ) : (
              <span
                aria-hidden="true"
                className="changelog-row-app-icon changelog-row-app-icon-placeholder"
              />
            )}
            <span className="changelog-row-app-name">{row.appName}</span>
          </Link>
          <span className="changelog-row-time">
            {formatRowDate(row.scrapedAt, dateMode)}
          </span>
          {row.source === "wayback" && (
            <span className="changelog-row-tag changelog-row-tag-wayback">
              Wayback
            </span>
          )}
        </div>
        <p className="changelog-row-desc">{row.entry.description}</p>
        {visibleDetails.length > 0 && (
          <ul className="changelog-row-details">
            {visibleDetails.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {overflow > 0 && (
              <li className="changelog-row-details-more">
                {detailsMore(overflow)}
              </li>
            )}
          </ul>
        )}
        <div className="changelog-row-links">
          <Link className="changelog-row-link" href={`/apps/${row.appId}`}>
            {viewAppLabel}
          </Link>
          {waybackUrl && (
            <a
              className="changelog-row-link"
              href={waybackUrl}
              rel="noopener"
              target="_blank"
            >
              {waybackLinkLabel}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
