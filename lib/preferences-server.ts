/**
 * Server-only dashboard preferences. Always import from this file inside
 * API routes and server components; never from a client component.
 *
 * The legacy `user_intent` archetype shim that used to live here was
 * retired once the dashboard moved entirely to the `flag.focus.audience` +
 * `flag.focus.goal.*` model — the welcome/settings purpose form is now the
 * single source of focus, and the migration in lib/migrations handles the
 * one-time `user_intent` → focus conversion for pre-migration installs.
 */

import { getSetting, setSetting } from "./scheduler";

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
