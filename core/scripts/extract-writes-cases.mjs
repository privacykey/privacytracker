/**
 * Write-route oracle for the Rust server (Phase 4, batch 1).
 *
 * Runs the REAL Next handlers of the twenty settings-style writes — the
 * `POST`/`PUT`/`DELETE` exports of seventeen route files — against a
 * scratch database and records, per case: the request (method, path,
 * query, headers, raw body), the environment that matters (the admin
 * token), the setup rows, every write the handler made in order with its
 * transaction markers, the four tables a settings write can touch, and
 * the wire response (status, body, content-type, Retry-After and
 * Set-Cookie). `core/src/server/writes_tests.rs` replays each case through
 * the same body reader and handler the axum routes use.
 *
 * Determinism: the clock is frozen (`now`), `crypto.randomUUID` is a
 * counter (audit and activity ids), and every case sends a distinct
 * `x-forwarded-for` behind `PRIVACYTRACKER_TRUST_PROXY=1` so Node's
 * process-wide inbound rate limiter keeps one bucket per case. A burst case
 * (`repeat`) sends limit+1 identical requests and records the last
 * response; the Rust replay does the same against a fresh limiter.
 *
 * The bind host is loopback, so the admin token is required only when a
 * case sets one — the same two states the Rust replay drives.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-writes-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;
delete process.env.PRIVACYTRACKER_RUNTIME;
delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;

const now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};

let idCounter = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: nextId,
  configurable: true,
  writable: true,
});
nodeCrypto.randomUUID = nextId;

const { default: db } = await import("../../lib/db.ts");

let recording = null;
const realPrepare = db.prepare.bind(db);
const realTransaction = db.transaction.bind(db);
db.prepare = (sql) => {
  const stmt = realPrepare(sql);
  const run = stmt.run.bind(stmt);
  stmt.run = (...params) => {
    if (recording) {
      recording.push({ sql, params });
    }
    return run(...params);
  };
  return stmt;
};
db.transaction = (fn) => {
  const tx = realTransaction(fn);
  return (...args) => {
    if (recording) {
      recording.push({ sql: "BEGIN", params: [] });
    }
    try {
      const out = tx(...args);
      if (recording) {
        recording.push({ sql: "COMMIT", params: [] });
      }
      return out;
    } catch (error) {
      if (recording) {
        recording.push({ sql: "ROLLBACK", params: [] });
      }
      throw error;
    }
  };
};

const ROUTES = [
  "date-format",
  "locale",
  "preferences",
  "settings",
  "settings/desktop",
  "notification-prefs",
  "focus",
  "accessibility-profile",
  "privacy-profile",
  "feature-flags/overrides",
  "feature-flags/overrides/[key]",
  "dashboard/layout",
  "dashboard/layout/preset",
  "coachmark-state",
  "dev-menu-state",
  "welcomed-at",
  "migration-flow/consume",
];
const handlers = {};
for (const route of ROUTES) {
  handlers[`/api/${route}`] = await import(`../../app/api/${route}/route.ts`);
}
const { DASHBOARD_PRESETS } = await import("../../lib/dashboard-layout.ts");
const { PROFILE_PRESETS } = await import("../../lib/privacy-profile.ts");

db.pragma("foreign_keys = OFF");
for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = [
  "app_settings",
  "feature_flag_overrides",
  "activity_log",
  "audit_log",
];
const setting = (key, value) => ({
  sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
  params: [key, value],
});
const override = (key, value, quarantined = 0) => ({
  sql: "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, ?, ?, ?)",
  params: [key, value, 1_700_000_000_000, "user", null, quarantined],
});

const cases = [];
let ipCounter = 0;
async function run(name, spec) {
  const {
    route,
    method,
    param,
    search = "",
    json,
    raw,
    headers = {},
    setup = [],
    adminToken = null,
    repeat = 1,
    contentLength,
  } = spec;
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.1`;
  const body = json === undefined ? (raw ?? null) : JSON.stringify(json);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "writes-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const pathname =
    param === undefined
      ? route
      : route.replace("[key]", encodeURIComponent(param));
  db.exec("SAVEPOINT writes_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let expected;
    for (let i = 0; i < repeat; i++) {
      const request = new NextRequest(
        `http://127.0.0.1:3000${pathname}${search}`,
        {
          method,
          headers: sent,
          body: body === null ? undefined : body,
        }
      );
      const handler = handlers[route][method];
      try {
        const response =
          param === undefined
            ? await handler(request)
            : await handler(request, {
                params: Promise.resolve({ key: param }),
              });
        expected = {
          status: response.status,
          body: await response.text(),
          type: response.headers.get("content-type"),
          retryAfter: response.headers.get("retry-after"),
          setCookie: response.headers.get("set-cookie"),
        };
      } catch (error) {
        // A throw is Next's generic 500; only the status is contractual.
        expected = {
          status: 500,
          body: "",
          type: null,
          retryAfter: null,
          setCookie: null,
          thrown: String(error?.message ?? error),
        };
      }
    }
    recording = null;
    const rows = {};
    for (const table of TABLES) {
      rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    cases.push({
      name,
      route,
      method,
      param: param ?? null,
      pathname,
      search,
      query: [...new URLSearchParams(search)],
      headers: sent,
      body,
      adminToken,
      repeat,
      setup,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO writes_case; RELEASE writes_case");
  }
}

/** The body-reader paths every JSON route shares. */
async function bodyCases(route, method, limit, extra = {}) {
  await run(`${route} ${method} empty body`, { route, method, ...extra });
  await run(`${route} ${method} invalid json`, {
    route,
    method,
    raw: "{not json",
    ...extra,
  });
  await run(`${route} ${method} declared too large`, {
    route,
    method,
    json: {},
    contentLength: limit + 1,
    ...extra,
  });
  await run(`${route} ${method} streamed too large`, {
    route,
    method,
    raw: `{"pad":"${"x".repeat(limit)}"}`,
    ...extra,
  });
}

/** The guard's two denials: admin token missing, and the burst past the limit. */
async function guardCases(route, method, limit, extra = {}) {
  await run(`${route} ${method} admin token required`, {
    route,
    method,
    adminToken: "secret-token",
    ...extra,
  });
  await run(`${route} ${method} admin token accepted`, {
    route,
    method,
    adminToken: "secret-token",
    headers: { "x-auditor-admin-token": "secret-token" },
    ...extra,
  });
  await run(`${route} ${method} rate limited`, {
    route,
    method,
    repeat: limit + 1,
    ...extra,
  });
}

// ── /api/date-format ─────────────────────────────────────────────────
{
  const route = "/api/date-format";
  const method = "POST";
  await run("date-format iso", { route, method, json: { mode: "iso" } });
  await run("date-format case-sensitive", {
    route,
    method,
    json: { mode: "ISO" },
  });
  await run("date-format non-string mode", {
    route,
    method,
    json: { mode: 5 },
  });
  await run("date-format manifest body", {
    route,
    method,
    json: { format: "iso" },
  });
  await run("date-format string body", { route, method, json: "iso" });
  await run("date-format null body", { route, method, json: null });
  await bodyCases(route, method, 1024);
}

// ── /api/locale ──────────────────────────────────────────────────────
{
  const route = "/api/locale";
  const method = "POST";
  await run("locale zh", { route, method, json: { locale: "zh" } });
  await run("locale manifest body", { route, method, json: { locale: "en" } });
  await run("locale unsupported", { route, method, json: { locale: "fr" } });
  await run("locale missing", { route, method, json: {} });
  await run("locale wrong case", { route, method, json: { locale: "EN" } });
  await run("locale null body", { route, method, json: null });
  await bodyCases(route, method, 1024);
}

// ── /api/preferences ─────────────────────────────────────────────────
{
  const route = "/api/preferences";
  const method = "PUT";
  await run("preferences dismiss", {
    route,
    method,
    json: { dismissManualAppsBanner: true },
  });
  await run("preferences resurface", {
    route,
    method,
    json: { dismissManualAppsBanner: false },
    setup: [setting("manual_apps_banner_dismissed_at", "1700000000000")],
  });
  await run("preferences null resurfaces", {
    route,
    method,
    json: { dismissManualAppsBanner: null },
    setup: [setting("manual_apps_banner_dismissed_at", "1700000000000")],
  });
  await run("preferences wrong type", {
    route,
    method,
    json: { dismissManualAppsBanner: "yes" },
  });
  await run("preferences manifest body", {
    route,
    method,
    json: { theme: "dark" },
  });
  await run("preferences null body", { route, method, json: null });
  await run("preferences array body", { route, method, json: [] });
  await bodyCases(route, method, 4 * 1024);
}

// ── /api/settings ────────────────────────────────────────────────────
{
  const route = "/api/settings";
  const method = "POST";
  await run("settings manifest body", {
    route,
    method,
    json: { app_store_region: "us" },
  });
  await run("settings everything valid", {
    route,
    method,
    setup: [setting("ai_provider", "disabled")],
    json: {
      sync_schedule: "daily",
      app_country: " GB ",
      ai_provider: "anthropic",
      ai_api_key: "  sk-live-key  ",
      ai_base_url: "http://localhost:11434",
      ai_model: " claude ",
      ai_summarize_on_import: 1,
      ai_debug_logging: 0,
      ai_timeout_direct_ms: "60000.9",
      ai_timeout_chunk_ms: "",
      ai_timeout_merge_ms: null,
      policy_diff_alert_days: "30.7",
      policy_scrape_throttle_enabled: false,
      policy_scrape_disabled: true,
      wayback_show_imported: "no",
      track_accessibility_labels: null,
      queue_show_progress_bar: "",
      cfgutil_imported_at: now - 1000,
      policy_scrape_throttle_minutes: 90,
      notification_webhook_url: "https://hooks.slack.com/services/T1/B2/X3",
      notification_webhook_format: "discord",
      notification_webhook_frequency: "off",
      notification_quiet_hours_start: " 22:00 ",
      notification_quiet_hours_end: "07:30",
      background_wizard_completed_at: 1_700_000_000_000.7,
      background_wizard_dismissed_at: "",
    },
  });
  await run("settings provider unchanged keeps key", {
    route,
    method,
    setup: [setting("ai_provider", "openai"), setting("ai_api_key", "keep-me")],
    json: { ai_provider: "openai" },
  });
  await run("settings provider switch clears key", {
    route,
    method,
    setup: [setting("ai_provider", "openai"), setting("ai_api_key", "keep-me")],
    json: { ai_provider: "custom" },
  });
  await run("settings ollama is rejected before normalisation", {
    route,
    method,
    json: { ai_provider: "ollama" },
  });
  await run("settings partial write then 400", {
    route,
    method,
    json: { sync_schedule: "weekly", ai_provider: "bogus" },
  });
  await run("settings invalid schedule", {
    route,
    method,
    json: { sync_schedule: "hourly" },
  });
  await run("settings api key sentinel", {
    route,
    method,
    json: { ai_api_key: "__SET__" },
  });
  await run("settings api key too long", {
    route,
    method,
    json: { ai_api_key: "k".repeat(513) },
  });
  await run("settings api key cleared", {
    route,
    method,
    json: { ai_api_key: null },
  });
  await run("settings base url cleared", {
    route,
    method,
    json: { ai_base_url: "  " },
  });
  await run("settings base url ftp", {
    route,
    method,
    json: { ai_base_url: "ftp://x.example/" },
  });
  await run("settings base url metadata host", {
    route,
    method,
    json: { ai_base_url: "http://169.254.169.254/latest" },
  });
  await run("settings base url unparseable", {
    route,
    method,
    json: { ai_base_url: "nope" },
  });
  await run("settings base url normalised", {
    route,
    method,
    json: { ai_base_url: "HTTPS://Api.Example.com/v1/../v2" },
  });
  await run("settings model too long", {
    route,
    method,
    json: { ai_model: "m".repeat(201) },
  });
  await run("settings timeout too low", {
    route,
    method,
    json: { ai_timeout_direct_ms: 5000 },
  });
  await run("settings timeout not a number", {
    route,
    method,
    json: { ai_timeout_chunk_ms: "abc" },
  });
  await run("settings timeout too high", {
    route,
    method,
    json: { ai_timeout_merge_ms: 900001 },
  });
  await run("settings alert days negative", {
    route,
    method,
    json: { policy_diff_alert_days: -1 },
  });
  await run("settings alert days zero", {
    route,
    method,
    json: { policy_diff_alert_days: "0" },
  });
  await run("settings cfgutil future", {
    route,
    method,
    json: { cfgutil_imported_at: now + 120_000 },
  });
  await run("settings cfgutil junk", {
    route,
    method,
    json: { cfgutil_imported_at: "abc" },
  });
  await run("settings cfgutil cleared", {
    route,
    method,
    json: { cfgutil_imported_at: null },
  });
  await run("settings throttle minutes too high", {
    route,
    method,
    json: { policy_scrape_throttle_minutes: 20_000 },
  });
  await run("settings webhook private host", {
    route,
    method,
    json: { notification_webhook_url: "http://10.0.0.1/hook" },
  });
  await run("settings webhook sentinel", {
    route,
    method,
    setup: [
      setting("notification_webhook_url", "https://hooks.example.com/abc/def"),
    ],
    json: { notification_webhook_url: "__SET__" },
  });
  await run("settings webhook masked round trip", {
    route,
    method,
    setup: [
      setting("notification_webhook_url", "https://hooks.example.com/abc/def"),
    ],
    json: { notification_webhook_url: "https://hooks.example.com/abc/***" },
  });
  await run("settings webhook configured round trip", {
    route,
    method,
    setup: [
      setting("notification_webhook_url", "https://hooks.example.com/abc/def"),
    ],
    json: { notification_webhook_url: "configured" },
  });
  await run("settings webhook configured without stored", {
    route,
    method,
    json: { notification_webhook_url: "configured" },
  });
  await run("settings webhook cleared", {
    route,
    method,
    json: { notification_webhook_url: "" },
  });
  await run("settings webhook format invalid", {
    route,
    method,
    json: { notification_webhook_format: "sms" },
  });
  await run("settings webhook format null", {
    route,
    method,
    json: { notification_webhook_format: null },
  });
  await run("settings webhook frequency invalid", {
    route,
    method,
    json: { notification_webhook_frequency: "hourly" },
  });
  await run("settings quiet hours invalid", {
    route,
    method,
    json: { notification_quiet_hours_start: "25:00" },
  });
  await run("settings quiet hours end invalid", {
    route,
    method,
    json: { notification_quiet_hours_end: "7:30" },
  });
  await run("settings quiet hours cleared", {
    route,
    method,
    json: {
      notification_quiet_hours_start: null,
      notification_quiet_hours_end: "",
    },
  });
  await run("settings wizard completed negative", {
    route,
    method,
    json: { background_wizard_completed_at: "-5" },
  });
  await run("settings wizard dismissed junk", {
    route,
    method,
    json: { background_wizard_dismissed_at: "soon" },
  });
  await run("settings wizard dismissed cleared", {
    route,
    method,
    json: { background_wizard_dismissed_at: null },
  });
  await run("settings string body", { route, method, json: "ab" });
  await run("settings number body", { route, method, json: 5 });
  await run("settings array body", { route, method, json: [1] });
  await run("settings null body", { route, method, json: null });
  await bodyCases(route, method, 16 * 1024);
  await guardCases(route, method, 30, { json: { app_country: "au" } });
}

// ── /api/settings/desktop ────────────────────────────────────────────
{
  const route = "/api/settings/desktop";
  const method = "POST";
  await run("desktop manifest body", {
    route,
    method,
    json: { desktop_hide_dock: false },
  });
  await run("desktop every key", {
    route,
    method,
    json: {
      hide_dock: true,
      launch_hidden: "yes",
      autostart: 0,
      native_notifications: null,
      global_shortcut: "Cmd+X",
      require_unlock: true,
      auto_lock_idle_minutes: "30.9",
      theme_override: "dark",
      devtools_open: true,
      tray_visible: false,
      zoom_level: "1.25",
    },
  });
  await run("desktop rejected values are skipped", {
    route,
    method,
    json: {
      global_shortcut: "",
      auto_lock_idle_minutes: 2000,
      theme_override: "blue",
      zoom_level: 5,
      desktop_global_shortcut: "x".repeat(65),
    },
  });
  await run("desktop numeric zoom and minutes", {
    route,
    method,
    json: { zoom_level: 2, auto_lock_idle_minutes: 45.5 },
  });
  await run("desktop short and legacy names both apply", {
    route,
    method,
    json: { hide_dock: true, desktop_hide_dock: false },
  });
  await run("desktop array body", { route, method, json: [] });
  await run("desktop string body", { route, method, json: "x" });
  await run("desktop null body", { route, method, json: null });
  await bodyCases(route, method, 16 * 1024);
  await guardCases(route, method, 20, { json: { tray_visible: true } });
}

// ── /api/notification-prefs ──────────────────────────────────────────
{
  const route = "/api/notification-prefs";
  const method = "PUT";
  await run("notification-prefs manifest body", {
    route,
    method,
    json: { prefs: { bell: true } },
  });
  await run("notification-prefs mixed keys", {
    route,
    method,
    setup: [override("flag.notifications.types.new_privacy_types", "on")],
    json: {
      prefs: {
        label_changes: false,
        policy_updates: true,
        accessibility_changes: "true",
        labelChanges: true,
        x: 1,
      },
    },
  });
  await run("notification-prefs clear", {
    route,
    method,
    setup: [
      override("flag.notifications.types.label_changes", "off"),
      setting("notification_prefs", '{"labelChanges":false}'),
    ],
    json: { prefs: null },
  });
  await run("notification-prefs missing", { route, method, json: {} });
  await run("notification-prefs string prefs", {
    route,
    method,
    json: { prefs: "str" },
  });
  await run("notification-prefs resolver failure falls back to the blob", {
    route,
    method,
    setup: [
      setting("flag.focus.audience", "garbage"),
      setting("notification_prefs", '{"labelChanges":false,"nope":true}'),
    ],
    json: { prefs: { label_changes: true, policyUpdates: false } },
  });
  await run("notification-prefs null body", { route, method, json: null });
  await run("notification-prefs array body", { route, method, json: [] });
  await bodyCases(route, method, 8 * 1024);
}

// ── /api/focus ───────────────────────────────────────────────────────
{
  const route = "/api/focus";
  const method = "POST";
  await run("focus manifest body", {
    route,
    method,
    json: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
  });
  await run("focus minimal wins", {
    route,
    method,
    json: { audience: "self", monitor: true, cleanup: true, minimal: true },
  });
  await run("focus truthy coercions", {
    route,
    method,
    json: {
      audience: "loved_one",
      monitor: "yes",
      cleanup: 0,
      accessibility: "",
    },
  });
  await run("focus explicit workflow", {
    route,
    method,
    json: { audience: "loved_one", workflow: "other_handoff" },
  });
  await run("focus invalid workflow", {
    route,
    method,
    json: { audience: "self", workflow: "nope" },
  });
  await run("focus invalid audience", {
    route,
    method,
    json: { audience: "family" },
  });
  await run("focus missing audience", {
    route,
    method,
    json: { monitor: true },
  });
  await run("focus age band set", {
    route,
    method,
    json: { audience: "guardian", childAgeBand: "9_12" },
  });
  await run("focus age band cleared", {
    route,
    method,
    setup: [setting("guardian_child_age_band", "9_12")],
    json: { audience: "guardian", childAgeBand: null },
  });
  await run("focus age band empty", {
    route,
    method,
    setup: [setting("guardian_child_age_band", "9_12")],
    json: { audience: "self", childAgeBand: "" },
  });
  await run("focus age band kept when absent", {
    route,
    method,
    setup: [setting("guardian_child_age_band", "13_15")],
    json: { audience: "self" },
  });
  await run("focus age band invalid", {
    route,
    method,
    json: { audience: "guardian", childAgeBand: "adult" },
  });
  await run("focus string body", { route, method, json: "self" });
  await run("focus null body", { route, method, json: null });
  await bodyCases(route, method, 4 * 1024);
}

// ── /api/privacy-profile ─────────────────────────────────────────────
{
  const route = "/api/privacy-profile";
  const method = "PUT";
  await run("privacy-profile preset from nothing", {
    route,
    method,
    json: { profile: PROFILE_PRESETS.strict },
  });
  await run("privacy-profile custom sparse", {
    route,
    method,
    json: {
      profile: {
        LOCATION: "linked",
        BOGUS: "linked",
        CONTACTS: "nope",
        OTHER: 5,
      },
    },
  });
  await run("privacy-profile preset switch", {
    route,
    method,
    setup: [setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict))],
    json: { profile: PROFILE_PRESETS.balanced },
  });
  await run("privacy-profile same preset", {
    route,
    method,
    setup: [setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict))],
    json: { profile: PROFILE_PRESETS.strict },
  });
  await run("privacy-profile custom edit of a preset", {
    route,
    method,
    setup: [setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict))],
    json: { profile: { ...PROFILE_PRESETS.strict, OTHER: "tracking" } },
  });
  await run("privacy-profile cleared", {
    route,
    method,
    setup: [
      setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.anti_tracking)),
    ],
    json: { profile: null },
  });
  await run("privacy-profile cleared when custom", {
    route,
    method,
    setup: [setting("privacy_profile", '{"LOCATION":"linked"}')],
    json: { profile: null },
  });
  await run("privacy-profile cleared when empty", {
    route,
    method,
    json: { profile: null },
  });
  await run("privacy-profile missing", { route, method, json: {} });
  await run("privacy-profile string profile", {
    route,
    method,
    json: { profile: "str" },
  });
  await run("privacy-profile array profile", {
    route,
    method,
    json: { profile: ["LOCATION"] },
  });
  await run("privacy-profile null body", { route, method, json: null });
  await bodyCases(route, method, 16 * 1024);
}

// ── /api/accessibility-profile ───────────────────────────────────────
{
  const route = "/api/accessibility-profile";
  const method = "PUT";
  await run("accessibility-profile manifest body", {
    route,
    method,
    json: {
      profile: {
        voiceover: "required",
        voice_control: "required",
        captions: "nice",
      },
    },
  });
  await run("accessibility-profile filtered", {
    route,
    method,
    json: {
      profile: {
        voiceover: "maybe",
        bogus: "required",
        captions: "nice",
        larger_text: 1,
      },
    },
  });
  await run("accessibility-profile cleared", {
    route,
    method,
    setup: [setting("accessibility_profile", '{"captions":"nice"}')],
    json: { profile: null },
  });
  await run("accessibility-profile missing", { route, method, json: {} });
  await run("accessibility-profile string profile", {
    route,
    method,
    json: { profile: "x" },
  });
  await run("accessibility-profile null body", { route, method, json: null });
  await bodyCases(route, method, 16 * 1024);
}

// ── /api/feature-flags/overrides ─────────────────────────────────────
{
  const route = "/api/feature-flags/overrides";
  await run("overrides manifest body", {
    route,
    method: "POST",
    json: { key: "flag.about.ai_disclosure", value: "off" },
  });
  await run("overrides previous focus is stored", {
    route,
    method: "POST",
    setup: [
      setting("flag.focus.audience", "guardian"),
      setting("flag.focus.goal.monitor", "true"),
      setting("ai_provider", "openai"),
      override("flag.about.ai_disclosure", "on", 1),
    ],
    json: { key: "flag.about.ai_disclosure", value: "collapsed" },
  });
  await run("overrides upsert", {
    route,
    method: "POST",
    setup: [override("flag.about.ai_disclosure", "on")],
    json: { key: "flag.about.ai_disclosure", value: "off" },
  });
  await run("overrides unknown key", {
    route,
    method: "POST",
    json: { key: "flag.nope", value: "on" },
  });
  await run("overrides non-string key", {
    route,
    method: "POST",
    json: { key: 5, value: "on" },
  });
  await run("overrides missing key", {
    route,
    method: "POST",
    json: { value: "on" },
  });
  await run("overrides invalid value", {
    route,
    method: "POST",
    json: { key: "flag.about.ai_disclosure", value: "maybe" },
  });
  await run("overrides missing value", {
    route,
    method: "POST",
    json: { key: "flag.about.ai_disclosure" },
  });
  await run("overrides bulk import", {
    route,
    method: "POST",
    setup: [
      override("flag.about.ai_disclosure", "on"),
      override("flag.retired.thing", "on", 1),
      setting("flag.focus.audience", "self"),
    ],
    json: {
      key: "flag.about.ai_disclosure",
      value: "on",
      flags: [
        { key: "flag.about.ai_disclosure", override: "off" },
        { key: "flag.nope", override: "on" },
        { key: "flag.dashboard.layout_editor.visible", override: null },
        { key: 5, override: "on" },
        null,
        "str",
        { key: "flag.about.ai_disclosure", override: "sideways" },
        { key: "flag.dashboard.layout_editor.visible", override: "collapsed" },
        { key: "flag.also.nope" },
      ],
    },
  });
  await run("overrides bulk empty", {
    route,
    method: "POST",
    setup: [override("flag.about.ai_disclosure", "on")],
    json: { flags: [] },
  });
  await run("overrides bulk not an array", {
    route,
    method: "POST",
    json: { flags: "x", key: "flag.about.ai_disclosure", value: "on" },
  });
  await run("overrides null body", { route, method: "POST", json: null });
  await run("overrides string body", { route, method: "POST", json: "x" });
  await bodyCases(route, "POST", 64 * 1024);
  await guardCases(route, "POST", 30, {
    json: { key: "flag.about.ai_disclosure", value: "on" },
  });

  const seeded = [
    override("flag.about.ai_disclosure", "off"),
    override("flag.dashboard.layout_editor.visible", "off"),
    override("flag.retired.thing", "on", 1),
  ];
  await run("overrides clear all", { route, method: "DELETE", setup: seeded });
  await run("overrides clear surface", {
    route,
    method: "DELETE",
    search: "?surface=dashboard",
    setup: seeded,
  });
  await run("overrides clear empty surface", {
    route,
    method: "DELETE",
    search: "?surface=",
    setup: seeded,
  });
  await run("overrides clear first surface", {
    route,
    method: "DELETE",
    search: "?surface=about&surface=dashboard",
    setup: seeded,
  });
  await run("overrides clear like wildcard is literal", {
    route,
    method: "DELETE",
    search: "?surface=%25",
    setup: seeded,
  });
  await guardCases(route, "DELETE", 10);
}

// ── /api/feature-flags/overrides/[key] ───────────────────────────────
{
  const route = "/api/feature-flags/overrides/[key]";
  const method = "DELETE";
  await run("override clear one", {
    route,
    method,
    param: "flag.about.ai_disclosure",
    setup: [
      override("flag.about.ai_disclosure", "off"),
      override("flag.dashboard.layout_editor.visible", "off"),
    ],
  });
  await run("override clear one unknown", {
    route,
    method,
    param: "flag.nope",
  });
  await run("override clear one quarantined too", {
    route,
    method,
    param: "flag.about.ai_disclosure",
    setup: [override("flag.about.ai_disclosure", "off", 1)],
  });
  await guardCases(route, method, 30, { param: "flag.about.ai_disclosure" });
}

// ── /api/dashboard/layout ────────────────────────────────────────────
{
  const route = "/api/dashboard/layout";
  await run("layout save preset shape", {
    route,
    method: "PUT",
    json: { layout: DASHBOARD_PRESETS.minimal },
  });
  await run("layout save custom", {
    route,
    method: "PUT",
    json: {
      layout: {
        v: 1,
        order: ["activity", "bogus", "stats", "activity"],
        hidden: ["stats", "callout_manual_apps", "nope"],
      },
    },
  });
  await run("layout save default from custom", {
    route,
    method: "PUT",
    setup: [
      setting(
        "dashboard.layout",
        '{"v":1,"order":["stats"],"hidden":["activity"]}'
      ),
    ],
    json: { layout: { v: 1, order: [], hidden: [] } },
  });
  await run("layout save array", {
    route,
    method: "PUT",
    json: { layout: [] },
  });
  await run("layout save string", {
    route,
    method: "PUT",
    json: { layout: "x" },
  });
  await run("layout save missing", { route, method: "PUT", json: {} });
  await run("layout save null body", { route, method: "PUT", json: null });
  await run("layout save admin token not required", {
    route,
    method: "PUT",
    adminToken: "secret-token",
    json: { layout: DASHBOARD_PRESETS.watchdog },
  });
  await bodyCases(route, "PUT", 8 * 1024);
  await run("layout save rate limited", {
    route,
    method: "PUT",
    repeat: 61,
    json: { layout: { v: 1, order: ["stats"], hidden: [] } },
  });

  await run("layout reset from custom", {
    route,
    method: "DELETE",
    setup: [
      setting(
        "dashboard.layout",
        '{"v":1,"order":["stats"],"hidden":["activity"]}'
      ),
    ],
  });
  await run("layout reset from default", { route, method: "DELETE" });
  await run("layout reset from minimal", {
    route,
    method: "DELETE",
    setup: [
      setting("dashboard.layout", JSON.stringify(DASHBOARD_PRESETS.minimal)),
    ],
  });
  await run("layout reset admin token not required", {
    route,
    method: "DELETE",
    adminToken: "secret-token",
  });
  await run("layout reset rate limited", {
    route,
    method: "DELETE",
    repeat: 21,
  });
}

// ── /api/dashboard/layout/preset ─────────────────────────────────────
{
  const route = "/api/dashboard/layout/preset";
  const method = "POST";
  await run("preset manifest body", {
    route,
    method,
    json: { preset: "minimal" },
  });
  await run("preset idempotent", {
    route,
    method,
    setup: [
      setting("dashboard.layout", JSON.stringify(DASHBOARD_PRESETS.caretaker)),
    ],
    json: { preset: "caretaker" },
  });
  await run("preset unknown", { route, method, json: { preset: "nope" } });
  await run("preset missing", { route, method, json: {} });
  await run("preset null body", { route, method, json: null });
  await bodyCases(route, method, 1024);
  await run("preset rate limited", {
    route,
    method,
    repeat: 31,
    json: { preset: "default" },
  });
}

// ── /api/coachmark-state and /api/dev-menu-state ─────────────────────
for (const [route, field] of [
  ["/api/coachmark-state", "completed"],
  ["/api/dev-menu-state", "enabled"],
]) {
  const method = "POST";
  await run(`${route} set true`, { route, method, json: { [field]: true } });
  await run(`${route} set false`, {
    route,
    method,
    setup: [
      setting(
        route === "/api/coachmark-state"
          ? "coachmark_tour_done"
          : "dev_menu_enabled",
        "true"
      ),
    ],
    json: { [field]: false },
  });
  await run(`${route} wrong type`, { route, method, json: { [field]: "yes" } });
  await run(`${route} array body`, { route, method, json: [] });
  await run(`${route} null body`, { route, method, json: null });
  await run(`${route} admin token not required`, {
    route,
    method,
    adminToken: "secret-token",
    json: { [field]: true },
  });
  await bodyCases(route, method, 4 * 1024);
  await run(`${route} rate limited`, {
    route,
    method,
    repeat: 31,
    json: { [field]: true },
  });
}

// ── /api/welcomed-at ─────────────────────────────────────────────────
{
  const route = "/api/welcomed-at";
  const method = "POST";
  await run("welcomed-at no body", { route, method });
  await run("welcomed-at unconditional", {
    route,
    method,
    setup: [setting("welcomed_at", "123")],
    json: {},
  });
  await run("welcomed-at if unset when set", {
    route,
    method,
    setup: [setting("welcomed_at", "123")],
    json: { ifUnset: true },
  });
  await run("welcomed-at if unset when empty", {
    route,
    method,
    setup: [setting("welcomed_at", "")],
    json: { ifUnset: true },
  });
  await run("welcomed-at if unset when unset", {
    route,
    method,
    json: { ifUnset: true },
  });
  await run("welcomed-at if unset string is false", {
    route,
    method,
    json: { ifUnset: "true" },
  });
  await run("welcomed-at invalid json", { route, method, raw: "{nope" });
  await run("welcomed-at too large is swallowed", {
    route,
    method,
    raw: `{"pad":"${"x".repeat(1024)}"}`,
  });
  await run("welcomed-at null body", { route, method, json: null });
  await run("welcomed-at admin token not required", {
    route,
    method,
    adminToken: "secret-token",
  });
  await run("welcomed-at rate limited", { route, method, repeat: 61 });
}

// ── /api/migration-flow/consume ──────────────────────────────────────
{
  const route = "/api/migration-flow/consume";
  const method = "POST";
  await run("migration-flow nothing pending", { route, method });
  await run("migration-flow pending", {
    route,
    method,
    setup: [
      setting(
        "migration_flow_pending",
        '{"recommenderName":"Bob","stashedAt":1,"targetPath":"/dashboard/review-recommendations"}'
      ),
    ],
  });
  await run("migration-flow relative path and non-string name", {
    route,
    method,
    setup: [
      setting(
        "migration_flow_pending",
        '{"recommenderName":5,"targetPath":"dashboard"}'
      ),
    ],
  });
  await run("migration-flow corrupt marker", {
    route,
    method,
    setup: [setting("migration_flow_pending", "{nope")],
  });
  await run("migration-flow non-object marker", {
    route,
    method,
    setup: [setting("migration_flow_pending", "5")],
  });
  await run("migration-flow admin token not required", {
    route,
    method,
    adminToken: "secret-token",
  });
  await run("migration-flow rate limited", { route, method, repeat: 61 });
}

// ── /api/notification-prefs: the camelCase keys Settings sends ───────
// Appended last: each case's forwarded address comes from a global
// counter, so a case added up in the route's own block would shift every
// later case.
{
  const route = "/api/notification-prefs";
  const method = "PUT";
  await run("notification-prefs camelCase turns policy updates on", {
    route,
    method,
    json: { prefs: { policyUpdates: true } },
  });
  await run("notification-prefs Settings full map", {
    route,
    method,
    setup: [
      override("flag.notifications.types.accessibility_changes", "off"),
      setting("notification_prefs", '{"versionUpdates":true}'),
    ],
    json: {
      prefs: {
        labelChanges: false,
        profileMismatch: true,
        policyUpdates: true,
        versionUpdates: false,
        importCompleted: true,
        manualAppsPrompt: true,
        aiTimeout: false,
      },
    },
  });
  await run("notification-prefs snake_case wins over camelCase", {
    route,
    method,
    json: {
      prefs: {
        policyUpdates: true,
        policy_updates: false,
        labelChanges: false,
        label_changes: true,
        new_privacy_types: true,
      },
    },
  });
  await run("notification-prefs non-boolean camelCase leaves the flag alone", {
    route,
    method,
    setup: [
      override("flag.notifications.types.policy_updates", "on"),
      override("flag.notifications.types.label_changes", "off"),
    ],
    json: { prefs: { policyUpdates: "true", labelChanges: null } },
  });
}

// ── /api/notification-prefs: a save writes only what it changes ──────
// Appended last for the same reason as the block above. A flag the body
// leaves out, or sends at the value it has, is not written; a change onto
// the flag's focus default clears its override; the stored blob is merged.
{
  const route = "/api/notification-prefs";
  const method = "PUT";
  const defaults = {
    labelChanges: true,
    profileMismatch: true,
    policyUpdates: false,
    versionUpdates: true,
    importCompleted: true,
    manualAppsPrompt: true,
    aiTimeout: true,
  };
  await run(
    "notification-prefs Settings save keeps overrides it did not change",
    {
      route,
      method,
      setup: [
        override("flag.notifications.types.accessibility_changes", "on"),
        override("flag.notifications.types.new_privacy_types", "off"),
        override("flag.notifications.types.label_changes", "on"),
        setting("notification_prefs", '{"versionUpdates":true}'),
      ],
      json: { prefs: { ...defaults, versionUpdates: false } },
    }
  );
  await run(
    "notification-prefs Reset defaults clears the overrides it changes",
    {
      route,
      method,
      setup: [
        override("flag.notifications.types.label_changes", "off"),
        override("flag.notifications.types.policy_updates", "on"),
      ],
      json: { prefs: defaults },
    }
  );
  await run("notification-prefs a change onto the focus default clears", {
    route,
    method,
    setup: [
      setting("flag.focus.goal.accessibility", "true"),
      override("flag.notifications.types.accessibility_changes", "off"),
    ],
    json: { prefs: { accessibility_changes: true } },
  });
  await run("notification-prefs a change off the focus default sets", {
    route,
    method,
    setup: [setting("flag.focus.goal.accessibility", "true")],
    json: { prefs: { accessibility_changes: false } },
  });
  await run("notification-prefs kill switch compares with hard defaults", {
    route,
    method,
    setup: [
      override("flag.devopts.feature_flag_system.enabled", "off"),
      override("flag.notifications.types.policy_updates", "on"),
    ],
    json: { prefs: { policyUpdates: false, labelChanges: false } },
  });
  await run("notification-prefs sparse body merges into the stored blob", {
    route,
    method,
    setup: [
      setting(
        "notification_prefs",
        '{"versionUpdates":false,"aiTimeout":false,"nope":true}'
      ),
    ],
    json: { prefs: { aiTimeout: true, policyUpdates: true } },
  });
  await run("notification-prefs unparseable stored blob is replaced", {
    route,
    method,
    setup: [setting("notification_prefs", "{nope")],
    json: { prefs: { versionUpdates: false } },
  });
}

writeFileSync(
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../tests/fixtures/writes-cases.json"
  ),
  `${JSON.stringify({ now, cases }, null, 1)}\n`
);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  `Recorded ${cases.length} actual Node write-route cases; no network.`
);
