/**
 * Shared toast timing — single source of truth for every toast surface
 * (Toast, SettingsAutoSaveToast, DeviceConnectedToast) and their call
 * sites, so the three don't drift apart again.
 *
 * Keep the durations in sync with the `--toast-in-duration` /
 * `--toast-out-duration` custom properties in app/globals.css — CSS
 * can't import TS, so the contract is comment-pinned on both sides.
 */

/** Entrance animation duration (`toastIn` keyframes in globals.css). */
export const TOAST_IN_MS = 200;

/**
 * Exit animation duration (`toastOut` keyframes in globals.css).
 * Components keep the node mounted this long after content clears so
 * dismissal is symmetric with the entrance instead of a hard blink.
 */
export const TOAST_OUT_MS = 200;

/**
 * How long an auto-dismissing toast holds fully visible before fading.
 * Interactive toasts (e.g. DeviceConnectedToast's import CTA) stay until
 * dismissed instead — auto-hiding an actionable surface strands users
 * who read slowly or were mid-reach for the button.
 */
export const TOAST_HOLD_MS = 5000;
