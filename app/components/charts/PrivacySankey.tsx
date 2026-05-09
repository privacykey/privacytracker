'use client';

/**
 * Sankey: app → severity → category. One "unit of flow" per (app, category)
 * cell in the matrix, so the width of each ribbon is proportional to the
 * number of (app, category) pairs at that severity.
 *
 * When the library is very large we cap the app column so the diagram stays
 * legible — the top N most-collecting apps are shown; a footer mentions how
 * many were hidden.
 *
 * UX notes:
 *   - Node names carry a `app:` / `sev:` / `cat:` prefix so an app literally
 *     called "Location" can't collide with the Location category node. The
 *     raw name never reaches the user — ECharts renders a human label via
 *     the node's `label.formatter` and the tooltip via a formatter callback
 *     that looks friendly labels up on a side map.
 *   - Clicking a node locks the adjacency highlight so the user can mouse
 *     off the diagram to read a long label without losing their context.
 *     Clicking the same node (or empty canvas) clears the lock.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import EChart from './EChart';
import type { MatrixData } from '../../../lib/stats-views-shared';

const MAX_APPS = 20;

/**
 * Read the effective theme from the DOM so ECharts label colours can match
 * the rest of the page. Priority:
 *   1. html[data-theme-override="light"|"dark"] — the app's explicit override
 *   2. window.matchMedia('(prefers-color-scheme: light)') — OS preference
 * Safe to call during SSR — returns 'dark' (the original default) when
 * `document`/`window` aren't available.
 */
function readTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  const override = document.documentElement.getAttribute('data-theme-override');
  if (override === 'light') return 'light';
  if (override === 'dark')  return 'dark';
  if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

/**
 * Theme-aware colours for Sankey labels and the locked-node accent. The raw
 * chart previously hardcoded dark-mode values (`#a0a0b0` labels, `#fff`
 * locked label + border) which turned into pale-on-pale in light mode. Each
 * field below maps to the one place in the option tree that uses it.
 */
interface ChartTheme {
  labelColor:      string; // default node label colour
  lockedLabel:     string; // bold label for the locked node
  lockedBorder:    string; // border ring colour for the locked node
  // Tooltip text colours used inside the formatter's inline HTML. The
  // tooltip itself still has the shared dark glass background (registered
  // in EChart.tsx) so pale greys read fine even in light page mode — no
  // need to flip these for light, but keep them in one place.
  tooltipTitle:    string;
  tooltipMeta:     string;
}

const CHART_THEME: Record<'light' | 'dark', ChartTheme> = {
  dark: {
    labelColor:   '#c8c8d2',   // was #a0a0b0 — nudged up for better dark contrast too
    lockedLabel:  '#ffffff',
    lockedBorder: '#ffffff',
    tooltipTitle: '#f0f0f5',
    tooltipMeta:  '#a0a0b0',
  },
  light: {
    // #3c3c43 is Apple's secondary label colour — ~10:1 contrast on the
    // --bg / --bg-2 light surfaces, well above the 4.5:1 WCAG AA floor.
    labelColor:   '#3c3c43',
    // Full black for the locked pivot so it visually pops against the
    // other labels even on a bright surface.
    lockedLabel:  '#1c1c1e',
    // Dark ring around the locked node replaces the dark-mode white ring,
    // which was completely invisible on the light --bg-2 canvas.
    lockedBorder: '#1c1c1e',
    tooltipTitle: '#f0f0f5',
    tooltipMeta:  '#a0a0b0',
  },
};
const SEV_COLOR: Record<string, string> = {
  DATA_USED_TO_TRACK_YOU: '#ff453a',
  DATA_LINKED_TO_YOU: '#ff9f0a',
  DATA_NOT_LINKED_TO_YOU: '#ffd60a',
};

// Prefixes used inside ECharts to keep node names unique across columns.
// See the file-level comment for why they exist.
const PREFIX_APP = 'app:';
const PREFIX_SEV = 'sev:';
const PREFIX_CAT = 'cat:';

type SankeyT = (key: string, values?: Record<string, string | number>) => string;

function prettyKind(t: SankeyT, nodeName: string): string {
  if (nodeName.startsWith(PREFIX_APP)) return t('kind_app');
  if (nodeName.startsWith(PREFIX_SEV)) return t('kind_severity');
  if (nodeName.startsWith(PREFIX_CAT)) return t('kind_category');
  return '';
}

export default function PrivacySankey() {
  const tSankey = useTranslations('privacy_sankey');
  const [data, setData] = useState<MatrixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Name of the currently locked node (e.g. "app:1234"). When set, we bake
  // visual dimming into the option directly — ECharts' own
  // `dispatchAction('highlight')` + `focus: 'adjacency'` + `blur` chain is
  // documented-but-flaky on Sankey (non-adjacent items don't always enter
  // the blur state when the highlight is triggered programmatically), so
  // option-level styling is the only reliable way to single out a node.
  // Clicking the same node again, or any empty area, clears the lock.
  const [lockedNode, setLockedNode] = useState<string | null>(null);
  // Theme tracking. Initialised synchronously from the DOM so the first
  // paint already uses the right colours on the server → client handoff;
  // the effect below keeps it in sync when the user toggles the
  // data-theme-override attribute or the OS switches light ↔ dark.
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readTheme());

  useEffect(() => {
    let live = true;
    fetch('/api/stats/matrix')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  /**
   * Re-read the theme on either (a) OS prefers-color-scheme changes or
   * (b) the app's data-theme-override attribute flipping. Both paths land
   * in the same state setter so the option memo re-runs with the right
   * label colours.
   */
  useEffect(() => {
    const update = () => setTheme(readTheme());
    update(); // sync once on mount in case SSR/client diverge
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener?.('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-override'] });
    return () => {
      mq.removeEventListener?.('change', update);
      mo.disconnect();
    };
  }, []);

  /**
   * Name → friendly label map. Keyed by the *internal* node name (with
   * prefix) so the formatter can turn "app:1543321" into "Uber" and
   * "sev:DATA_USED_TO_TRACK_YOU" into "Data Used to Track You".
   */
  const labelsByName = useMemo(() => {
    const m = new Map<string, string>();
    if (!data) return m;
    for (const app of data.apps) m.set(`${PREFIX_APP}${app.id}`, app.name);
    for (const s of data.severities) m.set(`${PREFIX_SEV}${s.identifier}`, s.label);
    for (const c of data.categories) m.set(`${PREFIX_CAT}${c.identifier}`, c.label);
    return m;
  }, [data]);

  const prettyLabel = useCallback((name: string): string => labelsByName.get(name) ?? name, [labelsByName]);

  const { option, hiddenCount } = useMemo(() => {
    if (!data) return { option: {}, hiddenCount: 0 };
    const t = CHART_THEME[theme];

    // Rank apps by total cells collected, keep top MAX_APPS.
    const ranked = [...data.apps].sort((a, b) => b.categoryCount - a.categoryCount);
    const shown = ranked.slice(0, MAX_APPS);
    const hidden = Math.max(0, ranked.length - shown.length);

    // Use unique, prefixed names to avoid collisions (an app named "Location"
    // would otherwise alias the category node). `label.formatter` gets the
    // raw node object back, which includes our stashed displayName — keeping
    // the prefix invisible to the user.
    const appNode = (id: string, name: string) => ({
      name: `${PREFIX_APP}${id}`,
      displayName: name,
      label: { formatter: name },
    });
    const sevNode = (s: string, label: string) => ({
      name: `${PREFIX_SEV}${s}`,
      displayName: label,
      itemStyle: { color: SEV_COLOR[s] },
      label: { formatter: label },
    });
    const catNode = (c: string, label: string) => ({
      name: `${PREFIX_CAT}${c}`,
      displayName: label,
      label: { formatter: label },
    });

    const usedSevs = new Set<string>();
    const usedCats = new Set<string>();
    const linksAppSev = new Map<string, number>();
    const linksSevCat = new Map<string, number>();

    for (const app of shown) {
      const cells = data.cells[app.id] ?? {};
      for (const [catId, sev] of Object.entries(cells)) {
        usedSevs.add(sev);
        usedCats.add(catId);
        const k1 = `${PREFIX_APP}${app.id}→${PREFIX_SEV}${sev}`;
        const k2 = `${PREFIX_SEV}${sev}→${PREFIX_CAT}${catId}`;
        linksAppSev.set(k1, (linksAppSev.get(k1) ?? 0) + 1);
        linksSevCat.set(k2, (linksSevCat.get(k2) ?? 0) + 1);
      }
    }

    const rawNodes = [
      ...shown.map(a => appNode(a.id, a.name)),
      ...data.severities.filter(s => usedSevs.has(s.identifier)).map(s => sevNode(s.identifier, s.label)),
      ...data.categories.filter(c => usedCats.has(c.identifier)).map(c => catNode(c.identifier, c.label)),
    ];

    const rawLinks = [
      ...[...linksAppSev].map(([k, v]) => {
        const [source, target] = k.split('→');
        return { source, target, value: v };
      }),
      ...[...linksSevCat].map(([k, v]) => {
        const [source, target] = k.split('→');
        return { source, target, value: v };
      }),
    ];

    // ── Adjacency computation for the locked node ─────────────────────
    // A naive BFS over links *looks* right but on a 3-layer Sankey where the
    // middle column (severities) is densely connected to both sides, every
    // node transitively reaches every other node. The whole graph ends up in
    // the "adjacent" set and nothing gets dimmed. So we key off the locked
    // node's TYPE and compute its specific chain directly from `data.cells`:
    //   - lock an app: its sev nodes, its cat nodes, and the exact links
    //     (app→sev and sev→cat) that make up its chain
    //   - lock a category: every app that collects it, every sev that feeds
    //     it, and the specific app→sev and sev→cat links involved
    //   - lock a severity: every app that uses it and every cat it reaches
    const adjacentNodes   = new Set<string>();
    const adjacentLinkKey = new Set<string>(); // `${source}→${target}`
    if (lockedNode) {
      adjacentNodes.add(lockedNode);

      if (lockedNode.startsWith(PREFIX_APP)) {
        // Lock an app → follow the cells it actually collects.
        const appId = lockedNode.slice(PREFIX_APP.length);
        const cells = data.cells[appId] ?? {};
        for (const [catId, sev] of Object.entries(cells)) {
          const sevN = `${PREFIX_SEV}${sev}`;
          const catN = `${PREFIX_CAT}${catId}`;
          adjacentNodes.add(sevN);
          adjacentNodes.add(catN);
          adjacentLinkKey.add(`${lockedNode}→${sevN}`);
          adjacentLinkKey.add(`${sevN}→${catN}`);
        }
      } else if (lockedNode.startsWith(PREFIX_CAT)) {
        // Lock a category → light every app that collects it and the exact
        // severity each of those apps uses for it.
        const catId = lockedNode.slice(PREFIX_CAT.length);
        for (const app of shown) {
          const sev = data.cells[app.id]?.[catId];
          if (!sev) continue;
          const appN = `${PREFIX_APP}${app.id}`;
          const sevN = `${PREFIX_SEV}${sev}`;
          adjacentNodes.add(appN);
          adjacentNodes.add(sevN);
          adjacentLinkKey.add(`${appN}→${sevN}`);
          adjacentLinkKey.add(`${sevN}→${lockedNode}`);
        }
      } else if (lockedNode.startsWith(PREFIX_SEV)) {
        // Lock a severity → light every app that uses it and every cat it
        // reaches (but NOT other severities' apps / cats).
        const sevId = lockedNode.slice(PREFIX_SEV.length);
        for (const app of shown) {
          const cells = data.cells[app.id] ?? {};
          let usesThisSev = false;
          for (const [catId, sev] of Object.entries(cells)) {
            if (sev !== sevId) continue;
            usesThisSev = true;
            const catN = `${PREFIX_CAT}${catId}`;
            adjacentNodes.add(catN);
            adjacentLinkKey.add(`${lockedNode}→${catN}`);
          }
          if (usesThisSev) {
            const appN = `${PREFIX_APP}${app.id}`;
            adjacentNodes.add(appN);
            adjacentLinkKey.add(`${appN}→${lockedNode}`);
          }
        }
      }
    }

    // Apply dim styling to non-adjacent nodes/links when a lock is active.
    // DIM_NODE_OPACITY / DIM_LINK_OPACITY are deliberately aggressive so
    // the locked flow visually dominates — "highlighting X" should make X
    // the only thing your eye tracks.
    const DIM_NODE_OPACITY  = 0.12;
    const DIM_LABEL_OPACITY = 0.22;
    const DIM_LINK_OPACITY  = 0.04;

    const nodes = rawNodes.map(n => {
      if (!lockedNode) return n;
      if (adjacentNodes.has(n.name)) {
        if (n.name === lockedNode) {
          // Locked node itself: thicker border + bolder label so the
          // pivot point reads as "this is what you locked". Border + label
          // colour come from the active theme so the pivot is visible on
          // both the dark canvas and the light --bg-2 surface.
          return {
            ...n,
            itemStyle: { ...(n as any).itemStyle, borderColor: t.lockedBorder, borderWidth: 2 },
            label: { ...(n as any).label, fontWeight: 700, color: t.lockedLabel },
          };
        }
        return n;
      }
      return {
        ...n,
        itemStyle: { ...(n as any).itemStyle, opacity: DIM_NODE_OPACITY },
        label: { ...(n as any).label, opacity: DIM_LABEL_OPACITY },
      };
    });

    const links = rawLinks.map(l => {
      if (!lockedNode) return l;
      if (adjacentLinkKey.has(`${l.source}→${l.target}`)) return l;
      return { ...l, lineStyle: { opacity: DIM_LINK_OPACITY } };
    });

    return {
      hiddenCount: hidden,
      option: {
        tooltip: {
          trigger: 'item',
          triggerOn: 'mousemove',
          // ECharts passes either a node or a link depending on what the
          // cursor is over. For nodes we show the friendly label + kind +
          // value (= total flow through the node). For links we show the
          // friendly source/target labels with the flow count.
          formatter: (params: {
            dataType: 'node' | 'edge';
            name?: string;
            value?: number;
            data?: { name?: string; displayName?: string; source?: string; target?: string; value?: number };
          }) => {
            if (params.dataType === 'node') {
              const raw = params.data?.name ?? params.name ?? '';
              const label = params.data?.displayName ?? prettyLabel(raw);
              const kind = prettyKind(tSankey, raw);
              const value = params.value;
              const valueLine = typeof value === 'number'
                ? `<div style="color:#a0a0b0;font-size:11px;margin-top:3px;">${escapeHtml(tSankey('connections', { count: value }))}</div>`
                : '';
              return `
                <div style="font-weight:600;font-size:13px;">${escapeHtml(label)}</div>
                ${kind ? `<div style="color:#a0a0b0;font-size:11px;margin-top:2px;">${escapeHtml(kind)}</div>` : ''}
                ${valueLine}
              `;
            }
            // Edge / link.
            const src = prettyLabel(params.data?.source ?? '');
            const tgt = prettyLabel(params.data?.target ?? '');
            const value = params.data?.value ?? params.value ?? 0;
            return `
              <div style="font-weight:600;font-size:13px;">${escapeHtml(src)} → ${escapeHtml(tgt)}</div>
              <div style="color:#a0a0b0;font-size:11px;margin-top:3px;">${escapeHtml(tSankey('connections', { count: value }))}</div>
            `;
          },
        },
        series: [{
          type: 'sankey',
          layout: 'none',
          nodeWidth: 14,
          nodeGap: 6,
          // Hover adjacency still works — `focus: 'adjacency'` drives the
          // blur state on mouseover even though it doesn't reliably fire
          // from dispatchAction. When locked, option-level opacity
          // overrides above take precedence so hover adjacency won't
          // visually fight the lock.
          emphasis: { focus: 'adjacency' },
          blur: {
            itemStyle: { opacity: 0.25 },
            lineStyle: { opacity: 0.08 },
            label: { opacity: 0.35 },
          },
          lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
          // Label colour is theme-aware — dark mode keeps the muted grey;
          // light mode uses Apple's secondary-label dark grey so the text
          // meets WCAG AA contrast against --bg-2.
          label: { color: t.labelColor, fontSize: 11 },
          data: nodes,
          links,
        }],
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [data, prettyLabel, lockedNode, theme]);

  // Click handler: lock/unlock the pivot node on node click.
  // The visual dimming is all driven off `lockedNode` in the option memo
  // above — no chart-instance dispatchAction needed.
  const handleChartClick = useCallback((params: unknown) => {
    const p = params as { dataType?: string; data?: { name?: string } };
    if (p.dataType !== 'node' || !p.data?.name) return;
    const name = p.data.name;
    setLockedNode(prev => (prev === name ? null : name));
  }, []);

  if (error) return <div className="empty-state" style={{ padding: 24 }}>Couldn&apos;t load flow: {error}</div>;
  if (!data) return <div className="empty-state" style={{ padding: 24 }}><span className="spinner-sm" /> Loading…</div>;
  if (data.apps.length === 0) return <div className="empty-state" style={{ padding: 24 }}>No apps tracked yet.</div>;

  const lockedLabel = lockedNode ? prettyLabel(lockedNode) : null;

  return (
    <div>
      <EChart
        option={option}
        height={Math.max(400, 24 + data.categories.length * 22)}
        onClick={handleChartClick}
      />
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginTop: 8,
          fontSize: 12,
          color: 'var(--text-3)',
          flexWrap: 'wrap',
        }}
      >
        {lockedLabel ? (
          <>
            <span style={{ color: 'var(--text-2)' }}>
              Highlighting: <strong style={{ color: 'var(--text)' }}>{lockedLabel}</strong>
            </span>
            <button
              type="button"
              onClick={() => setLockedNode(null)}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11 }}
            >
              Clear
            </button>
          </>
        ) : (
          <span>Click any node to lock its highlight. Hover still works as normal.</span>
        )}
        {hiddenCount > 0 && (
          <span style={{ marginLeft: 'auto' }}>
            Showing top {MAX_APPS} apps by category count · {hiddenCount} more not shown
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Minimal HTML-escape for values interpolated into the tooltip formatter.
 * The default ECharts tooltip renders HTML, so a developer name like
 * "Foo & Bar <LLC>" would break the layout if not escaped.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
