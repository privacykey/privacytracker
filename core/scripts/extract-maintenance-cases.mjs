/**
 * Maintenance oracle for the Rust server (Phase 4, batch 5a).
 *
 * Runs the REAL handlers of the health check and self-heal
 * (`POST /api/diagnostics/health` and the startup hook's own 60 s
 * closure), the diagnostics writes (`POST /api/diagnostics/database`,
 * `DELETE /api/diagnostics/errors`, `DELETE`/`POST
 * /api/diagnostics/runtime`, `DELETE /api/ai/debug-log`), the
 * admin-token login and logout, the CSP report ingest, the dev helpers
 * (`reset-changelog`, `seed-notification`, `wipe-apps`) and the two
 * teardowns (`/api/reset`, `/api/admin/start-over`). Records, per case,
 * the request or the callback, the setup rows, every write in order with
 * its transaction markers, the tables these paths touch, the CSP ring,
 * and the wire response with its Set-Cookie.
 *
 * The health check reads this process and this database file — RSS,
 * heap, event-loop lag, page counts, file sizes, the path — so those keys
 * are blanked as they are recorded, wherever they appear (the wire, the
 * persisted blob, the activity detail), and the replay blanks the same
 * keys on its own side; the counts, the heals, the warnings that derive
 * from rows, and the status stay exact. The runtime envelope the two
 * runtime writes answer is this process's own and is compared by status
 * alone, so its body is not recorded. The event-loop monitor is reset
 * before each case so its severity never colours a run.
 *
 * Determinism as before: frozen clock, counted ids, foreign keys ON, a
 * distinct forwarded address per case, the in-process rings and the
 * login brute-force counter reset per case, and the feature-flag
 * migration marker preset so `register()` migrates nothing.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-maintenance-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.NEXT_RUNTIME = "nodejs";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;
delete process.env.PRIVACYTRACKER_RUNTIME;
delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
delete process.env.PRIVACYTRACKER_PARENT_PID;

const now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
  static UTC(...a) {
    return RealDate.UTC(...a);
  }
  static parse(s) {
    return RealDate.parse(s);
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
const realRandomBytes = nodeCrypto.randomBytes;
nodeCrypto.randomBytes = (size, ...rest) =>
  size === 9
    ? Buffer.from(String(++idCounter).padStart(12, "0"), "base64url")
    : realRandomBytes(size, ...rest);
syncBuiltinESMExports();

// Timers captured while the startup hook registers its tickers. Only the
// closures matter; the handles satisfy `.unref()`.
let capturedTimers = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
let capturing = false;
const fakeHandle = () => ({
  unref() {
    return this;
  },
  ref() {
    return this;
  },
  hasRef() {
    return false;
  },
  refresh() {
    return this;
  },
  [Symbol.toPrimitive]() {
    return 0;
  },
});
globalThis.setTimeout = (fn, ms, ...args) => {
  if (capturing) {
    capturedTimers.push({ kind: "timeout", fn, ms });
    return fakeHandle();
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.setInterval = (fn, ms, ...args) => {
  if (capturing) {
    capturedTimers.push({ kind: "interval", fn, ms });
    return fakeHandle();
  }
  return realSetInterval(fn, ms, ...args);
};

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

const { _resetSoftBuckets } = await import("../../lib/rate-limit.ts");

const ROUTES = [
  "diagnostics/health",
  "diagnostics/database",
  "diagnostics/errors",
  "diagnostics/runtime",
  "ai/debug-log",
  "auth/admin-token/login",
  "auth/admin-token/logout",
  "csp-report",
  "dev/reset-changelog",
  "dev/seed-notification",
  "dev/wipe-apps",
  "reset",
  "admin/start-over",
];
const handlers = {};
for (const route of ROUTES) {
  handlers[`/api/${route}`] = await import(`../../app/api/${route}/route.ts`);
}
const { _resetLoginBruteForce } = await import("../../lib/security.ts");
const { clearErrorLog } = await import("../../lib/error-log-ring.ts");
const { resetEventLoopMonitor } = await import(
  "../../lib/runtime-diagnostics.ts"
);

for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = [
  "apps",
  "privacy_types",
  "privacy_categories",
  "privacy_snapshots",
  "change_review_actions",
  "annotations",
  "app_verdicts",
  "shortlist_entries",
  "manual_apps",
  "manual_app_events",
  "imports",
  "import_items",
  "privacy_policy_analyses",
  "feature_flag_overrides",
  "ai_debug_log",
  "notifications",
  "activity_log",
  "audit_log",
  "app_settings",
];

// ── Fixture rows ─────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
// The migration marker (so `register()` migrates nothing) and the runtime
// marker its first, unrecorded run writes. No policy mutex this time: the
// health check would heal it.
const BASE = [
  setting("feature_flag_migration_version", "2"),
  setting("runtime_environment", ""),
];
for (const { sql, params } of BASE) {
  db.prepare(sql).run(...params);
}

const quiet = ["error", "warn", "info", "log"];
function silence() {
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  return () => {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  };
}

const { register } = await import("../../instrumentation.ts");
capturing = true;
capturedTimers = [];
{
  const restore = silence();
  try {
    await register();
  } finally {
    restore();
  }
}
capturing = false;
const bootTimers = capturedTimers;
const callbackFor = (delay) => {
  const found = bootTimers.find((t) => t.kind === "timeout" && t.ms === delay);
  if (!found) {
    throw new Error(`no ${delay}ms timer captured from register()`);
  }
  return found.fn;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;
const A1 = "1001";
const A2 = "1002";
const app = (id, name = `App ${id}`, extra = {}) =>
  stmt(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    url(id),
    now - 5 * DAY,
    now - 5 * DAY,
    extra.changeCount ?? 2,
    extra.ackAt ?? 5,
    extra.snoozedUntil ?? 7
  );
const privacyType = (id, appId) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    appId,
    "DATA_LINKED_TO_YOU",
    "Data Linked to You"
  );
const privacyCategory = (id, typeId) =>
  stmt(
    "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    typeId,
    "CONTACT_INFO",
    "Contact Info"
  );
const snapshot = (id, appId) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source, triggered_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    appId,
    now - DAY,
    "[]",
    "[]",
    "live",
    "manual"
  );
const reviewAction = (id, appId) =>
  stmt(
    "INSERT INTO change_review_actions (id, app_id, action, acted_at, covered_count) VALUES (?, ?, ?, ?, ?)",
    id,
    appId,
    "reviewed",
    now - DAY,
    2
  );
const notification = (id, appId, read = 0) =>
  stmt(
    "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "App",
    "[]",
    now - DAY,
    read
  );
const annotation = (id, appId) =>
  stmt(
    "INSERT INTO annotations (id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "a note",
    "user",
    null,
    "export",
    null,
    now - DAY,
    now - DAY,
    null
  );
const verdict = (id, appId) =>
  stmt(
    "INSERT INTO app_verdicts (id, app_id, verdict, rationale, source, source_name, set_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "safe",
    null,
    "user",
    null,
    now - DAY,
    now - DAY
  );
const manualApp = (id, name) =>
  stmt(
    "INSERT INTO manual_apps (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    "sideloaded",
    null,
    null,
    null,
    null,
    now - DAY,
    now - DAY
  );
const manualEvent = (id, manualAppId) =>
  stmt(
    "INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail) VALUES (?, ?, ?, ?, ?)",
    id,
    manualAppId,
    "field_change",
    now - DAY,
    '{"kind":"field_change","field":"name","from":"a","to":"b"}'
  );
const policyAnalysis = (appId, runStatus, startedAt) =>
  stmt(
    "INSERT INTO privacy_policy_analyses (app_id, policy_url, status, updated_at, run_status, run_started_at, last_run_log) VALUES (?, ?, ?, ?, ?, ?, ?)",
    appId,
    "https://example.test/policy",
    "pending",
    now - DAY,
    runStatus,
    startedAt,
    "[]"
  );
const aiDebugRow = (n) =>
  stmt(
    "INSERT INTO ai_debug_log (id, created_at, app_id, app_name, provider, model, phase, prompt, response, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    `ai-${String(n).padStart(3, "0")}`,
    now - n * 1000,
    A1,
    "App 1001",
    "openai",
    "gpt",
    "direct",
    "prompt",
    "response",
    12,
    null
  );
const flagOverride = (key, value) =>
  stmt(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, 'user', ?, 0)",
    key,
    value,
    now - DAY,
    null
  );
const importRow = (id) =>
  stmt(
    "INSERT INTO imports (id, created_at, completed_at, source, source_label, total, matched, unmatched, imported, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    now - DAY,
    null,
    "manual",
    null,
    1,
    1,
    0,
    1,
    null
  );
const item = (id, importId, appId) =>
  stmt(
    "INSERT INTO import_items (id, import_id, query, edited_query, status, app_id, app_name, developer, url, icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    importId,
    "One",
    null,
    "imported",
    appId,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    0
  );
const shortlist = (id, source, candidate) =>
  stmt(
    "INSERT INTO shortlist_entries (id, source_app_id, candidate_apple_id, candidate_name, candidate_developer, candidate_icon_url, candidate_store_url, candidate_bundle_id, note, added_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    source,
    candidate,
    "Candidate",
    null,
    null,
    url(candidate),
    null,
    null,
    now - DAY,
    "privacy"
  );
const zeroSync = {
  attempted: 0,
  succeeded: 0,
  changes: 0,
  failed: 0,
  rateLimited: 0,
  skipped: 0,
};
const syncState = (queue, updatedAt) =>
  setting(
    "sync_bulk_state",
    JSON.stringify({
      version: 1,
      runId: "run-sync",
      startedAt: now - 8 * HOUR,
      initiator: "manual",
      updatedAt,
      currentAppId: null,
      queue,
      totals: zeroSync,
    })
  );
const waybackState = (queue, updatedAt, status = "running") =>
  setting(
    "wayback_bulk_state",
    JSON.stringify({
      version: 2,
      runId: "run-wayback",
      startedAt: now - 8 * HOUR,
      initiator: "manual",
      updatedAt,
      currentAppId: null,
      status,
      queue,
      totals: {},
      streamRequested: false,
    })
  );
const policyState = (queue, updatedAt) =>
  setting(
    "policy_bulk_state",
    JSON.stringify({
      version: 1,
      runId: "run-policy",
      startedAt: now - 8 * HOUR,
      initiator: "manual",
      updatedAt,
      currentAppId: null,
      phase: "all",
      force: false,
      queue,
      totals: {},
    })
  );
const pending = (appId) => ({
  appId,
  appName: `App ${appId}`,
  status: "pending",
});
const done = (appId) => ({ appId, appName: `App ${appId}`, status: "done" });
const corpus = [
  app(A1, "Instagram"),
  app(A2, "Signal"),
  privacyType("pt-1", A1),
  privacyCategory("pc-1", "pt-1"),
  snapshot("s-1", A1),
  snapshot("s-2", A2),
  reviewAction("ra-1", A1),
  notification("n-1", A1),
  annotation("an-1", A1),
  verdict("v-1", A2),
  manualApp("m-1", "Sideloaded"),
  manualEvent("me-1", "m-1"),
  importRow("imp-1"),
  item("iti-1", "imp-1", A1),
  shortlist("sl-1", A1, A2),
  aiDebugRow(1),
  flagOverride("flag.dashboard.stats", "off"),
];
const SAME_ORIGIN = {
  origin: "http://127.0.0.1:3000",
  host: "127.0.0.1:3000",
};

// ── Volatile figures ─────────────────────────────────────────────────
// The keys that belong to the process and the file. Mirrors
// `VOLATILE` in core/src/server/maintenance_tests.rs; the two blankers
// must agree so the replay's pass over the recorded side is a no-op.
const VOLATILE = new Set([
  "rssMb",
  "heapFractionUsed",
  "eventLoopP99Ms",
  "walBytes",
  "fileBytes",
  "shmBytes",
  "pageCount",
  "freelistCount",
  "utilisationPct",
  "fragmented",
  "path",
  "journalMode",
]);

/** Blank the volatile keys in place, following JSON embedded in strings. */
function blank(value) {
  if (Array.isArray(value)) {
    return value.map(blank);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, VOLATILE.has(k) ? 0 : blank(v)])
    );
  }
  if (typeof value === "string" && value.startsWith("{")) {
    let inner = null;
    try {
      inner = JSON.parse(value);
    } catch {
      return value;
    }
    return inner && typeof inner === "object" && !Array.isArray(inner)
      ? JSON.stringify(blank(inner))
      : value;
  }
  return value;
}

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;
const cspRing = () => {
  const ring = (globalThis.__pt_csp_ring ??= []);
  return ring;
};

async function run(name, spec) {
  const {
    kind = "route",
    delay = null,
    route = null,
    method = null,
    search = "",
    json: jsonBody,
    raw,
    headers = {},
    setup: extraSetup = [],
    adminToken = null,
    repeat = 1,
    contentLength,
    compare = "exact",
    seedErrors = 0,
  } = spec;
  const setup = [...BASE, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.6`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "maintenance-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  // Process state the routes read or write, reset so each case stands alone.
  _resetLoginBruteForce();
  clearErrorLog();
  cspRing().length = 0;
  resetEventLoopMonitor();
  for (let i = 0; i < seedErrors; i++) {
    console.error(`seeded error ${i + 1}`);
  }
  db.exec("SAVEPOINT maintenance_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let expected = null;
    const restore = silence();
    try {
      if (kind === "callback") {
        await callbackFor(delay)();
      } else {
        for (let i = 0; i < repeat; i++) {
          const request = new NextRequest(
            `http://127.0.0.1:3000${route}${search}`,
            {
              method,
              headers: sent,
              body: body === null ? undefined : body,
            }
          );
          try {
            const response = await handlers[route][method](request);
            expected = {
              status: response.status,
              body: await response.text(),
              type: response.headers.get("content-type"),
              retryAfter: response.headers.get("retry-after"),
              setCookie: response.headers.get("set-cookie"),
            };
          } catch (error) {
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
      }
    } finally {
      restore();
    }
    recording = null;
    const rows = {};
    for (const table of TABLES) {
      const all = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      rows[table] =
        all.length > 100
          ? { count: all.length, head: all.slice(0, 3), tail: all.slice(-3) }
          : all;
    }
    const record = {
      name,
      kind,
      delay,
      route,
      method,
      search,
      query: [...new URLSearchParams(search)],
      headers: sent,
      body,
      adminToken,
      repeat,
      compare,
      seedErrors,
      setup,
      stream,
      rows,
      csp: [...cspRing()],
      expected,
    };
    if (compare === "health" || compare === "database") {
      record.stream = blank(stream);
      record.rows = blank(rows);
      if (expected) {
        record.expected = { ...expected, body: blank(expected.body) };
      }
    } else if (compare === "status" && expected) {
      record.expected = { ...expected, body: null };
    }
    cases.push(record);
  } finally {
    recording = null;
    db.exec("ROLLBACK TO maintenance_case; RELEASE maintenance_case");
  }
}

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

const admin = {
  adminToken: "secret-token",
  headers: { "x-auditor-admin-token": "secret-token" },
};

try {
  // ── POST /api/diagnostics/health ─────────────────────────────────
  {
    const route = "/api/diagnostics/health";
    const method = "POST";
    const health = { route, method, compare: "health" };
    await run("health check clean", { ...health, setup: corpus });
    await run("health check heals a dead sync lock", {
      ...health,
      setup: [...corpus, setting("sync_running", "true")],
    });
    await run("health check heals a finished sync run", {
      ...health,
      setup: [
        ...corpus,
        setting("sync_running", "true"),
        syncState([done(A1)], now - HOUR),
      ],
    });
    await run("health check heals a sync run silent for seven hours", {
      ...health,
      setup: [
        ...corpus,
        setting("sync_running", "true"),
        syncState([pending(A1)], now - 7 * HOUR),
      ],
    });
    await run("health check leaves a live sync run alone", {
      ...health,
      setup: [
        ...corpus,
        setting("sync_running", "true"),
        syncState([pending(A1)], now - HOUR),
      ],
    });
    await run("health check leaves a paused wayback queue alone", {
      ...health,
      setup: [
        ...corpus,
        setting("wayback_import_running", "true"),
        waybackState([pending(A1)], now - 9 * HOUR, "paused"),
      ],
    });
    await run("health check heals a dead wayback lock", {
      ...health,
      setup: [
        ...corpus,
        setting("wayback_import_running", "true"),
        waybackState([pending(A1)], now - 9 * HOUR),
      ],
    });
    await run("health check heals a dead policy lock", {
      ...health,
      setup: [...corpus, setting("policy_sync_running", "true")],
    });
    await run("health check heals a stale import-queue lock", {
      ...health,
      setup: [
        ...corpus,
        setting("import_queue_running", "true"),
        setting("import_queue_running_since", String(now - 7 * HOUR)),
      ],
    });
    await run("health check leaves a fresh import-queue lock", {
      ...health,
      setup: [
        ...corpus,
        setting("import_queue_running", "true"),
        setting("import_queue_running_since", String(now - HOUR)),
      ],
    });
    await run("health check resets stuck policy runs", {
      ...health,
      setup: [
        ...corpus,
        policyAnalysis(A1, "running", now - 7 * HOUR),
        policyAnalysis(A2, "running", now - HOUR),
        app("1003", "Third"),
        policyAnalysis("1003", "running", null),
      ],
    });
    await run("health check integrity enabled", {
      ...health,
      setup: [...corpus, setting("health_check_integrity_enabled", "true")],
    });
    await run("health check integrity too large", {
      ...health,
      setup: [
        ...corpus,
        setting("health_check_integrity_enabled", "true"),
        setting("health_check_integrity_max_mb", "0"),
      ],
    });
    await run("health check skips heals while a run is live", {
      ...health,
      setup: [
        ...corpus,
        setting("health_check_integrity_enabled", "true"),
        setting("policy_sync_running", "true"),
        policyState([pending(A1)], now - HOUR),
        policyAnalysis(A1, "running", now - 7 * HOUR),
      ],
    });
    await run("health check warns on caps and orphans", {
      ...health,
      setup: [
        ...corpus,
        ...Array.from({ length: 51 }, (_, i) => aiDebugRow(i + 2)),
        manualEvent("me-orphan", "m-gone"),
      ],
    });
    await run("health check custom thresholds", {
      ...health,
      setup: [
        ...corpus,
        setting("health_check_stale_lock_hours", "1"),
        setting("health_check_stuck_run_hours", "0.5"),
        setting("health_check_rss_warn_mb", "junk"),
        setting("sync_running", "true"),
        syncState([pending(A1)], now - 2 * HOUR),
        policyAnalysis(A1, "running", now - HOUR),
      ],
    });
    await run("health check busy", {
      ...health,
      setup: [
        ...corpus,
        setting("health_check_running", "true"),
        setting("health_check_running_since", String(now - 60_000)),
      ],
    });
    await run("health check takes over a stale lock", {
      ...health,
      setup: [
        ...corpus,
        setting("health_check_running", "true"),
        setting("health_check_running_since", String(now - 6 * 60_000)),
      ],
    });
    await run("health check admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("health check admin token accepted", {
      ...health,
      setup: corpus,
      ...admin,
    });
    await run("health check rate limited", {
      route,
      method,
      setup: [
        setting("health_check_running", "true"),
        setting("health_check_running_since", String(now - 60_000)),
      ],
      repeat: 5,
    });
  }

  // ── POST /api/diagnostics/database ───────────────────────────────
  {
    const route = "/api/diagnostics/database";
    const method = "POST";
    await run("database integrity check", {
      route,
      method,
      setup: corpus,
      json: { runIntegrityCheck: true },
      compare: "database",
    });
    await run("database integrity flag missing", {
      route,
      method,
      json: { runIntegrityCheck: "yes" },
    });
    await run("database integrity admin token required", {
      route,
      method,
      json: { runIntegrityCheck: true },
      adminToken: "secret-token",
    });
    await bodyCases(route, method, 1024);
    await run("database integrity rate limited", {
      route,
      method,
      json: {},
      repeat: 5,
    });
  }

  // ── DELETE /api/diagnostics/errors ───────────────────────────────
  {
    const route = "/api/diagnostics/errors";
    const method = "DELETE";
    await run("errors cleared", { route, method, seedErrors: 3 });
    await run("errors cleared when empty", { route, method });
    await run("errors clear admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("errors clear admin token accepted", {
      route,
      method,
      seedErrors: 1,
      ...admin,
    });
    await run("errors clear rate limited", { route, method, repeat: 11 });
  }

  // ── DELETE / POST /api/diagnostics/runtime ───────────────────────
  {
    const route = "/api/diagnostics/runtime";
    await run("runtime cleared", {
      route,
      method: "DELETE",
      compare: "status",
    });
    await run("runtime clear admin token required", {
      route,
      method: "DELETE",
      adminToken: "secret-token",
    });
    await run("runtime clear rate limited", {
      route,
      method: "DELETE",
      repeat: 11,
      compare: "status",
    });
    await run("runtime profiling off", {
      route,
      method: "POST",
      json: { profilingEnabled: false },
      compare: "status",
    });
    await run("runtime profiling on", {
      route,
      method: "POST",
      json: { profilingEnabled: true },
      compare: "status",
    });
    await run("runtime profiling not a boolean", {
      route,
      method: "POST",
      json: { profilingEnabled: "yes" },
    });
    await run("runtime profiling admin token required", {
      route,
      method: "POST",
      json: { profilingEnabled: true },
      adminToken: "secret-token",
    });
    await bodyCases(route, "POST", 1024);
    await run("runtime profiling rate limited", {
      route,
      method: "POST",
      json: {},
      repeat: 11,
    });
  }

  // ── DELETE /api/ai/debug-log ─────────────────────────────────────
  {
    const route = "/api/ai/debug-log";
    const method = "DELETE";
    await run("ai debug log cleared", {
      route,
      method,
      setup: [aiDebugRow(1), aiDebugRow(2)],
    });
    await run("ai debug log cleared when empty", { route, method });
    await run("ai debug log clear admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("ai debug log clear admin token accepted", {
      route,
      method,
      setup: [aiDebugRow(1)],
      ...admin,
    });
    await run("ai debug log clear rate limited", {
      route,
      method,
      repeat: 11,
    });
  }

  // ── POST /api/auth/admin-token/login ─────────────────────────────
  {
    const route = "/api/auth/admin-token/login";
    const method = "POST";
    await run("login without an origin", {
      route,
      method,
      adminToken: "secret-token",
      json: { token: "secret-token" },
    });
    await run("login with a foreign origin", {
      route,
      method,
      adminToken: "secret-token",
      headers: { origin: "http://evil.test", host: "127.0.0.1:3000" },
      json: { token: "secret-token" },
    });
    await run("login token not configured", {
      route,
      method,
      headers: SAME_ORIGIN,
      json: { token: "anything" },
    });
    await run("login succeeds", {
      route,
      method,
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
      json: { token: " secret-token " },
    });
    await run("login succeeds over https", {
      route,
      method,
      adminToken: "secret-token",
      headers: {
        origin: "https://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        "x-forwarded-proto": "https",
      },
      json: { token: "secret-token" },
    });
    await run("login invalid token", {
      route,
      method,
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
      json: { token: "wrong" },
    });
    await run("login token missing", {
      route,
      method,
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
      json: { token: "   " },
    });
    await run("login token not a string", {
      route,
      method,
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
      json: { token: 5 },
    });
    await bodyCases(route, method, 4 * 1024, {
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
    });
    await run("login rate limited", {
      route,
      method,
      adminToken: "secret-token",
      headers: SAME_ORIGIN,
      json: { token: "wrong" },
      repeat: 6,
    });
  }

  // ── POST /api/auth/admin-token/logout ────────────────────────────
  {
    const route = "/api/auth/admin-token/logout";
    const method = "POST";
    await run("logout without an origin", { route, method });
    await run("logout", { route, method, headers: SAME_ORIGIN });
  }

  // ── POST /api/csp-report ─────────────────────────────────────────
  {
    const route = "/api/csp-report";
    const method = "POST";
    await run("csp report legacy shape", {
      route,
      method,
      json: {
        "csp-report": {
          "violated-directive": "script-src",
          "blocked-uri": "inline",
          "document-uri": "http://127.0.0.1:3000/dashboard",
          "script-sample": "alert(1)",
        },
      },
    });
    await run("csp report reporting api shape", {
      route,
      method,
      json: [
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "img-src",
            blockedURL: "https://cdn.example/x.png",
            documentURL: "http://127.0.0.1:3000/",
            sample: "",
          },
        },
        { type: "other" },
      ],
    });
    await run("csp report bare body", {
      route,
      method,
      json: {
        effectiveDirective: "style-src",
        blockedURI: "https://fonts.example",
        documentURL: "x".repeat(300),
      },
    });
    await run("csp report without a body", { route, method, json: [{}] });
    await run("csp report non-object", { route, method, raw: '"text"' });
    await run("csp report invalid json", { route, method, raw: "{bad" });
    await run("csp report too large", {
      route,
      method,
      raw: `{"pad":"${"x".repeat(16 * 1024)}"}`,
    });
    await run("csp report rate limited", {
      route,
      method,
      json: { "csp-report": { "violated-directive": "img-src" } },
      repeat: 31,
    });
  }

  // ── POST /api/dev/reset-changelog ────────────────────────────────
  {
    const route = "/api/dev/reset-changelog";
    const method = "POST";
    await run("reset changelog", { route, method, setup: corpus, ...admin });
    await run("reset changelog when empty", { route, method, ...admin });
    await run("reset changelog without a configured token", {
      route,
      method,
      setup: corpus,
    });
    await run("reset changelog admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("reset changelog rate limited", {
      route,
      method,
      ...admin,
      repeat: 7,
    });
  }

  // ── POST /api/dev/seed-notification ──────────────────────────────
  {
    const route = "/api/dev/seed-notification";
    const method = "POST";
    const change = {
      category: "privacy-label",
      type: "added",
      description: "parity fixture change",
    };
    await run("seed notification", {
      route,
      method,
      ...admin,
      json: { appId: ` ${A1} `, appName: " Instagram ", changes: [change] },
    });
    await run("seed notification during quiet hours", {
      route,
      method,
      ...admin,
      setup: [
        flagOverride("flag.notifications.quiet_hours", "on"),
        setting("notification_quiet_hours_start", "10:00"),
        setting("notification_quiet_hours_end", "14:30"),
      ],
      json: { appId: A1, appName: "Instagram", changes: [change] },
    });
    await run("seed notification drops malformed changes", {
      route,
      method,
      ...admin,
      json: {
        appId: A1,
        appName: "Instagram",
        changes: [change, { type: "x" }, "junk", { type: 1, description: "d" }],
      },
    });
    await run("seed notification no valid changes", {
      route,
      method,
      ...admin,
      json: { appId: A1, appName: "Instagram", changes: [{ type: "x" }] },
    });
    await run("seed notification missing app", {
      route,
      method,
      ...admin,
      json: { appId: "", appName: "Instagram", changes: [change] },
    });
    await run("seed notification without a configured token", {
      route,
      method,
      json: { appId: A1, appName: "Instagram", changes: [change] },
    });
    await bodyCases(route, method, 16 * 1024, admin);
    await run("seed notification rate limited", {
      route,
      method,
      ...admin,
      json: {},
      repeat: 31,
    });
  }

  // ── POST /api/dev/wipe-apps ──────────────────────────────────────
  {
    const route = "/api/dev/wipe-apps";
    const method = "POST";
    await run("wipe apps", { route, method, setup: corpus, ...admin });
    await run("wipe apps when empty", { route, method, ...admin });
    await run("wipe apps without a configured token", { route, method });
    await run("wipe apps rate limited", {
      route,
      method,
      ...admin,
      repeat: 7,
    });
  }

  // ── POST /api/reset ──────────────────────────────────────────────
  {
    const route = "/api/reset";
    const method = "POST";
    await run("reset", {
      route,
      method,
      setup: [...corpus, setting("sync_schedule", "daily")],
    });
    await run("reset while a sync runs", {
      route,
      method,
      setup: [...corpus, setting("sync_running", "true")],
    });
    await run("reset admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("reset admin token accepted", {
      route,
      method,
      setup: corpus,
      ...admin,
    });
    await run("reset rate limited", {
      route,
      method,
      setup: [setting("sync_running", "true")],
      // One past the route's limit (60 in ten minutes).
      repeat: 61,
    });
  }

  // ── POST /api/admin/start-over ───────────────────────────────────
  {
    const route = "/api/admin/start-over";
    const method = "POST";
    await run("start over", {
      route,
      method,
      setup: [...corpus, setting("sync_schedule", "daily")],
      ...admin,
    });
    await run("start over when empty", { route, method, ...admin });
    await run("start over admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("start over without a configured token", { route, method });
    await run("start over rate limited", {
      route,
      method,
      ...admin,
      repeat: 4,
    });
  }

  // ── instrumentation.ts: the 60 s health check ────────────────────
  await run("scheduled health check", {
    kind: "callback",
    delay: 60_000,
    setup: corpus,
    compare: "health",
  });
  await run("scheduled health check disabled", {
    kind: "callback",
    delay: 60_000,
    setup: [...corpus, setting("health_check_enabled", "false")],
  });
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const out = path.join(
  import.meta.dirname,
  "..",
  "tests",
  "fixtures",
  "maintenance-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
