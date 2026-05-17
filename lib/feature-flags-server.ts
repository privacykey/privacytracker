/**
 * Server-only feature-flag helpers. Kept separate from `lib/feature-flags.ts`
 * so better-sqlite3 (via `lib/feature-flag-storage.ts`) stays out of client
 * bundles. Client components use `lib/feature-flags-hooks.ts` instead.
 */

import "server-only";

import type { FlagKey, FlagValue } from "./feature-flag-rules";
import { HARD_DEFAULTS } from "./feature-flag-rules";
import { getActiveFocus, getAllOverrides } from "./feature-flag-storage";
import { type ResolverContext, resolveFlag } from "./feature-flags";
import { getSetting } from "./scheduler";

/**
 * Build a ResolverContext from the live SQLite state. Each call hits the DB
 * (no server-side cache).
 *
 *   const ctx = getResolverContextFromDb();
 *   if (resolveFlag('flag.page.compare', ctx) !== 'on') return null;
 */
export function getResolverContextFromDb(): ResolverContext {
  const focus = getActiveFocus();
  const overrides = getAllOverrides();
  const killSwitchOff =
    (overrides.get("flag.devopts.feature_flag_system.enabled") ??
      HARD_DEFAULTS["flag.devopts.feature_flag_system.enabled"]) === "off";
  const runtimeEnvironment =
    getSetting("runtime_environment", "") === "desktop" ||
    process.env.PRIVACYTRACKER_RUNTIME === "desktop"
      ? "desktop"
      : undefined;
  return { focus, overrides, killSwitchOff, runtimeEnvironment };
}

/**
 * Convenience: resolve a single flag from the live DB state in one call.
 * Equivalent to `resolveFlag(key, getResolverContextFromDb())`.
 */
export function resolveFlagFromDb(key: FlagKey): FlagValue {
  return resolveFlag(key, getResolverContextFromDb());
}
