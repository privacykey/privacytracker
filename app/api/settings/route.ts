export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  AI_PROVIDERS,
  AI_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
  AI_TIMEOUT_PHASES,
  AI_TIMEOUT_SETTING_KEYS,
  normalizeAiProvider,
} from "../../../lib/ai-config";
import { DEFAULT_COUNTRY, normalizeCountry } from "../../../lib/region";
import {
  getSetting,
  type SyncSchedule,
  setSetting,
} from "../../../lib/scheduler";
import {
  adminTokenRequiredForRequest,
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
  validateExternalUrl,
} from "../../../lib/security";

export async function GET(request: Request) {
  // NOTE: ai_api_key is deliberately masked — the settings UI should treat
  // this as "set / not set" rather than a plaintext round-trip. The raw key
  // is still available via the `lib/scheduler` helpers on the server.
  const storedKey = getSetting("ai_api_key", "");
  const storedCountry = getSetting("app_country", "");
  return NextResponse.json({
    sync_schedule: getSetting("sync_schedule", "manual"),
    last_auto_sync: getSetting("last_auto_sync", "0"),
    sync_running: getSetting("sync_running", "false"),
    app_country: storedCountry || DEFAULT_COUNTRY,
    app_country_explicit: !!storedCountry,
    ai_provider: normalizeAiProvider(getSetting("ai_provider", "disabled")),
    ai_api_key: storedKey ? "__SET__" : "",
    ai_api_key_set: !!storedKey,
    ai_base_url: getSetting("ai_base_url", ""),
    ai_model: getSetting("ai_model", ""),
    ai_summarize_on_import: getSetting("ai_summarize_on_import", "false"),
    ai_debug_logging: getSetting("ai_debug_logging", "false"),
    // Per-phase AI request timeouts (ms). Empty string = use the
    // provider-appropriate default (see resolveAiTimeoutMs).
    ai_timeout_direct_ms: getSetting(AI_TIMEOUT_SETTING_KEYS.direct, ""),
    ai_timeout_chunk_ms: getSetting(AI_TIMEOUT_SETTING_KEYS.chunk, ""),
    ai_timeout_merge_ms: getSetting(AI_TIMEOUT_SETTING_KEYS.merge, ""),
    // Window (in days) within which the AI Policy tab will surface a
    // "policy text changed recently" banner with a link to the diff on the
    // History tab. 0 disables the banner entirely; default 90.
    policy_diff_alert_days: getSetting("policy_diff_alert_days", "90"),
    // Per-app cooldown between privacy-policy scrapes. When enabled, any
    // scrape (manual Re-sync, background scheduler, or import flow) that
    // fires inside the cooldown short-circuits before hitting the network.
    // Default 60 min; set `policy_scrape_throttle_enabled` to 'false' to
    // disable for dev testing.
    policy_scrape_throttle_enabled:
      getSetting("policy_scrape_throttle_enabled", "true") !== "false",
    policy_scrape_throttle_minutes: getSetting(
      "policy_scrape_throttle_minutes",
      "60"
    ),
    // Global kill-switch for policy scraping. When 'true', every code
    // path that would fetch a privacy-policy URL short-circuits without
    // making the HTTP call. Stronger than the throttle — disables all
    // background activity, including the per-app auto-trigger from
    // scraper.ts and the bulk runner's resume path.
    policy_scrape_disabled:
      getSetting("policy_scrape_disabled", "false") === "true",
    // Show Wayback-imported history rows inline in the per-app Changelog.
    // Stored as a plain boolean flag: when false, the timeline filters
    // wayback-source snapshots out of its rendering without deleting them
    // (users can re-enable from Settings without re-running the import).
    wayback_show_imported:
      getSetting("wayback_show_imported", "true") !== "false",
    // Show Apple's accessibility nutrition labels (the "Accessibility" shelf
    // that lists VoiceOver/Voice Control/etc. support) in the UI. Scraping
    // always happens regardless of this flag — the setting only gates
    // whether the app detail page, stats page, and grid filter surface the
    // captured data. Default on.
    track_accessibility_labels:
      getSetting("track_accessibility_labels", "true") !== "false",
    // Review-queue progress bar visibility. Read by the Apps page server
    // route to thread into AppGrid → ReviewQueue. Default on.
    queue_show_progress_bar:
      getSetting("queue_show_progress_bar", "true") !== "false",
    // Epoch ms of the last successful cfgutil-based import. Empty string
    // means "user has never imported via cfgutil on this machine". The
    // /onboard device-connect toast is gated on this — without a prior
    // success we don't subscribe to USB attach events at all, so users
    // who never use cfgutil don't pay any of its cost.
    cfgutil_imported_at: getSetting("cfgutil_imported_at", ""),
    // Webhook notifications — POSTs notification summaries to a
    // user-supplied URL (Slack / Discord / Teams / generic JSON). Empty
    // URL disables the path entirely. `format` decides the payload
    // shape; `frequency` decides whether each notification fires its
    // own POST ('immediate') or whether they're batched into a daily /
    // weekly summary.
    notification_webhook_url: getSetting("notification_webhook_url", ""),
    notification_webhook_format: getSetting(
      "notification_webhook_format",
      "generic"
    ),
    notification_webhook_frequency: getSetting(
      "notification_webhook_frequency",
      "immediate"
    ),
    // Quiet-hours window for both in-app and OS notifications. Stored
    // as 'HH:MM' strings; empty = no quiet hours configured.
    notification_quiet_hours_start: getSetting(
      "notification_quiet_hours_start",
      ""
    ),
    notification_quiet_hours_end: getSetting(
      "notification_quiet_hours_end",
      ""
    ),
    // Background-mode wizard lifecycle. Both are epoch ms timestamps
    // serialised as strings (empty = never). The dashboard callout is
    // hidden whenever either is set. Stored separately so we can
    // distinguish "user finished the wizard" from "user clicked dismiss
    // without doing anything" in metrics later.
    background_wizard_completed_at: getSetting(
      "background_wizard_completed_at",
      ""
    ),
    background_wizard_dismissed_at: getSetting(
      "background_wizard_dismissed_at",
      ""
    ),
    admin_token_required: adminTokenRequiredForRequest(request),
  });
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "settings.write"),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (
    adminTokenRequiredForRequest(request) &&
    !requestHasValidAdminToken(request)
  ) {
    recordAudit({
      action: "settings.write.unauthorised",
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json(
      { error: "Admin token required" },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 16 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid body" },
      { status: 400 }
    );
  }

  const VALID: SyncSchedule[] = ["manual", "daily", "weekly"];

  if (body.sync_schedule !== undefined) {
    if (!VALID.includes(body.sync_schedule as SyncSchedule)) {
      return NextResponse.json({ error: "Invalid schedule" }, { status: 400 });
    }
    setSetting("sync_schedule", body.sync_schedule as string);
  }

  if (body.app_country !== undefined) {
    setSetting("app_country", normalizeCountry(body.app_country));
  }

  if (body.ai_provider !== undefined) {
    if (
      !AI_PROVIDERS.includes(body.ai_provider as (typeof AI_PROVIDERS)[number])
    ) {
      return NextResponse.json(
        { error: "Invalid AI provider" },
        { status: 400 }
      );
    }
    const provider = normalizeAiProvider(body.ai_provider);
    const previousProvider = normalizeAiProvider(
      getSetting("ai_provider", "disabled")
    );
    setSetting("ai_provider", provider);
    // Cross-provider key leak prevention: a user who pasted an OpenAI key
    // and then flipped the provider to `custom` (with a base URL they
    // typed in) would otherwise watch their OpenAI key get sent in the
    // Authorization header of the very next call to that custom endpoint.
    // Force a re-enter on every provider switch.
    if (provider !== previousProvider) {
      setSetting("ai_api_key", "");
    }
  }

  if (body.ai_api_key !== undefined) {
    // Ignore the masked sentinel — it means the UI hasn't touched the key.
    const raw = String(body.ai_api_key ?? "");
    if (raw !== "__SET__") {
      // Trim + reject anything implausibly long; api keys are <=512 chars.
      if (raw.length > 512) {
        return NextResponse.json(
          { error: "API key too long" },
          { status: 400 }
        );
      }
      setSetting("ai_api_key", raw.trim());
    }
  }

  if (body.ai_base_url !== undefined) {
    const raw = String(body.ai_base_url ?? "").trim();
    if (raw === "") {
      setSetting("ai_base_url", "");
    } else {
      // Allow http(s) targeting public hosts OR loopback / RFC-1918 addresses,
      // since the AI provider is frequently a self-hosted service (Ollama on
      // localhost, a LAN inference box, a docker-compose sibling container).
      // Cloud metadata endpoints (IMDS / 169.254.0.0/16 / GCP metadata) remain
      // blocked inside validateExternalUrl even under allowPrivateHosts.
      const verdict = validateExternalUrl(raw, {
        maxLength: 512,
        allowPrivateHosts: true,
      });
      if (!verdict.ok) {
        return NextResponse.json(
          { error: `Invalid ai_base_url: ${verdict.detail ?? verdict.error}` },
          { status: 400 }
        );
      }
      setSetting("ai_base_url", verdict.url!.toString());
    }
  }

  if (body.ai_model !== undefined) {
    const raw = String(body.ai_model ?? "").trim();
    if (raw.length > 200) {
      return NextResponse.json({ error: "ai_model too long" }, { status: 400 });
    }
    setSetting("ai_model", raw);
  }

  if (body.ai_summarize_on_import !== undefined) {
    setSetting(
      "ai_summarize_on_import",
      body.ai_summarize_on_import ? "true" : "false"
    );
  }

  if (body.ai_debug_logging !== undefined) {
    setSetting("ai_debug_logging", body.ai_debug_logging ? "true" : "false");
  }

  // Per-phase AI timeouts. Empty string / null clears the setting and
  // reverts to the provider-appropriate default on the next AI call.
  for (const phase of AI_TIMEOUT_PHASES) {
    const key = `ai_timeout_${phase}_ms`;
    if (body[key] === undefined) {
      continue;
    }
    const raw = body[key];
    if (raw === "" || raw === null) {
      setSetting(AI_TIMEOUT_SETTING_KEYS[phase], "");
      continue;
    }
    const parsed = Number(raw);
    if (
      !Number.isFinite(parsed) ||
      parsed < AI_TIMEOUT_MIN_MS ||
      parsed > AI_TIMEOUT_MAX_MS
    ) {
      return NextResponse.json(
        {
          error: `${key} must be between ${AI_TIMEOUT_MIN_MS} and ${AI_TIMEOUT_MAX_MS} ms`,
        },
        { status: 400 }
      );
    }
    setSetting(AI_TIMEOUT_SETTING_KEYS[phase], String(Math.floor(parsed)));
  }

  if (body.policy_diff_alert_days !== undefined) {
    const raw = Number(body.policy_diff_alert_days);
    // 0 is valid — disables the banner. Upper bound ~10 years keeps the
    // settings UI from accepting Number.MAX_SAFE_INTEGER-style nonsense
    // that would then render as "changed ~29,000 years ago" in edge cases.
    if (!Number.isFinite(raw) || raw < 0 || raw > 3650) {
      return NextResponse.json(
        { error: "policy_diff_alert_days must be 0–3650" },
        { status: 400 }
      );
    }
    setSetting("policy_diff_alert_days", String(Math.floor(raw)));
  }

  if (body.policy_scrape_throttle_enabled !== undefined) {
    // Stored as 'true' / 'false' string for consistency with the other
    // boolean settings. The lib-side guard treats any non-'false' value as
    // enabled (so old installs without the key default on).
    setSetting(
      "policy_scrape_throttle_enabled",
      body.policy_scrape_throttle_enabled ? "true" : "false"
    );
  }

  if (body.policy_scrape_disabled !== undefined) {
    // Global kill-switch — stored as 'true' / 'false' string. Defaults to
    // off so existing installs continue scraping; the gate in
    // `fetchAndStorePolicySource` only activates when the value is the
    // string 'true'.
    setSetting(
      "policy_scrape_disabled",
      body.policy_scrape_disabled ? "true" : "false"
    );
  }

  if (body.wayback_show_imported !== undefined) {
    setSetting(
      "wayback_show_imported",
      body.wayback_show_imported ? "true" : "false"
    );
  }

  if (body.track_accessibility_labels !== undefined) {
    setSetting(
      "track_accessibility_labels",
      body.track_accessibility_labels ? "true" : "false"
    );
  }

  if (body.queue_show_progress_bar !== undefined) {
    setSetting(
      "queue_show_progress_bar",
      body.queue_show_progress_bar ? "true" : "false"
    );
  }

  if (body.cfgutil_imported_at !== undefined) {
    // Accept either a number (epoch ms) or '' to clear. Reject anything
    // implausibly old or in the future — the value is informational so
    // we don't need to be strict, but we want to catch obvious junk.
    const raw = body.cfgutil_imported_at;
    if (raw === "" || raw === null) {
      setSetting("cfgutil_imported_at", "");
    } else {
      const parsed = Number(raw);
      if (
        !Number.isFinite(parsed) ||
        parsed < 0 ||
        parsed > Date.now() + 60_000
      ) {
        return NextResponse.json(
          {
            error:
              "cfgutil_imported_at must be a recent epoch ms timestamp or empty",
          },
          { status: 400 }
        );
      }
      setSetting("cfgutil_imported_at", String(Math.floor(parsed)));
    }
  }

  if (body.policy_scrape_throttle_minutes !== undefined) {
    const raw = Number(body.policy_scrape_throttle_minutes);
    // 0 is valid — equivalent to disabling the throttle but keeping the
    // `enabled` flag on. Upper bound is one week, enough for any reasonable
    // self-hosted "only re-check once a day" workflow, and small enough
    // that UI doesn't need scientific notation.
    if (!Number.isFinite(raw) || raw < 0 || raw > 10_080) {
      return NextResponse.json(
        { error: "policy_scrape_throttle_minutes must be 0–10080" },
        { status: 400 }
      );
    }
    setSetting("policy_scrape_throttle_minutes", String(Math.floor(raw)));
  }

  if (body.notification_webhook_url !== undefined) {
    const raw = String(body.notification_webhook_url ?? "").trim();
    if (raw === "") {
      setSetting("notification_webhook_url", "");
    } else {
      // Webhook destinations are user-controlled and frequently land on
      // a SaaS endpoint (Slack / Discord / Teams), so we use the same
      // SSRF-defended validator as the AI base URL — disallow private
      // networks unless the host is whitelisted. Tauri users running a
      // self-hosted Mattermost on the LAN can override by hosting
      // behind a public DNS.
      const verdict = validateExternalUrl(raw, { maxLength: 512 });
      if (!verdict.ok) {
        return NextResponse.json(
          {
            error: `Invalid notification_webhook_url: ${verdict.detail ?? verdict.error}`,
          },
          { status: 400 }
        );
      }
      setSetting("notification_webhook_url", verdict.url!.toString());
    }
  }

  if (body.notification_webhook_format !== undefined) {
    const VALID_FORMATS = ["slack", "discord", "teams", "generic"] as const;
    const raw = String(
      body.notification_webhook_format ?? "generic"
    ) as (typeof VALID_FORMATS)[number];
    if (!(VALID_FORMATS as readonly string[]).includes(raw)) {
      return NextResponse.json(
        {
          error: `notification_webhook_format must be one of: ${VALID_FORMATS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    setSetting("notification_webhook_format", raw);
  }

  if (body.notification_webhook_frequency !== undefined) {
    const VALID_FREQS = [
      "immediate",
      "daily_summary",
      "weekly_summary",
      "off",
    ] as const;
    const raw = String(
      body.notification_webhook_frequency ?? "immediate"
    ) as (typeof VALID_FREQS)[number];
    if (!(VALID_FREQS as readonly string[]).includes(raw)) {
      return NextResponse.json(
        {
          error: `notification_webhook_frequency must be one of: ${VALID_FREQS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    setSetting("notification_webhook_frequency", raw);
  }

  if (body.notification_quiet_hours_start !== undefined) {
    const raw = String(body.notification_quiet_hours_start ?? "").trim();
    // Accept '' (clear) or HH:MM 24h format. The notifications layer
    // tolerates malformed values by treating them as "no quiet hours",
    // but we reject here so an obviously-broken UI write doesn't get
    // silently masked.
    if (raw !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
      return NextResponse.json(
        { error: "notification_quiet_hours_start must be HH:MM or empty" },
        { status: 400 }
      );
    }
    setSetting("notification_quiet_hours_start", raw);
  }

  if (body.notification_quiet_hours_end !== undefined) {
    const raw = String(body.notification_quiet_hours_end ?? "").trim();
    if (raw !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
      return NextResponse.json(
        { error: "notification_quiet_hours_end must be HH:MM or empty" },
        { status: 400 }
      );
    }
    setSetting("notification_quiet_hours_end", raw);
  }

  if (body.background_wizard_completed_at !== undefined) {
    // Allow '' to clear (re-show the callout) or any non-negative epoch
    // ms timestamp. We don't validate the value tightly — it's only
    // read for "is this set" checks downstream.
    const raw = body.background_wizard_completed_at;
    if (raw === "" || raw === null) {
      setSetting("background_wizard_completed_at", "");
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json(
          {
            error:
              "background_wizard_completed_at must be an epoch ms timestamp or empty",
          },
          { status: 400 }
        );
      }
      setSetting("background_wizard_completed_at", String(Math.floor(parsed)));
    }
  }

  if (body.background_wizard_dismissed_at !== undefined) {
    const raw = body.background_wizard_dismissed_at;
    if (raw === "" || raw === null) {
      setSetting("background_wizard_dismissed_at", "");
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json(
          {
            error:
              "background_wizard_dismissed_at must be an epoch ms timestamp or empty",
          },
          { status: 400 }
        );
      }
      setSetting("background_wizard_dismissed_at", String(Math.floor(parsed)));
    }
  }

  recordAudit({
    action: "settings.write.success",
    actorIp,
    userAgent,
    success: true,
    detail: Object.keys(body).join(","),
  });

  return NextResponse.json({ success: true });
}
