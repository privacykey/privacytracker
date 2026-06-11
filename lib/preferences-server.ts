/**
 * Server-only translation shim between the legacy `user_intent` enum and the
 * `flag.focus.audience` + `flag.focus.goal.*` keys. Always import from this
 * file inside API routes and server components; never from a client
 * component.
 *
 * Mapping legacy enum ← focus state:
 *   - audience=guardian          → 'family'
 *   - audience=self + understand+declutter → 'hygiene'
 *   - audience=self + declutter  → 'cleanup'
 *   - audience=self + understand → 'curious' (also the safe default)
 */

import { isUserIntent, type UserIntent } from "./preferences";
import { getSetting, setSetting } from "./scheduler";

/** Legacy single-key — read-only fallback for pre-migration installs. */
const LEGACY_KEY = "user_intent";

/**
 * Returns the saved intent, or `null` if the user hasn't chosen one yet.
 * Reads the focus keys and translates back to the legacy enum; falls back
 * to the `user_intent` key on pre-migration installs.
 */
export function getUserIntent(): UserIntent | null {
  const audience = getSetting("flag.focus.audience", "");
  if (audience) {
    if (audience === "guardian") {
      return "family";
    }
    if (audience === "loved_one") {
      return "curious";
    }
    const understand = getSetting("flag.focus.goal.understand") === "true";
    const declutter = getSetting("flag.focus.goal.declutter") === "true";
    const minimal = getSetting("flag.focus.goal.minimal") === "true";
    if (minimal) {
      return "curious";
    }
    if (understand && declutter) {
      return "hygiene";
    }
    if (declutter) {
      return "cleanup";
    }
    if (understand) {
      return "curious";
    }
    return "curious";
  }

  const raw = getSetting(LEGACY_KEY, "");
  return isUserIntent(raw) ? raw : null;
}

/**
 * Write-through to both the legacy key and the new audience+goals keys.
 */
export function setUserIntent(value: UserIntent): void {
  setSetting(LEGACY_KEY, value);
  switch (value) {
    case "curious":
      setSetting("flag.focus.audience", "self");
      setSetting("flag.focus.goal.understand", "true");
      setSetting("flag.focus.goal.declutter", "false");
      setSetting("flag.focus.goal.minimal", "false");
      setSetting("flag.focus.workflow", "self_monitor");
      break;
    case "cleanup":
      setSetting("flag.focus.audience", "self");
      setSetting("flag.focus.goal.understand", "false");
      setSetting("flag.focus.goal.declutter", "true");
      setSetting("flag.focus.goal.minimal", "false");
      setSetting("flag.focus.workflow", "self_cleanup");
      break;
    case "hygiene":
      setSetting("flag.focus.audience", "self");
      setSetting("flag.focus.goal.understand", "true");
      setSetting("flag.focus.goal.declutter", "true");
      setSetting("flag.focus.goal.minimal", "false");
      setSetting("flag.focus.workflow", "custom");
      break;
    case "family":
      setSetting("flag.focus.audience", "guardian");
      setSetting("flag.focus.goal.understand", "true");
      setSetting("flag.focus.goal.declutter", "false");
      setSetting("flag.focus.goal.minimal", "false");
      setSetting("flag.focus.workflow", "custom");
      break;
  }
}

/** Clears the saved intent and audience so the next dashboard hit routes
 *  back through /welcome. */
export function clearUserIntent(): void {
  setSetting(LEGACY_KEY, "");
  setSetting("flag.focus.audience", "");
  setSetting("flag.focus.workflow", "");
}

// ── Dashboard banner dismissal ──────────────────────────────────────────
// The "consider adding manual apps" banner stays visible until the user
// dismisses it. Stored as a timestamp string so callers can tell when it
// was dismissed, not just whether.

const MANUAL_APPS_BANNER_DISMISSED_KEY = "manual_apps_banner_dismissed_at";

export function getManualAppsBannerDismissed(): boolean {
  const raw = getSetting(MANUAL_APPS_BANNER_DISMISSED_KEY, "");
  return raw.trim() !== "";
}

export function setManualAppsBannerDismissed(dismissed: boolean): void {
  setSetting(
    MANUAL_APPS_BANNER_DISMISSED_KEY,
    dismissed ? String(Date.now()) : ""
  );
}
