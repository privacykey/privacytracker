'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  ChangeEntry,
  ChangelogRow,
  ReviewChangelogRow,
  SnapshotChangelogRow,
} from '../../lib/changelog-types';
import { formatDate as formatDateWithMode, type DateFormatMode } from '../../lib/date-format';
import { useDateFormat } from '../../lib/date-format-hook';
import AppChangeTimeline from './charts/AppChangeTimeline';

// Local aliases so the existing rendering code that references SnapshotRow
// keeps working without renaming every call-site. The client is now fed a
// merged snapshot+review stream by `getChangelog` — branching on row.kind
// happens in the top-level `rows.map` below.
type SnapshotRow = SnapshotChangelogRow;
type ReviewRow = ReviewChangelogRow;

/**
 * Shape returned by GET /api/policy/version/[id]. Populated lazily when the
 * user clicks a privacy-policy changelog point that carries a
 * `policy_version_id`, so we can render the captured source text inline.
 */
interface PolicyVersionResponse {
  id: string;
  app_id: string;
  first_fetched_at: number;
  last_fetched_at: number;
  policy_url: string | null;
  source_final_url: string | null;
  source_title: string | null;
  source_origin: string | null;
  source_word_count: number;
  source_text: string;
  /** Internet Archive snapshot URL, populated best-effort after a rescrape. */
  archive_url?: string | null;
  archive_submitted_at?: number | null;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; data: PolicyVersionResponse }
  | { status: 'error'; message: string };

/**
 * Wire format for GET /api/policy/version/[id]/diff. Mirrors
 * PolicyDiffLine / PolicyDiffWord in lib/policy-diff.ts — intentionally
 * duplicated here because this is a client component and we don't want to
 * drag server-only imports into the browser bundle.
 */
interface PolicyDiffWord {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

interface PolicyDiffLine {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
  words?: PolicyDiffWord[];
}

interface PolicyDiffResponse {
  previous: { id: string; first_fetched_at: number; source_word_count: number };
  current: { id: string; first_fetched_at: number; source_word_count: number };
  stats: { added: number; removed: number; unchanged: number; truncated: boolean };
  lines: PolicyDiffLine[];
}

type DiffState =
  | { status: 'loading' }
  | { status: 'loaded'; data: PolicyDiffResponse }
  | { status: 'error'; message: string };

/**
 * Cap the preview text so the DOM doesn't have to render a 300 KB policy.
 * Matches the cap in PolicyPreviewBlock on AppDetailView.
 */
const PREVIEW_MAX_CHARS = 6_000;

/** Rendered-diff-line ceiling so an unusually long policy can't freeze the DOM. */
const DIFF_MAX_LINES = 4_000;

/**
 * Date helpers route through `lib/date-format.ts` so every changelog
 * surface respects Settings → Appearance → Date format. The previous
 * versions of these were locally-defined `Intl.DateTimeFormat('en-AU', ...)`
 * calls — they hard-coded a single locale, ignored the user's pref, and
 * were the last holdout when the rest of the app was migrated to the
 * shared formatter (see AGENTS.md "Recent Work Summary").
 *
 * The thin wrappers below preserve the call sites' ergonomics
 * (`formatDate(ts, mode)` for "date + time", `formatShortDate(ts, mode)`
 * for "date only") while delegating to `formatDate` from
 * `lib/date-format.ts`. Each call site already calls
 * `useDateFormat()` to get `mode` from the live preference.
 */
function formatDate(ts: number, mode: DateFormatMode) {
  return formatDateWithMode(ts, mode, { withTime: true });
}

/** Date-only variant used for the per-snapshot release-date chip. */
function formatShortDate(ts: number, mode: DateFormatMode) {
  return formatDateWithMode(ts, mode);
}

function dotClass(row: SnapshotRow, index: number) {
  // Wayback imports get their own timeline dot colour regardless of whether
  // the snapshot happened to change anything — the provenance is the most
  // important signal we can convey visually on the sparse set of imported
  // rows. The CSS class `wayback` is layered on top of the usual states so
  // the ring/shape rules from `first-sync` / `has-changes` still apply.
  if (row.source === 'wayback') {
    if (row.changes_detected) return 'wayback has-changes';
    return 'wayback no-changes';
  }
  if (index === 0 && row.changes_detected === 0 && row.changes_summary.length === 0) return 'first-sync';
  if (row.changes_detected) return 'has-changes';
  return 'no-changes';
}

type WaybackT = (key: string) => string;

/**
 * Format a Wayback snapshot URL for a compact inline label. Extracts the
 * 14-digit YYYYMMDDhhmmss timestamp and renders it as an ISO-ish date so
 * users can eyeball which capture the row came from without opening it.
 * Falls back to the localised `wayback_capture_fallback` string when the
 * URL is missing or doesn't match the standard Wayback format.
 */
function formatWaybackTimestampLabel(t: WaybackT, url: string | null | undefined): string {
  if (!url) return t('wayback_capture_fallback');
  const m = url.match(/\/web\/(\d{14})/);
  if (!m) return t('wayback_capture_fallback');
  const ts = m[1];
  return `Wayback · ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

/**
 * Client-side mirror of `formatQuarterLabel` from lib/historical-import.ts
 * — turns an epoch-ms target into "Q1 2026". The lib function doesn't ship
 * client-side (it's pulled into the server-only changelog write path), so
 * the bell duplicates the trivial maths here. The "Q" prefix and trailing
 * year are deliberately left in Latin — both forms ("Q1 2026") read fine
 * across Crowdin's en + zh bundles, and the more localised "2026 年第 1
 * 季度" would diverge from how every other Wayback affordance in the app
 * renders the quarter (badge label, settings card, audit-bundle exports).
 */
function formatQuarterLabelClient(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

/**
 * Render a small pill describing what triggered the rescrape that produced
 * this snapshot. Legacy rows (triggered_by === null) still render a generic
 * "Live sync" pill so the timeline reads consistently. Wayback rows now
 * render their own "Wayback sync" variant so the sync subcategory is
 * labelled explicitly — the per-row date badge still carries the specific
 * archive timestamp, but the pill makes the subcategory (import/wayback/
 * scheduled/manual) scannable at a glance across mixed-history timelines.
 */
function TriggerPill({
  trigger,
  isWayback,
  appVersion,
}: {
  trigger: 'scheduled' | 'manual' | 'import' | 'wayback' | 'sample' | null;
  isWayback: boolean;
  /**
   * App Store version Apple reported at the time of this snapshot.
   * Currently only surfaced inline for the wayback pill, where it
   * answers "what version did the archive capture?" — the stand-alone
   * version-chip rendered next to the pill is suppressed for wayback
   * rows so the version isn't shown twice. Live syncs keep the
   * existing chip; the pill there is just the subcategory label.
   */
  appVersion?: string | null;
}) {
  // i18n — labels + tooltip titles read from `trigger_pill.*`. Visual
  // styling (icon glyph + colour palette) stays inline because it's
  // language-agnostic. The wayback `title` is interpolated with the
  // captured-at app version when present.
  const t = useTranslations('trigger_pill');
  type Style = { bg: string; fg: string; border: string; icon: string };
  const STYLES: Record<'scheduled' | 'manual' | 'import' | 'wayback' | 'sample' | 'legacy', Style> = {
    scheduled: { bg: 'rgba(37, 99, 235, 0.10)', fg: '#1d4ed8', border: '#1d4ed8', icon: '⏱' },
    manual:    { bg: 'rgba(245, 158, 11, 0.14)', fg: '#b45309', border: '#b45309', icon: '👆' },
    import:    { bg: 'rgba(100, 116, 139, 0.14)', fg: '#475569', border: '#475569', icon: '⬇' },
    // Purple palette mirrors the wayback-badge + wayback timeline dot
    // so all three read as the same family.
    wayback:   { bg: 'rgba(124, 58, 237, 0.10)', fg: '#7c3aed', border: '#7c3aed', icon: '🕰' },
    // SAMPLE — dev-only seed data. Same purple register as the
    // /onboard preview banner and the dev-tooling family (DevMenu,
    // feature-flag highlights) so it reads as "this came from a
    // developer surface, not a real sync". Distinct icon from
    // wayback's clock so the two purple pills don't read as
    // duplicates on a mixed timeline.
    sample:    { bg: 'rgba(168, 85, 247, 0.14)', fg: '#a855f7', border: '#a855f7', icon: '🧪' },
    legacy:    { bg: 'rgba(100, 116, 139, 0.10)', fg: '#64748b', border: '#94a3b8', icon: '◼' },
  };

  // Wayback rows wear the 'wayback' pill regardless of what
  // triggered_by says — the `isWayback` prop is derived from the
  // row's source column, which is the source of truth. SAMPLE rows
  // override even that: a wayback-shaped sample (synthetic archive
  // history from the seed) still reads as SAMPLE first because
  // distinguishing dev data from real archive data trumps the
  // archive-vs-live distinction. Older rows missing the trigger
  // column still fall back to 'legacy' so the timeline reads
  // consistently.
  const key = trigger === 'sample'
    ? 'sample'
    : isWayback
      ? 'wayback'
      : trigger === 'scheduled' || trigger === 'manual' || trigger === 'import'
        ? trigger
        : 'legacy';
  const style = STYLES[key];
  const label = t(`${key}_label`);
  const baseTitle = t(`${key}_title`);
  const title = key === 'wayback' && appVersion
    ? t('wayback_with_version', { title: baseTitle, version: appVersion })
    : baseTitle;

  return (
    <span
      className={`trigger-pill trigger-pill-${key}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        background: style.bg,
        color: style.fg,
        border: `1px solid ${style.border}`,
      }}
      title={title}
    >
      <span aria-hidden="true">{style.icon}</span>
      {label}
      {/*
        Wayback pills append the captured app version inline so users
        can see at a glance which release the archive snapshot
        corresponds to — answers "did the labels change because the
        app updated, or because Apple's UI moved around it?". Other
        pills don't bother because the standalone version-chip next
        to them already does the job.
      */}
      {key === 'wayback' && appVersion && (
        <span style={{ opacity: 0.85 }}>· v{appVersion}</span>
      )}
    </span>
  );
}

type CardTitleT = (key: string, values?: Record<string, string | number>) => string;

/**
 * Choose a more specific card title for all-policy rows so "first-ever
 * download", "rescraped — unchanged" and "rescrape failed" read clearly
 * on the timeline. Translator-typed first arg keeps the helper locale-
 * aware while staying out of React's hook ordering — it's called from
 * inside a memoised render path that already has `tCt` in scope.
 */
function policyCardTitle(t: CardTitleT, changes: ChangeEntry[]): string {
  const events = new Set(changes.map(c => c.policy_event ?? 'changed'));
  const count = changes.length;
  const useSuffix = count > 1;
  if (events.size === 1) {
    const only = events.values().next().value;
    const args = { count };
    if (only === 'first') return useSuffix ? t('policy_card_first_suffix', args) : t('policy_card_first');
    if (only === 'same') return useSuffix ? t('policy_card_same_suffix', args) : t('policy_card_same');
    if (only === 'changed') return useSuffix ? t('policy_card_changed_suffix', args) : t('policy_card_changed');
    if (only === 'error') return useSuffix ? t('policy_card_error_suffix', args) : t('policy_card_error');
  }
  return useSuffix ? t('policy_card_mixed_suffix', { count }) : t('policy_card_mixed');
}

/**
 * Card title for rows whose every entry is a wayback-attempt. Three
 * user-visible variants when the row is single-kind ("requested",
 * "failed to request", "no capture found"); falls back to the neutral
 * "archive activity" label when the row mixes kinds.
 */
function waybackAttemptCardTitle(t: CardTitleT, changes: ChangeEntry[]): string {
  const events = new Set(changes.map(c => c.wayback_event ?? 'no_capture'));
  const count = changes.length;
  const useSuffix = count > 1;
  if (events.size === 1) {
    const only = events.values().next().value;
    const args = { count };
    if (only === 'requested_snapshot') return useSuffix ? t('wayback_card_requested_suffix', args) : t('wayback_card_requested');
    if (only === 'save_now_failed') return useSuffix ? t('wayback_card_save_now_failed_suffix', args) : t('wayback_card_save_now_failed');
    if (only === 'no_capture') return useSuffix ? t('wayback_card_no_capture_suffix', args) : t('wayback_card_no_capture');
  }
  return useSuffix ? t('wayback_card_mixed_suffix', { count }) : t('wayback_card_mixed');
}

export interface ChangelogTimelineFlagState {
  liveRows: boolean;
  waybackRows: boolean;
  waybackToggle: boolean;
  triggerPills: boolean;
  versionChip: boolean;
  matchesLiveSyncBadge: boolean;
  reviewRows: boolean;
  reviewSnapshotChips: boolean;
  policyPreviewToggle: boolean;
  policyDiffToggle: boolean;
  // Wave I — per-chart gates inside HistoryStatsStrip.
  chartsCategoryTrend: boolean;
  chartsTrendPresets: boolean;
  chartsTrendLegend: boolean;
}

export default function ChangelogTimeline({
  rows,
  defaultShowImported = true,
  appId,
  flags,
}: {
  rows: ChangelogRow[];
  /**
   * Initial state of the "show Wayback imports" toggle, derived from the
   * `wayback_show_imported` setting. Users can still flip it locally here
   * without changing their global preference.
   */
  defaultShowImported?: boolean;
  /**
   * When provided, enables the "History stats" strip under the timeline
   * that calls `/api/apps/[id]/history-stats` to show category trend +
   * changes-per-quarter aggregates built partly from imported rows.
   */
  appId?: string;
  /**
   * Wave I — per-surface flag state. Each `flag.detail.timeline.*` flag
   * threads through here; missing flags fall back to true so legacy
   * callers stay rendering as before.
   */
  flags?: Partial<ChangelogTimelineFlagState>;
}) {
  // i18n — wayback badge / "Matches live sync" / preview/diff toggles /
  // wayback-toggle checkbox label all read from `timeline.*`. Per-row
  // ChangeEntry descriptions are dynamically composed strings stored
  // in the DB and remain English in v1.
  const tTimeline = useTranslations('timeline');
  const tCt = useTranslations('changelog_timeline');

  const tf: ChangelogTimelineFlagState = {
    liveRows: flags?.liveRows ?? true,
    waybackRows: flags?.waybackRows ?? true,
    waybackToggle: flags?.waybackToggle ?? true,
    triggerPills: flags?.triggerPills ?? true,
    versionChip: flags?.versionChip ?? true,
    matchesLiveSyncBadge: flags?.matchesLiveSyncBadge ?? true,
    reviewRows: flags?.reviewRows ?? true,
    reviewSnapshotChips: flags?.reviewSnapshotChips ?? true,
    policyPreviewToggle: flags?.policyPreviewToggle ?? true,
    policyDiffToggle: flags?.policyDiffToggle ?? true,
    chartsCategoryTrend: flags?.chartsCategoryTrend ?? true,
    chartsTrendPresets: flags?.chartsTrendPresets ?? true,
    chartsTrendLegend: flags?.chartsTrendLegend ?? true,
  };
  const chartsCategoryTrendOn = tf.chartsCategoryTrend;
  const chartsTrendPresetsOn = tf.chartsTrendPresets;
  const chartsTrendLegendOn = tf.chartsTrendLegend;
  // Keyed by the policy_version_id; we only fetch each version once per
  // session even if the same id appears on multiple entries (it can, if the
  // policy was rescraped with identical text and reused the deduped row).
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  // Which `rowId:changeIndex` composite currently has its *preview* open.
  // We use a composite key because each timeline row can carry multiple
  // change entries, and in theory more than one could be a privacy-policy
  // event. Preview and diff track independently so users can inspect both
  // side-by-side for the same row.
  const [expandedPreview, setExpandedPreview] = useState<string | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  // Which snapshot row is currently flashing, and a monotonic "nonce" so
  // clicking the same link twice re-triggers the animation (each click
  // bumps the nonce, so the effect inside TimelineSnapshotItem restarts
  // even when the id hasn't changed). Kept at the top-level component so
  // review rows anywhere in the merged feed can pulse any snapshot.
  const [pulsed, setPulsed] = useState<{ id: string; nonce: number } | null>(null);
  const pulseSnapshot = (snapshotId: string) => {
    // Nonce jumps each call so repeated clicks on the same row restart the
    // animation instead of being swallowed by React's identity check.
    setPulsed(prev => ({
      id: snapshotId,
      nonce: (prev && prev.id === snapshotId ? prev.nonce : 0) + 1,
    }));
    // Scroll is done inside TimelineSnapshotItem's effect so it happens
    // after the element has the pulse class applied.
  };
  // Local override for the wayback-imports toggle. Initialises from the
  // server-provided `defaultShowImported`; any flip on this page is
  // intentionally session-local so the global preference isn't silently
  // rewritten from an ad-hoc inspection.
  const [showImported, setShowImported] = useState(defaultShowImported);
  // Re-sync local state if the settings prop changes (e.g. user saves a new
  // default in another tab and navigates back to the detail page).
  useEffect(() => {
    setShowImported(defaultShowImported);
  }, [defaultShowImported]);

  const waybackCount = useMemo(
    () => rows.filter(r => r.kind === 'snapshot' && r.source === 'wayback').length,
    [rows],
  );
  const visibleRows = useMemo(
    () => {
      // Wave I — apply per-row flags before everything else. Each row is
      // dropped only when its kind/source's flag explicitly resolves off:
      //   liveRows         — synthetic "live" rows from scheduled/manual syncs
      //   waybackRows      — rows whose source = 'wayback' (archive imports)
      //   reviewRows       — review-action rows (mark reviewed / dismissed / snoozed)
      // The `showImported` toggle still gates wayback rows on top of the
      // flag — flipping the toggle off hides them regardless of the flag.
      const filtered = rows.filter(r => {
        if (r.kind === 'review') return tf.reviewRows;
        if (r.kind === 'snapshot') {
          if (r.source === 'wayback') return tf.waybackRows;
          return tf.liveRows;
        }
        return true;
      });
      return showImported
        ? filtered
        : filtered.filter(r => !(r.kind === 'snapshot' && r.source === 'wayback'));
    },
    [rows, showImported, tf.liveRows, tf.waybackRows, tf.reviewRows],
  );

  const togglePreview = (key: string, versionId: string) => {
    setExpandedPreview(prev => (prev === key ? null : key));

    if (previews[versionId]) return; // already loaded (or loading/error)

    setPreviews(prev => ({ ...prev, [versionId]: { status: 'loading' } }));
    fetch(`/api/policy/version/${encodeURIComponent(versionId)}`)
      .then(async res => {
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as PolicyVersionResponse;
      })
      .then(data => {
        setPreviews(prev => ({ ...prev, [versionId]: { status: 'loaded', data } }));
      })
      .catch(error => {
        setPreviews(prev => ({
          ...prev,
          [versionId]: {
            status: 'error',
            message: error instanceof Error ? error.message : tCt('load_failed'),
          },
        }));
      });
  };

  const toggleDiff = (key: string, versionId: string) => {
    setExpandedDiff(prev => (prev === key ? null : key));

    if (diffs[versionId]) return;

    setDiffs(prev => ({ ...prev, [versionId]: { status: 'loading' } }));
    fetch(`/api/policy/version/${encodeURIComponent(versionId)}/diff`)
      .then(async res => {
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          // 404 is expected when there's no earlier version text on file —
          // either this is the first-ever scrape, or the change was
          // detected before the diff feature started persisting full text.
          // The old message read as a raw "not found"; the longer copy
          // here explains what's really going on and sets the expectation
          // that the *next* change will have a full diff.
          if (res.status === 404) {
            throw new Error(
              tCt('earlier_not_captured'),
            );
          }
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as PolicyDiffResponse;
      })
      .then(data => {
        setDiffs(prev => ({ ...prev, [versionId]: { status: 'loaded', data } }));
      })
      .catch(error => {
        setDiffs(prev => ({
          ...prev,
          [versionId]: {
            status: 'error',
            message: error instanceof Error ? error.message : tCt('load_failed'),
          },
        }));
      });
  };

  if (rows.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '40px 0' }}>
        <div className="empty-state-icon">📜</div>
        <div className="empty-state-title">{tCt('empty_no_history_title')}</div>
        <p className="empty-state-text">{tCt('empty_no_history_body')}</p>
      </div>
    );
  }

  // Index of the earliest (last-rendered) *snapshot* row — used to pick out the
  // "first scan recorded" marker. We compute it against the snapshot subset so
  // an interleaved review row never accidentally takes the "first-sync" slot.
  // Computed from `visibleRows` so a filtered-out wayback row at the tail
  // never claims the marker, and a live row newly-exposed by filtering can
  // legitimately take it.
  let lastSnapshotIndex = -1;
  for (let i = visibleRows.length - 1; i >= 0; i -= 1) {
    if (visibleRows[i].kind === 'snapshot') { lastSnapshotIndex = i; break; }
  }
  // Same idea for the newest snapshot, so `dotClass` treats only the newest
  // snapshot as the "latest sync" visual anchor regardless of review rows
  // above it in the merged feed.
  let firstSnapshotIndex = -1;
  for (let i = 0; i < visibleRows.length; i += 1) {
    if (visibleRows[i].kind === 'snapshot') { firstSnapshotIndex = i; break; }
  }

  return (
    <>
      {/* Per-page controls: only show the Wayback toggle when there's
          actually an imported row to toggle. Keeps the header clean on
          apps that have never been backfilled. Wave I: also gated on
          `flag.detail.timeline.wayback_toggle` so audiences who don't
          care about archive history don't see the inline checkbox. */}
      {tf.waybackToggle && waybackCount > 0 && (
        <div
          className="timeline-controls"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '8px 0 12px',
            borderBottom: '1px solid var(--border)',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <span aria-hidden="true" style={{ marginRight: 6 }}>🕰</span>
            {waybackCount} Wayback import{waybackCount === 1 ? '' : 's'} in this timeline
          </div>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showImported}
              onChange={e => setShowImported(e.target.checked)}
            />
            {tTimeline('show_wayback_imports')}
          </label>
        </div>
      )}

      {/* Wave I — `flag.detail.charts.category_trend` gates the entire
          history-stats strip (the per-quarter sparkline + the category
          trend totals). When off the chart never mounts; when on, the
          inner trend_presets / trend_legend flags fine-tune what's
          rendered. */}
      {chartsCategoryTrendOn && appId && <HistoryStatsStrip
        appId={appId}
        showPresets={chartsTrendPresetsOn}
        showLegend={chartsTrendLegendOn}
      />}

    <div className="timeline">
      {visibleRows.map((row, i) => {
        if (row.kind === 'review') {
          return (
            <ReviewTimelineItem
              key={row.id}
              row={row}
              onSnapshotClick={pulseSnapshot}
              showSnapshotChips={tf.reviewSnapshotChips}
            />
          );
        }

        const isFirst = i === lastSnapshotIndex;
        const snapshotPosition = i === firstSnapshotIndex ? 0 : 1;

        return (
          <TimelineSnapshotItem
            key={row.id}
            snapshot={row}
            isFirst={isFirst}
            snapshotPosition={snapshotPosition}
            pulsed={pulsed}
            previews={previews}
            diffs={diffs}
            expandedPreview={expandedPreview}
            expandedDiff={expandedDiff}
            togglePreview={togglePreview}
            toggleDiff={toggleDiff}
            showTriggerPills={tf.triggerPills}
            showVersionChip={tf.versionChip}
            showMatchesLiveSyncBadge={tf.matchesLiveSyncBadge}
            showPolicyPreviewToggle={tf.policyPreviewToggle}
            showPolicyDiffToggle={tf.policyDiffToggle}
          />
        );
      })}
    </div>
    </>
  );
}

/**
 * Individual snapshot row. Extracted from the inline map so we can:
 *  1. Bind an `id="snapshot-<id>"` DOM anchor for deep-links from review
 *     rows (see `pulseSnapshot` in the parent),
 *  2. Own a local `pulsing` state driven by the parent's `pulsed` prop so
 *     the CSS animation restarts on every link-click (even when the same
 *     snapshot is re-clicked), and
 *  3. Scroll itself into view once the pulse fires.
 *
 * The visual behaviour mirrors the Privacy Map card pulse
 * (`pmap-card-target-pulse`) — same 1.9 s teardown window, same
 * requestAnimationFrame primer — so users get a consistent "here's what
 * you came for" flash across the app.
 */
function TimelineSnapshotItem({
  snapshot,
  isFirst,
  snapshotPosition,
  pulsed,
  previews,
  diffs,
  expandedPreview,
  expandedDiff,
  togglePreview,
  toggleDiff,
  showTriggerPills = true,
  showVersionChip = true,
  showMatchesLiveSyncBadge = true,
  showPolicyPreviewToggle = true,
  showPolicyDiffToggle = true,
}: {
  snapshot: SnapshotRow;
  isFirst: boolean;
  snapshotPosition: number;
  pulsed: { id: string; nonce: number } | null;
  previews: Record<string, PreviewState>;
  diffs: Record<string, DiffState>;
  expandedPreview: string | null;
  expandedDiff: string | null;
  togglePreview: (key: string, versionId: string) => void;
  toggleDiff: (key: string, versionId: string) => void;
  /**
   * Wave I — per-row decorations. Each one stays in the layout when its
   * flag resolves on; defaults preserve legacy "all visible" behaviour.
   */
  showTriggerPills?: boolean;
  showVersionChip?: boolean;
  showMatchesLiveSyncBadge?: boolean;
  showPolicyPreviewToggle?: boolean;
  showPolicyDiffToggle?: boolean;
}) {
  // Translation hook scoped to the timeline namespace — needed inside
  // this inner component so the linter's recent string-extraction
  // (matches_live_sync, preview_text_button, etc.) resolves at runtime.
  // Hooks rules: must run unconditionally on every render of this
  // component, which is fine — this is the component's first line.
  const tTimeline = useTranslations('timeline');
  const tCt = useTranslations('changelog_timeline');
  // Settings → Appearance → Date format. Routes through useDateFormat
  // so date strings re-render reactively when the user changes the
  // preference in another tab/session.
  const dateMode = useDateFormat();
  const changes = snapshot.changes_summary ?? [];
  const isWayback = snapshot.source === 'wayback';
  // Reusing the row's own id as the dependency key: when `pulsed.id` is us,
  // we run the scroll+flash effect; the monotonic `nonce` is what restarts
  // the animation on repeat clicks of the same review → snapshot link.
  const isTarget = pulsed !== null && pulsed.id === snapshot.id;
  const pulseNonce = isTarget ? pulsed!.nonce : 0;
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (!isTarget || pulseNonce === 0) return;
    const el = document.getElementById(`snapshot-${snapshot.id}`);
    setPulsing(false);
    const raf = requestAnimationFrame(() => {
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setPulsing(true);
    });
    const timer = window.setTimeout(() => setPulsing(false), 1900);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [isTarget, pulseNonce, snapshot.id]);

  return (
    <div
      id={`snapshot-${snapshot.id}`}
      className={`timeline-item${isWayback ? ' timeline-item-wayback' : ''}`}
    >
      <div className={`timeline-dot ${dotClass(snapshot, snapshotPosition)}`} />

      <div className="timeline-date">{formatDate(snapshot.scraped_at, dateMode)}</div>

      <div
        className={`timeline-card${isWayback ? ' timeline-card-wayback' : ''}${
          pulsing ? ' timeline-card-pulse' : ''
        }`}
      >
        <div
          className="timeline-badges"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}
        >
          {isWayback && (
            <span
              className="wayback-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--wayback-badge-bg, rgba(124, 58, 237, 0.12))',
                color: 'var(--wayback-accent, #7c3aed)',
                border: '1px solid var(--wayback-accent, #7c3aed)',
              }}
              title={tCt('wayback_dot_title')}
            >
              <span aria-hidden="true">🕰</span>
              {formatWaybackTimestampLabel(tCt, snapshot.wayback_snapshot_url)}
            </span>
          )}
          {showTriggerPills && <TriggerPill
            trigger={snapshot.triggered_by ?? null}
            isWayback={isWayback}
            appVersion={snapshot.app_version ?? null}
          />}
          {/*
            Per-snapshot App Store version chip. Captures what Apple reported
            at the time of the sync so a privacy-label change can be
            cross-referenced with a release. We render the chip on every
            snapshot that has a version (including the "First scan recorded"
            marker), so users can see what version the baseline was pinned
            to. Release date is best-effort — Apple sometimes omits it.
          */}
          {/*
            Wayback rows now carry the version inside the TriggerPill
            ("Wayback sync · v3.4.1"), so the standalone version-chip
            is suppressed for them — otherwise the row would show the
            same `v3.4.1` twice in adjacent badges. Live/scheduled/
            manual/import rows keep the chip because their pill is
            just the subcategory label and the chip adds release-date
            context that the pill doesn't try to carry.
          */}
          {showVersionChip && snapshot.app_version && !isWayback && (
            <span
              className="version-chip"
              title={tCt('version_chip_title')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(15, 118, 110, 0.10)',
                color: '#0f766e',
                border: '1px solid #0f766e',
              }}
            >
              <span aria-hidden="true">📱</span>
              v{snapshot.app_version}
              {snapshot.app_version_updated_at
                ? ` · released ${formatShortDate(snapshot.app_version_updated_at, dateMode)}`
                : ''}
            </span>
          )}
          {showMatchesLiveSyncBadge && isWayback && snapshot.matches_live_sync && (
            <span
              className="match-live-sync-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(5, 150, 105, 0.12)',
                color: '#047857',
                border: '1px solid #047857',
              }}
              title={tCt('matches_live_sync_title')}
            >
              <span aria-hidden="true">✓</span>
              {tTimeline('matches_live_sync')}
            </span>
          )}
        </div>
        {isFirst && changes.length === 0 ? (
          <div className="timeline-card-title">
            {isWayback ? '🕰 Wayback baseline imported' : '🆕 First scan recorded'}
          </div>
        ) : changes.length === 0 ? (
          <div className="timeline-card-title" style={{ color: 'var(--text-2)' }}>
            {isWayback ? '🕰 Wayback snapshot — no differences from previous' : '✓ No changes detected'}
          </div>
        ) : (
          <>
            <div className="timeline-card-title">
              {isWayback
                ? `🕰 Wayback reconstruction · ${changes.length} change${changes.length !== 1 ? 's' : ''}`
                : changes.every(c => c.category === 'privacy-policy')
                  ? policyCardTitle(tCt, changes)
                  : changes.every(c => c.category === 'wayback-attempt')
                    ? waybackAttemptCardTitle(tCt, changes)
                    : `⚡ ${changes.length} change${changes.length !== 1 ? 's' : ''} detected`}
            </div>
            {changes.map((c, ci) => {
              const isPolicyEntry = c.category === 'privacy-policy';
              const isWaybackAttempt = c.category === 'wayback-attempt';
              const hasVersion = isPolicyEntry && !!c.policy_version_id;
              const entryKey = `${snapshot.id}:${ci}`;
              const isPreviewOpen = expandedPreview === entryKey;
              const isDiffOpen = expandedDiff === entryKey;
              const preview = hasVersion
                ? previews[c.policy_version_id as string]
                : undefined;
              const diff = hasVersion
                ? diffs[c.policy_version_id as string]
                : undefined;

              const isPolicyError = isPolicyEntry && c.policy_event === 'error';
              const isWaybackFailed =
                isWaybackAttempt && c.wayback_event === 'save_now_failed';
              const showDiffToggle = hasVersion && c.policy_event === 'changed';
              return (
                <div key={ci} className="timeline-change">
                  <span
                    className={`timeline-change-icon ${c.type}${isPolicyError ? ' policy-error' : ''}${isWaybackFailed ? ' wayback-failed' : ''}`}
                    title={
                      isPolicyError
                        ? tCt('policy_rescrape_failed')
                        : isPolicyEntry
                          ? tCt('policy_change')
                          : isWaybackFailed
                            ? tCt('wayback_save_now_failed')
                            : isWaybackAttempt
                              ? tCt('wayback_save_now')
                              : undefined
                    }
                  >
                    {isPolicyError
                      ? '⚠'
                      : isPolicyEntry
                        ? '📄'
                        : isWaybackFailed
                          ? '⚠'
                          : isWaybackAttempt
                            ? '🕰'
                            : c.type === 'added'
                              ? '＋'
                              : c.type === 'removed'
                                ? '−'
                                : '~'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      {(() => {
                        // Wayback-attempt rows ship structured fields
                        // (`wayback_event`, `target_date`); we localise from
                        // those instead of rendering the English description
                        // that lib/historical-import.ts composed at insert
                        // time. Older rows missing the structured tag still
                        // fall through to the stored description.
                        if (isWaybackAttempt && c.wayback_event) {
                          const quarter =
                            typeof c.target_date === 'number'
                              ? formatQuarterLabelClient(c.target_date)
                              : tCt('wayback_attempt_quarter_fallback');
                          if (c.wayback_event === 'requested_snapshot') {
                            return tCt('wayback_attempt_requested', { quarter });
                          }
                          if (c.wayback_event === 'save_now_failed') {
                            return tCt('wayback_attempt_save_now_failed', {
                              quarter,
                              error:
                                (c.details && c.details[0]) ||
                                tCt('wayback_attempt_save_now_failed_default'),
                            });
                          }
                          if (c.wayback_event === 'no_capture') {
                            return tCt('wayback_attempt_no_capture', { quarter });
                          }
                        }
                        return c.description;
                      })()}
                    </div>
                    {c.details && c.details.length > 0 && (
                      <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
                        {c.details.join(', ')}
                      </div>
                    )}
                    {isWaybackAttempt && c.save_now_url && (
                      <div style={{ marginTop: 4 }}>
                        <a
                          href={c.save_now_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontSize: 12,
                            color: 'var(--wayback-accent, #7c3aed)',
                            textDecoration: 'underline dotted',
                          }}
                        >
                          {tCt('view_requested_capture')}
                        </a>
                      </div>
                    )}

                    {hasVersion && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 12,
                          marginTop: 6,
                        }}
                      >
                        {showPolicyPreviewToggle && <button
                          type="button"
                          onClick={() =>
                            togglePreview(entryKey, c.policy_version_id as string)
                          }
                          aria-expanded={isPreviewOpen}
                          style={{
                            all: 'unset',
                            cursor: 'pointer',
                            fontSize: 12,
                            color: 'var(--accent, #2563eb)',
                            textDecoration: 'underline dotted',
                          }}
                        >
                          {isPreviewOpen
                            ? tCt('hide_captured_text')
                            : tTimeline('preview_text_button') + ' ▾'}
                        </button>}
                        {showPolicyDiffToggle && showDiffToggle && (
                          <button
                            type="button"
                            onClick={() =>
                              toggleDiff(entryKey, c.policy_version_id as string)
                            }
                            aria-expanded={isDiffOpen}
                            style={{
                              all: 'unset',
                              cursor: 'pointer',
                              fontSize: 12,
                              color: 'var(--accent, #2563eb)',
                              textDecoration: 'underline dotted',
                            }}
                          >
                            {isDiffOpen
                              ? tTimeline('hide_diff_button') + ' ▲'
                              : tTimeline('show_diff_button') + ' ▾'}
                          </button>
                        )}
                      </div>
                    )}

                    {hasVersion && isPreviewOpen && (
                      <PolicyVersionPreview state={preview} />
                    )}
                    {showDiffToggle && isDiffOpen && (
                      <PolicyDiffPanel state={diff} />
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {isWayback && snapshot.wayback_snapshot_url && (
          <div style={{ marginTop: 8 }}>
            <a
              href={snapshot.wayback_snapshot_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 12,
                color: 'var(--wayback-accent, #7c3aed)',
                textDecoration: 'underline dotted',
              }}
            >
              {tTimeline('wayback_link')} ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Meta for each review action. Drives the timeline dot colour, icon,
 * and copy so the kind of acknowledgement (reviewed vs dismissed vs
 * snoozed vs unsnoozed) reads at a glance.
 *
 * `dotClass` on this list reuses timeline-dot states already styled in
 * globals.css (`no-changes`, `has-changes`, `first-sync`) rather than
 * introducing a new palette — dismissed actions borrow the muted
 * no-changes state; explicit reviews use the accent first-sync ring.
 */
const REVIEW_ACTION_META: Record<
  ReviewRow['action'],
  { icon: string; titleKey: string; dotClass: string }
> = {
  reviewed:  { icon: '✓', titleKey: 'ack_reviewed', dotClass: 'first-sync' },
  dismissed: { icon: '✕', titleKey: 'ack_dismissed', dotClass: 'no-changes' },
  snoozed:   { icon: '🔔', titleKey: 'ack_snoozed', dotClass: 'no-changes' },
  unsnoozed: { icon: '↻', titleKey: 'ack_unsnoozed', dotClass: 'no-changes' },
};

function formatSnoozeUntil(ts: number, mode: DateFormatMode) {
  // Same shape as formatShortDate above (date-only) — just kept under a
  // distinct name so the call sites read clearly. Routes through the
  // settings-aware shared formatter so a user with the preference set
  // to "ISO" sees `2026-05-09` instead of `9 May 2026` on this row.
  return formatDateWithMode(ts, mode);
}

/**
 * Timeline row for a `change_review_actions` entry. Renders a single line
 * noting what the user did, how many changes were covered at that moment,
 * and — for snoozed rows — when reminders resume.
 *
 * When the row carries a `covered_snapshot_ids` list (populated at write
 * time by `recordReviewAction`), we render each id as a clickable chip that
 * calls `onSnapshotClick` to scroll to + flash the snapshot. Older review
 * rows without the list degrade to just the count.
 */
function ReviewTimelineItem({
  row,
  onSnapshotClick,
  showSnapshotChips = true,
}: {
  row: ReviewRow;
  onSnapshotClick: (snapshotId: string) => void;
  /**
   * Wave I — `flag.detail.timeline.review_snapshot_chips`. When false the
   * row still renders the action header + duration extra; only the
   * "Linked to:" snapshot chip strip is hidden.
   */
  showSnapshotChips?: boolean;
}) {
  const tCt = useTranslations('changelog_timeline');
  // Settings → Appearance → Date format. Read once per render, used
  // by both the snooze-resume line and the timeline-date column below.
  const dateMode = useDateFormat();
  const meta = REVIEW_ACTION_META[row.action] ?? REVIEW_ACTION_META.reviewed;
  const coveredIds = row.covered_snapshot_ids ?? [];
  const coveredBlurb =
    row.covered_count > 0
      ? ` · covered ${row.covered_count} pending change${row.covered_count === 1 ? '' : 's'}`
      : '';

  let extra: string | null = null;
  if (row.action === 'snoozed' && row.snooze_until) {
    extra = `Reminders resume on ${formatSnoozeUntil(row.snooze_until, dateMode)}`;
  }

  return (
    <div className="timeline-item">
      <div className={`timeline-dot ${meta.dotClass}`} />
      <div className="timeline-date">{formatDate(row.scraped_at, dateMode)}</div>
      <div className="timeline-card">
        <div className="timeline-card-title" style={{ color: 'var(--text-2)' }}>
          <span aria-hidden="true" style={{ marginRight: 6 }}>{meta.icon}</span>
          {tCt(meta.titleKey)}
          <span style={{ color: 'var(--text-3)', fontWeight: 'normal' }}>
            {coveredBlurb}
          </span>
        </div>
        {showSnapshotChips && coveredIds.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 6,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Linked to:
            </span>
            {coveredIds.map((id, idx) => (
              <button
                key={id}
                type="button"
                onClick={() => onSnapshotClick(id)}
                className="review-snapshot-chip"
                title={tCt('ack_jump_title')}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--accent-soft, rgba(37, 99, 235, 0.10))',
                  color: 'var(--accent, #2563eb)',
                  border: '1px solid var(--accent, #2563eb)',
                }}
              >
                ↳ change #{idx + 1}
              </button>
            ))}
          </div>
        )}
        {extra && (
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
            {extra}
          </div>
        )}
        {row.note && (
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
            “{row.note}”
          </div>
        )}
      </div>
    </div>
  );
}

function PolicyVersionPreview({ state }: { state: PreviewState | undefined }) {
  const tCt = useTranslations('changelog_timeline');
  // Settings-aware date format for the "First seen: …" line below.
  const dateMode = useDateFormat();
  if (!state || state.status === 'loading') {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="spinner-sm" /> Loading captured text…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={{ fontSize: 12, color: 'var(--red, #c03)', marginTop: 8 }}>
        ⚠ {state.message}
      </div>
    );
  }

  const { data } = state;
  const text = data.source_text ?? '';
  const truncated = text.length > PREVIEW_MAX_CHARS;
  const shown = truncated ? text.slice(0, PREVIEW_MAX_CHARS) : text;

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-3)',
          marginBottom: 4,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span>
          {data.source_word_count.toLocaleString()} words
          {data.source_origin ? ` · via ${data.source_origin}` : ''}
        </span>
        {data.source_final_url && (
          <a
            href={data.source_final_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--text-3)', textDecoration: 'underline' }}
          >
            source URL ↗
          </a>
        )}
        {data.archive_url && (
          <a
            href={data.archive_url}
            target="_blank"
            rel="noopener noreferrer"
            title={tCt('open_archive_title')}
            style={{ color: 'var(--text-3)', textDecoration: 'underline' }}
          >
            Wayback backup ↗
          </a>
        )}
        <span>First seen: {formatDate(data.first_fetched_at, dateMode)}</span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.45,
          maxHeight: 320,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {shown || '(empty)'}
      </pre>
      {truncated && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
          Showing first {PREVIEW_MAX_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters.
        </div>
      )}
    </div>
  );
}

/**
 * Git-style unified diff between a policy version and its predecessor.
 * Fetched on demand via GET /api/policy/version/[id]/diff. Renders each
 * line as a monospace row with added/removed backgrounds; paired lines
 * additionally highlight the specific words that changed, so policy
 * rewrites don't drown the view in whole-paragraph flips.
 */
function PolicyDiffPanel({ state }: { state: DiffState | undefined }) {
  const tCt = useTranslations('changelog_timeline');
  // Settings-aware date format for the "Comparing X → Y" line below.
  const dateMode = useDateFormat();
  if (!state || state.status === 'loading') {
    return (
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-3)',
          marginTop: 8,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <span className="spinner-sm" /> Computing diff…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
        ⚠ {state.message}
      </div>
    );
  }

  const { data } = state;
  const { stats, lines } = data;
  const shown = lines.length > DIFF_MAX_LINES ? lines.slice(0, DIFF_MAX_LINES) : lines;
  const overflow = lines.length > DIFF_MAX_LINES;

  if (stats.added === 0 && stats.removed === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
        No differences detected between the two captures.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-3)',
          marginBottom: 4,
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span className="policy-diff-added-chip">+{stats.added}</span>{' '}
          <span className="policy-diff-removed-chip">−{stats.removed}</span>{' '}
          {stats.unchanged.toLocaleString()} unchanged
        </span>
        <span>
          Comparing {formatDate(data.previous.first_fetched_at, dateMode)} → {formatDate(data.current.first_fetched_at, dateMode)}
        </span>
        {stats.truncated && (
          <span style={{ color: 'var(--orange, #c85c27)' }}>
            Diff truncated — one side exceeded the line cap.
          </span>
        )}
      </div>
      <div className="policy-diff-view" role="region" aria-label={tCt('diff_view_aria')}>
        {shown.map((line, idx) => (
          <div
            key={idx}
            className={`policy-diff-line policy-diff-line-${line.type}`}
          >
            <span className="policy-diff-gutter" aria-hidden="true">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
            </span>
            <span className="policy-diff-content">
              {line.words
                ? line.words.map((w, wi) => (
                    <span key={wi} className={`policy-diff-word policy-diff-word-${w.type}`}>
                      {w.text}
                    </span>
                  ))
                : line.text || '\u00A0'}
            </span>
          </div>
        ))}
      </div>
      {overflow && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
          Showing first {DIFF_MAX_LINES.toLocaleString()} of {lines.length.toLocaleString()} diff lines.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// History stats strip
// ─────────────────────────────────────────────

/**
 * Shape returned by GET /api/apps/[id]/history-stats. Kept loose on purpose
 * so a future additive field on the server doesn't force a client redeploy
 * in lockstep; the widget only reaches for fields it knows about.
 */
interface HistoryStatsResponse {
  appId: string;
  categoryTrend: {
    totalAdded: number;
    totalRemoved: number;
    netChange: number;
    buckets: Array<{
      startMs: number;
      endMs: number;
      label: string;
      added: number;
      removed: number;
    }>;
  };
  quarterly: Array<{
    startMs: number;
    endMs: number;
    label: string;
    changeEvents: number;
    changeEntries: number;
  }>;
}

type HistoryStatsState =
  | { status: 'loading' }
  | { status: 'loaded'; data: HistoryStatsResponse }
  | { status: 'error'; message: string };

/**
 * Aggregated history widgets rendered above the timeline:
 *   - Category trend  : quarterly +/− bars pulled from the diff entries.
 *   - Changes/quarter : minimal sparkline of rows-with-changes per bucket.
 *
 * Both are driven by the same quarterly buckets computed server-side by
 * `computeCategoryTrend` / `computeQuarterlyChanges`, so the x-axes line
 * up exactly and users can visually match "that big bar" to "that spike".
 */
function HistoryStatsStrip({
  appId,
  showPresets = true,
  showLegend = true,
}: {
  appId: string;
  /** Wave I — toggle the 30d/90d/6m preset buttons. */
  showPresets?: boolean;
  /** Wave I — toggle the chart legend. */
  showLegend?: boolean;
}) {
  const tCt = useTranslations('changelog_timeline');
  const [state, setState] = useState<HistoryStatsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/api/apps/${encodeURIComponent(appId)}/history-stats`)
      .then(async res => {
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as HistoryStatsResponse;
      })
      .then(data => {
        if (!cancelled) setState({ status: 'loaded', data });
      })
      .catch(error => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : tCt('load_stats_failed'),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [appId]);

  if (state.status === 'loading') {
    return (
      <div className="history-stats history-stats-loading" style={{ margin: '0 0 16px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="spinner-sm" /> Loading quarterly stats…
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="history-stats history-stats-error" style={{ margin: '0 0 16px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Could not load quarterly stats: {state.message}
        </div>
      </div>
    );
  }

  const { categoryTrend, quarterly } = state.data;
  const hasAnyData =
    categoryTrend.totalAdded +
      categoryTrend.totalRemoved +
      quarterly.reduce((acc, q) => acc + q.changeEvents, 0) >
    0;

  if (!hasAnyData) {
    return null;
  }

  return (
    <div
      className="history-stats"
      style={{
        // AppChangeTimeline now owns the whole strip. The quarterly
        // sparkline ("Label changes per quarter") was removed because
        // it duplicated information the main stacked-area chart
        // already showed more clearly — you could already see
        // added/removed by bucket on the timeline, and the rollup by
        // quarter just added visual noise below it.
        margin: '0 0 16px',
        padding: 12,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface-1)',
      }}
    >
      <AppChangeTimeline
        appId={appId}
        showPresets={showPresets}
        showLegend={showLegend}
      />
    </div>
  );
}

