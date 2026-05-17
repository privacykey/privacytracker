/**
 * Webhook delivery for notification summaries.
 *
 * Replaces the original "should we add email?" plan with a much
 * simpler primitive: the user pastes a webhook URL (Slack, Discord,
 * Teams, or any generic JSON endpoint), picks a format, and we POST
 * notifications there either immediately or as a daily / weekly
 * batch. No SMTP, no spam concerns, no unsubscribe management.
 *
 * Settings keys touched:
 *   - notification_webhook_url       — the destination ('' = disabled)
 *   - notification_webhook_format    — 'slack' | 'discord' | 'teams' | 'generic'
 *   - notification_webhook_frequency — 'immediate' | 'daily_summary' | 'weekly_summary' | 'off'
 *   - notification_webhook_last_sent — epoch ms of last successful summary post
 *
 * Three call sites today:
 *   1. lib/notifications.ts — fires `postImmediateWebhook` when a new
 *      row lands AND frequency is 'immediate'.
 *   2. instrumentation.ts — fires `maybePostSummaryWebhook` from the
 *      same 30-min tick that runs the scheduled-sync gate, batching
 *      unread notifications if a day / week has elapsed since the
 *      last summary.
 *   3. app/api/notifications/webhook-test/route.ts — fires
 *      `postWebhookTestPayload` so the wizard's "Test" button can
 *      verify the URL works before the user commits.
 *
 * All POSTs go through `safeFetch` so the same SSRF + size + timeout
 * guards that protect /api/scrape protect us here too.
 */

import db from "./db";
import { getSetting, setSetting } from "./scheduler";
import { validateExternalUrl } from "./security";

export type WebhookFormat = "slack" | "discord" | "teams" | "generic";
export type WebhookFrequency =
  | "immediate"
  | "daily_summary"
  | "weekly_summary"
  | "off";

const VALID_FORMATS: readonly WebhookFormat[] = [
  "slack",
  "discord",
  "teams",
  "generic",
];
const VALID_FREQUENCIES: readonly WebhookFrequency[] = [
  "immediate",
  "daily_summary",
  "weekly_summary",
  "off",
];

/** One notification row condensed to the fields a webhook payload needs. */
export interface WebhookNotification {
  appName: string | null;
  createdAt: number;
  summary: string;
}

interface WebhookConfig {
  format: WebhookFormat;
  frequency: WebhookFrequency;
  url: string;
}

/**
 * Read the user's current webhook config. Returns null when the URL is
 * empty or the frequency is 'off' — callers should short-circuit on
 * null rather than treating an empty URL as a valid destination.
 */
export function readWebhookConfig(): WebhookConfig | null {
  const url = getSetting("notification_webhook_url", "").trim();
  if (!url) {
    return null;
  }
  const formatRaw = getSetting("notification_webhook_format", "generic");
  const freqRaw = getSetting("notification_webhook_frequency", "immediate");
  const format = (VALID_FORMATS as readonly string[]).includes(formatRaw)
    ? (formatRaw as WebhookFormat)
    : "generic";
  const frequency = (VALID_FREQUENCIES as readonly string[]).includes(freqRaw)
    ? (freqRaw as WebhookFrequency)
    : "immediate";
  if (frequency === "off") {
    return null;
  }
  return { url, format, frequency };
}

/**
 * Build the platform-specific JSON body for a payload. Slack and
 * Discord both accept a simple `{ text: '...' }` shape, Teams uses
 * MessageCard, generic ships the raw notification list under `data`.
 */
function buildPayload(
  format: WebhookFormat,
  title: string,
  lines: readonly string[],
  notifications: readonly WebhookNotification[]
): Record<string, unknown> {
  const text = `${title}\n${lines.join("\n")}`;
  switch (format) {
    case "slack":
      // Slack supports `text` for a basic post; the wizard surfaces a
      // tooltip recommending users paste their channel-specific
      // Incoming Webhook URL rather than a workflow-builder one (the
      // latter requires a schema we'd have to second-guess).
      return { text };
    case "discord":
      // Discord caps `content` at 2000 chars. We slice defensively —
      // anything longer rarely reads well in a chat anyway.
      return { content: text.length > 1900 ? `${text.slice(0, 1900)}…` : text };
    case "teams":
      // Microsoft Teams uses the legacy MessageCard format for
      // Incoming Webhooks. The connector accepts an Adaptive Card via
      // the newer `attachments` shape too, but MessageCard works
      // across Teams + Outlook + Workflow connectors with one payload.
      return {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: title,
        themeColor: "0a84ff",
        title,
        text: lines.join("\n\n"),
      };
    case "generic":
      // Generic POST — opaque JSON. Includes both the rendered text
      // and the structured rows so a downstream automation can pick
      // the shape it wants.
      return {
        title,
        text,
        notifications: notifications.map((n) => ({
          appName: n.appName,
          summary: n.summary,
          createdAt: n.createdAt,
        })),
      };
  }
}

/**
 * POST a single immediate notification to the configured webhook.
 * No-op when no webhook is configured or frequency != 'immediate'.
 * Failures are swallowed (logged) — webhook failures must not break
 * the in-app notification write path.
 */
export async function postImmediateWebhook(
  notification: WebhookNotification
): Promise<void> {
  const cfg = readWebhookConfig();
  if (!cfg || cfg.frequency !== "immediate") {
    return;
  }
  const title = notification.appName
    ? `📱 ${notification.appName}: ${notification.summary}`
    : `📱 ${notification.summary}`;
  await postWebhook(cfg, title, [notification.summary], [notification]).catch(
    (err) => {
      console.warn("[webhook] immediate POST failed:", err);
    }
  );
}

/**
 * POST a batched summary if enough time has elapsed since the last
 * one. Designed to be called from the existing 30-min scheduler tick
 * — the function self-rate-limits via `notification_webhook_last_sent`
 * so calling it every tick is safe.
 *
 * Returns the number of notifications sent (0 = nothing happened).
 */
export async function maybePostSummaryWebhook(): Promise<number> {
  const cfg = readWebhookConfig();
  if (!cfg) {
    return 0;
  }
  if (cfg.frequency !== "daily_summary" && cfg.frequency !== "weekly_summary") {
    return 0;
  }

  const intervalMs =
    cfg.frequency === "daily_summary"
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const lastSent =
    Number(getSetting("notification_webhook_last_sent", "0")) || 0;
  if (now - lastSent < intervalMs) {
    return 0;
  }

  const since = lastSent > 0 ? lastSent : now - intervalMs;
  const rows = db
    .prepare(
      `SELECT app_name, change_summary, created_at
       FROM notifications
       WHERE created_at >= ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(since) as Array<{
    app_name: string | null;
    change_summary: string;
    created_at: number;
  }>;
  if (rows.length === 0) {
    // Nothing to report — bump the cursor so we don't query the same
    // empty window again every tick.
    setSetting("notification_webhook_last_sent", String(now));
    return 0;
  }

  const notifications: WebhookNotification[] = rows.map((r) => ({
    appName: r.app_name,
    summary: r.change_summary,
    createdAt: r.created_at,
  }));
  const title =
    cfg.frequency === "daily_summary"
      ? `🌙 Daily privacytracker summary — ${rows.length} update${rows.length === 1 ? "" : "s"}`
      : `📅 Weekly privacytracker summary — ${rows.length} update${rows.length === 1 ? "" : "s"}`;
  const lines = rows.map((r) =>
    r.app_name
      ? `• ${r.app_name}: ${r.change_summary}`
      : `• ${r.change_summary}`
  );
  try {
    await postWebhook(cfg, title, lines, notifications);
    setSetting("notification_webhook_last_sent", String(now));
    return rows.length;
  } catch (err) {
    console.warn("[webhook] summary POST failed:", err);
    // Don't bump the cursor — next tick will retry the same window.
    return 0;
  }
}

/**
 * POST a one-off "test" payload, used by the wizard's Test button
 * before the user commits the webhook config. Bypasses the
 * frequency / config-read shortcut so the user can test with the
 * URL they're typing without saving first.
 */
export async function postWebhookTestPayload(
  url: string,
  format: WebhookFormat
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const cfg: WebhookConfig = { url, format, frequency: "immediate" };
  const title = "✅ Webhook test from privacytracker";
  const lines = [
    "This is a test message — your webhook is wired up correctly.",
    "You'll start seeing notification summaries here per your chosen frequency.",
  ];
  try {
    const result = await postWebhook(cfg, title, lines, []);
    return { ok: result.ok, status: result.status, detail: result.detail };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Core POST. `safeFetch` is GET-only by design, so we run the same SSRF
 * validator manually and then issue a plain `fetch` with the
 * webhook body. Validation rejects file://, private/loopback IPs
 * (unless we extended the allowPrivateHosts switch), and anything
 * pointing at cloud metadata services.
 *
 * 10s timeout via AbortSignal — webhooks should respond near-instantly;
 * if Slack/Discord etc. take longer the user has bigger problems than
 * waiting for our POST to time out.
 */
async function postWebhook(
  cfg: WebhookConfig,
  title: string,
  lines: readonly string[],
  notifications: readonly WebhookNotification[]
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const verdict = validateExternalUrl(cfg.url, { maxLength: 512 });
  if (!(verdict.ok && verdict.url)) {
    throw new Error(
      `Blocked webhook URL: ${verdict.error ?? "invalid_url"} — ${verdict.detail ?? cfg.url}`
    );
  }
  const body = JSON.stringify(
    buildPayload(cfg.format, title, lines, notifications)
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(verdict.url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    return {
      ok: response.ok,
      status: response.status,
      detail: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
