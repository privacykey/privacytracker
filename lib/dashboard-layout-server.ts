/**
 * Server-only helpers for the editable home-dashboard layout. Stores
 * the JSON-encoded layout as a single `app_settings` row keyed
 * `dashboard.layout`. Pure-data helpers (preset matching, reconcile,
 * transition descriptions) live in `lib/dashboard-layout.ts` so client
 * components can import them without dragging the SQLite layer in.
 *
 * Mirrors the split used by `lib/privacy-profile-server.ts` /
 * `lib/privacy-profile.ts`.
 */

// `server-only` not used here — this codebase relies on the `-server.ts`
// filename convention plus DB imports to keep the module out of the
// client bundle.
import { recordActivity } from "./activity";
import {
  CANONICAL_ORDER,
  DASHBOARD_PRESETS,
  type DashboardLayout,
  type DashboardPresetKey,
  DEFAULT_LAYOUT,
  describeLayoutTransition,
  matchDashboardPreset,
  reconcileLayout,
} from "./dashboard-layout";
import { getSetting, setSetting } from "./scheduler";

const LAYOUT_SETTING_KEY = "dashboard.layout";

/**
 * Read the user's stored layout and reconcile it against the current
 * canonical card list. Always returns a usable layout — empty,
 * malformed, or missing settings fall through to DEFAULT_LAYOUT.
 */
export function getDashboardLayout(): DashboardLayout {
  const raw = getSetting(LAYOUT_SETTING_KEY, "");
  if (!raw) {
    return { ...DEFAULT_LAYOUT, order: [...CANONICAL_ORDER], hidden: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt row — bail to default. We don't clobber the row so an
    // operator can salvage it manually if needed.
    return { ...DEFAULT_LAYOUT, order: [...CANONICAL_ORDER], hidden: [] };
  }
  return reconcileLayout(parsed, CANONICAL_ORDER);
}

/**
 * Persist a layout. Caller is responsible for validation — pass through
 * `reconcileLayout` first if the input came from an untrusted source
 * (the API route does this).
 */
export function setDashboardLayout(layout: DashboardLayout): void {
  setSetting(LAYOUT_SETTING_KEY, JSON.stringify(layout));
}

/**
 * Save a layout and record a `dashboard_layout_applied` activity row
 * when the change crosses a named-preset boundary. Single chokepoint
 * for route handlers so PUT / DELETE / preset POST log consistently.
 *
 * Custom-to-custom edits (single-row tweaks inside a non-preset state)
 * intentionally don't fire — the editor saves on every keystroke and
 * we don't want the activity log to spam every reorder. See
 * `describeLayoutTransition` in lib/dashboard-layout.ts for the rule.
 */
export function saveDashboardLayoutWithLog(
  next: DashboardLayout
): DashboardLayout {
  const startedAt = Date.now();
  const previous = getDashboardLayout();
  setDashboardLayout(next);
  const transition = describeLayoutTransition(previous, next);
  if (transition) {
    recordActivity({
      type: "dashboard_layout_applied",
      status: "ok",
      summary: transition.summary,
      detail: transition.detail,
      startedAt,
    });
  }
  return next;
}

/**
 * Apply a named preset and return the resulting layout. Idempotent.
 * Goes through `saveDashboardLayoutWithLog` so a preset POST gets the
 * same activity-log treatment as a PUT.
 */
export function applyDashboardPreset(
  preset: DashboardPresetKey
): DashboardLayout {
  const layout = DASHBOARD_PRESETS[preset];
  // Defensive copy so callers can't mutate the in-memory preset table.
  const stored: DashboardLayout = {
    v: 1,
    order: [...layout.order],
    hidden: [...layout.hidden],
  };
  return saveDashboardLayoutWithLog(stored);
}

/**
 * Restore the layout to `default`. Equivalent to `applyDashboardPreset('default')`
 * but spelled out so route handlers can express intent.
 */
export function resetDashboardLayout(): DashboardLayout {
  return applyDashboardPreset("default");
}

/**
 * Convenience read used by /api/dashboard/layout GET. Returns the
 * reconciled layout alongside the active preset key (or null when the
 * user has customised away from any of the named presets).
 */
export function readDashboardLayoutWithMatch(): {
  layout: DashboardLayout;
  matchedPreset: DashboardPresetKey | null;
} {
  const layout = getDashboardLayout();
  return { layout, matchedPreset: matchDashboardPreset(layout) };
}
