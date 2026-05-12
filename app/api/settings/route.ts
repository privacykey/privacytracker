export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSetting, setSetting, SyncSchedule } from '../../../lib/scheduler';
import {
  AI_PROVIDERS,
  AI_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
  AI_TIMEOUT_PHASES,
  AI_TIMEOUT_SETTING_KEYS,
  normalizeAiProvider,
} from '../../../lib/ai-config';
import { DEFAULT_COUNTRY, normalizeCountry } from '../../../lib/region';
import {
  adminTokenRequiredForRequest,
  requestHasValidAdminToken,
  readBoundedJson,
  validateExternalUrl,
  recordAudit,
  requestActorIp,
  checkRateLimit,
  rateLimitKeyForRequest,
} from '../../../lib/security';

export async function GET(request: Request) {
  // NOTE: ai_api_key is deliberately masked — the settings UI should treat
  // this as "set / not set" rather than a plaintext round-trip. The raw key
  // is still available via the `lib/scheduler` helpers on the server.
  const storedKey = getSetting('ai_api_key', '');
  const storedCountry = getSetting('app_country', '');
  return NextResponse.json({
    sync_schedule:   getSetting('sync_schedule', 'manual'),
    last_auto_sync:  getSetting('last_auto_sync', '0'),
    sync_running:    getSetting('sync_running',   'false'),
    app_country:     storedCountry || DEFAULT_COUNTRY,
    app_country_explicit: !!storedCountry,
    ai_provider:     normalizeAiProvider(getSetting('ai_provider', 'disabled')),
    ai_api_key:      storedKey ? '__SET__' : '',
    ai_api_key_set:  !!storedKey,
    ai_base_url:     getSetting('ai_base_url', ''),
    ai_model:        getSetting('ai_model', ''),
    ai_summarize_on_import: getSetting('ai_summarize_on_import', 'false'),
    ai_debug_logging: getSetting('ai_debug_logging', 'false'),
    // Per-phase AI request timeouts (ms). Empty string = use the
    // provider-appropriate default (see resolveAiTimeoutMs).
    ai_timeout_direct_ms: getSetting(AI_TIMEOUT_SETTING_KEYS.direct, ''),
    ai_timeout_chunk_ms:  getSetting(AI_TIMEOUT_SETTING_KEYS.chunk, ''),
    ai_timeout_merge_ms:  getSetting(AI_TIMEOUT_SETTING_KEYS.merge, ''),
    // Window (in days) within which the AI Policy tab will surface a
    // "policy text changed recently" banner with a link to the diff on the
    // History tab. 0 disables the banner entirely; default 90.
    policy_diff_alert_days: getSetting('policy_diff_alert_days', '90'),
    // Per-app cooldown between privacy-policy scrapes. When enabled, any
    // scrape (manual Re-sync, background scheduler, or import flow) that
    // fires inside the cooldown short-circuits before hitting the network.
    // Default 60 min; set `policy_scrape_throttle_enabled` to 'false' to
    // disable for dev testing.
    policy_scrape_throttle_enabled: getSetting('policy_scrape_throttle_enabled', 'true') !== 'false',
    policy_scrape_throttle_minutes: getSetting('policy_scrape_throttle_minutes', '60'),
    // Show Wayback-imported history rows inline in the per-app Changelog.
    // Stored as a plain boolean flag: when false, the timeline filters
    // wayback-source snapshots out of its rendering without deleting them
    // (users can re-enable from Settings without re-running the import).
    wayback_show_imported: getSetting('wayback_show_imported', 'true') !== 'false',
    // Show Apple's accessibility nutrition labels (the "Accessibility" shelf
    // that lists VoiceOver/Voice Control/etc. support) in the UI. Scraping
    // always happens regardless of this flag — the setting only gates
    // whether the app detail page, stats page, and grid filter surface the
    // captured data. Default on.
    track_accessibility_labels: getSetting('track_accessibility_labels', 'true') !== 'false',
    // Review-queue progress bar visibility. Read by the Apps page server
    // route to thread into AppGrid → ReviewQueue. Default on.
    queue_show_progress_bar: getSetting('queue_show_progress_bar', 'true') !== 'false',
    // Epoch ms of the last successful cfgutil-based import. Empty string
    // means "user has never imported via cfgutil on this machine". The
    // /onboard device-connect toast is gated on this — without a prior
    // success we don't subscribe to USB attach events at all, so users
    // who never use cfgutil don't pay any of its cost.
    cfgutil_imported_at: getSetting('cfgutil_imported_at', ''),
    admin_token_required: adminTokenRequiredForRequest(request),
  });
}

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'settings.write'),
    limit: 30,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (adminTokenRequiredForRequest(request) && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: 'settings.write.unauthorised',
      actorIp,
      userAgent,
      success: false,
    });
    return NextResponse.json({ error: 'Admin token required' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 16 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid body' },
      { status: 400 },
    );
  }

  const VALID: SyncSchedule[] = ['manual', 'daily', 'weekly'];

  if (body.sync_schedule !== undefined) {
    if (!VALID.includes(body.sync_schedule as SyncSchedule)) {
      return NextResponse.json({ error: 'Invalid schedule' }, { status: 400 });
    }
    setSetting('sync_schedule', body.sync_schedule as string);
  }

  if (body.app_country !== undefined) {
    setSetting('app_country', normalizeCountry(body.app_country));
  }

  if (body.ai_provider !== undefined) {
    if (!AI_PROVIDERS.includes(body.ai_provider as (typeof AI_PROVIDERS)[number])) {
      return NextResponse.json({ error: 'Invalid AI provider' }, { status: 400 });
    }
    const provider = normalizeAiProvider(body.ai_provider);
    setSetting('ai_provider', provider);
  }

  if (body.ai_api_key !== undefined) {
    // Ignore the masked sentinel — it means the UI hasn't touched the key.
    const raw = String(body.ai_api_key ?? '');
    if (raw !== '__SET__') {
      // Trim + reject anything implausibly long; api keys are <=512 chars.
      if (raw.length > 512) {
        return NextResponse.json({ error: 'API key too long' }, { status: 400 });
      }
      setSetting('ai_api_key', raw.trim());
    }
  }

  if (body.ai_base_url !== undefined) {
    const raw = String(body.ai_base_url ?? '').trim();
    if (raw === '') {
      setSetting('ai_base_url', '');
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
          { status: 400 },
        );
      }
      setSetting('ai_base_url', verdict.url!.toString());
    }
  }

  if (body.ai_model !== undefined) {
    const raw = String(body.ai_model ?? '').trim();
    if (raw.length > 200) {
      return NextResponse.json({ error: 'ai_model too long' }, { status: 400 });
    }
    setSetting('ai_model', raw);
  }

  if (body.ai_summarize_on_import !== undefined) {
    setSetting('ai_summarize_on_import', body.ai_summarize_on_import ? 'true' : 'false');
  }

  if (body.ai_debug_logging !== undefined) {
    setSetting('ai_debug_logging', body.ai_debug_logging ? 'true' : 'false');
  }

  // Per-phase AI timeouts. Empty string / null clears the setting and
  // reverts to the provider-appropriate default on the next AI call.
  for (const phase of AI_TIMEOUT_PHASES) {
    const key = `ai_timeout_${phase}_ms`;
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === '' || raw === null) {
      setSetting(AI_TIMEOUT_SETTING_KEYS[phase], '');
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < AI_TIMEOUT_MIN_MS || parsed > AI_TIMEOUT_MAX_MS) {
      return NextResponse.json(
        {
          error: `${key} must be between ${AI_TIMEOUT_MIN_MS} and ${AI_TIMEOUT_MAX_MS} ms`,
        },
        { status: 400 },
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
        { error: 'policy_diff_alert_days must be 0–3650' },
        { status: 400 },
      );
    }
    setSetting('policy_diff_alert_days', String(Math.floor(raw)));
  }

  if (body.policy_scrape_throttle_enabled !== undefined) {
    // Stored as 'true' / 'false' string for consistency with the other
    // boolean settings. The lib-side guard treats any non-'false' value as
    // enabled (so old installs without the key default on).
    setSetting(
      'policy_scrape_throttle_enabled',
      body.policy_scrape_throttle_enabled ? 'true' : 'false',
    );
  }

  if (body.wayback_show_imported !== undefined) {
    setSetting('wayback_show_imported', body.wayback_show_imported ? 'true' : 'false');
  }

  if (body.track_accessibility_labels !== undefined) {
    setSetting(
      'track_accessibility_labels',
      body.track_accessibility_labels ? 'true' : 'false',
    );
  }

  if (body.queue_show_progress_bar !== undefined) {
    setSetting(
      'queue_show_progress_bar',
      body.queue_show_progress_bar ? 'true' : 'false',
    );
  }

  if (body.cfgutil_imported_at !== undefined) {
    // Accept either a number (epoch ms) or '' to clear. Reject anything
    // implausibly old or in the future — the value is informational so
    // we don't need to be strict, but we want to catch obvious junk.
    const raw = body.cfgutil_imported_at;
    if (raw === '' || raw === null) {
      setSetting('cfgutil_imported_at', '');
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > Date.now() + 60_000) {
        return NextResponse.json(
          { error: 'cfgutil_imported_at must be a recent epoch ms timestamp or empty' },
          { status: 400 },
        );
      }
      setSetting('cfgutil_imported_at', String(Math.floor(parsed)));
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
        { error: 'policy_scrape_throttle_minutes must be 0–10080' },
        { status: 400 },
      );
    }
    setSetting('policy_scrape_throttle_minutes', String(Math.floor(raw)));
  }

  recordAudit({
    action: 'settings.write.success',
    actorIp,
    userAgent,
    success: true,
    detail: Object.keys(body).join(','),
  });

  return NextResponse.json({ success: true });
}
