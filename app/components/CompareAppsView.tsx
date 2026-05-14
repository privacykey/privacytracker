'use client';

/**
 * Side-by-side privacy comparison for two apps.
 *
 * Each slot can be filled from:
 *   - the existing library (dropdown of tracked apps)
 *   - App Store search (debounced; uses /api/search → /api/compare with
 *     the picked candidate's URL; the candidate is NOT committed to the DB)
 *
 * Once both slots are populated, we show:
 *   - header rows (icon, name, developer)
 *   - a category-by-severity diff table — each category collected by either
 *     app is listed, marked as Only-A / Only-B / Both, severity-coloured
 *   - summary counts per severity
 *
 * Policy-summary comparison is deliberately deferred: transient scrapes
 * don't have one, and the radar panel on the Stats page already covers the
 * tracked-vs-tracked case. Kept the data plumbing in the API shape so we
 * can add it later without changing the contract.
 */
import Image from 'next/image';
import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
// Co-located CSS for the slot card + modal — keeps Turbopack hot-reload
// reliable, unlike appending to the 26k-line globals.css.
import './compare-slot.css';
import { CATEGORY_META, SEVERITY_CONFIG } from '../../lib/privacy-meta';
import {
  type PrivacyProfile,
  type ProfileTier,
  TIER_META,
  TIER_RANK,
  TYPE_IDENTIFIER_TO_TIER,
} from '../../lib/privacy-profile';
import {
  CANONICAL_ACCESSIBILITY_FEATURES,
  resolveAppleArtworkUrl,
  type AccessibilityFeature,
  type CanonicalAccessibilityFeature,
} from '../../lib/accessibility-types';
import {
  A11Y_PREFERENCE_META,
  type AccessibilityPreference,
  type AccessibilityProfile,
} from '../../lib/accessibility-profile';
import type { ShortlistEntry } from '../../lib/shortlist-types';

// ── Types (match the API shape in /api/compare/route.ts) ───────────────
interface SlotData {
  source: 'library' | 'scrape';
  id: string;
  name: string;
  iconUrl: string;
  developer: string;
  privacyPolicyUrl: string;
  url: string;
  privacyTypes: {
    identifier: string;
    title: string;
    categories: { identifier: string; title: string }[];
  }[];
  hasPrivacyDetails: number | null;
  /**
   * Accessibility features declared on Apple's a11y nutrition-labels shelf.
   * Always defined on the API response (empty array when the developer has
   * filed the shelf but declared nothing). Rendered by the Accessibility
   * tab of the comparison grid.
   */
  accessibilityFeatures: AccessibilityFeature[];
  /**
   * Tri-state mirror of `apps.hasAccessibilityLabels`:
   *   1    — at least one feature declared
   *   0    — shelf present but declares nothing
   *   null — shelf absent / not scraped
   */
  hasAccessibilityLabels: number | null;
}

interface LibraryApp { id: string; name: string; iconUrl: string; developer: string; }

interface SearchCandidate {
  /** Mirrors AppCandidate in lib/scraper.ts. Field names must match the
   *  /api/search response or the results list silently renders empty —
   *  earlier iterations of this view used `matches`/`storeUrl`, which was
   *  the shape of an older draft API that never shipped. */
  appleId: string;
  name: string;
  developer: string;
  iconUrl: string;
  url: string;
}

type SlotState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: SlotData }
  | { kind: 'error'; message: string };

type PickerMode = 'library' | 'search';

/**
 * Which dimension the comparison grid renders. 'privacy' keeps the original
 * category-by-severity table; 'accessibility' swaps in the accessibility
 * nutrition-labels grid that reads Apple's new shelf. Stored as component
 * state on the parent so the slot pickers + toolbar survive the switch —
 * no route change, no prop drilling, just a re-render of the comparison
 * body.
 */
type CompareMode = 'privacy' | 'accessibility' | 'both';

/**
 * Minimal pair shape shared with /api/shortlist (see lib/shortlist.ts).
 * We only need source+candidate Apple IDs to decide whether a given candidate
 * is already shortlisted under the current source app.
 */
interface ShortlistPair {
  sourceAppId: string;
  candidateAppleId: string;
}

interface CompareAppsViewProps {
  /**
   * Pre-populate slot A (or slot B, if pinnedSlot === 'B') with a spec
   * string — `id:<appId>` for a tracked app or `url:<storeUrl>` for an
   * App Store preview. When omitted the view boots with both slots empty,
   * which is the Stats-page default.
   */
  initialSpec?: string;
  /**
   * Optional pre-population of the *other* slot (B when pinnedSlot is 'A',
   * A when pinnedSlot is 'B'). Used by the dedicated /dashboard/compare
   * route so that following a link like `?a=id:X&b=id:Y` boots straight
   * into a filled comparison, rather than forcing the user to re-pick one
   * side. Ignored when `lockPinned` is true — the locked case is for the
   * "compare *this* app against …" flow where only the opposite slot is
   * user-chosen.
   */
  initialSpecOther?: string;
  /**
   * Which slot the initial spec belongs to. Defaults to 'A'.
   * Only meaningful when initialSpec is provided.
   */
  pinnedSlot?: 'A' | 'B';
  /**
   * When true, hide the slot-picker for the pinned slot and show a simple
   * "pinned to this app" header instead. Used by the app-detail tab so the
   * user can't accidentally compare an app against a different version of
   * itself.
   */
  lockPinned?: boolean;
  /**
   * Set when the user landed here from the Review wizard's Compare step.
   * Three behaviour changes flow from this:
   *   1. Slot B's picker defaults to "App Store search" mode (rather than
   *      the library dropdown) — the user is by definition looking for an
   *      alternative they don't already track.
   *   2. Slot B surfaces the source app's existing shortlist entries as
   *      quick-pick chips above the picker, so a returning user can jump
   *      straight to a candidate they previously saved.
   *   3. Whatever lands in slot B is auto-saved to the source app's
   *      shortlist — picking a candidate IS the "I want to compare to this
   *      one" signal, and saving it means the Review page sees the
   *      decision when the user navigates back.
   */
  fromReview?: boolean;
}

export default function CompareAppsView({
  initialSpec,
  initialSpecOther,
  pinnedSlot = 'A',
  lockPinned = false,
  fromReview = false,
}: CompareAppsViewProps = {}) {
  // i18n — toolbar aria-labels, mode-toggle title, shortlist link title,
  // search placeholder, plus the cluster of slot-chip titles below.
  // Per-cell privacy chip copy is composed dynamically and remains
  // English in v1.
  const tCompare = useTranslations('compare');
  const [library, setLibrary] = useState<LibraryApp[]>([]);
  const [slotA, setSlotA] = useState<SlotState>({ kind: 'empty' });
  const [slotB, setSlotB] = useState<SlotState>({ kind: 'empty' });
  const [specA, setSpecA] = useState<string | null>(() => {
    if (initialSpec && pinnedSlot === 'A') return initialSpec;
    if (initialSpecOther && pinnedSlot === 'B' && !lockPinned) return initialSpecOther;
    return null;
  });
  const [specB, setSpecB] = useState<string | null>(() => {
    if (initialSpec && pinnedSlot === 'B') return initialSpec;
    if (initialSpecOther && pinnedSlot === 'A' && !lockPinned) return initialSpecOther;
    return null;
  });

  // If the caller swaps the pinned app (e.g. the user navigates from
  // /apps/123 to /apps/456 without a remount), re-seed the pinned slot.
  useEffect(() => {
    if (!initialSpec) return;
    if (pinnedSlot === 'A') setSpecA(initialSpec);
    else setSpecB(initialSpec);
  }, [initialSpec, pinnedSlot]);

  useEffect(() => {
    fetch('/api/apps')
      .then(r => r.ok ? r.json() : [])
      .then((apps: any[]) => setLibrary(apps.map(a => ({
        id: String(a.id),
        name: String(a.name),
        iconUrl: String(a.iconUrl ?? ''),
        developer: String(a.developer ?? ''),
      }))))
      .catch(() => { /* keeps slots usable via App Store search even if DB is empty */ });
  }, []);

  // Hydrate the saved privacy profile so each category row in the
  // comparison grid can show a "matches your preference" verdict. The
  // profile endpoint is authoritative — if the user hasn't set one this
  // stays `null` and all profile-aware UI quietly falls back to the old
  // severity-only view.
  const [profile, setProfile] = useState<PrivacyProfile | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/privacy-profile')
      .then(r => r.ok ? r.json() as Promise<{ profile: PrivacyProfile | null }> : null)
      .then(body => {
        if (!live || !body) return;
        setProfile(body.profile ?? null);
      })
      .catch(() => { /* optional — the grid still renders without a profile */ });
    return () => { live = false; };
  }, []);

  // Accessibility profile — mirrors the privacy profile fetch above. Drives
  // the preference key card + teal row chrome on the Accessibility tab.
  // Falls back to null (legacy rendering) when the user hasn't configured
  // one or the endpoint is unavailable.
  const [a11yProfile, setA11yProfile] = useState<AccessibilityProfile | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/accessibility-profile')
      .then(r => r.ok ? r.json() as Promise<{ profile: AccessibilityProfile | null }> : null)
      .then(body => {
        if (!live || !body) return;
        setA11yProfile(body.profile ?? null);
      })
      .catch(() => { /* optional — the grid still renders without a profile */ });
    return () => { live = false; };
  }, []);

  // Shortlist state — the set of (source, candidate) pairs the user has
  // already stashed. Used to render "Shortlisted" on candidate rows and
  // toggle the Slot B header action. Kept in sync on mount and after every
  // add/remove so stale toggles never stick around.
  const [shortlistPairs, setShortlistPairs] = useState<ShortlistPair[]>([]);
  // Round 3 v1.2 — also hold the full grouped entries so the inline
  // "Already shortlisted for {app}" panel below has icons + names + URLs
  // to render. The pairs lookup stays as the source of truth for "is
  // this candidate already shortlisted?" (cheap Set membership), but the
  // panel itself needs the heavier ShortlistEntry shape.
  const [shortlistEntries, setShortlistEntries] = useState<ShortlistEntry[]>([]);
  const refreshShortlist = useCallback(async () => {
    try {
      const r = await fetch('/api/shortlist');
      if (!r.ok) return;
      const body = await r.json() as {
        pairs?: ShortlistPair[];
        groups?: { entries?: ShortlistEntry[] }[];
      };
      setShortlistPairs(body.pairs ?? []);
      // Flatten the groups into a single entry array — each group's
      // entries array carries the same shape and we filter per-source-app
      // at render time rather than carrying the grouping forward.
      const flat: ShortlistEntry[] = [];
      for (const g of body.groups ?? []) {
        for (const e of g.entries ?? []) flat.push(e);
      }
      setShortlistEntries(flat);
    } catch { /* non-fatal: the UI falls back to "Shortlist" with no checkmark */ }
  }, []);
  useEffect(() => { refreshShortlist(); }, [refreshShortlist]);

  // "Which tracked app are we using as the source for shortlisting?"
  // Must be a tracked app id (matches `id:…`), because shortlist entries
  // FK onto apps(id). Every shortlist row is (source=tracked app, candidate=any
  // app), so whichever slot holds a tracked app becomes the source — and the
  // OTHER slot's action saves *itself* as an alternative of that source.
  //
  // We compute a source id *per slot*: `sourceIdForA` is the tracked
  // counterpart B (so Slot A's button saves A against B), and vice versa.
  // When both slots are tracked we default to A-as-source (the historical
  // behaviour); when neither slot is tracked both buttons stay disabled and
  // explain why via tooltip.
  const sourceIdForA = useMemo(() => {
    // If slot A itself is tracked, the "source" of its button would be slot B
    // (a tracked counterpart would otherwise shortlist A against itself,
    // which is meaningless). So: only expose a source for A when A is
    // *not* tracked but B *is* tracked — the classic "two App Store apps,
    // but one is in your library" case.
    if (specA && specA.startsWith('id:')) return null;
    if (specB && specB.startsWith('id:')) return specB.slice(3);
    return null;
  }, [specA, specB]);

  const sourceIdForB = useMemo(() => {
    // Slot B's source is slot A whenever A is tracked — the common case.
    if (specA && specA.startsWith('id:')) return specA.slice(3);
    return null;
  }, [specA]);

  const shortlistSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of shortlistPairs) s.add(`${p.sourceAppId}::${p.candidateAppleId}`);
    return s;
  }, [shortlistPairs]);

  // Per-source closures so each slot picker/header gets an `isShortlisted`
  // and `onToggleShortlist` already bound to the right source id. Cheaper
  // than threading sourceId down to every call site.
  const isShortlistedFor = useCallback(
    (sourceId: string | null) =>
      (candidateId: string) => {
        if (!sourceId || !candidateId) return false;
        return shortlistSet.has(`${sourceId}::${candidateId}`);
      },
    [shortlistSet],
  );

  // `compareMode` is declared below but the toggle closure needs it now —
  // pull the ref early so the callback always sees the latest mode without
  // re-creating the closure on every flip (which would defeat useCallback).
  // We lift the actual state declaration up here for the same reason.
  const [compareMode, setCompareMode] = useState<CompareMode>('privacy');

  const toggleShortlistFor = useCallback(
    (sourceId: string | null) =>
      async (candidate: {
        appleId: string;
        name: string;
        developer?: string;
        iconUrl?: string;
        url: string;
        bundleId?: string;
      }) => {
        if (!sourceId) return;
        const alreadyIn = shortlistSet.has(`${sourceId}::${candidate.appleId}`);
        try {
          if (alreadyIn) {
            const qs = new URLSearchParams({
              sourceAppId: sourceId,
              candidateAppleId: candidate.appleId,
            });
            await fetch(`/api/shortlist?${qs}`, { method: 'DELETE' });
          } else {
            await fetch('/api/shortlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sourceAppId:         sourceId,
                candidateAppleId:    candidate.appleId,
                candidateName:       candidate.name,
                candidateDeveloper:  candidate.developer ?? '',
                candidateIconUrl:    candidate.iconUrl ?? '',
                candidateStoreUrl:   candidate.url,
                candidateBundleId:   candidate.bundleId ?? '',
                // Tag the saved entry with the currently-active compare mode
                // so the shortlist page can render a "saved for accessibility"
                // vs "saved for privacy" pill. Re-shortlisting from the other
                // tab unions the mode server-side — a candidate saved twice
                // ends up with both badges, not a flip-flop. Under the "both"
                // mode the user is explicitly looking at both axes, so we
                // tag the entry with both modes in one shot.
                modes:
                  compareMode === 'both'
                    ? ['privacy', 'accessibility']
                    : [compareMode],
              }),
            });
          }
        } finally {
          refreshShortlist();
        }
      },
    [shortlistSet, refreshShortlist, compareMode],
  );

  // From-review auto-shortlist USED to live here — every candidate
  // picked in slot B was auto-saved to the source app's shortlist on
  // selection. We removed that: it conflated two distinct user
  // intents ("I want to compare against X" vs "I want X on my
  // shortlist"), and a user who picked something just to glance at
  // the diff ended up with stray shortlist entries they had to
  // hunt down later. The explicit `+ Shortlist` toggle on each
  // result row is now the only path to add — selecting just
  // selects, shortlisting just shortlists. The `fromReview` flag
  // still drives the back-link copy + slot B's default search mode.

  // Pre-existing shortlist entries for the current source app are
  // available via `shortlistPairs.filter(p => p.sourceAppId ===
  // sourceIdForB)`. Computed inline at the call-site only when
  // needed; the review-recommendations page renders the chip list
  // inline rather than the Compare picker doing it.

  // Refetch whenever either spec changes. Uses AbortController so an in-flight
  // compare for the previous pair gets cancelled when the user switches.
  //
  // Important UX: don't blank the already-hydrated slot(s) to `loading` on
  // refetch. Doing that wipes the comparison table out from under the user
  // every time they pick a new App B, and because the page height collapses
  // the viewport visibly snaps — it reads as "the page scrolled to the top"
  // even though the scroll position hasn't changed. Instead we keep the
  // prior payload visible and surface a subtle "Updating…" chip; the first
  // successful response replaces it in place.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!specA || !specB) return;
    const ctrl = new AbortController();
    setSlotA(prev => prev.kind === 'ready' ? prev : { kind: 'loading' });
    setSlotB(prev => prev.kind === 'ready' ? prev : { kind: 'loading' });
    setRefreshing(true);
    const qs = new URLSearchParams({ a: specA, b: specB });
    fetch(`/api/compare?${qs}`, { signal: ctrl.signal })
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        return body as { a: SlotData; b: SlotData };
      })
      .then(({ a, b }) => { setSlotA({ kind: 'ready', data: a }); setSlotB({ kind: 'ready', data: b }); })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        setSlotA({ kind: 'error', message: e.message });
        setSlotB({ kind: 'error', message: e.message });
      })
      .finally(() => { if (!ctrl.signal.aborted) setRefreshing(false); });
    return () => ctrl.abort();
  }, [specA, specB]);

  // Total shortlist entries the user has stashed across every source app.
  // Shown in the CTA button so the count itself advertises the shortlist —
  // people are more likely to click "Shortlist (3)" than an empty "Shortlist"
  // they've never visited.
  const shortlistCount = shortlistPairs.length;

  // Compare dimension state (`compareMode` / `setCompareMode`) was lifted
  // above `toggleShortlistFor` earlier in this component so the shortlist
  // POST body can tag each entry with the currently-active mode. The toggle
  // in the toolbar below wires into `setCompareMode` as usual — nothing
  // here changes at the render layer, the declaration just moved.

  return (
    <div>
      {/* Toolbar row — visible regardless of whether slots are filled, so the
          shortlist + compare-mode toggle are always reachable. The empty-state
          hint sits in the middle so it has room to wrap on narrow widths, and
          both controls on the right stay glued together via a dedicated flex
          container. Previously the shortlist sat on the left; moving it right
          groups the two "global" controls together and leaves the slot pickers
          below to start from the left edge. */}
      <div className="compare-toolbar">
        {shortlistCount === 0 && (
          <span className="compare-toolbar-hint">
            Save candidates with the <strong>+ Shortlist</strong> button on the right to review them later.
          </span>
        )}
        <div className="compare-toolbar-right">
          <div
            className="compare-mode-toggle"
            role="group"
            aria-label={tCompare('compare_by_aria')}
          >
            <button
              type="button"
              className={`compare-mode-btn${compareMode === 'privacy' ? ' is-active' : ''}`}
              aria-pressed={compareMode === 'privacy'}
              onClick={() => setCompareMode('privacy')}
            >
              Privacy
            </button>
            <button
              type="button"
              className={`compare-mode-btn${compareMode === 'accessibility' ? ' is-active' : ''}`}
              aria-pressed={compareMode === 'accessibility'}
              onClick={() => setCompareMode('accessibility')}
            >
              Accessibility
            </button>
            <button
              type="button"
              className={`compare-mode-btn${compareMode === 'both' ? ' is-active' : ''}`}
              aria-pressed={compareMode === 'both'}
              onClick={() => setCompareMode('both')}
              title={tCompare('both_mode_title')}
            >
              Both
            </button>
          </div>
          <Link
            href="/dashboard/shortlist"
            className="compare-shortlist-cta"
            aria-label={shortlistCount > 0
              ? `View your shortlist (${shortlistCount} ${shortlistCount === 1 ? 'entry' : 'entries'})`
              : tCompare('shortlist_view_empty_title')}
            title={tCompare('shortlist_link_title')}
          >
            <span aria-hidden="true">★</span>
            <span className="compare-shortlist-cta-label">{tCompare('shortlist_view_label')}</span>
            {shortlistCount > 0 && (
              <span className="compare-shortlist-cta-count" aria-hidden="true">
                {shortlistCount}
              </span>
            )}
          </Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        {lockPinned && pinnedSlot === 'A' && specA ? (
          <PinnedSlot label="App A" slot={slotA} library={library} spec={specA} />
        ) : (
          <SlotCard
            label="App A"
            slot={slotA}
            library={library}
            spec={specA}
            onChange={setSpecA}
            otherSpec={specB}
            enableShortlistOnResults={!!sourceIdForA}
            sourceAppId={sourceIdForA}
            isShortlisted={isShortlistedFor(sourceIdForA)}
            onToggleShortlist={toggleShortlistFor(sourceIdForA)}
          />
        )}
        {lockPinned && pinnedSlot === 'B' && specB ? (
          <PinnedSlot label="App B" slot={slotB} library={library} spec={specB} />
        ) : (
          <SlotCard
            label="App B"
            slot={slotB}
            library={library}
            spec={specB}
            onChange={setSpecB}
            otherSpec={specA}
            enableShortlistOnResults={!!sourceIdForB}
            sourceAppId={sourceIdForB}
            isShortlisted={isShortlistedFor(sourceIdForB)}
            onToggleShortlist={toggleShortlistFor(sourceIdForB)}
            // Default slot B to App Store search when entering from the
            // Review wizard — the user is by definition looking for an
            // alternative they don't already track, so the library
            // dropdown is the wrong starting point.
            initialMode={fromReview && !specB ? 'search' : undefined}
          />
        )}
      </div>

      {/* Top-in-category quick-pick. Appears whenever there's a
          tracked source app in the layout (typically slot A) — fetches
          the top free or top paid apps in that app's primaryGenre via
          /api/related-apps and surfaces them as one-click "load into
          slot B" buttons. Hidden when the response yields no
          candidates (e.g. genre lookup failed for the source app).
          The dropdown reserves room for a future "may also like"
          mode; v1 only the top-in-category mode is wired. */}
      {(() => {
        const sourceForRelated =
          sourceIdForB
          ?? sourceIdForA
          ?? (initialSpec && initialSpec.startsWith('id:')
            ? initialSpec.slice(3)
            : null);
        if (!sourceForRelated) return null;
        return (
          <RelatedAppsPanel
            sourceAppId={sourceForRelated}
            onPick={url => setSpecB(`url:${url}`)}
            currentSpecB={specB}
          />
        );
      })()}

      {/*
       * Inline shortlist panel — surfaces every alternative the user has
       * already saved against the current source app. We resolve a
       * "source app" in three layers, in order:
       *   1. The tracked slot (sourceIdForB || sourceIdForA) — the
       *      shortlist always FKs onto a tracked app, so this is the
       *      authoritative source whenever a tracked app is in either
       *      slot.
       *   2. When neither slot is tracked yet but the user came from the
       *      review wizard, the URL passes `a=id:<sourceAppId>` and the
       *      `initialSpec` prop carries it. We accept that as a hint so
       *      a returning user with empty slots still sees what they've
       *      saved for the app they were looking at.
       *
       * Hidden entirely when no source app can be resolved — the panel
       * has nothing to scope to in that case, and the "View shortlist"
       * link in the toolbar already covers the global case.
       *
       * Click a chip to load the candidate into slot B for comparison;
       * click the chip again (or the explicit ✕) to remove it from the
       * shortlist. Mirrors the chip pattern in the Review wizard's Step
       * 2 so users learn the affordance once.
       */}
      {(() => {
        // Resolve the active source app for the panel — see comment block
        // above for the precedence rules.
        const resolvedSourceId =
          sourceIdForB
          ?? sourceIdForA
          ?? (initialSpec && initialSpec.startsWith('id:')
            ? initialSpec.slice(3)
            : null);
        if (!resolvedSourceId) return null;

        const sourceApp = library.find(a => a.id === resolvedSourceId);
        const entriesForSource = shortlistEntries.filter(
          e => e.sourceAppId === resolvedSourceId,
        );

        // Hide the panel entirely on a fresh dashboard visit (no source
        // can be resolved AND no entries) — only render when the user
        // has either a source-app context or actual saved entries to
        // show. If neither, the empty-state copy below would just be
        // noise.
        const hasContext = !!sourceApp || entriesForSource.length > 0;
        if (!hasContext) return null;

        const sourceName = sourceApp?.name ?? '';
        // State-aware header: when the shortlist is empty, the
        // "Already shortlisted for X" copy is misleading (nothing has
        // been shortlisted yet). Swap to the empty-state phrasing so
        // the panel header matches its body.
        const isEmpty = entriesForSource.length === 0;
        const headerLabel = isEmpty
          ? sourceName
            ? tCompare('source_shortlist_label_empty', { name: sourceName })
            : tCompare('source_shortlist_label_empty_unknown')
          : sourceName
            ? tCompare('source_shortlist_label', { name: sourceName })
            : tCompare('source_shortlist_label_unknown');

        return (
          <section
            className="compare-source-shortlist"
            aria-label={headerLabel}
          >
            <div className="compare-source-shortlist-head">
              <span className="compare-source-shortlist-icon" aria-hidden="true">★</span>
              <span className="compare-source-shortlist-label">
                {headerLabel}
              </span>
              {entriesForSource.length > 0 && (
                <span
                  className="compare-source-shortlist-count"
                  aria-label={tCompare('source_shortlist_count_aria', {
                    count: entriesForSource.length,
                  })}
                >
                  {entriesForSource.length}
                </span>
              )}
            </div>

            {entriesForSource.length === 0 ? (
              <p className="compare-source-shortlist-empty">
                {tCompare('source_shortlist_empty')}
              </p>
            ) : (
              <ul className="compare-source-shortlist-list">
                {entriesForSource.map(entry => {
                  // The chip is "picked" when slot B currently holds the
                  // same App Store URL — clicking again clears the slot
                  // (via onChange(null)) so the user can pick a different
                  // candidate without hunting for the slot's Clear button.
                  const isPicked = specB === `url:${entry.candidateStoreUrl}`;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={`compare-source-shortlist-chip${isPicked ? ' is-picked' : ''}`}
                        onClick={() =>
                          setSpecB(
                            isPicked
                              ? null
                              : `url:${entry.candidateStoreUrl}`,
                          )
                        }
                        aria-pressed={isPicked}
                        title={
                          isPicked
                            ? tCompare('source_shortlist_picked_title')
                            : tCompare('source_shortlist_pick_title', {
                                name: entry.candidateName,
                              })
                        }
                      >
                        {entry.candidateIconUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={entry.candidateIconUrl}
                            alt=""
                            className="compare-source-shortlist-chip-icon"
                            width={20}
                            height={20}
                          />
                        ) : (
                          <span
                            className="compare-source-shortlist-chip-icon compare-source-shortlist-chip-icon-placeholder"
                            aria-hidden="true"
                          />
                        )}
                        <span className="compare-source-shortlist-chip-name">
                          {entry.candidateName}
                        </span>
                        {isPicked && (
                          <span
                            className="compare-source-shortlist-chip-tick"
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="compare-source-shortlist-chip-remove"
                        onClick={async () => {
                          const qs = new URLSearchParams({
                            sourceAppId: resolvedSourceId,
                            candidateAppleId: entry.candidateAppleId,
                          });
                          try {
                            await fetch(`/api/shortlist?${qs}`, {
                              method: 'DELETE',
                            });
                          } finally {
                            // If this was the currently-picked chip, drop
                            // the slot so we're not pointing at a chip
                            // that no longer exists in the shortlist.
                            if (isPicked) setSpecB(null);
                            refreshShortlist();
                          }
                        }}
                        aria-label={tCompare('source_shortlist_remove_aria', {
                          name: entry.candidateName,
                        })}
                        title={tCompare('source_shortlist_remove_title')}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })()}

      {(!specA || !specB) && (
        <div className="empty-state" style={{ padding: 24 }}>
          <div>{tCompare('pick_two')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {tCompare('pick_two_hint')}
          </div>
        </div>
      )}

      {specA && specB && (
        <ComparisonBody
          a={slotA}
          b={slotB}
          refreshing={refreshing}
          sourceIdForA={sourceIdForA}
          sourceIdForB={sourceIdForB}
          isShortlistedFor={isShortlistedFor}
          toggleShortlistFor={toggleShortlistFor}
          profile={profile}
          a11yProfile={a11yProfile}
          compareMode={compareMode}
        />
      )}
    </div>
  );
}

// ── Slot picker (library dropdown + App Store search) ──────────────────

/**
 * Detect whether what the user typed/pasted into the search input is an
 * App Store product URL (apps.apple.com or itunes.apple.com) rather than
 * a free-text query. We only commit to the URL path when the host matches
 * AND we can pull a numeric `/id<digits>` out of it — that's the token we
 * use downstream as `apps.id`, so without it the URL is unusable here.
 *
 * Returns the cleaned URL string (stripped of whitespace) and the Apple
 * ID; the caller hands the URL straight to `/api/compare?a=url:<url>` so
 * the existing scrape path hydrates the slot exactly as the normal
 * "App Store search → pick candidate" flow does.
 */
function parseAppStoreUrlInput(raw: string): { url: string; appleId: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Bail early on anything that doesn't smell like a URL so the free-text
  // search path still runs at typical typing speeds. We accept bare URLs
  // without a scheme too — copy-paste from Safari sometimes drops https://.
  if (!/apps\.apple\.com|itunes\.apple\.com/i.test(trimmed)) return null;
  let normalised = trimmed;
  if (!/^https?:\/\//i.test(normalised)) normalised = 'https://' + normalised;
  let parsed: URL;
  try {
    parsed = new URL(normalised);
  } catch {
    return null;
  }
  if (!/^(apps|itunes)\.apple\.com$/i.test(parsed.hostname)) return null;
  const idMatch = parsed.pathname.match(/\/id(\d+)/i);
  if (!idMatch) return null;
  return { url: parsed.toString(), appleId: idMatch[1] };
}

/**
 * Big-card wrapper for a Compare slot — the primary affordance for
 * picking App A / App B. Replaces the previous compact input-box
 * picker. Two states:
 *
 *   - Empty:  dashed card, big "+" glyph, "Pick App A" CTA. Whole card
 *             is a single button — click anywhere opens the picker modal.
 *   - Picked: solid card with the app's icon, name, developer; small
 *             "Change" + "✕" pill buttons in the top-right corner.
 *             Clicking the card body (or "Change") reopens the picker
 *             modal; the "✕" clears the slot in place.
 *
 * The picker UX itself stays in {@link SlotPicker} — we host it inside
 * a `.modal-overlay` / `.modal-card` shell when the user opens it, and
 * propagate `onChange` back through so picking inside the modal closes
 * the modal automatically.
 *
 * `slot` is the resolved {@link SlotState} from the parent — we read
 * the picked app's icon/name/developer from it; if the resolved data
 * hasn't landed yet (kind === 'loading'), we fall back to the library
 * row for an id:-spec'd slot so the card never shows blank flicker
 * during the first fetch.
 */

type RiskLevel = 'high' | 'moderate' | 'low' | 'minimal';

/**
 * Mirror of AppGrid's `computeRiskLevel`, but counting categories
 * straight off SlotData.privacyTypes instead of the pre-aggregated
 * track/linked/unlinked columns that the grid passes through. Returns
 * `null` when there's no privacy data to assess (e.g. an app the
 * developer never filled labels for).
 */
function deriveRiskLevelFromPrivacyTypes(
  privacyTypes: SlotData['privacyTypes'],
): RiskLevel | null {
  if (!privacyTypes || privacyTypes.length === 0) return null;
  let trackCount = 0;
  let linkedCount = 0;
  let unlinkedCount = 0;
  for (const type of privacyTypes) {
    const cats = type.categories?.length ?? 0;
    if (type.identifier === 'DATA_USED_TO_TRACK_YOU') trackCount += cats;
    else if (type.identifier === 'DATA_LINKED_TO_YOU') linkedCount += cats;
    else if (type.identifier === 'DATA_NOT_LINKED_TO_YOU') unlinkedCount += cats;
  }
  if (trackCount === 0 && linkedCount === 0 && unlinkedCount === 0) return null;
  if (trackCount >= 1) return 'high';
  if (linkedCount >= 3) return 'moderate';
  if (linkedCount >= 1 || unlinkedCount >= 1) return 'low';
  return 'minimal';
}

function SlotCard(props: {
  label: string;
  slot: SlotState;
  library: LibraryApp[];
  spec: string | null;
  onChange: (s: string | null) => void;
  otherSpec: string | null;
  enableShortlistOnResults: boolean;
  // Match the SlotPicker types exactly so props flow through without
  // narrow-vs-wide friction when we re-pass them inside the modal.
  sourceAppId: string | null;
  isShortlisted: (candidateId: string) => boolean;
  onToggleShortlist: (c: { appleId: string; name: string; developer?: string; iconUrl?: string; url: string; bundleId?: string }) => void | Promise<void>;
  initialMode?: PickerMode;
}) {
  const tCompare = useTranslations('compare');
  const tRisk = useTranslations('risk');
  const [modalOpen, setModalOpen] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Esc + autofocus the modal's close button so keyboard users can
  // tab through the picker without losing focus context.
  useEffect(() => {
    if (!modalOpen) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  // Resolve a best-guess preview of the picked app for the card body.
  // Prefer the live SlotData (which has the freshest icon URL + name);
  // fall back to the library row for `id:`-spec'd slots so the card
  // never blanks on the initial fetch.
  const isPicked = !!props.spec;
  const liveData = props.slot.kind === 'ready' ? props.slot.data : null;
  const fromLibrary = props.spec?.startsWith('id:')
    ? props.library.find(a => a.id === props.spec!.slice(3))
    : null;
  const displayName = liveData?.name ?? fromLibrary?.name ?? '';
  const displayDev  = liveData?.developer ?? fromLibrary?.developer ?? '';
  const displayIcon = liveData?.iconUrl ?? fromLibrary?.iconUrl ?? '';

  // Risk pill — derived from the resolved SlotData (only available
  // when the picked app is fully loaded). Mirrors AppGrid's pill so
  // the same colour/copy reads consistently across the app.
  const riskLevel = liveData ? deriveRiskLevelFromPrivacyTypes(liveData.privacyTypes) : null;

  // Propagate picks from the inner picker and auto-close the modal so the
  // user lands back on the now-picked slot card without an extra click.
  const handleInnerChange = (next: string | null) => {
    props.onChange(next);
    if (next) setModalOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className={`compare-slot-card ${isPicked ? 'is-picked' : 'is-empty'}`}
        onClick={() => setModalOpen(true)}
        aria-label={
          isPicked
            ? tCompare('slot_card_change_aria', { label: props.label, name: displayName || props.label })
            : tCompare('slot_card_pick_aria', { label: props.label })
        }
      >
        <span className="compare-slot-card-label">{props.label}</span>
        {!isPicked ? (
          <span className="compare-slot-card-empty-body">
            <span className="compare-slot-card-plus" aria-hidden="true">+</span>
            <span className="compare-slot-card-cta">
              {tCompare('slot_card_pick_cta', { label: props.label })}
            </span>
            <span className="compare-slot-card-hint">{tCompare('slot_card_pick_hint')}</span>
          </span>
        ) : (
          <span className="compare-slot-card-picked-body">
            {displayIcon ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={displayIcon}
                alt=""
                className="compare-slot-card-icon"
                width={56}
                height={56}
              />
            ) : (
              <span className="compare-slot-card-icon-placeholder" aria-hidden="true" />
            )}
            <span className="compare-slot-card-text">
              <span className="compare-slot-card-name">{displayName || tCompare('slot_card_loading')}</span>
              <span className="compare-slot-card-developer">{displayDev || '—'}</span>
              {riskLevel && (
                <span className="compare-slot-card-meta">
                  <span className={`risk-pill risk-pill-${riskLevel}`}>
                    {tRisk(`${riskLevel}_label`)}
                  </span>
                </span>
              )}
            </span>
          </span>
        )}
        {isPicked && (
          // Inline actions live above the card click target — stopPropagation
          // so each acts on its own intent (Change reopens, Clear empties).
          // Rendering them inside the parent <button> would nest interactive
          // elements; instead they're absolutely positioned siblings of the
          // card body. The parent <button> still handles "click anywhere
          // else" to reopen the modal.
          <span
            className="compare-slot-card-actions"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              className="compare-slot-card-action"
              onClick={() => setModalOpen(true)}
              title={tCompare('slot_card_change_title')}
            >
              {tCompare('slot_card_change_label')}
            </button>
            <button
              type="button"
              className="compare-slot-card-action is-clear"
              onClick={() => props.onChange(null)}
              aria-label={tCompare('slot_clear_aria', { label: props.label })}
              title={tCompare('slot_clear_title')}
            >
              ✕
            </button>
          </span>
        )}
      </button>

      {modalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={tCompare('slot_card_modal_aria', { label: props.label })}
        >
          <div
            className="modal-card compare-slot-modal-card"
            onClick={e => e.stopPropagation()}
          >
            <header className="compare-slot-modal-header">
              <h2 className="compare-slot-modal-title">
                {tCompare('slot_card_modal_title', { label: props.label })}
              </h2>
              <button
                ref={closeBtnRef}
                type="button"
                className="compare-slot-modal-close"
                onClick={() => setModalOpen(false)}
                title={tCompare('slot_card_modal_close_title')}
                aria-label={tCompare('slot_card_modal_close_aria')}
              >
                ✕
              </button>
            </header>
            <SlotPicker
              label={props.label}
              library={props.library}
              spec={props.spec}
              onChange={handleInnerChange}
              otherSpec={props.otherSpec}
              enableShortlistOnResults={props.enableShortlistOnResults}
              sourceAppId={props.sourceAppId}
              isShortlisted={props.isShortlisted}
              onToggleShortlist={props.onToggleShortlist}
              initialMode={props.initialMode}
              hideHeader
            />
          </div>
        </div>
      )}
    </>
  );
}

function SlotPicker({
  label, library, spec, onChange, otherSpec,
  enableShortlistOnResults, sourceAppId, isShortlisted, onToggleShortlist,
  initialMode, hideHeader,
}: {
  label: string;
  library: LibraryApp[];
  spec: string | null;
  onChange: (s: string | null) => void;
  otherSpec: string | null;
  /** When true, each App Store search result renders a quick "+ Shortlist"
   *  toggle next to the pick button. Requires a tracked source app. */
  enableShortlistOnResults: boolean;
  sourceAppId: string | null;
  isShortlisted: (candidateId: string) => boolean;
  onToggleShortlist: (c: { appleId: string; name: string; developer?: string; iconUrl?: string; url: string; bundleId?: string }) => void | Promise<void>;
  /**
   * Which picker mode to land in initially. Defaults to 'library' (the
   * historical behaviour) — the Compare page passes 'search' for slot
   * B when entering from the Review wizard so the user lands on the
   * App Store search box rather than a library dropdown of apps they
   * already track. They're looking for an alternative they DON'T
   * have.
   */
  initialMode?: PickerMode;
  /**
   * When true, the picker omits its own outer wrapper border + header
   * (label, mode-toggle row, clear button). Used when SlotCard hosts
   * the picker inside a modal whose `.modal-card` chrome + custom
   * header already supply that framing.
   */
  hideHeader?: boolean;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  const [mode, setMode] = useState<PickerMode>(initialMode ?? 'library');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /**
   * When the user pastes a full apps.apple.com URL into the search box we
   * short-circuit the iTunes search and offer to use the URL directly.
   * Kept in state (rather than recomputed from `search` on every render)
   * so the confirmation row stays visible even if the textbox is then
   * cleared — clicking "Use this URL" commits via `onChange('url:…')`.
   */
  const pastedUrl = useMemo(() => parseAppStoreUrlInput(search), [search]);
  // Collapse long result lists to a manageable preview. The user can opt into
  // the full list with a "Show more" toggle — same affordance we use in the
  // wizard's search result blocks, so the pattern is familiar across surfaces.
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const INITIAL_RESULT_LIMIT = 4;

  // Debounced App Store search: 400ms after the last keystroke.
  //
  // When the input parses as an App Store URL we skip the network call
  // entirely — the URL already carries the Apple ID we need, and the
  // "Use this URL" pick below commits directly to `url:<url>`. Iterating
  // past this guard also avoids triggering the iTunes search with a full
  // URL as the query (which either returns junk or just the same app).
  useEffect(() => {
    if (mode !== 'search') { setResults([]); return; }
    if (pastedUrl) {
      // Clear any leftover search state so the URL row is the only
      // candidate on screen. `searching` stays false — nothing to wait on.
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    if (search.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true); setSearchError(null);
      try {
        const r = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: [search.trim()] }),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setResults(body.results?.[0]?.candidates ?? []);
        // Fresh query → collapse back to the preview so the user always lands
        // on the top matches first. Otherwise a big expanded list sticks
        // around after a narrowed-down search.
        setResultsExpanded(false);
      } catch (e: any) {
        setSearchError(e?.message ?? tCompare('search_failed'));
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [search, mode, pastedUrl]);

  const currentLabel = useMemo(() => {
    if (!spec) return null;
    if (spec.startsWith('id:')) {
      const app = library.find(a => a.id === spec.slice(3));
      return app ? app.name : spec.slice(3);
    }
    if (spec.startsWith('url:')) return tCompare('appstore_candidate');
    return spec;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [spec, library]);

  // When SlotCard hosts us inside a modal, drop the outer card chrome
  // (border/padding) — the modal-card supplies it — and skip the
  // label-and-clear header row since the modal header already shows
  // the slot label + a close affordance. The mode toggle still needs
  // to appear so the user can switch between Library and App Store
  // search; we render it as a standalone row at the top.
  const Wrapper: React.ElementType = hideHeader ? React.Fragment : 'div';
  const wrapperProps = hideHeader
    ? {}
    : { style: { border: '1px solid var(--border)', borderRadius: 12, padding: 12 } };
  return (
    <Wrapper {...wrapperProps}>
      {!hideHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13, color: 'var(--text)' }}>{label}</strong>
          {currentLabel && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>· {currentLabel}</span>
          )}
          {/* Deselect / clear the slot. Visible only when the slot is
              populated; clicking calls `onChange(null)` which empties
              both the spec and (downstream) the resolved SlotData. The
              shortlist entry, if any, stays put — clearing the slot is
              distinct from un-shortlisting the candidate. */}
          {spec && (
            <button
              type="button"
              className="compare-slot-clear-btn"
              onClick={() => onChange(null)}
              aria-label={tCompare('slot_clear_aria', { label })}
              title={tCompare('slot_clear_title')}
            >
              {tCompare('slot_clear_label')}
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <ModeButton active={mode === 'library'} onClick={() => setMode('library')}>{tCompare('mode_library')}</ModeButton>
            <ModeButton active={mode === 'search'} onClick={() => setMode('search')}>{tCompare('mode_appstore')}</ModeButton>
          </div>
        </div>
      )}
      {hideHeader && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 4, marginBottom: 10 }}>
          <ModeButton active={mode === 'library'} onClick={() => setMode('library')}>{tCompare('mode_library')}</ModeButton>
          <ModeButton active={mode === 'search'} onClick={() => setMode('search')}>{tCompare('mode_appstore')}</ModeButton>
        </div>
      )}

      {mode === 'library' && (
        <select
          value={spec?.startsWith('id:') ? spec.slice(3) : ''}
          onChange={e => onChange(e.target.value ? `id:${e.target.value}` : null)}
          style={selectStyle}
        >
          <option value="">{tCompare('library_select_placeholder')}</option>
          {library
            .filter(a => otherSpec !== `id:${a.id}`)
            .map(a => (
              <option key={a.id} value={a.id}>
                {a.name}{a.developer ? ` · ${a.developer}` : ''}
              </option>
            ))}
        </select>
      )}

      {mode === 'search' && (
        <div>
          <input
            type="search"
            placeholder={tCompare('search_placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={selectStyle}
          />
          {searching && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{tCompare('searching')}</div>}
          {searchError && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{searchError}</div>}
          {/* Pasted App Store URL short-circuit: skip the iTunes search, offer
              a single "Use this URL" row that commits the scrape path directly.
              Matches the pick affordance of a normal search result (selected
              outline when already chosen, "+ Shortlist" sibling when the other
              slot is tracked) so the flow feels the same. */}
          {pastedUrl && (() => {
            const selected = spec === `url:${pastedUrl.url}`;
            const shortlisted = enableShortlistOnResults && isShortlisted(pastedUrl.appleId);
            const rowBorder = selected ? 'var(--blue)' : 'var(--border)';
            const rowBg = selected ? 'rgba(10,132,255,0.12)' : 'var(--surface)';
            return (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  Looks like an App Store link — use it directly?
                </div>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: 6, borderRadius: 8,
                    border: '1px solid', borderColor: rowBorder,
                    background: rowBg,
                  }}
                >
                  <button
                    type="button"
                    // Toggle: a second click on the already-selected
                    // row deselects it (clears the slot). Lets the
                    // user un-pick without hunting for the Clear
                    // button in the slot header.
                    onClick={() => onChange(selected ? null : `url:${pastedUrl.url}`)}
                    aria-pressed={selected}
                    title={selected ? tCompare('result_deselect_title') : undefined}
                    style={{
                      flex: 1, minWidth: 0,
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: 'transparent', border: 'none',
                      padding: 0, cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: 'color-mix(in srgb, var(--blue, #0a84ff) 18%, transparent)',
                      color: 'var(--blue, #0a84ff)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, fontSize: 14,
                    }} aria-hidden="true">🔗</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        App Store ID {pastedUrl.appleId}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pastedUrl.url}
                      </div>
                    </div>
                  </button>
                  {enableShortlistOnResults && sourceAppId && (
                    <button
                      type="button"
                      onClick={() => onToggleShortlist({
                        appleId:   pastedUrl.appleId,
                        name:      tCompare('app_store_id_name', { id: pastedUrl.appleId }),
                        url:       pastedUrl.url,
                      })}
                      aria-pressed={shortlisted}
                      title={shortlisted
                        ? tCompare('remove_from_shortlist')
                        : tCompare('save_alternative')}
                      className={`compare-shortlist-btn${shortlisted ? ' is-saved' : ''}`}
                    >
                      {shortlisted ? tCompare('shortlist_saved') : tCompare('shortlist_add')}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {/* Explicit "no hits" state so a silent empty dropdown can't be
              mistaken for a broken search (which is exactly how the previous
              matches/candidates field-name mismatch manifested). */}
          {!pastedUrl && !searching && !searchError && search.trim().length >= 2 && results.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
              No App Store matches for &ldquo;{search.trim()}&rdquo;.
            </div>
          )}
          {!pastedUrl && results.length > 0 && (() => {
            // Cap at 8 total (the full surfaced set from /api/search) but
            // default the visible slice to INITIAL_RESULT_LIMIT so the list
            // stays compact. Users who want more hit "Show more".
            const fullList = results.slice(0, 8);
            const visible = resultsExpanded
              ? fullList
              : fullList.slice(0, INITIAL_RESULT_LIMIT);
            const hasMore = fullList.length > INITIAL_RESULT_LIMIT;
            return (
            <>
            <div style={{ maxHeight: resultsExpanded ? 340 : 220, overflow: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {visible.map(m => {
                const selected = spec === `url:${m.url}`;
                const shortlisted = enableShortlistOnResults && isShortlisted(m.appleId);
                const rowBorder = selected ? 'var(--blue)' : 'var(--border)';
                const rowBg = selected ? 'rgba(10,132,255,0.12)' : 'var(--surface)';
                // Row-level container so we can render pick + shortlist as
                // siblings; neither is a <button> inside the other (invalid
                // HTML and an a11y trap — the inner button would be
                // unreachable by keyboard in most browsers).
                return (
                  <div
                    key={m.appleId}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: 6, borderRadius: 8,
                      border: '1px solid', borderColor: rowBorder,
                      background: rowBg,
                    }}
                  >
                    <button
                      type="button"
                      // Toggle: a second click on the already-selected
                      // row deselects it. Same UX as the pasted-URL
                      // row above so users learn the pattern once.
                      onClick={() => onChange(selected ? null : `url:${m.url}`)}
                      aria-pressed={selected}
                      title={selected ? tCompare('result_deselect_title') : undefined}
                      style={{
                        flex: 1, minWidth: 0,
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: 'transparent', border: 'none',
                        padding: 0, cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      {m.iconUrl ? (
                        <Image
                          src={m.iconUrl}
                          alt={m.name}
                          width={28}
                          height={28}
                          // Explicit style dims + object-fit prevent the
                          // parent flex row from stretching non-square icons.
                          style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                          unoptimized
                        />
                      ) : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-3)', flexShrink: 0 }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.developer}</div>
                      </div>
                    </button>
                    {enableShortlistOnResults && sourceAppId && (
                      <button
                        type="button"
                        onClick={() => onToggleShortlist({
                          appleId:   m.appleId,
                          name:      m.name,
                          developer: m.developer,
                          iconUrl:   m.iconUrl,
                          url:       m.url,
                        })}
                        aria-pressed={shortlisted}
                        title={shortlisted
                          ? tCompare('remove_from_shortlist')
                          : tCompare('save_alternative')}
                        className={`compare-shortlist-btn${shortlisted ? ' is-saved' : ''}`}
                      >
                        {shortlisted ? tCompare('shortlist_saved') : tCompare('shortlist_add')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {hasMore && (
              <button
                type="button"
                className="show-more-btn"
                onClick={() => setResultsExpanded(v => !v)}
                aria-expanded={resultsExpanded}
              >
                {resultsExpanded
                  ? tCompare('show_less')
                  : tCompare('show_n_more', { count: fullList.length - INITIAL_RESULT_LIMIT })}
              </button>
            )}
            </>
            );
          })()}
        </div>
      )}
    </Wrapper>
  );
}

/**
 * Non-editable "this is the app you're on" tile used by the app-detail
 * Compare tab. Shows the app's icon/name/dev when hydrated; falls back to
 * a shimmer-ish placeholder while /api/compare is in-flight.
 */
function PinnedSlot({
  label, slot, library, spec,
}: {
  label: string;
  slot: SlotState;
  library: LibraryApp[];
  spec: string;
}) {
  // Figure out a "best guess" name/dev/icon for the loading state so the tile
  // doesn't look blank on the initial fetch. We can do this cheaply when
  // slot A is pinned by spec `id:<appId>` because the library list already
  // has the row; for URL-pinned slots we wait for the API response.
  const fromLibrary = spec.startsWith('id:')
    ? library.find(a => a.id === spec.slice(3))
    : null;

  const liveData = slot.kind === 'ready' ? slot.data : null;
  const displayName = liveData?.name ?? fromLibrary?.name ?? '—';
  const displayDev = liveData?.developer ?? fromLibrary?.developer ?? '';
  const displayIcon = liveData?.iconUrl ?? fromLibrary?.iconUrl ?? '';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: 'var(--text)' }}>{label}</strong>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· pinned to this app</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {displayIcon ? (
          <Image
            src={displayIcon}
            alt={displayName}
            width={36}
            height={36}
            style={{ width: 36, height: 36, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }}
            unoptimized
          />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: 7, background: 'var(--bg-3)', flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayDev || '—'}
          </div>
        </div>
        {slot.kind === 'loading' && <span className="spinner-sm" />}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode; }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`compare-mode-btn${active ? ' is-active' : ''}`}
    >{children}</button>
  );
}

/**
 * "Top in category" panel rendered between the slot pickers and the
 * comparison body. Hits /api/related-apps with the source app's id —
 * the API resolves the app's primaryGenre + price tier and returns
 * the top free or top paid candidates in that genre. Each result
 * surfaces as a button-styled chip; clicking loads it into slot B
 * for an immediate side-by-side.
 *
 * The dropdown reserves room for a future "may also like" mode (the
 * user asked for both axes). v1 only the top-in-category mode is
 * wired — the alternate option is rendered as disabled with a
 * "coming soon" hint so the affordance is discoverable but doesn't
 * mislead.
 */
type RelatedMode = 'top_in_category' | 'may_also_like';

function RelatedAppsPanel({
  sourceAppId,
  onPick,
  currentSpecB,
}: {
  sourceAppId: string;
  onPick: (storeUrl: string) => void;
  currentSpecB: string | null;
}) {
  const tCompare = useTranslations('compare');
  const [mode, setMode] = useState<RelatedMode>('top_in_category');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    genreName: string | null;
    free: boolean | null;
    candidates: Array<{
      appleId: string;
      name: string;
      developer: string;
      iconUrl: string;
      url: string;
    }>;
    /** Set on `may_also_like` when the source app has never been scraped
     *  since the shelf-extraction code shipped. UI uses this to offer a
     *  one-click rescrape instead of a generic empty state. */
    reason?: 'not_scraped_yet';
    /** Source app's App Store URL — used by the rescrape CTA. */
    sourceAppUrl?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescraping, setRescraping] = useState(false);

  // Fetch lazily on first open + whenever the source app or the
  // selected mode changes. Closing the panel preserves the cached
  // data so re-opening is instant. Both modes hit the same endpoint;
  // the `mode` query string controls which Apple feed gets queried
  // server-side.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(
      `/api/related-apps?sourceAppId=${encodeURIComponent(sourceAppId)}&mode=${mode}&limit=5`,
      { signal: ctrl.signal },
    )
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        return body as {
          genreName: string | null;
          free: boolean | null;
          candidates: typeof data extends { candidates: infer C } ? C : never;
          reason?: 'not_scraped_yet';
          sourceAppUrl?: string;
        };
      })
      .then(b => setData(b as never))
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, sourceAppId, mode]);

  /**
   * Trigger a fresh scrape of the source app so the next response
   * includes the now-extracted shelves. After the scrape lands we
   * refetch the related-apps payload. Best-effort: if the scrape fails
   * we fall through to the generic empty state on the next render.
   */
  const handleRescrape = async () => {
    if (!data?.sourceAppUrl) return;
    setRescraping(true);
    setError(null);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [data.sourceAppUrl],
          resync: true,
          summarizePolicies: false,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refetch the related-apps payload — same query, fresh result.
      const r = await fetch(
        `/api/related-apps?sourceAppId=${encodeURIComponent(sourceAppId)}&mode=${mode}&limit=5`,
      );
      if (r.ok) setData(await r.json());
    } catch (e) {
      console.warn('[RelatedAppsPanel] rescrape failed', e);
      setError((e as Error).message);
    } finally {
      setRescraping(false);
    }
  };

  return (
    <section className="compare-related" aria-label={tCompare('related_aria')}>
      <header className="compare-related-head">
        <button
          type="button"
          className="compare-related-toggle"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span className="compare-related-toggle-icon" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="compare-related-toggle-label">
            {tCompare('related_toggle_label')}
          </span>
          {data?.genreName && mode === 'top_in_category' && (
            <span className="compare-related-toggle-genre">
              {data.genreName}
            </span>
          )}
        </button>
        {open && (
          <select
            className="compare-related-mode-select"
            value={mode}
            onChange={e => setMode(e.target.value as RelatedMode)}
            aria-label={tCompare('related_mode_aria')}
          >
            <option value="top_in_category">
              {tCompare('related_mode_top_in_category')}
            </option>
            <option value="may_also_like">
              {tCompare('related_mode_may_also_like')}
            </option>
          </select>
        )}
      </header>

      {open && (
        <div className="compare-related-body">
          {loading && (
            <p className="compare-related-empty">
              {mode === 'may_also_like'
                ? tCompare('related_loading_may_also_like')
                : tCompare('related_loading')}
            </p>
          )}
          {!loading && error && (
            <p className="compare-related-empty">{tCompare('related_error')}</p>
          )}
          {/* "Not scraped yet" — surfaced only in may_also_like mode when
              we have no rows for the source app. Offers a one-click
              rescrape that re-pulls the product page with the new
              shelf-extraction code, then refetches. */}
          {!loading && !error && mode === 'may_also_like'
            && data && data.candidates.length === 0
            && data.reason === 'not_scraped_yet' && (
              <div className="compare-related-empty compare-related-not-scraped">
                <p>{tCompare('related_mode_may_also_like_empty')}</p>
                {data.sourceAppUrl && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleRescrape()}
                    disabled={rescraping}
                  >
                    {rescraping
                      ? tCompare('related_rescrape_busy')
                      : tCompare('related_rescrape_cta')}
                  </button>
                )}
              </div>
            )}
          {!loading && !error && data && data.candidates.length === 0
            && !(mode === 'may_also_like' && data.reason === 'not_scraped_yet') && (
              <p className="compare-related-empty">
                {mode === 'may_also_like'
                  ? tCompare('related_empty_may_also_like')
                  : tCompare('related_empty')}
              </p>
            )}
          {!loading && !error && data && data.candidates.length > 0 && (
            <ul className="compare-related-list">
              {data.candidates.map(c => {
                const picked = currentSpecB === `url:${c.url}`;
                return (
                  <li key={c.appleId}>
                    <button
                      type="button"
                      className={`compare-related-chip${picked ? ' is-picked' : ''}`}
                      onClick={() => onPick(c.url)}
                      aria-pressed={picked}
                      title={
                        picked
                          ? tCompare('related_chip_picked_title')
                          : tCompare('related_chip_pick_title', { name: c.name })
                      }
                    >
                      {c.iconUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={c.iconUrl}
                          alt=""
                          className="compare-related-chip-icon"
                          width={28}
                          height={28}
                        />
                      ) : (
                        <span
                          className="compare-related-chip-icon compare-related-chip-icon-placeholder"
                          aria-hidden="true"
                        />
                      )}
                      <span className="compare-related-chip-body">
                        <span className="compare-related-chip-name">{c.name}</span>
                        {c.developer && (
                          <span className="compare-related-chip-dev">{c.developer}</span>
                        )}
                      </span>
                      {picked && (
                        <span className="compare-related-chip-tick" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  padding: '7px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
};

// ── Comparison body ────────────────────────────────────────────────────

type ShortlistCandidate = { appleId: string; name: string; developer?: string; iconUrl?: string; url: string; bundleId?: string };

function ComparisonBody({
  a, b, refreshing,
  sourceIdForA, sourceIdForB,
  isShortlistedFor, toggleShortlistFor,
  profile, a11yProfile, compareMode,
}: {
  a: SlotState; b: SlotState; refreshing: boolean;
  /** Source id that Slot A's shortlist action binds to (= slot B's id when B is tracked and A is not). */
  sourceIdForA: string | null;
  /** Source id that Slot B's shortlist action binds to (= slot A's id when A is tracked). */
  sourceIdForB: string | null;
  isShortlistedFor: (sourceId: string | null) => (candidateId: string) => boolean;
  toggleShortlistFor: (sourceId: string | null) => (c: ShortlistCandidate) => void | Promise<void>;
  /** Saved privacy profile. `null` disables profile-aware cell highlighting. */
  profile: PrivacyProfile | null;
  /**
   * Saved accessibility profile — drives the profile key card + teal row
   * chrome on the accessibility tab. `null` keeps the legacy neutral grid.
   */
  a11yProfile: AccessibilityProfile | null;
  /** Which grid to render. Privacy is the legacy view; accessibility is the
   *  feature-by-feature a11y label grid. */
  compareMode: CompareMode;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  // Only show the full-size spinner when we genuinely have nothing to paint
  // yet. Once either slot has data, we keep it on-screen through subsequent
  // refreshes so picking a new App B doesn't cause the page height to
  // collapse (which previously read as "the scroll snapped to the top").
  if (a.kind === 'loading' && b.kind === 'loading') {
    return <div className="empty-state" style={{ padding: 24 }}><span className="spinner-sm" /> {tCompare('loading_comparison')}</div>;
  }
  if (a.kind === 'error') return <div className="empty-state" style={{ padding: 24, color: 'var(--red)' }}>{a.message}</div>;
  if (b.kind === 'error') return <div className="empty-state" style={{ padding: 24, color: 'var(--red)' }}>{b.message}</div>;
  if (a.kind !== 'ready' || b.kind !== 'ready') return null;

  if (compareMode === 'accessibility') {
    return (
      // Keyed on both slot ids so React forces a clean remount whenever
      // either app is swapped. The inner table is derived-from-props only
      // (no local state) so a remount is cheap, and keying here eliminates
      // any chance of a stale memo result — a belt-and-suspenders fix for
      // reports of the a11y grid not updating when App B changes.
      <AccessibilityComparisonTable
        key={`a11y-compare:${a.data.id}:${b.data.id}`}
        a={a.data}
        b={b.data}
        refreshing={refreshing}
        sourceIdForA={sourceIdForA}
        sourceIdForB={sourceIdForB}
        isShortlistedFor={isShortlistedFor}
        toggleShortlistFor={toggleShortlistFor}
        a11yProfile={a11yProfile}
      />
    );
  }

  if (compareMode === 'both') {
    // Stacked view: privacy table first (its SlotHeader carries icon / name /
    // shortlist / a11y-count footer chip), then a section divider, then the
    // accessibility table with its own SlotHeaders suppressed so the user
    // doesn't see the same two apps introduced twice on one scroll.
    return (
      <div>
        <ComparisonTable
          a={a.data}
          b={b.data}
          refreshing={refreshing}
          sourceIdForA={sourceIdForA}
          sourceIdForB={sourceIdForB}
          isShortlistedFor={isShortlistedFor}
          toggleShortlistFor={toggleShortlistFor}
          profile={profile}
        />
        <div className="compare-both-divider" role="separator" aria-label={tCompare('accessibility_separator_aria')}>
          <span className="compare-both-divider-label">{tCompare('a11y_section_label')}</span>
        </div>
        <AccessibilityComparisonTable
          key={`a11y-compare-both:${a.data.id}:${b.data.id}`}
          a={a.data}
          b={b.data}
          refreshing={refreshing}
          sourceIdForA={sourceIdForA}
          sourceIdForB={sourceIdForB}
          isShortlistedFor={isShortlistedFor}
          toggleShortlistFor={toggleShortlistFor}
          showSlotHeaders={false}
          a11yProfile={a11yProfile}
        />
      </div>
    );
  }

  return (
    <ComparisonTable
      a={a.data}
      b={b.data}
      refreshing={refreshing}
      sourceIdForA={sourceIdForA}
      sourceIdForB={sourceIdForB}
      isShortlistedFor={isShortlistedFor}
      toggleShortlistFor={toggleShortlistFor}
      profile={profile}
    />
  );
}

interface CellSev { severity: string | null; types: string[]; }

function buildCategoryMap(slot: SlotData): Map<string, CellSev> {
  const map = new Map<string, CellSev>();
  const rank: Record<string, number> = {
    DATA_USED_TO_TRACK_YOU: 3,
    DATA_LINKED_TO_YOU: 2,
    DATA_NOT_LINKED_TO_YOU: 1,
  };
  for (const type of slot.privacyTypes) {
    for (const cat of type.categories) {
      const prev = map.get(cat.identifier);
      const prevRank = prev?.severity ? rank[prev.severity] ?? 0 : 0;
      const thisRank = rank[type.identifier] ?? 0;
      const severity = thisRank > prevRank ? type.identifier : prev?.severity ?? type.identifier;
      const types = prev ? [...prev.types, type.identifier] : [type.identifier];
      map.set(cat.identifier, { severity, types });
    }
  }
  return map;
}

function ComparisonTable({
  a, b, refreshing,
  sourceIdForA, sourceIdForB,
  isShortlistedFor, toggleShortlistFor,
  profile,
}: {
  a: SlotData; b: SlotData; refreshing: boolean;
  sourceIdForA: string | null;
  sourceIdForB: string | null;
  isShortlistedFor: (sourceId: string | null) => (candidateId: string) => boolean;
  toggleShortlistFor: (sourceId: string | null) => (c: ShortlistCandidate) => void | Promise<void>;
  profile: PrivacyProfile | null;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  // Resolve each slot's shortlist action here rather than further down so
  // SlotHeader stays a dumb presentational component. When the counterpart
  // slot isn't tracked we pass `null` and the header skips the button.
  const aShortlistAction = sourceIdForA && a.id ? {
    isShortlisted: isShortlistedFor(sourceIdForA)(a.id),
    onClick: () => toggleShortlistFor(sourceIdForA)({
      appleId:   a.id,
      name:      a.name,
      developer: a.developer,
      iconUrl:   a.iconUrl,
      url:       a.url,
    }),
  } : null;
  const bShortlistAction = sourceIdForB && b.id ? {
    isShortlisted: isShortlistedFor(sourceIdForB)(b.id),
    onClick: () => toggleShortlistFor(sourceIdForB)({
      appleId:   b.id,
      name:      b.name,
      developer: b.developer,
      iconUrl:   b.iconUrl,
      url:       b.url,
    }),
  } : null;
  const mapA = useMemo(() => buildCategoryMap(a), [a]);
  const mapB = useMemo(() => buildCategoryMap(b), [b]);

  // Union of categories, ordered by canonical CATEGORY_META order.
  const canonical = Object.keys(CATEGORY_META);
  const union = new Set<string>([...mapA.keys(), ...mapB.keys()]);
  const ordered = [
    ...canonical.filter(k => union.has(k)),
    ...[...union].filter(k => !canonical.includes(k)).sort(),
  ];

  const onlyA = ordered.filter(k => mapA.has(k) && !mapB.has(k)).length;
  const onlyB = ordered.filter(k => !mapA.has(k) && mapB.has(k)).length;
  const both = ordered.filter(k => mapA.has(k) && mapB.has(k)).length;

  // Classify each slot into one of three empty-state flavours:
  //   - 'labeled'     → the app has at least one privacy category
  //   - 'none'        → the app declares zero categories and hasPrivacyDetails
  //                     is not explicitly `0` — this is the "doesn't collect
  //                     data" case we want to celebrate in green.
  //   - 'unfilled'    → hasPrivacyDetails === 0 (Apple's "No Details
  //                     Provided") — the dev hasn't filled labels yet. This
  //                     is the legacy/attention case.
  type EmptyStatus = 'labeled' | 'none' | 'unfilled';
  const statusOf = (slot: SlotData, empty: boolean): EmptyStatus => {
    if (!empty) return 'labeled';
    if (slot.hasPrivacyDetails === 0) return 'unfilled';
    return 'none';
  };
  const aEmpty = mapA.size === 0;
  const bEmpty = mapB.size === 0;
  const aStatus = statusOf(a, aEmpty);
  const bStatus = statusOf(b, bEmpty);

  // True when at least one slot is in the "needs a closer look at the policy"
  // bucket. We surface the warning banner below the grid (per user feedback)
  // only in the 'unfilled' case; 'none' is explicitly green and shouldn't
  // repeat itself as a yellow banner too.
  const showBanner = aStatus === 'unfilled' || bStatus === 'unfilled';

  // Count per-slot profile mismatches for the compact "match X/Y" summary
  // shown in the stats strip. A mismatch is any category where the observed
  // tier is strictly worse than the user's preference. When no profile is
  // set these stay `null` and the stats strip hides them.
  const profileCountFor = (map: Map<string, CellSev>): { mismatches: number; total: number } | null => {
    if (!profile) return null;
    const hasAnyPref = Object.values(profile).some(v => typeof v === 'string');
    if (!hasAnyPref) return null;
    let mismatches = 0;
    let total = 0;
    for (const [catId, cell] of map) {
      const allowed = profile[catId];
      if (!allowed) continue;
      total += 1;
      if (!cell.severity) continue;
      const tier = TYPE_IDENTIFIER_TO_TIER[cell.severity];
      if (!tier) continue;
      if (TIER_RANK[tier] > TIER_RANK[allowed]) mismatches += 1;
    }
    return { mismatches, total };
  };
  const profileA = profileCountFor(mapA);
  const profileB = profileCountFor(mapB);
  const hasActiveProfile = profileA !== null || profileB !== null;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
        <SlotHeader slot={a} status={aStatus} shortlistAction={aShortlistAction} />
        <SlotHeader slot={b} status={bStatus} shortlistAction={bShortlistAction} />
      </div>

      {!(aEmpty && bEmpty) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--text-3)', marginBottom: 10, alignItems: 'center' }}>
          <span>{both} shared</span>
          <span>{onlyA} only in {a.name}</span>
          <span>{onlyB} only in {b.name}</span>
          {hasActiveProfile && (
            <span className="compare-profile-strip" aria-label={tCompare('profile_match_aria')}>
              <span aria-hidden="true">🎯</span>
              {profileA && <ProfileSummaryPill label={a.name} counts={profileA} />}
              {profileB && <ProfileSummaryPill label={b.name} counts={profileB} />}
            </span>
          )}
          {refreshing && (
            // Subtle in-place indicator while a new comparison is in flight.
            // Keeps the user oriented without collapsing the table.
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', color: 'var(--text-2)' }}>
              <span className="spinner-sm" /> Updating…
            </span>
          )}
        </div>
      )}

      {ordered.length > 0 && (
        <div style={{
          display: 'grid',
          // Extra column for the user's per-category preference when a
          // profile is active; falls back to the old 3-column layout
          // otherwise so tracked-only comparisons stay dense.
          gridTemplateColumns: hasActiveProfile
            ? 'minmax(160px, 1.1fr) minmax(110px, 0.9fr) 1fr 1fr'
            : 'minmax(160px, 1fr) 1fr 1fr',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          fontSize: 13,
        }}>
          <CompareHeaderCell>{tCompare('header_category')}</CompareHeaderCell>
          {hasActiveProfile && <CompareHeaderCell>{tCompare('header_your_pref')}</CompareHeaderCell>}
          <CompareHeaderCell>{a.name}</CompareHeaderCell>
          <CompareHeaderCell>{b.name}</CompareHeaderCell>
          {ordered.map((catId, i) => {
            const meta = CATEGORY_META[catId];
            const inA = mapA.get(catId);
            const inB = mapB.get(catId);
            const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';
            const allowed = profile?.[catId] ?? null;
            // Privacy category icons: we use CATEGORY_META emoji (📇 📍 🔒 …)
            // rather than Apple's own category artwork because Apple's
            // privacy-label shelf doesn't ship per-category artwork.template
            // URLs the way the accessibility shelf does — the live JSON only
            // exposes `identifier`, `title`, `detail`, and `categories[]`
            // (identifier + title). If a future App Store HTML release adds
            // artwork fields here, mirror the `resolveAppleArtworkUrl` flow
            // used by AccessibilityFeatureIcon above and hoist this column's
            // icon resolver out.
            return (
              <div key={catId} style={{ display: 'contents' }}>
                <div style={{ ...cellStyle, background: rowBg, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{meta?.icon ?? '•'}</span>
                  <span>{meta?.label ?? catId}</span>
                </div>
                {hasActiveProfile && (
                  <ProfilePrefCell allowed={allowed} bg={rowBg} />
                )}
                <SeverityCell cell={inA ?? null} bg={rowBg} allowed={allowed} />
                <SeverityCell cell={inB ?? null} bg={rowBg} allowed={allowed} />
              </div>
            );
          })}
        </div>
      )}

      {/* Warning banner now lives BELOW the grid — surfacing it underneath
          keeps the categories as the first thing the user sees, and frames
          the banner as context ("here's why one side is thin") rather than
          a full-width alert at the top. We only show it for the 'unfilled'
          case; genuine "no data collected" slots advertise themselves with
          a green chip on the slot header instead. */}
      {showBanner && (
        <NoDataNotice
          a={a}
          b={b}
          aUnfilled={aStatus === 'unfilled'}
          bUnfilled={bStatus === 'unfilled'}
        />
      )}
    </div>
  );
}

// ── Small presentational helpers used only by the comparison table ─────

/**
 * Compact "Slack-green / orange" pill summarising each app's match against
 * the saved profile. Total = categories the profile has an opinion on that
 * this app also collects; mismatches = strict exceedances. When no
 * comparable categories exist we collapse to a dash so the viewer knows the
 * pair is un-scoreable rather than "clean".
 */
function ProfileSummaryPill({
  label, counts,
}: {
  label: string;
  counts: { mismatches: number; total: number };
}) {
  const tone: 'ok' | 'warn' | 'bad' =
    counts.total === 0 ? 'ok'
    : counts.mismatches === 0 ? 'ok'
    : counts.mismatches >= 3 ? 'bad'
    : 'warn';
  const body =
    counts.total === 0
      ? 'no profile categories'
      : counts.mismatches === 0
      ? 'matches profile'
      : `${counts.mismatches} over limit`;
  return (
    <span
      className={`compare-profile-pill match-${tone}`}
      title={`${label}: ${body}${counts.total > 0 ? ` (of ${counts.total} scored)` : ''}`}
    >
      <span className="compare-profile-pill-label">{label}:</span>
      <span>{body}</span>
    </span>
  );
}

/**
 * The "Your preference" cell — reads the user's tier for this category and
 * renders the TIER_META badge. Shows a muted em-dash when the user hasn't
 * opinionated on this category; that's the signal that the two severity
 * cells to the right should be read as raw Apple labels without any
 * "should/shouldn't" framing.
 */
function ProfilePrefCell({
  allowed, bg,
}: {
  allowed: ProfileTier | null;
  bg: string;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  if (!allowed) {
    return (
      <div
        style={{ ...cellStyle, background: bg, color: 'var(--text-3)' }}
        title={tCompare('category_no_pref_title')}
      >
        —
      </div>
    );
  }
  const meta = TIER_META[allowed];
  return (
    <div
      style={{ ...cellStyle, background: bg, display: 'flex', alignItems: 'center', gap: 6 }}
      title={meta.description}
    >
      <span className={`severity-badge ${meta.severityCls}`} style={{ fontSize: 11 }}>
        <span aria-hidden="true">{meta.icon}</span>
        {meta.shortLabel}
      </span>
    </div>
  );
}

/**
 * Callout shown below the comparison grid when one or both apps are in the
 * `unfilled` empty-state bucket — i.e. Apple explicitly renders "No Details
 * Provided" because the developer hasn't declared privacy labels yet. This
 * is distinct from a modern app that legitimately doesn't collect data
 * (those get the green "No data collected" chip on their slot header; no
 * banner here). We nudge the user toward the dev's privacy policy so they
 * can corroborate the App Store silence against the dev's own disclosure.
 */
function NoDataNotice({
  a, b, aUnfilled, bUnfilled,
}: {
  a: SlotData; b: SlotData;
  aUnfilled: boolean; bUnfilled: boolean;
}) {
  const tCompare = useTranslations('compare');
  const headline =
    aUnfilled && bUnfilled
      ? tCompare('neither_filled_labels')
      : aUnfilled
      ? `${a.name} hasn\u2019t filled in privacy labels yet`
      : `${b.name} hasn\u2019t filled in privacy labels yet`;

  // Per-slot explanation, matching the AppDetailView copy so users see the
  // same story in every surface.
  const reasonFor = (slot: SlotData) =>
    `${slot.name}: Apple shows "No Details Provided". The developer will be required to provide privacy details when they submit their next app update.`;

  // Deep-link the dev's privacy policy — this is the highest-signal thing
  // the user can do next. If the slot doesn't have one captured we fall
  // through to the bare line.
  const policyLinkFor = (slot: SlotData) => {
    if (!slot.privacyPolicyUrl) return null;
    return (
      <a
        href={slot.privacyPolicyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="compare-policy-link"
      >
        Read {slot.name}&rsquo;s privacy policy ↗
      </a>
    );
  };

  return (
    <div className="compare-unfilled-banner" role="status">
      <span aria-hidden="true" className="compare-unfilled-banner-icon">⚠️</span>
      <div className="compare-unfilled-banner-body">
        <div className="compare-unfilled-banner-title">{headline}</div>
        <div className="compare-unfilled-banner-detail">
          {aUnfilled && <div>{reasonFor(a)}</div>}
          {bUnfilled && <div style={{ marginTop: aUnfilled ? 4 : 0 }}>{reasonFor(b)}</div>}
        </div>
        <div className="compare-unfilled-banner-actions">
          {aUnfilled && policyLinkFor(a)}
          {bUnfilled && policyLinkFor(b)}
        </div>
        <div className="compare-unfilled-banner-foot">
          Privacy policies carry the authoritative disclosures until Apple captures labels — read the policy to confirm what the app actually collects.
        </div>
      </div>
    </div>
  );
}

function SlotHeader({
  slot,
  status,
  shortlistAction,
}: {
  slot: SlotData;
  /** `labeled` = app has privacy categories. `none` = app declared nothing
   *  (green "No data collected" chip). `unfilled` = Apple shows "No Details
   *  Provided" (warning chip + banner below the grid).  */
  status: 'labeled' | 'none' | 'unfilled';
  /** Optional "save as alternative" affordance. Only passed for slot B, and
   *  only when a tracked source app is paired up (sourceAppId exists). */
  shortlistAction?: { isShortlisted: boolean; onClick: () => void } | null;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  const isNoData = status === 'none';
  const isUnfilled = status === 'unfilled';
  // The a11y count chip is purely additive on the privacy-view header — it
  // rides along in the footer row whenever the developer has declared at
  // least one accessibility feature, regardless of the privacy status. This
  // lets users see at a glance "this app at least files a11y labels" even
  // when it has nothing notable to say about privacy.
  const hasA11yCount = slot.hasAccessibilityLabels === 1;
  const hasFooter = isNoData || isUnfilled || hasA11yCount;
  return (
    <div
      className={`compare-slot-header${isNoData ? ' compare-slot-header-ok' : ''}${isUnfilled ? ' compare-slot-header-warn' : ''}`}
    >
      <div className="compare-slot-header-row">
        {slot.iconUrl ? (
          <Image
            src={slot.iconUrl}
            alt={slot.name}
            width={40}
            height={40}
            style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
            unoptimized
          />
        ) : <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--bg-3)', flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.developer || '—'}</div>
        </div>
        {shortlistAction && (
          <button
            type="button"
            onClick={shortlistAction.onClick}
            aria-pressed={shortlistAction.isShortlisted}
            title={shortlistAction.isShortlisted
              ? tCompare('remove_from_shortlist_long')
              : tCompare('save_alternative_long')}
            className={`compare-shortlist-btn compare-shortlist-btn-header${shortlistAction.isShortlisted ? ' is-saved' : ''}`}
          >
            {shortlistAction.isShortlisted ? tCompare('shortlist_saved') : tCompare('shortlist_add')}
          </button>
        )}
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 999,
          background: slot.source === 'library' ? 'rgba(10,132,255,0.18)' : 'rgba(191,90,242,0.18)',
          color: slot.source === 'library' ? '#5ea9ff' : '#d28bff',
        }}>
          {slot.source === 'library' ? tCompare('slot_label_tracked') : tCompare('slot_label_preview')}
        </span>
      </div>

      {hasFooter && (
        <div className="compare-slot-header-empty">
          {/* Privacy status chip — only when the privacy status is an actual
              empty state. The a11y count chip (below) rides in the same row
              even when the privacy side is just 'labeled' / fine. */}
          {isNoData && (
            <span className="compare-slot-chip compare-slot-chip-ok" title={tCompare('no_collection_chip_title')}>
              <span aria-hidden="true">✓</span>
              {tCompare('chip_no_data_collected')}
            </span>
          )}
          {isUnfilled && (
            <span className="compare-slot-chip compare-slot-chip-warn" title={tCompare('chip_no_details_chip_title_alt')}>
              <span aria-hidden="true">⚠</span>
              {tCompare('chip_no_details_provided')}
            </span>
          )}
          {/* A11y density chip — lives on the same row as the privacy status
              chip so the "reason chips" for the slot all sit at one tier. */}
          <AccessibilityCountChip slot={slot} />
          {(isNoData || isUnfilled) && (
            slot.privacyPolicyUrl ? (
              <a
                href={slot.privacyPolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="compare-policy-link"
                title={isNoData
                  ? tCompare('policy_link_review_pref')
                  : tCompare('policy_link_review_no_labels')}
              >
                <span aria-hidden="true">📄</span>
                {tCompare('read_privacy_policy')}
              </a>
            ) : (
              <span className="compare-slot-chip-muted" title={tCompare('no_policy_url_title')}>
                {tCompare('chip_no_policy_link')}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

function SeverityCell({
  cell, bg, allowed,
}: {
  cell: CellSev | null;
  bg: string;
  /** The user's per-category tolerance. When provided we annotate the cell
   *  with a ⚠ mismatch flag (observed > allowed) or a ✓ within-bounds check
   *  (observed ≤ allowed). `null` disables profile markers entirely. */
  allowed?: ProfileTier | null;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  // The app doesn't collect this category at all. If the user has an opinion
  // on it, mark the cell as "within bounds" (green check) so they can see
  // the app matches even for categories where it's absent.
  if (!cell || !cell.severity) {
    return (
      <div style={{ ...cellStyle, background: bg, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
        {allowed && (
          <span
            className="compare-profile-mark ok"
            aria-label={tCompare('within_pref_aria')}
            title={tCompare('within_pref_aria')}
          >
            ✓
          </span>
        )}
        <span>—</span>
      </div>
    );
  }
  const sev = SEVERITY_CONFIG[cell.severity];
  const color = cell.severity === 'DATA_USED_TO_TRACK_YOU'
    ? 'var(--red)' : cell.severity === 'DATA_LINKED_TO_YOU'
    ? 'var(--orange)' : 'var(--yellow)';

  // Profile-aware decoration — only light up when the user has opinionated
  // on this category. Observed rank comes from the worst tier seen for the
  // (category, app) pair; `TIER_RANK[allowed]` is the user's ceiling.
  let mark: { kind: 'ok' | 'warn'; title: string } | null = null;
  if (allowed) {
    const observedTier = TYPE_IDENTIFIER_TO_TIER[cell.severity];
    if (observedTier) {
      const observedRank = TIER_RANK[observedTier];
      const allowedRank = TIER_RANK[allowed];
      const allowedLabel = TIER_META[allowed].shortLabel.toLowerCase();
      const observedLabel = TIER_META[observedTier].shortLabel.toLowerCase();
      if (observedRank > allowedRank) {
        mark = {
          kind: 'warn',
          title: `Exceeds your preference: ${observedLabel} (you allow ${allowedLabel})`,
        };
      } else {
        mark = {
          kind: 'ok',
          title: `Within your preference: ${observedLabel} (you allow ${allowedLabel})`,
        };
      }
    }
  }

  return (
    <div style={{ ...cellStyle, background: bg, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
      {mark && (
        <span
          className={`compare-profile-mark ${mark.kind}`}
          aria-label={mark.title}
          title={mark.title}
        >
          {mark.kind === 'ok' ? '✓' : '⚠'}
        </span>
      )}
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 12 }}>{sev?.label ?? cell.severity}</span>
    </div>
  );
}

function CompareHeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      ...cellStyle,
      background: 'var(--bg-3)',
      color: 'var(--text-3)',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      fontWeight: 600,
    }}>{children}</div>
  );
}

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
};

// ── Accessibility comparison ──────────────────────────────────────────
// A second flavour of the comparison grid. Rows are the canonical feature
// catalogue (VoiceOver, Voice Control, Larger Text, …) so the two slots
// always line up on the same axis even when one app declares fewer
// features than the other. Each cell is a simple "supports / doesn't
// claim" check — Apple's shelf doesn't expose severity tiers or
// per-category preferences, so there's no profile-aware decoration here.

function AccessibilityComparisonTable({
  a, b, refreshing,
  sourceIdForA, sourceIdForB,
  isShortlistedFor, toggleShortlistFor,
  showSlotHeaders = true,
  a11yProfile = null,
}: {
  a: SlotData; b: SlotData; refreshing: boolean;
  sourceIdForA: string | null;
  sourceIdForB: string | null;
  isShortlistedFor: (sourceId: string | null) => (candidateId: string) => boolean;
  toggleShortlistFor: (sourceId: string | null) => (c: ShortlistCandidate) => void | Promise<void>;
  /**
   * When false, suppress the per-slot header strip at the top of the a11y
   * grid. Used by the "Both" compare mode — the privacy table above already
   * carries those headers, and repeating them makes the page feel like it
   * introduces the apps twice. The summary row + grid + unfilled banner
   * still render so the table is self-contained.
   */
  showSlotHeaders?: boolean;
  /**
   * Saved accessibility profile (feature → preference tier). Drives the key
   * card above the grid + teal row chrome on rows the user cares about.
   * Null skips every profile-aware surface so legacy users see the old
   * neutral grid.
   */
  a11yProfile?: AccessibilityProfile | null;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  // Mirrors the privacy table's shortlist wiring — shortlist actions work
  // identically in either mode so users can star an alternative without
  // flipping back to the privacy view first.
  const aShortlistAction = sourceIdForA && a.id ? {
    isShortlisted: isShortlistedFor(sourceIdForA)(a.id),
    onClick: () => toggleShortlistFor(sourceIdForA)({
      appleId:   a.id,
      name:      a.name,
      developer: a.developer,
      iconUrl:   a.iconUrl,
      url:       a.url,
    }),
  } : null;
  const bShortlistAction = sourceIdForB && b.id ? {
    isShortlisted: isShortlistedFor(sourceIdForB)(b.id),
    onClick: () => toggleShortlistFor(sourceIdForB)({
      appleId:   b.id,
      name:      b.name,
      developer: b.developer,
      iconUrl:   b.iconUrl,
      url:       b.url,
    }),
  } : null;

  // Build per-slot lookup maps keyed by feature identifier. Anything the
  // developer declares lives in the map; anything missing falls through as
  // "—" below. Title from the slot wins over the canonical fallback so
  // Apple's localised wording (if any) still surfaces, but we use the
  // canonical icon so the row decoration stays consistent.
  const mapA = useMemo(
    () => new Map(a.accessibilityFeatures.map(f => [f.identifier, f])),
    [a.accessibilityFeatures],
  );
  const mapB = useMemo(
    () => new Map(b.accessibilityFeatures.map(f => [f.identifier, f])),
    [b.accessibilityFeatures],
  );

  // Canonical feature catalogue drives the row order so both the "VoiceOver
  // at the top" expectation matches what the app detail page shows. Anything
  // Apple has added that we don't know about (rare — Apple extended the
  // list in the 2025 launch without prior notice) gets tacked on at the end
  // alphabetically so nothing is dropped silently.
  const canonicalIds = CANONICAL_ACCESSIBILITY_FEATURES.map(f => f.identifier);
  const knownSet = new Set(canonicalIds);
  const union = new Set<string>([...mapA.keys(), ...mapB.keys(), ...canonicalIds]);
  const extras = [...union].filter(id => !knownSet.has(id)).sort();
  const ordered = [...canonicalIds, ...extras];

  const bothCount = ordered.filter(id => mapA.has(id) && mapB.has(id)).length;
  const onlyACount = ordered.filter(id => mapA.has(id) && !mapB.has(id)).length;
  const onlyBCount = ordered.filter(id => !mapA.has(id) && mapB.has(id)).length;

  // ── Preference plumbing ──────────────────────────────────────────────
  // Normalise the profile into a map so row-rendering can look up the
  // preference tier in O(1). Missing profile → empty map → every row
  // renders as neutral.
  const preferenceLookup = useMemo(() => {
    const map = new Map<string, AccessibilityPreference>();
    if (a11yProfile) {
      for (const [key, value] of Object.entries(a11yProfile)) {
        if (typeof value === 'string') map.set(key, value);
      }
    }
    return map;
  }, [a11yProfile]);

  // Aggregate stats for the key card — how many features at each tier the
  // user marked, and how many of those are missing from *either* app. We
  // count a feature as "missing" when neither side declares it, because
  // the Compare view is about deciding between A and B: a feature only
  // one of the two lacks still shows up in the mismatch verdict for that
  // slot via its empty cell.
  const prefStats: Record<
    AccessibilityPreference,
    { total: number; missing: number }
  > = {
    required: { total: 0, missing: 0 },
    nice: { total: 0, missing: 0 },
  };
  for (const [key, preference] of preferenceLookup) {
    prefStats[preference].total += 1;
    if (!mapA.has(key) && !mapB.has(key)) {
      prefStats[preference].missing += 1;
    }
  }
  const profileActive = preferenceLookup.size > 0;
  const totalPreferred = preferenceLookup.size;
  const totalMissingPreferred = prefStats.required.missing + prefStats.nice.missing;

  // Per-slot empty-state flavour. `null` = shelf absent (we couldn't tell
  // because the slot was never scraped for a11y — legacy tracked rows fall
  // into this). `0` = developer filed the shelf with nothing listed, which
  // we surface as a neutral yellow chip rather than the green "No data
  // collected" privacy chip — declaring *zero* accessibility features is
  // not good news the way declaring zero privacy categories is.
  type A11yStatus = 'labeled' | 'none' | 'unknown';
  const statusOf = (slot: SlotData): A11yStatus => {
    if (slot.accessibilityFeatures.length > 0) return 'labeled';
    if (slot.hasAccessibilityLabels === 0) return 'none';
    return 'unknown';
  };
  const aStatus = statusOf(a);
  const bStatus = statusOf(b);

  return (
    <div>
      {showSlotHeaders && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
          <AccessibilitySlotHeader slot={a} status={aStatus} shortlistAction={aShortlistAction} />
          <AccessibilitySlotHeader slot={b} status={bStatus} shortlistAction={bShortlistAction} />
        </div>
      )}

      {/* Preference key — only when the user has saved an a11y profile.
          Same visual language as the detail page so users recognise the
          legend before scanning rows. */}
      {profileActive && (
        <div
          className={`a11y-profile-key a11y-profile-key-compact${
            totalMissingPreferred === 0 ? ' a11y-profile-key-match' : ''
          }`}
          role="note"
          aria-label={tCompare('your_a11y_prefs_aria')}
          style={{ marginBottom: 10 }}
        >
          <div className="a11y-profile-key-header">
            <span className="a11y-profile-key-eyebrow">
              Your accessibility preferences
            </span>
            <span className="a11y-profile-key-summary">
              {totalMissingPreferred === 0 ? (
                <>
                  All {totalPreferred} preferred feature
                  {totalPreferred === 1 ? '' : 's'} covered by at least one
                  app
                </>
              ) : (
                <>
                  {totalMissingPreferred} of {totalPreferred} missing from
                  both apps
                </>
              )}
            </span>
          </div>
          <div className="a11y-profile-key-tiers">
            {prefStats.required.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-required">
                <span className="a11y-profile-key-swatch" aria-hidden="true" />
                <strong>{prefStats.required.total}</strong>{' '}
                {A11Y_PREFERENCE_META.required.label.toLowerCase()}
                {prefStats.required.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    · {prefStats.required.missing} missing both sides
                  </span>
                )}
              </span>
            )}
            {prefStats.nice.total > 0 && (
              <span className="a11y-profile-key-tier a11y-profile-key-tier-nice">
                <span className="a11y-profile-key-swatch" aria-hidden="true" />
                <strong>{prefStats.nice.total}</strong>{' '}
                {A11Y_PREFERENCE_META.nice.label.toLowerCase()}
                {prefStats.nice.missing > 0 && (
                  <span className="a11y-profile-key-tier-missing">
                    · {prefStats.nice.missing} missing both sides
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="a11y-profile-key-hint">
            Rows you marked are outlined in teal —{' '}
            <Link href="/dashboard/settings#accessibility-profile">
              edit your profile in Settings
            </Link>
            .
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--text-3)', marginBottom: 10, alignItems: 'center' }}>
        <span>{bothCount} shared</span>
        <span>{onlyACount} only in {a.name}</span>
        <span>{onlyBCount} only in {b.name}</span>
        {refreshing && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 'auto',
              padding: '3px 10px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--blue, #0a84ff) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--blue, #0a84ff) 35%, transparent)',
              color: 'var(--blue, #0a84ff)',
              fontWeight: 600,
            }}
            aria-live="polite"
          >
            <span className="spinner-sm" /> Updating comparison…
          </span>
        )}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1fr) 1fr 1fr',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        fontSize: 13,
      }}>
        <CompareHeaderCell>{tCompare('header_a11y_feature')}</CompareHeaderCell>
        <CompareHeaderCell>{a.name}</CompareHeaderCell>
        <CompareHeaderCell>{b.name}</CompareHeaderCell>
        {ordered.map((featureId, i) => {
          const canonical = CANONICAL_ACCESSIBILITY_FEATURES.find(f => f.identifier === featureId);
          const inA = mapA.get(featureId);
          const inB = mapB.get(featureId);
          // Title priority: what the developer declared → canonical title
          // → raw identifier. Same rule on both sides so wording stays
          // symmetric even if one side is missing.
          const title = inA?.title ?? inB?.title ?? canonical?.title ?? featureId;
          const description =
            inA?.description ?? inB?.description ?? canonical?.fallbackDescription ?? '';
          const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';
          const preference = preferenceLookup.get(featureId) ?? null;
          // The three cells of a preferred row need to stitch into one
          // visual outline. Each cell owns its side of the border; the
          // middle cell only contributes top + bottom. We use solid for
          // "required" and dashed for "nice" so the two tiers read as
          // visually distinct.
          const prefBorderStyle = preference === 'nice' ? 'dashed' : 'solid';
          const prefBorderColor =
            preference === 'nice'
              ? 'color-mix(in srgb, var(--teal, #40c8c8) 75%, transparent)'
              : 'var(--teal, #40c8c8)';
          const prefCellShared: React.CSSProperties = preference
            ? {
                borderTop: `2px ${prefBorderStyle} ${prefBorderColor}`,
                borderBottom: `2px ${prefBorderStyle} ${prefBorderColor}`,
              }
            : {};
          const prefLabelCell: React.CSSProperties = preference
            ? { ...prefCellShared, borderLeft: `2px ${prefBorderStyle} ${prefBorderColor}` }
            : {};
          const prefRightmostCell: React.CSSProperties = preference
            ? { ...prefCellShared, borderRight: `2px ${prefBorderStyle} ${prefBorderColor}` }
            : {};
          return (
            <div key={featureId} style={{ display: 'contents' }}>
              <div
                style={{
                  ...cellStyle,
                  background: rowBg,
                  color: 'var(--text-2)',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  ...prefLabelCell,
                }}
                title={description || undefined}
              >
                <AccessibilityFeatureIcon
                  templateA={inA?.iconTemplate ?? null}
                  templateB={inB?.iconTemplate ?? null}
                  canonical={canonical ?? null}
                  alt={title}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--text)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>{title}</span>
                    {preference && (
                      <span
                        className={`a11y-feature-pref-chip a11y-feature-pref-chip-${preference}`}
                        title={A11Y_PREFERENCE_META[preference].description}
                      >
                        {A11Y_PREFERENCE_META[preference].shortLabel}
                      </span>
                    )}
                  </div>
                  {description && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.35 }}>
                      {description}
                    </div>
                  )}
                </div>
              </div>
              <AccessibilityCell
                feature={inA ?? null}
                bg={rowBg}
                preferenceBorderStyle={prefCellShared}
                preferenceMissing={!!preference && !inA}
                preference={preference}
              />
              <AccessibilityCell
                feature={inB ?? null}
                bg={rowBg}
                preferenceBorderStyle={prefRightmostCell}
                preferenceMissing={!!preference && !inB}
                preference={preference}
              />
            </div>
          );
        })}
      </div>

      {/* Empty-state banner covers two distinct "no data" shapes:
            - 'unknown' → we haven't got the shelf at all (legacy row / preview
              couldn't resolve it). Surface as "labels aren't available — sync
              to refresh" because the user CAN do something about it.
            - 'none'    → developer *did* file the shelf but declared zero
              supported features. There's nothing to sync; surface the verdict
              plainly so the user sees "this app declares no accessibility
              features" instead of an all-dashes grid that looks like a bug.
          Rendered per-slot so both sides can have different states — e.g.
          App A has features, App B declared nothing. */}
      {(aStatus !== 'labeled' || bStatus !== 'labeled') && (
        <div
          className="compare-unfilled-banner"
          role="status"
          style={{ marginTop: 12 }}
        >
          <span aria-hidden="true" className="compare-unfilled-banner-icon">ℹ️</span>
          <div className="compare-unfilled-banner-body">
            {aStatus !== 'labeled' && (
              <div style={{ marginBottom: bStatus !== 'labeled' ? 8 : 0 }}>
                <div className="compare-unfilled-banner-title">
                  {aStatus === 'none'
                    ? tCompare('a11y_unfilled_no_features_title', { name: a.name })
                    : tCompare('a11y_unfilled_unavailable_title', { name: a.name })}
                </div>
                <div className="compare-unfilled-banner-detail">
                  {aStatus === 'none'
                    ? tCompare('a11y_unfilled_no_features_left_short')
                    : tCompare('a11y_unfilled_unavailable_short')}
                </div>
              </div>
            )}
            {bStatus !== 'labeled' && (
              <div>
                <div className="compare-unfilled-banner-title">
                  {bStatus === 'none'
                    ? tCompare('a11y_unfilled_no_features_title', { name: b.name })
                    : tCompare('a11y_unfilled_unavailable_title', { name: b.name })}
                </div>
                <div className="compare-unfilled-banner-detail">
                  {bStatus === 'none'
                    ? tCompare('a11y_unfilled_no_features_right_short')
                    : tCompare('a11y_unfilled_unavailable_short')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Slot header for the accessibility grid. Mirrors `SlotHeader` structurally
 * (icon, name, developer, source pill, shortlist action) but swaps the
 * privacy-oriented empty-state chips for accessibility-oriented ones so the
 * language matches what the user sees in the grid below.
 */
function AccessibilitySlotHeader({
  slot,
  status,
  shortlistAction,
}: {
  slot: SlotData;
  status: 'labeled' | 'none' | 'unknown';
  shortlistAction?: { isShortlisted: boolean; onClick: () => void } | null;
}) {
  // i18n — translations for chips/aria within this helper.
  const tCompare = useTranslations('compare');
  // On the Accessibility tab, the footer chip *is* the a11y summary for
  // this slot — density count when the developer filed features, a warn
  // chip for empty shelves, a muted chip for missing ones. Keeping all
  // three in the same footer slot means every header card is one
  // consistent silhouette regardless of status.
  const chip =
    status === 'labeled'
    ? <AccessibilityCountChip slot={slot} />
    : status === 'none'
    ? (
      <span className="compare-slot-chip compare-slot-chip-warn" title={tCompare('a11y_filed_no_features_title')}>
        <span aria-hidden="true">⚠</span>
        No accessibility features declared
      </span>
    )
    : (
      <span className="compare-slot-chip-muted" title={tCompare('a11y_shelf_absent_title')}>
        No accessibility data on file
      </span>
    );

  return (
    <div className={`compare-slot-header${status === 'none' ? ' compare-slot-header-warn' : ''}${status === 'labeled' ? ' compare-slot-header-a11y-ok' : ''}`}>
      <div className="compare-slot-header-row">
        {slot.iconUrl ? (
          <Image
            src={slot.iconUrl}
            alt={slot.name}
            width={40}
            height={40}
            style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
            unoptimized
          />
        ) : <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--bg-3)', flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.developer || '—'}</div>
        </div>
        {shortlistAction && (
          <button
            type="button"
            onClick={shortlistAction.onClick}
            aria-pressed={shortlistAction.isShortlisted}
            title={shortlistAction.isShortlisted
              ? tCompare('remove_from_shortlist_long')
              : tCompare('save_alternative_long')}
            className={`compare-shortlist-btn compare-shortlist-btn-header${shortlistAction.isShortlisted ? ' is-saved' : ''}`}
          >
            {shortlistAction.isShortlisted ? tCompare('shortlist_saved') : tCompare('shortlist_add')}
          </button>
        )}
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 999,
          background: slot.source === 'library' ? 'rgba(10,132,255,0.18)' : 'rgba(191,90,242,0.18)',
          color: slot.source === 'library' ? '#5ea9ff' : '#d28bff',
        }}>
          {slot.source === 'library' ? tCompare('slot_label_tracked') : tCompare('slot_label_preview')}
        </span>
      </div>
      {chip && (
        <div className="compare-slot-header-empty">
          {chip}
        </div>
      )}
    </div>
  );
}

/**
 * Compact "6/9 a11y" chip shown in the slot-header footer row alongside the
 * other empty-state chips ("No details provided", "No data collected", etc.)
 * so every reason-for-this-slot pill sits on the same visual tier. Rendered
 * in both comparison modes so the a11y density of a previewed App Store app
 * is visible at a glance, without the user having to flip over to the
 * Accessibility tab first. Only appears when the developer has *declared*
 * features — `hasAccessibilityLabels === 0` means the shelf is present but
 * empty (its own "No accessibility features declared" chip takes the slot),
 * and `null` means the shelf is absent (can't count what we don't have).
 * Denominator = `CANONICAL_ACCESSIBILITY_FEATURES.length` (currently 9),
 * matching the feature count the stats chart uses.
 *
 * Icon: a person figure rather than the wheelchair symbol, matching Apple's
 * modern accessibility glyph (the "figure" SF Symbol) — accessibility isn't
 * only mobility, and the nutrition-labels shelf spans vision, hearing, and
 * cognition too, so a generic person reads more honestly here.
 */
function AccessibilityCountChip({ slot }: { slot: SlotData }) {
  if (slot.hasAccessibilityLabels !== 1) return null;
  const declared = slot.accessibilityFeatures.length;
  const total = CANONICAL_ACCESSIBILITY_FEATURES.length;
  // If Apple adds a feature we don't know about, the declared count can
  // exceed the canonical count — show the bigger number as the denominator
  // so the chip never reads "11/9". The Accessibility grid already appends
  // those extras as extra rows, so it lines up with what's rendered below.
  const displayTotal = Math.max(declared, total);
  return (
    <span
      className="compare-slot-chip compare-slot-chip-a11y"
      title={`Declares ${declared} of ${displayTotal} accessibility features`}
      aria-label={`${declared} of ${displayTotal} accessibility features declared`}
    >
      <span aria-hidden="true">🧍</span>
      {declared}/{displayTotal}
    </span>
  );
}

/**
 * Per-cell accessibility rendering. Present features get a ✓ plus the blue
 * "Supported" pill we reuse from the a11y filter on the apps grid; absent
 * features get a muted em-dash so missing rows read as explicit gaps
 * rather than "we didn't scrape it".
 */
/**
 * Small icon rendered in the label column of the accessibility grid so each
 * feature row carries the same visual mark Apple ships on the App Store
 * listing. Prefers the live artwork URL captured by the scraper (either
 * slot will do — the template is identical per feature) and falls back to
 * a canonical emoji when the template is missing or points at an SF Symbol
 * pseudo-URI. Sized to match the row's leading line height so the title
 * baseline doesn't jump when the icon is present vs. absent.
 */
function AccessibilityFeatureIcon({
  templateA,
  templateB,
  canonical,
  alt,
}: {
  templateA: string | null;
  templateB: string | null;
  canonical: CanonicalAccessibilityFeature | null;
  alt: string;
}) {
  const url =
    resolveAppleArtworkUrl(templateA) ??
    resolveAppleArtworkUrl(templateB) ??
    null;
  const emoji = canonical?.fallbackEmoji ?? '•';
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        marginTop: 1,
        fontSize: 15,
        flex: '0 0 auto',
        color: 'var(--text-2)',
      }}
    >
      {url ? (
        // Tiny 20×20 favicon — next/image is overkill for this size and
        // would add wrapper markup. Same pattern used elsewhere in the
        // file (see the other eslint-disable above).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          width={20}
          height={20}
          style={{ display: 'block' }}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span>{emoji}</span>
      )}
    </span>
  );
}

function AccessibilityCell({
  feature, bg,
  preferenceBorderStyle,
  preferenceMissing,
  preference,
}: {
  feature: AccessibilityFeature | null;
  bg: string;
  /**
   * Extra border rules stitched together by the row so all three cells
   * share one visual outline when the user marked the feature in their
   * profile. Empty object when no preference.
   */
  preferenceBorderStyle?: React.CSSProperties;
  /**
   * `true` when the user marked this feature AND this slot doesn't declare
   * it. We use it to nudge the empty-state copy from a generic "—" to a
   * more pointed "missing" hint so the gap is obvious inline.
   */
  preferenceMissing?: boolean;
  /** User's preference tier for this feature; null when unset. */
  preference?: AccessibilityPreference | null;
}) {
  const tCompare = useTranslations('compare');
  const border = preferenceBorderStyle ?? {};
  // Required-but-missing cells also pick up a subtle orange text tint so
  // the inline "Missing" chip reads as a flag instead of a neutral dash.
  // Nice-to-have missing stays in the quiet grey track — the whole point
  // of that tier is "nudge, not flag".
  const flagMissing = preferenceMissing && preference === 'required';
  if (!feature) {
    return (
      <div
        style={{
          ...cellStyle,
          background: bg,
          color: flagMissing ? 'var(--orange, #ff9500)' : 'var(--text-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          ...border,
        }}
      >
        {preferenceMissing ? (
          <>
            <span aria-hidden="true">⚠</span>
            <span>Missing {preference === 'required' ? '(required)' : '(nice-to-have)'}</span>
          </>
        ) : (
          <span>—</span>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        ...cellStyle,
        background: bg,
        color: 'var(--text)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        ...border,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--blue, #0a84ff)', display: 'inline-block',
        }}
      />
      <span style={{ fontSize: 12 }}>{tCompare('a11y_declares_support')}</span>
    </div>
  );
}
