/**
 * Feature flag system — resolver + registry (server-safe; no React imports).
 * Companion to `lib/feature-flag-rules.ts` (rule tables).
 * Server: import `resolveFlag` here + `getResolverContextFromDb` from
 * `lib/feature-flags-server.ts`. Client: use `lib/feature-flags-hooks.ts`.
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags
 */

import {
  AUDIENCE_RULES,
  ACCESSIBILITY_RULES,
  FLAG_DEPENDENCIES,
  GOAL_RULES,
  HARD_DEFAULTS,
  TOUR_STEPS,
  activeGoalsFrom,
  type Audience,
  type FlagKey,
  type FlagValue,
  type FocusState,
  type Modifier,
  type PrimaryGoal,
} from './feature-flag-rules';

// ============================================================================
// Registry
// ============================================================================
// Per-flag descriptions live here alongside hard defaults and dependency
// metadata. The Dev Options panel iterates this object to render its
// accordions.

export interface FlagRegistration {
  description: string;
  hardDefault: FlagValue;
  dependsOn?: FlagKey;
  /** Flag exists but isn't governed by audience/goal rules. */
  deferred?: boolean;
}

export const FLAG_REGISTRY: Record<FlagKey, FlagRegistration> = Object.fromEntries(
  (Object.keys(HARD_DEFAULTS) as FlagKey[]).map((key) => [
    key,
    {
      description: '',
      hardDefault: HARD_DEFAULTS[key],
      dependsOn: FLAG_DEPENDENCIES[key],
    },
  ]),
) as Record<FlagKey, FlagRegistration>;

// Sample descriptions — concrete examples of the registry entry shape.
export const SAMPLE_DESCRIPTIONS: Partial<Record<FlagKey, string>> = {
  'flag.detail.policy.ai_summary':
    'AI-generated summary of the privacy policy. Off by default; turned on by goal.understand or goal.declutter.',
  'flag.detail.policy.safety_summary':
    'Guardian-only "is this safe for them?" summary above the lens grid. Requires a guardian-tuned AI prompt variant.',
  'flag.detail.annotations_sidebar':
    'Right-rail annotations sidebar on App Detail. Markdown-supported notes per app, travels with audit-bundle exports.',
  'flag.devopts.feature_flag_system.enabled':
    'Master kill-switch. When OFF, all flags resolve to their hard defaults regardless of overrides or rules.',
  'flag.notifications.quiet_hours':
    'Time-windowed notification suppression. Time window stored in app_settings.notification_quiet_hours_start / _end.',
  'flag.devopts.feature_flag_presets':
    'Save the current set of overrides as a named preset for quick switching. Disabled for guardian/loved_one/minimal.',
};

// ============================================================================
// Resolver context
// ============================================================================
// `FocusState` lives in `feature-flag-rules.ts`; reads come via
// `lib/feature-flag-storage.ts`'s `getActiveFocus()`.

export interface ResolverContext {
  focus: FocusState;
  /** Override row from feature_flag_overrides, keyed by flag_key. Quarantined rows are filtered out. */
  overrides: Map<FlagKey, FlagValue>;
  /** Whether the kill-switch is currently OFF (skip rules, return HARD_DEFAULTS only) */
  killSwitchOff: boolean;
  /** 'desktop' on Tauri builds, undefined on web. Forces flag.desktop.app_section on. */
  runtimeEnvironment?: 'desktop';
}

// ============================================================================
// Resolver
// ============================================================================
// Synchronous; suitable for both server and client components. Cache is built
// once per ResolverContext and invalidated when context fields change.

export interface ResolverCache {
  context: ResolverContext;
  values: Map<FlagKey, FlagValue>;
}

let activeCache: ResolverCache | null = null;

/**
 * Resolve a single flag. Falls back to the cached context populated by
 * `setResolverContext()` when `ctx` is omitted.
 */
export function resolveFlag(key: FlagKey, ctx?: ResolverContext): FlagValue {
  const context = ctx ?? requireContext();

  // Kill-switch short-circuit — every flag becomes its hard default.
  if (context.killSwitchOff) {
    return HARD_DEFAULTS[key];
  }

  // Reuse cached value if context matches.
  if (
    activeCache &&
    activeCache.context.focus === context.focus &&
    activeCache.context.overrides === context.overrides &&
    activeCache.context.killSwitchOff === context.killSwitchOff &&
    activeCache.context.runtimeEnvironment === context.runtimeEnvironment
  ) {
    const cached = activeCache.values.get(key);
    if (cached !== undefined) return cached;
  } else {
    activeCache = { context, values: new Map() };
  }

  const value = computeFlag(key, context);
  activeCache.values.set(key, value);
  return value;
}

function computeFlag(key: FlagKey, ctx: ResolverContext): FlagValue {
  // 1. Hard default.
  let value: FlagValue = HARD_DEFAULTS[key];

  // 2. Audience rule.
  const audienceRule = AUDIENCE_RULES[ctx.focus.audience][key];
  if (audienceRule !== undefined) value = audienceRule;

  // 3. Goal rules — apply each active primary goal in fixed order [understand, declutter, minimal].
  for (const goal of ['understand', 'declutter', 'minimal'] as const) {
    if (ctx.focus.goals.has(goal)) {
      const goalRule = GOAL_RULES[goal][key];
      if (goalRule !== undefined) value = goalRule;
    }
  }

  // 4. Accessibility modifier — wins locally even when minimal hides things.
  if (ctx.focus.goals.has('accessibility')) {
    const a11yRule = ACCESSIBILITY_RULES[key];
    if (a11yRule !== undefined) value = a11yRule;
  }

  // 5. Runtime environment override — force desktop-only affordances on
  //    when running in Tauri.
  if (key === 'flag.desktop.app_section' && ctx.runtimeEnvironment === 'desktop') {
    value = 'on';
  }
  if (key === 'flag.onboarding.method.configurator' && ctx.runtimeEnvironment === 'desktop') {
    value = 'on';
  }

  // 6. Dependency check — dependents collapse to 'off' when the parent
  //    isn't 'on'. Runs BEFORE the user override so an explicit override
  //    of 'on' can break the chain (intentional power-user escape hatch).
  const parent = FLAG_DEPENDENCIES[key];
  if (parent) {
    const parentValue = computeFlag(parent, ctx); // recurse — DAG is enforced at registry time
    if (parentValue !== 'on') value = 'off';
  }

  // 7. User override — absolute final word, overrides every layer including dependency.
  const override = ctx.overrides.get(key);
  if (override !== undefined) value = override;

  return value;
}

/**
 * Resolve focus state from the four `flag.focus.goal.*` keys + audience key.
 * Takes a `read` callback so callers can mock storage in tests.
 */
export function getFocusState(read: (key: string) => string): FocusState {
  const audience = (read('flag.focus.audience') || 'self') as Audience;
  const goals = activeGoalsFrom({
    understand: read('flag.focus.goal.understand') === 'true',
    declutter: read('flag.focus.goal.declutter') === 'true',
    minimal: read('flag.focus.goal.minimal') === 'true',
    accessibility: read('flag.focus.goal.accessibility') === 'true',
  });
  const aiConfigured = read('ai_provider') !== '' && read('ai_provider') !== 'disabled';
  return { audience, goals, aiConfigured };
}

/**
 * Build a full resolver context. Pass the result to `resolveFlag` to skip
 * the cache lookup indirection.
 */
export function getResolverContext(read: (key: string) => string, overrides: Map<FlagKey, FlagValue>): ResolverContext {
  const focus = getFocusState(read);
  const killSwitchOff = (overrides.get('flag.devopts.feature_flag_system.enabled') ?? HARD_DEFAULTS['flag.devopts.feature_flag_system.enabled']) === 'off';
  const runtimeEnvironment = read('runtime_environment') === 'desktop' ? 'desktop' : undefined;
  return { focus, overrides, killSwitchOff, runtimeEnvironment };
}

// Server-side context helper is in `lib/feature-flags-server.ts`.

function requireContext(): ResolverContext {
  if (!activeCache) {
    throw new Error(
      'resolveFlag called without a ResolverContext and no cached context exists. ' +
      'Call setResolverContext() at app startup or pass ctx explicitly.',
    );
  }
  return activeCache.context;
}

/**
 * Set the active resolver context. Invalidates the cache and notifies
 * subscribers. Called by the React provider at the top of the tree.
 */
export function setResolverContext(ctx: ResolverContext) {
  activeCache = { context: ctx, values: new Map() };
  notifySubscribers();
}

// ============================================================================
// Subscriber model — for useSyncExternalStore
// ============================================================================

const subscribers = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function notifySubscribers() {
  for (const cb of subscribers) cb();
}

// ============================================================================
// Cache accessors used by the React hooks (`lib/feature-flags-hooks.ts`)
// ============================================================================

/** Subscribe to context changes. Returns an unsubscribe fn. */
export function subscribeToContext(callback: () => void): () => void {
  return subscribe(callback);
}

/** Read the currently-cached context, or null when nothing's been set. */
export function getCachedContext(): ResolverContext | null {
  return activeCache?.context ?? null;
}

// ============================================================================
// enabledFor* helpers — direct audience/goal checks for components that
// branch on focus state without declaring a one-off flag.
// ============================================================================

export function enabledForAudience(audience: Audience, ctx?: ResolverContext): boolean {
  const context = ctx ?? requireContext();
  return context.focus.audience === audience;
}

export function enabledForGoal(goal: PrimaryGoal | Modifier, ctx?: ResolverContext): boolean {
  const context = ctx ?? requireContext();
  return context.focus.goals.has(goal);
}

// `useFocus` lives in `lib/feature-flags-hooks.ts` (client-only).

// ============================================================================
// Override mutators — in-memory cache mutation. Persistence to SQLite lives
// in `lib/feature-flag-storage.ts`.
// ============================================================================

/** Set (with `value`) or clear (with `undefined`) an override. */
export function setOverride(key: FlagKey, value: FlagValue | undefined) {
  if (!activeCache) return;
  const newOverrides = new Map(activeCache.context.overrides);
  if (value === undefined) {
    newOverrides.delete(key);
  } else {
    newOverrides.set(key, value);
  }
  setResolverContext({ ...activeCache.context, overrides: newOverrides });
}

/** Clear all overrides from the in-memory cache. */
export function resetAllOverrides() {
  if (!activeCache) return;
  setResolverContext({ ...activeCache.context, overrides: new Map() });
}

/** Clear overrides for a single surface (e.g. all `flag.dashboard.*` keys). */
export function resetSurfaceOverrides(surfacePrefix: string) {
  if (!activeCache) return;
  const newOverrides = new Map(activeCache.context.overrides);
  for (const key of newOverrides.keys()) {
    if (key.startsWith(`flag.${surfacePrefix}.`)) newOverrides.delete(key);
  }
  setResolverContext({ ...activeCache.context, overrides: newOverrides });
}

/**
 * Run a callback with the given flag overrides applied, then restore the
 * previous context.
 *
 *   withFlags({ 'flag.page.compare': 'off' }, () => {
 *     render(<App />);
 *     expect(screen.queryByText('Compare')).toBeNull();
 *   });
 */
export function withFlags<T>(
  overrides: Partial<Record<FlagKey, FlagValue>>,
  callback: () => T,
): T {
  const previous = activeCache;
  const newOverrides = new Map(activeCache?.context.overrides ?? new Map());
  for (const [key, value] of Object.entries(overrides) as Array<[FlagKey, FlagValue]>) {
    newOverrides.set(key, value);
  }
  // Synthesise a context for tests with no DB.
  const synthesisedContext: ResolverContext = activeCache?.context ?? {
    focus: { audience: 'self', goals: new Set(['understand']), aiConfigured: false },
    overrides: newOverrides,
    killSwitchOff: false,
  };
  setResolverContext({ ...synthesisedContext, overrides: newOverrides });
  try {
    return callback();
  } finally {
    activeCache = previous;
    notifySubscribers();
  }
}

// ============================================================================
// Re-exports from rules — convenience for callers
// ============================================================================

export { TOUR_STEPS, activeGoalsFrom };
export type { Audience, FlagKey, FlagValue, FocusState, Modifier, PrimaryGoal };
