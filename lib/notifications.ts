import db from './db';
import crypto from 'crypto';
import { ChangeEntry } from './changelog';
import { getSetting, setSetting } from './scheduler';
import type { AiTimeoutPhase } from './ai-config';
import { type CategoryMismatch } from './privacy-profile';

// Quiet hours: when the flag resolves on AND the current wall time falls
// inside the configured window, notifications are deferred by stamping
// `not_before = end-of-window`. The bell filters on
// `not_before IS NULL OR not_before <= now()`, so deferred rows surface
// automatically when the window closes.
// Window is stored as two HH:MM strings in app_settings; malformed
// values disable deferral.

function parseHHMM(value: string): { hour: number; minute: number } | null {
  const m = value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Compute `not_before` for a notification firing now. Returns `null`
 * when notifications should surface immediately, or an epoch-ms
 * timestamp at the end of the active quiet-hours window otherwise.
 */
export function computeNotBefore(now: Date = new Date()): number | null {
  // Lazy require to keep the resolver out of any accidental client bundle.
  let quietHoursOn = false;
  try {
    const { resolveFlagFromDb } = require('./feature-flags-server') as typeof import('./feature-flags-server');
    quietHoursOn = resolveFlagFromDb('flag.notifications.quiet_hours') === 'on';
  } catch {
    quietHoursOn = false;
  }
  if (!quietHoursOn) return null;

  const startStr = getSetting('notification_quiet_hours_start', '');
  const endStr = getSetting('notification_quiet_hours_end', '');
  const start = parseHHMM(startStr);
  const end = parseHHMM(endStr);
  if (!start || !end) return null;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const minutesStart = start.hour * 60 + start.minute;
  const minutesEnd = end.hour * 60 + end.minute;

  // Same-day window (start < end) vs overnight (start > end).
  // Equal start/end means zero-length window → no quiet hours.
  if (minutesStart === minutesEnd) return null;

  let inside: boolean;
  if (minutesStart < minutesEnd) {
    inside = minutesNow >= minutesStart && minutesNow < minutesEnd;
  } else {
    inside = minutesNow >= minutesStart || minutesNow < minutesEnd;
  }

  if (!inside) return null;

  const endTs = new Date(now);
  endTs.setHours(end.hour, end.minute, 0, 0);
  // Overnight window: if we're past start today, end is tomorrow at HH:MM.
  if (minutesStart > minutesEnd && minutesNow >= minutesStart) {
    endTs.setDate(endTs.getDate() + 1);
  }
  return endTs.getTime();
}

export function createNotification(appId: string, appName: string, changes: ChangeEntry[]): void {
  if (changes.length === 0) return;
  const notBefore = computeNotBefore();
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, not_before)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(crypto.randomUUID(), appId, appName, JSON.stringify(changes), createdAt, notBefore);

  // Webhook fan-out (Slack / Discord / Teams / generic). Fire-and-forget
  // so a slow / broken webhook can't block the in-app notification
  // write. Only fires when the user has configured an `immediate`
  // frequency — daily / weekly summaries are batched by the scheduler
  // tick in `instrumentation.ts`.
  void fireWebhookIfConfigured(appName, changes);
}

// Dynamic import so the webhook lib (which pulls `validateExternalUrl`
// + DB helpers) doesn't get loaded into bundles that just want to
// write a row. Errors are swallowed — the webhook is not on the
// critical path for notification persistence.
async function fireWebhookIfConfigured(
  appName: string,
  changes: ChangeEntry[],
): Promise<void> {
  try {
    const { postImmediateWebhook } = await import('./notification-webhooks');
    // Pick the first change's description as the headline — the in-app
    // bell renders all of them, but a chat post wants a single line.
    // Falls back to a generic phrasing when the description is missing.
    const headline = changes[0]?.description || `${changes.length} change${changes.length === 1 ? '' : 's'}`;
    await postImmediateWebhook({
      appName,
      summary: headline,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.warn('[notifications] webhook fan-out failed:', err);
  }
}

// Synthetic app_ids used by non-app notifications. Double-underscore
// prefix prevents collision with real Apple track ids; the bell uses
// these values to route clicks (e.g. AI-timeout → AI settings,
// import-completion → Settings#import-history).
export const AI_TIMEOUT_NOTIFICATION_APP_ID = '__ai_timeout__';
export const MANUAL_APPS_NOTIFICATION_APP_ID = '__manual_apps__';
export const IMPORT_COMPLETION_NOTIFICATION_APP_ID = '__import__';
export const WAYBACK_RESUME_NOTIFICATION_APP_ID = '__wayback_resume__';
export const SYNC_RESUME_NOTIFICATION_APP_ID = '__sync_resume__';
export const POLICY_RESUME_NOTIFICATION_APP_ID = '__policy_resume__';

// Per-notification-type cooldowns to avoid spam.
const PROFILE_MISMATCH_NOTIFY_WINDOW_MS = 24 * 60 * 60_000;
// Apple occasionally flips versions during staged rollouts — 1h dedupes blips.
const VERSION_UPDATE_NOTIFY_WINDOW_MS = 60 * 60_000;
const MANUAL_APPS_NOTIFY_WINDOW_MS = 24 * 60 * 60_000;
// Per-phase (direct/chunk/merge) cooldown so a bulk resync only nags once per phase.
const AI_TIMEOUT_NOTIFY_WINDOW_MS = 10 * 60_000;

interface AiTimeoutNotificationInput {
  appId: string;
  appName: string;
  phase: AiTimeoutPhase;
  /** The configured timeout budget. */
  timeoutMs: number;
  /** How long the call actually ran before aborting. */
  observedMs: number;
  /** Model label (e.g. "llama3.2"). */
  modelLabel?: string;
}

/**
 * Persist an "AI timed out" notification. Debounced per-phase via
 * `AI_TIMEOUT_NOTIFY_WINDOW_MS`. Returns `true` when a row was inserted.
 */
export function createAiTimeoutNotification(input: AiTimeoutNotificationInput): boolean {
  const dedupeKey = `ai_timeout_notify_${input.phase}_at`;
  const lastFired = Number(getSetting(dedupeKey, '0')) || 0;
  const now = Date.now();
  if (now - lastFired < AI_TIMEOUT_NOTIFY_WINDOW_MS) return false;

  const prettyPhase =
    input.phase === 'direct'
      ? 'direct summary'
      : input.phase === 'chunk'
        ? 'per-chunk'
        : 'chunk-merge';
  const observedSecs = Math.max(1, Math.round(input.observedMs / 1000));
  const budgetSecs = Math.max(1, Math.round(input.timeoutMs / 1000));
  const modelSuffix = input.modelLabel ? ` with ${input.modelLabel}` : '';
  const description =
    `AI ${prettyPhase} call${modelSuffix} aborted after ${observedSecs}s ` +
    `(limit: ${budgetSecs}s). Raise the ${input.phase}-phase AI timeout in Settings → AI.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    AI_TIMEOUT_NOTIFICATION_APP_ID,
    input.appName || 'Privacy policy AI',
    JSON.stringify([
      {
        // Synthetic type tag for routing/styling; structured fields below
        // are what the bell reads, with `description` as fallback.
        type: 'ai_timeout',
        description,
        phase: input.phase,
        timeoutMs: input.timeoutMs,
        observedMs: input.observedMs,
        modelLabel: input.modelLabel,
      } as unknown as ChangeEntry,
    ]),
    now,
  );

  setSetting(dedupeKey, String(now));
  return true;
}

interface ManualAppsPromptInput {
  /** How many rows the import finished without an App Store match. */
  unmatchedCount: number;
  /** Name of the import file / source, shown in the notification subline. */
  sourceLabel?: string | null;
}

/**
 * Raise a once-per-day nudge to review unmatched import rows. Safe to
 * call unconditionally — returns `false` (without inserting) when the
 * 24h cooldown is still active. Returns `true` when a row was inserted.
 */
export function createManualAppsPromptNotification(input: ManualAppsPromptInput): boolean {
  if (input.unmatchedCount <= 0) return false;

  const dedupeKey = 'manual_apps_prompt_notified_at';
  const lastFired = Number(getSetting(dedupeKey, '0')) || 0;
  const now = Date.now();
  if (now - lastFired < MANUAL_APPS_NOTIFY_WINDOW_MS) return false;

  const source = input.sourceLabel?.trim();
  const sourceSuffix = source ? ` from ${source}` : '';
  const description =
    `${input.unmatchedCount} row${input.unmatchedCount !== 1 ? 's' : ''}` +
    `${sourceSuffix} didn\u2019t match an App Store listing. ` +
    `If any are Safari web apps, TestFlight betas, or sideloaded apps, ` +
    `track them under Manual apps so you still have a privacy record.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    MANUAL_APPS_NOTIFICATION_APP_ID,
    'Manual apps',
    JSON.stringify([
      {
        // Synthetic type tag; structured fields are below, description is fallback.
        type: 'manual_apps_prompt',
        description,
        unmatchedCount: input.unmatchedCount,
        sourceLabel: source ?? null,
      } as unknown as ChangeEntry,
    ]),
    now,
  );

  setSetting(dedupeKey, String(now));
  return true;
}

interface ImportCompletionInput {
  importId: string;
  sourceLabel: string | null;
  total: number;
  imported: number;
  errored: number;
  queued: number;
  unmatched: number;
  itemCount: number;
  /** Activity status: drives the bell icon tone (green/orange/red). */
  status: 'ok' | 'partial' | 'error';
}

/**
 * Bell notification fired for every import completion regardless of status.
 * Not debounced — volume is naturally low.
 */
export function createImportCompletionNotification(input: ImportCompletionInput): void {
  const imported = Math.max(0, input.imported | 0);
  const total = Math.max(0, input.total | 0);
  const queued = Math.max(0, input.queued | 0);
  const errored = Math.max(0, input.errored | 0);
  const unmatched = Math.max(0, input.unmatched | 0);
  const itemCount = Math.max(0, input.itemCount | 0);
  const source = input.sourceLabel?.trim();
  const sourceSuffix = source ? ` from ${source}` : '';

  const headlineParts: string[] = [];
  if (input.status === 'ok') {
    headlineParts.push(`Imported ${imported} of ${total}${sourceSuffix}`);
  } else if (input.status === 'partial') {
    headlineParts.push(`${imported} of ${total} imported${sourceSuffix}`);
    const tail: string[] = [];
    if (queued > 0) tail.push(`${queued} queued`);
    if (errored > 0) tail.push(`${errored} failed`);
    if (unmatched > 0) tail.push(`${unmatched} unmatched`);
    if (tail.length > 0) headlineParts.push(tail.join(', '));
  } else {
    // error — cover both "nothing landed" and "items never persisted"
    if (total > 0 && itemCount === 0) {
      headlineParts.push(
        `Import failed before any apps were recorded${sourceSuffix} — ` +
        `Apple search likely rate-limited us. Use "Resume matching" in Import History.`,
      );
    } else {
      headlineParts.push(
        `Import of ${total} app${total !== 1 ? 's' : ''}${sourceSuffix} failed · ` +
        `${errored} error${errored !== 1 ? 's' : ''}, ${queued} still queued`,
      );
    }
  }

  const description = headlineParts.join(' · ').slice(0, 500);

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    IMPORT_COMPLETION_NOTIFICATION_APP_ID,
    'Import finished',
    JSON.stringify([
      {
        type: 'import_completed',
        description,
        importId: input.importId,
        status: input.status,
        total,
        imported,
        errored,
        queued,
        unmatched,
        itemCount,
        sourceLabel: source ?? null,
      } as unknown as ChangeEntry,
    ]),
    Date.now(),
  );
}

interface ProfileMismatchNotificationInput {
  appId: string;
  appName: string;
  /**
   * Newly-mismatched categories (in the new footprint, not the previous).
   * Callers must diff per-category — passing existing mismatches re-notifies.
   */
  newMismatches: CategoryMismatch[];
  /** `true` when this is the app's first import; tunes the wording. */
  isNew?: boolean;
}

/**
 * Raise a "this app now exceeds your privacy profile" notification.
 * Stored against the real appId so the bell renders the app icon and
 * routes to its detail page. Debounced per-app via a 24h cooldown.
 * Returns `true` when a row was inserted.
 */
export function createProfileMismatchNotification(
  input: ProfileMismatchNotificationInput,
): boolean {
  if (!input.appId || input.newMismatches.length === 0) return false;

  const dedupeKey = `profile_mismatch_notified_${input.appId}_at`;
  const lastFired = Number(getSetting(dedupeKey, '0')) || 0;
  const now = Date.now();
  if (now - lastFired < PROFILE_MISMATCH_NOTIFY_WINDOW_MS) return false;

  const [top] = input.newMismatches;
  const totalMismatches = input.newMismatches.length;
  const mismatchWord = totalMismatches === 1 ? 'mismatch' : 'mismatches';

  // The full per-category breakdown is one click away on the app detail
  // page (#profile-mismatch anchor + pulse on the privacy-types section).
  const leading = input.isNew
    ? `App imported · ${totalMismatches} ${mismatchWord} for ${input.appName}`
    : `${totalMismatches} new ${mismatchWord} for ${input.appName}`;
  const description = leading;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    input.appId,
    input.appName,
    JSON.stringify([
      {
        // Synthetic type tag for routing/branching.
        type: 'profile_mismatch',
        description,
        newCategoryCount: input.newMismatches.length,
        topCategory: top.category,
        topObserved: top.observed,
        topAllowed: top.allowed,
      } as unknown as ChangeEntry,
    ]),
    now,
  );

  setSetting(dedupeKey, String(now));
  return true;
}

interface VersionUpdateNotificationInput {
  appId: string;
  appName: string;
  previousVersion: string;
  currentVersion: string;
  previousVersionUpdatedAt: number | null;
  currentVersionUpdatedAt: number | null;
}

/**
 * Raise a "new App Store version" notification. Stored against the
 * real appId so the bell shows the icon and routes to the detail page.
 * Debounced per-app via a 1h cooldown. Returns `true` when inserted.
 */
export function createVersionUpdateNotification(
  input: VersionUpdateNotificationInput,
): boolean {
  if (!input.appId) return false;
  if (!input.previousVersion || !input.currentVersion) return false;
  if (input.previousVersion === input.currentVersion) return false;

  const dedupeKey = `version_update_notified_${input.appId}_at`;
  const lastFired = Number(getSetting(dedupeKey, '0')) || 0;
  const now = Date.now();
  if (now - lastFired < VERSION_UPDATE_NOTIFY_WINDOW_MS) return false;

  // Released-on suffix when iTunes reports a release date.
  const releasedSuffix = input.currentVersionUpdatedAt
    ? ` (released ${new Intl.DateTimeFormat('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(input.currentVersionUpdatedAt))})`
    : '';

  const description =
    `${input.appName} updated from v${input.previousVersion} ` +
    `to v${input.currentVersion}${releasedSuffix}.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    input.appId,
    input.appName,
    JSON.stringify([
      {
        // Synthetic type tag — drives the user's versionUpdates on/off filter.
        type: 'version_update',
        description,
        previousVersion: input.previousVersion,
        currentVersion: input.currentVersion,
        previousVersionUpdatedAt: input.previousVersionUpdatedAt,
        currentVersionUpdatedAt: input.currentVersionUpdatedAt,
      } as unknown as ChangeEntry,
    ]),
    now,
  );

  setSetting(dedupeKey, String(now));
  return true;
}

interface WaybackResumeNotificationInput {
  /** Remaining apps (pending + in_progress) at the moment of resume. */
  appsRemaining: number;
  /** Total apps in the queue. */
  totalApps: number;
  /** Stale-heal case: mutex was true but no queue existed. */
  staleHealed?: boolean;
}

/**
 * Raise a bell notification when `instrumentation.ts` detects leftover
 * bulk-Wayback-import state on startup and kicks off a resume. Not
 * debounced — volume is naturally low (one per crash). The stale-heal
 * variant fires when the mutex was stuck without a state blob.
 */
export function createWaybackResumeNotification(
  input: WaybackResumeNotificationInput,
): void {
  if (!isResumeEnabled()) return;
  const appsRemaining = Math.max(0, input.appsRemaining | 0);
  const totalApps = Math.max(0, input.totalApps | 0);

  const description = input.staleHealed
    ? 'A previous Wayback import lock was stuck after a server restart and has been cleared. You can start a new import now.'
    : `Wayback import resumed — ${appsRemaining} of ${totalApps} app${
        totalApps === 1 ? '' : 's'
      } still to process. Running in the background.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    WAYBACK_RESUME_NOTIFICATION_APP_ID,
    'Wayback import',
    JSON.stringify([
      {
        // Synthetic type tag for routing/branching.
        type: input.staleHealed ? 'wayback_stale_cleared' : 'wayback_resumed',
        description,
        appsRemaining,
        totalApps,
      } as unknown as ChangeEntry,
    ]),
    Date.now(),
  );
}

interface SyncResumeNotificationInput {
  appsRemaining: number;
  totalApps: number;
  staleHealed?: boolean;
}

/**
 * `flag.notifications.resume.enabled` gate shared by the three resume
 * notification helpers. When off, no row is inserted. Resolver failure
 * defaults to `true` so a resolver hiccup doesn't silently suppress.
 */
function isResumeEnabled(): boolean {
  try {
    const { resolveFlagFromDb } = require('./feature-flags-server') as typeof import('./feature-flags-server');
    return resolveFlagFromDb('flag.notifications.resume.enabled') === 'on';
  } catch {
    return true;
  }
}

/**
 * Bell notification when bulk App Store sync state is detected and
 * resumed on startup. Same shape as `createWaybackResumeNotification`.
 */
export function createSyncResumeNotification(
  input: SyncResumeNotificationInput,
): void {
  if (!isResumeEnabled()) return;
  const appsRemaining = Math.max(0, input.appsRemaining | 0);
  const totalApps = Math.max(0, input.totalApps | 0);

  const description = input.staleHealed
    ? 'A previous App Store sync lock was stuck after a server restart and has been cleared. You can start a new sync now.'
    : `App Store sync resumed — ${appsRemaining} of ${totalApps} app${
        totalApps === 1 ? '' : 's'
      } still to process. Running in the background.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    SYNC_RESUME_NOTIFICATION_APP_ID,
    'App Store sync',
    JSON.stringify([
      {
        type: input.staleHealed ? 'sync_stale_cleared' : 'sync_resumed',
        description,
        appsRemaining,
        totalApps,
      } as unknown as ChangeEntry,
    ]),
    Date.now(),
  );
}

interface PolicyResumeNotificationInput {
  appsRemaining: number;
  totalApps: number;
  staleHealed?: boolean;
}

/**
 * Bell notification when bulk privacy-policy sync state is detected
 * and resumed on startup. Same shape as the wayback/sync equivalents.
 */
export function createPolicyResumeNotification(
  input: PolicyResumeNotificationInput,
): void {
  if (!isResumeEnabled()) return;
  const appsRemaining = Math.max(0, input.appsRemaining | 0);
  const totalApps = Math.max(0, input.totalApps | 0);

  const description = input.staleHealed
    ? 'A previous privacy-policy sync lock was stuck after a server restart and has been cleared. You can start a new policy sync now.'
    : `Privacy-policy sync resumed — ${appsRemaining} of ${totalApps} app${
        totalApps === 1 ? '' : 's'
      } still to process. Running in the background.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    POLICY_RESUME_NOTIFICATION_APP_ID,
    'Privacy-policy sync',
    JSON.stringify([
      {
        type: input.staleHealed ? 'policy_stale_cleared' : 'policy_resumed',
        description,
        appsRemaining,
        totalApps,
      } as unknown as ChangeEntry,
    ]),
    Date.now(),
  );
}

/**
 * Per-type notification filter. Each change is mapped to one of four
 * type keys; when the matching flag is `off`, the change is filtered
 * out, and a row whose changes are all filtered is suppressed.
 *
 * Synthetic notifications (AI timeout, manual-apps, import completion,
 * resume cards) carry an empty change_summary and always pass through.
 */
function classifyChange(c: ChangeEntry): 'label_changes' | 'policy_updates' | 'accessibility_changes' | 'new_privacy_types' {
  if (c.category === 'privacy-policy') return 'policy_updates';
  if (c.category === 'accessibility') return 'accessibility_changes';
  // Whole-new privacy type: `type: 'added'` with empty/missing details.
  if (c.type === 'added' && (!c.details || c.details.length === 0)) {
    return 'new_privacy_types';
  }
  return 'label_changes';
}

function getEnabledTypeFilter(): {
  label_changes: boolean;
  policy_updates: boolean;
  accessibility_changes: boolean;
  new_privacy_types: boolean;
} {
  const fallback = {
    label_changes: true,
    policy_updates: true,
    accessibility_changes: true,
    new_privacy_types: true,
  };
  try {
    const { resolveFlagFromDb } = require('./feature-flags-server') as typeof import('./feature-flags-server');
    return {
      label_changes: resolveFlagFromDb('flag.notifications.types.label_changes') === 'on',
      policy_updates: resolveFlagFromDb('flag.notifications.types.policy_updates') === 'on',
      accessibility_changes: resolveFlagFromDb('flag.notifications.types.accessibility_changes') === 'on',
      new_privacy_types: resolveFlagFromDb('flag.notifications.types.new_privacy_types') === 'on',
    };
  } catch {
    return fallback;
  }
}

function applyTypeFilter(changes: ChangeEntry[], enabled: ReturnType<typeof getEnabledTypeFilter>): ChangeEntry[] {
  if (changes.length === 0) return changes; // synthetic — pass through
  return changes.filter(c => enabled[classifyChange(c)]);
}

export function getNotifications(limit = 30) {
  // Quiet-hours filter: NULL not_before means "show now".
  const now = Date.now();
  const enabled = getEnabledTypeFilter();
  return (db.prepare(`
    SELECT n.id, n.app_id, n.app_name, n.change_summary, n.created_at, n.read,
           n.stale, a.iconUrl
    FROM notifications n
    LEFT JOIN apps a ON a.id = n.app_id
    WHERE n.not_before IS NULL OR n.not_before <= ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(now, limit) as any[])
    .map(n => {
      const parsed = JSON.parse(n.change_summary) as ChangeEntry[];
      const filtered = applyTypeFilter(parsed, enabled);
      return { ...n, change_summary: filtered, originalLength: parsed.length };
    })
    // Keep synthetic rows (originally empty); drop rows whose changes were all filtered.
    .filter(n => n.originalLength === 0 || n.change_summary.length > 0)
    .map(n => ({
      id: n.id,
      app_id: n.app_id,
      app_name: n.app_name,
      change_summary: n.change_summary,
      created_at: n.created_at,
      read: n.read,
      stale: n.stale,
      iconUrl: n.iconUrl,
    }));
}

export function getUnreadCount(): number {
  // Quiet-hours + per-type filters apply.
  const now = Date.now();
  const enabled = getEnabledTypeFilter();
  // Fast path: every type on → per-type filter is a no-op, use SQL count.
  if (enabled.label_changes && enabled.policy_updates && enabled.accessibility_changes && enabled.new_privacy_types) {
    return ((db.prepare(
      'SELECT COUNT(*) as c FROM notifications WHERE read = 0 AND (not_before IS NULL OR not_before <= ?)',
    ).get(now) as any)?.c) ?? 0;
  }
  // Slow path: walk unread rows, apply filter, count survivors.
  const rows = db.prepare(
    'SELECT change_summary FROM notifications WHERE read = 0 AND (not_before IS NULL OR not_before <= ?)',
  ).all(now) as Array<{ change_summary: string }>;
  let count = 0;
  for (const r of rows) {
    let parsed: ChangeEntry[] = [];
    try { parsed = JSON.parse(r.change_summary) as ChangeEntry[]; } catch { /* ignore */ }
    const filtered = applyTypeFilter(parsed, enabled);
    if (parsed.length === 0 || filtered.length > 0) count++;
  }
  return count;
}

export function markAllRead(): void {
  db.prepare('UPDATE notifications SET read = 1').run();
}

/**
 * Re-flip a specific set of notifications back to unread. Powers the
 * Cmd-Z undo on the bell's mark-all-read action. Bounded at 200 ids.
 * Returns the number of rows actually flipped.
 */
export function markUnreadByIds(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  // Cap to stay well under better-sqlite3's 999 parameter limit.
  const capped = ids.slice(0, 200);
  const placeholders = capped.map(() => '?').join(',');
  const stmt = db.prepare(
    `UPDATE notifications SET read = 0 WHERE id IN (${placeholders})`,
  );
  const res = stmt.run(...capped);
  return Number(res.changes ?? 0);
}

/**
 * Flag every notification for `appId` as stale. Called when an import
 * item is rewired to a different App Store listing — the old entries
 * are still historically true but no longer actively tracked, so the
 * bell renders them faded rather than deleting them.
 *
 * Rejects synthetic ids so a malformed caller can't mass-stale every
 * synthetic row. Returns the number of rows updated.
 */
export function markNotificationsStaleForApp(appId: string): number {
  if (!appId) return 0;
  if (
    appId === AI_TIMEOUT_NOTIFICATION_APP_ID ||
    appId === MANUAL_APPS_NOTIFICATION_APP_ID ||
    appId === IMPORT_COMPLETION_NOTIFICATION_APP_ID
  ) {
    return 0;
  }
  const res = db
    .prepare(`UPDATE notifications SET stale = 1 WHERE app_id = ? AND stale = 0`)
    .run(appId);
  return Number(res.changes ?? 0);
}

/**
 * Synthetic app id for "Apple's privacy-label HTML drifted — parser
 * fell through every fallback shelf for one or more apps."
 */
export const PARSER_FALLTHROUGH_NOTIFICATION_APP_ID = '__parser_fallthrough__';

/** Cooldown window for the parser-fallthrough alert. */
const PARSER_FALLTHROUGH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY = 'parser_fallthrough_last_notified_at';

/**
 * Raise a single bell notification when the App Store HTML parser's
 * shelf-fallback chain runs dry. Spam-resistant — at most one row per
 * `PARSER_FALLTHROUGH_COOLDOWN_MS` window. Returns `true` when a row
 * was inserted, `false` when suppressed by cooldown.
 */
export function createParserFallthroughNotification(input: {
  appName: string | null;
  appsAffected: number;
}): boolean {
  // Cooldown gate first — cheap settings read.
  const now = Date.now();
  const lastRaw = getSetting(PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY, '0');
  const last = Number.parseInt(lastRaw, 10);
  if (Number.isFinite(last) && last > 0 && now - last < PARSER_FALLTHROUGH_COOLDOWN_MS) {
    return false;
  }

  const appsAffected = Math.max(1, input.appsAffected | 0);
  // Wording is hedged — only one row fires per cooldown window even if
  // many apps fall through in a single sync.
  const examplePart = input.appName ? `most recently ${input.appName}` : '';
  const scopePart = appsAffected > 1
    ? `${appsAffected} apps in this batch${examplePart ? ` (${examplePart})` : ''}`
    : `at least one app${examplePart ? ` (${examplePart})` : ''}`;
  const description =
    `Privacy labels couldn't be parsed for ${scopePart}. ` +
    `Apple may have changed the App Store HTML format. The history pages will keep working, but no fresh ` +
    `privacy-label data will land until the parser catches up. If this persists, please open a GitHub issue.`;

  db.prepare(`
    INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(),
    PARSER_FALLTHROUGH_NOTIFICATION_APP_ID,
    'Privacy-label parser',
    JSON.stringify([
      {
        type: 'parser_fallthrough',
        description,
        appsAffected,
        exampleAppName: input.appName ?? null,
      } as unknown as ChangeEntry,
    ]),
    now,
  );
  setSetting(PARSER_FALLTHROUGH_LAST_NOTIFIED_KEY, String(now));
  return true;
}
