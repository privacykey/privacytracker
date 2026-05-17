/**
 * Editable home-dashboard layout — pure types, canonical order, and
 * named presets.
 *
 * Mirrors the preset pattern in `lib/privacy-profile.ts` so the UX
 * (preset pills + active-match round-trip + activity-log transitions)
 * stays consistent across the app's "customisable bundle" features.
 *
 * Two axes drive what a user sees on `/dashboard`:
 *
 *   1. `flag.dashboard.<id>` — capability-level: "is this card available
 *      for your audience/goal?" Resolved via the focus chain
 *      (HARD_DEFAULTS → AUDIENCE_RULES → GOAL_RULES → ACCESSIBILITY → user
 *      override) in `lib/feature-flags.ts`.
 *
 *   2. `DashboardLayout` (this file) — preference-level: "given the cards
 *      available to me, which order and which hidden?" Stored in
 *      `app_settings` as a single JSON row keyed `dashboard.layout`.
 *
 * A card renders iff:
 *   `flag === 'on'` AND `!layout.hidden.includes(id)` AND (for callouts)
 *   `dataPredicate === true`
 *
 * Keeping the axes separate means a user who hides "Activity" then switches
 * focus from `self/curious` to `loved_one/family` keeps their personal
 * "Activity hidden" choice but picks up the family-callout cards that the
 * focus brings on. Conversely, a flag that goes 'off' for an audience hides
 * the card regardless of saved preference (capability gate wins).
 *
 * Callouts (Cleanup / Family / Third-party / Definitions / Manual-Apps
 * banner) are listed in the order array so users can move them up/down,
 * but their visibility stays rule-driven — they only paint when their
 * data condition is met. The editor presents them as reorder-only rows.
 */

export type DashboardCardId =
  | "task_list"
  | "review_cta"
  | "focus_strip"
  | "background_mode_wizard"
  | "risk_section"
  | "hero"
  | "cleanup_callout"
  | "family_callout"
  | "third_party_callout"
  | "glance_section"
  | "definitions_callout"
  | "review_section"
  | "profile_mismatch_section"
  | "stale_section"
  | "activity_section"
  | "risk_tier_legend"
  | "manual_apps_banner";

/**
 * Cards whose visibility the user can toggle in the editor. Auto-managed
 * callouts (CALLOUT_CARDS below) are excluded — the editor still lists
 * them so they can be reordered, but their checkbox is greyed out.
 *
 * Note: `definitions_callout` used to be in CALLOUT_CARDS (auto-managed
 * by `flag.dashboard.callout.understand_only`), but users reasonably
 * want to mute it even when their focus enables it — so it moved here.
 * The flag is still a capability gate: if it's `off` the card never
 * renders regardless of the user's hidden[] choice.
 */
export const FIRST_CLASS_CARDS = new Set<DashboardCardId>([
  "task_list",
  "review_cta",
  "focus_strip",
  "background_mode_wizard",
  "risk_section",
  "hero",
  "glance_section",
  "definitions_callout",
  "review_section",
  "profile_mismatch_section",
  "stale_section",
  "activity_section",
  "risk_tier_legend",
]);

export const CALLOUT_CARDS = new Set<DashboardCardId>([
  "manual_apps_banner",
  "cleanup_callout",
  "family_callout",
  "third_party_callout",
]);

/**
 * Authoritative ordering when no user layout exists. Matches the
 * top-down render order in `app/components/HomeView.tsx`. When future
 * cards land, append them here in their semantic position and
 * `reconcileLayout` will slot them next to that neighbour for users
 * with existing saved layouts.
 *
 * `manual_apps_banner` lives at the bottom — it's a low-priority
 * "did you know you can also track…" prompt that should never push
 * actionable content (risk / hero / review) below the fold.
 */
export const CANONICAL_ORDER: readonly DashboardCardId[] = [
  "task_list",
  "review_cta",
  "focus_strip",
  "background_mode_wizard",
  "risk_section",
  "hero",
  "cleanup_callout",
  "family_callout",
  "third_party_callout",
  "glance_section",
  "definitions_callout",
  "review_section",
  "profile_mismatch_section",
  "stale_section",
  "activity_section",
  "risk_tier_legend",
  "manual_apps_banner",
];

const CANONICAL_SET: ReadonlySet<DashboardCardId> = new Set(CANONICAL_ORDER);

export interface DashboardLayout {
  /**
   * First-class cards the user has hidden. Callouts ignore this set —
   * their visibility is data-driven. Stored as an array (not a Set) so
   * the layout is trivially JSON-roundtrippable.
   */
  hidden: DashboardCardId[];
  order: DashboardCardId[];
  v: 1;
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  v: 1,
  order: [...CANONICAL_ORDER],
  hidden: [],
};

// ─────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────

export const DASHBOARD_PRESET_KEYS = [
  "default",
  "minimal",
  "caretaker",
  "watchdog",
  "at_a_glance",
] as const;

export type DashboardPresetKey = (typeof DASHBOARD_PRESET_KEYS)[number];

export interface DashboardPresetMeta {
  description: string;
  /** Single-character emoji shown inside the preset pill. */
  icon: string;
  key: DashboardPresetKey;
  label: string;
  /** Reused severity class for the active-pill accent. */
  severityCls: string;
  shortLabel: string;
}

export const DASHBOARD_PRESET_META: Record<
  DashboardPresetKey,
  DashboardPresetMeta
> = {
  default: {
    key: "default",
    label: "Default",
    shortLabel: "Default",
    description:
      "The canonical order with every card visible. A safe baseline.",
    icon: "🏠",
    severityCls: "severity-unlinked",
  },
  minimal: {
    key: "minimal",
    label: "Minimal",
    shortLabel: "Minimal",
    description:
      "Just the essentials — hero, risk, review, and at-a-glance stats.",
    icon: "🪶",
    severityCls: "severity-none",
  },
  caretaker: {
    key: "caretaker",
    label: "Caretaker",
    shortLabel: "Caretaker",
    description:
      "Family-focused. Surface privacy concerns and review queue first.",
    icon: "🫶",
    severityCls: "severity-linked",
  },
  watchdog: {
    key: "watchdog",
    label: "Watchdog",
    shortLabel: "Watchdog",
    description:
      "Risk-first. Quickly spot the apps you might want to replace or sync.",
    icon: "🕵️",
    severityCls: "severity-track",
  },
  at_a_glance: {
    key: "at_a_glance",
    label: "At a glance",
    shortLabel: "At a glance",
    description:
      "Stats up top. For users who want the high-level picture first.",
    icon: "📊",
    severityCls: "severity-unlinked",
  },
};

/**
 * Build a preset by listing only the first-class cards you want visible
 * (in display order). Callouts are appended in their CANONICAL_ORDER
 * positions — they're reorder-only so the preset doesn't really pick
 * "the right" order for them, just slots them near their neighbours.
 * All omitted first-class cards land in `hidden`.
 */
function buildPreset(visibleFirstClass: DashboardCardId[]): DashboardLayout {
  const visibleSet = new Set(visibleFirstClass);
  // Order: user-chosen first-class cards (in the order given), then any
  // omitted first-class cards (in CANONICAL_ORDER, to keep "Show all"
  // toggles intuitive), with callouts interleaved at their canonical
  // positions to keep "near their semantic neighbour".
  const order: DashboardCardId[] = [];
  const consumed = new Set<DashboardCardId>();

  for (const id of visibleFirstClass) {
    if (!CANONICAL_SET.has(id)) {
      continue;
    }
    order.push(id);
    consumed.add(id);
    // Drop any callouts whose canonical position is immediately before
    // this card and haven't landed yet — they slot in just before.
    // Simpler approach: do a single cleanup pass below.
  }

  // Append any callouts and remaining first-class cards in canonical
  // order, preserving the visible first-class ordering the caller chose.
  // We rebuild: for each canonical id not yet in order, append.
  for (const id of CANONICAL_ORDER) {
    if (consumed.has(id)) {
      continue;
    }
    order.push(id);
    consumed.add(id);
  }

  const hidden: DashboardCardId[] = [];
  for (const id of FIRST_CLASS_CARDS) {
    if (!visibleSet.has(id)) {
      hidden.push(id);
    }
  }
  // Stable order for the hidden array (canonical order) so two equivalent
  // presets serialise identically and `matchDashboardPreset` round-trips.
  hidden.sort(
    (a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b)
  );

  return { v: 1, order, hidden };
}

export const DASHBOARD_PRESETS: Record<DashboardPresetKey, DashboardLayout> = {
  default: {
    v: 1,
    order: [...CANONICAL_ORDER],
    hidden: [],
  },
  // `review_cta` lands near the top of every non-default preset — it's
  // the "you have N apps that need a decision" CTA and we never want
  // it buried under presentation cards.
  minimal: buildPreset([
    "review_cta",
    "hero",
    "risk_section",
    "review_section",
    "glance_section",
  ]),
  caretaker: buildPreset([
    "review_cta",
    "risk_section",
    "profile_mismatch_section",
    "review_section",
    "activity_section",
    "glance_section",
    "hero",
    "task_list",
    "focus_strip",
  ]),
  watchdog: buildPreset([
    "review_cta",
    "risk_section",
    "profile_mismatch_section",
    "stale_section",
    "activity_section",
    "review_section",
    "hero",
    "focus_strip",
    "glance_section",
  ]),
  at_a_glance: buildPreset([
    "review_cta",
    "glance_section",
    "hero",
    "review_section",
    "activity_section",
    "risk_section",
    "focus_strip",
  ]),
};

// ─────────────────────────────────────────────
// Matching + reconciliation
// ─────────────────────────────────────────────

/**
 * Normalise a layout so equivalent shapes serialise identically. Used
 * before equality comparison in `matchDashboardPreset`.
 *
 *   - `order` is left as-is (order is meaningful).
 *   - `hidden` is sorted in CANONICAL_ORDER so [a,b] and [b,a] match.
 *   - Duplicates are dropped from both.
 */
function normaliseLayout(layout: DashboardLayout): DashboardLayout {
  const seenOrder = new Set<DashboardCardId>();
  const order = layout.order.filter((id) => {
    if (seenOrder.has(id)) {
      return false;
    }
    seenOrder.add(id);
    return true;
  });
  const seenHidden = new Set<DashboardCardId>();
  const hidden = layout.hidden
    .filter((id) => {
      if (!FIRST_CLASS_CARDS.has(id)) {
        return false;
      }
      if (seenHidden.has(id)) {
        return false;
      }
      seenHidden.add(id);
      return true;
    })
    .sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b));
  return { v: 1, order, hidden };
}

function layoutsEqual(a: DashboardLayout, b: DashboardLayout): boolean {
  const an = normaliseLayout(a);
  const bn = normaliseLayout(b);
  if (an.order.length !== bn.order.length) {
    return false;
  }
  for (let i = 0; i < an.order.length; i += 1) {
    if (an.order[i] !== bn.order[i]) {
      return false;
    }
  }
  if (an.hidden.length !== bn.hidden.length) {
    return false;
  }
  for (let i = 0; i < an.hidden.length; i += 1) {
    if (an.hidden[i] !== bn.hidden[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Return the preset key whose layout exactly matches the supplied one,
 * or null if the layout is customised. Used by the editor to highlight
 * the active preset pill — picking a preset and then editing a single
 * card drops the highlight, signalling "this is now custom".
 */
export function matchDashboardPreset(
  layout: DashboardLayout | null | undefined
): DashboardPresetKey | null {
  if (!layout) {
    return null;
  }
  for (const key of DASHBOARD_PRESET_KEYS) {
    if (layoutsEqual(layout, DASHBOARD_PRESETS[key])) {
      return key;
    }
  }
  return null;
}

/**
 * Bring a stored layout into agreement with the current canonical card
 * set. Used on every read so existing installs continue to work after a
 * release that adds or removes a card.
 *
 *   - Drop ids no longer in CANONICAL_ORDER (deprecated cards).
 *   - Append any CANONICAL_ORDER ids missing from `order`, slotting each
 *     next to its CANONICAL_ORDER neighbour rather than at the end.
 *   - New cards default to visible (NOT hidden) — opt-out is more
 *     discoverable than opt-in.
 *   - Strip any hidden-set entries that don't refer to first-class cards.
 */
export function reconcileLayout(
  stored: unknown,
  canonical: readonly DashboardCardId[] = CANONICAL_ORDER
): DashboardLayout {
  // Best-effort decode. Any malformed input falls through to DEFAULT_LAYOUT.
  if (!stored || typeof stored !== "object") {
    return { v: 1, order: [...canonical], hidden: [] };
  }
  const s = stored as Partial<DashboardLayout>;
  const canonicalSet = new Set(canonical);

  // Existing order: keep known ids in the user's order, drop unknowns.
  const known = (Array.isArray(s.order) ? s.order : []).filter(
    (id): id is DashboardCardId =>
      typeof id === "string" && canonicalSet.has(id as DashboardCardId)
  );
  // De-duplicate while preserving the user's first occurrence.
  const seen = new Set<DashboardCardId>();
  const orderedKnown: DashboardCardId[] = [];
  for (const id of known) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    orderedKnown.push(id);
  }

  // For each canonical id missing from the user's order, slot it next to
  // its previous canonical neighbour if that neighbour is present, else
  // append at the tail. Iterate canonical so "neighbour" is well-defined.
  const out: DashboardCardId[] = [...orderedKnown];
  for (const id of canonical) {
    if (seen.has(id)) {
      continue;
    }
    // Find this id's index in canonical, then the closest preceding
    // canonical neighbour that already exists in `out`.
    let inserted = false;
    const cIdx = canonical.indexOf(id);
    for (let i = cIdx - 1; i >= 0; i -= 1) {
      const neighbour = canonical[i];
      const at = out.indexOf(neighbour);
      if (at >= 0) {
        out.splice(at + 1, 0, id);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      out.unshift(id);
    }
    seen.add(id);
  }

  const hidden = (Array.isArray(s.hidden) ? s.hidden : []).filter(
    (id): id is DashboardCardId =>
      typeof id === "string" && FIRST_CLASS_CARDS.has(id as DashboardCardId)
  );

  return normaliseLayout({ v: 1, order: out, hidden });
}

// ─────────────────────────────────────────────
// Activity-log transition shape
// ─────────────────────────────────────────────

export interface LayoutTransitionDescription {
  detail: {
    from: DashboardPresetKey | null;
    to: DashboardPresetKey | null;
  };
  summary: string;
}

/**
 * Compare two layouts and return an activity-log-shaped description
 * when the change crosses a preset boundary. Custom-to-custom edits
 * intentionally don't surface — the activity log is for noteworthy
 * state transitions, not per-keystroke saves.
 */
export function describeLayoutTransition(
  prev: DashboardLayout | null | undefined,
  next: DashboardLayout | null | undefined
): LayoutTransitionDescription | null {
  if (!next) {
    return null;
  }
  const fromPreset = prev ? matchDashboardPreset(prev) : null;
  const toPreset = matchDashboardPreset(next);
  if (toPreset && toPreset !== fromPreset) {
    return {
      summary: `Dashboard layout set to ${DASHBOARD_PRESET_META[toPreset].label}`,
      detail: { from: fromPreset, to: toPreset },
    };
  }
  return null;
}

/**
 * Visibility helper for callers (tour-step skippers, deep-link
 * resolvers) that need to know whether a card will actually render.
 * Capability-flag check is the caller's responsibility — pass it via
 * the optional `flagResolved` argument, otherwise we assume 'on'.
 */
export function isCardVisible(
  id: DashboardCardId,
  layout: DashboardLayout,
  flagResolved: "on" | "off" | "collapsed" | null | undefined = "on"
): boolean {
  if (flagResolved && flagResolved !== "on" && flagResolved !== "collapsed") {
    return false;
  }
  if (FIRST_CLASS_CARDS.has(id) && layout.hidden.includes(id)) {
    return false;
  }
  return true;
}
