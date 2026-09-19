/**
 * Runner oracle for the Rust server (Phase 4, batch 4a).
 *
 * Runs the REAL bulk App Store sync — `runBulkSync` and its adapter
 * `runScheduledSync` — through the three ways Node reaches it: the
 * `POST /api/sync/trigger` route, the scheduler's 30-minute check and the
 * boot-time resume in `instrumentation.ts`; the boot-time stale-lock
 * clears and the import-queue drain tick alongside; and the two small
 * writes that belong with them: `POST /api/dev/sync-stop`,
 * `DELETE /api/rate-limit/status` and `DELETE /api/apps`. Records, per
 * case, the request or the callback, the setup rows, every raw fetch,
 * every write in order with its transaction markers, the twelve tables
 * these paths touch, and the wire response.
 *
 * The startup hook is exercised as itself: `setTimeout` and
 * `setInterval` are captured while `register()` runs, so the scheduler
 * check (15 s), the import-queue drain (20 s) and the sync resume (10 s)
 * are the real closures, invoked directly with the clock frozen. The
 * resume spawns its run without awaiting it; the oracle waits for the
 * mutex to clear before it dumps.
 *
 * Determinism as before: frozen clock, counted ids, the network canned
 * per case, foreign keys ON, a distinct forwarded address per case, and
 * the policy-sync mutex held so the deferred policy fetch a successful
 * sync arms never starts. The feature-flag migration marker is preset so
 * `register()` migrates nothing.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-runners-oracle-"));
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

const ROUTES = ["sync/trigger", "dev/sync-stop", "rate-limit/status", "apps"];
const handlers = {};
for (const route of ROUTES) {
  handlers[`/api/${route}`] = await import(`../../app/api/${route}/route.ts`);
}

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
  "accessibility_features",
  "related_apps_observed",
  "privacy_snapshots",
  "imports",
  "import_items",
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
// Persistent for the whole run and part of every recorded setup: the
// policy mutex (so the deferred policy fetch never starts), the migration
// marker (so `register()` migrates nothing) and the runtime marker
// `register()` writes on its first, unrecorded run.
const BASE = [
  setting("policy_sync_running", "true"),
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

// The startup hook, once, with its tickers captured: the closures the
// callback cases invoke. Its own boot writes land on the persistent base.
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
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;
const F1 = "555000111";
const F2 = "555000222";
const F3 = "555000333";
const app = (id, name = `App ${id}`, extra = {}) =>
  stmt(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
    id,
    name,
    extra.url === undefined ? url(id) : extra.url,
    extra.firstSeen ?? now - 5 * DAY,
    extra.lastSynced ?? now - 5 * DAY
  );
// The snapshot a scrape of `page(name)` stores, so a resync of this app
// finds nothing changed.
const LINKED_SNAPSHOT =
  '[{"identifier":"DATA_LINKED_TO_YOU","title":"Data Linked to You","categories":[{"identifier":"CONTACT_INFO","title":"Contact Info"}]}]';
const liveSnapshot = (id, appId, scrapedAt) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source, wayback_snapshot_url, triggered_by, app_version, app_version_updated_at) VALUES (?, ?, ?, ?, 0, '[]', 'live', NULL, 'import', '1.0.0', 1767323045000)",
    id,
    appId,
    scrapedAt,
    LINKED_SNAPSHOT
  );
const importRow = (id, extra = {}) =>
  stmt(
    "INSERT INTO imports (id, created_at, completed_at, source, source_label, total, matched, unmatched, imported, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    extra.createdAt ?? now - DAY,
    extra.completedAt ?? null,
    extra.source ?? "manual",
    extra.sourceLabel ?? null,
    extra.total ?? 0,
    extra.matched ?? 0,
    extra.unmatched ?? 0,
    extra.imported ?? 0,
    extra.deviceId ?? null
  );
const item = (id, importId, query, status, extra = {}) =>
  stmt(
    "INSERT INTO import_items (id, import_id, query, edited_query, status, app_id, app_name, developer, url, icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    importId,
    query,
    extra.editedQuery ?? null,
    status,
    extra.appId ?? null,
    extra.appName ?? null,
    extra.developer ?? null,
    extra.url ?? null,
    extra.iconUrl ?? null,
    extra.country ?? null,
    extra.scrapeError ?? null,
    extra.removedAppId ?? null,
    extra.nextAttemptAt ?? null,
    extra.attemptCount ?? 0
  );
const entry = (appId, appName, status, extra = {}) => ({
  appId,
  appName,
  url: url(appId),
  status,
  ...extra,
});
const syncState = (queue, extra = {}) =>
  setting(
    "sync_bulk_state",
    JSON.stringify({
      version: 1,
      runId: extra.runId ?? "run-fixture-1",
      startedAt: extra.startedAt ?? now - 3600_000,
      initiator: extra.initiator ?? "manual",
      updatedAt: extra.updatedAt ?? now - 1800_000,
      currentAppId: extra.currentAppId ?? null,
      queue,
      totals: extra.totals ?? {
        attempted: 0,
        succeeded: 0,
        changes: 0,
        failed: 0,
        rateLimited: 0,
        skipped: 0,
      },
    })
  );

// ── Pages and replies ────────────────────────────────────────────────
const cat = (identifier, title) => ({ identifier, title });
const type = (identifier, title, categories) => ({
  identifier,
  title,
  detail: `${title} detail`,
  categories,
});
const LINKED = type("DATA_LINKED_TO_YOU", "Data Linked to You", [
  cat("CONTACT_INFO", "Contact Info"),
]);
const page = (name, types = [LINKED]) => {
  const blob = JSON.stringify({
    data: [
      {
        data: { title: name, shelfMapping: { privacyTypes: { items: types } } },
      },
    ],
    userTokenHash: "fixture",
  });
  return `<!doctype html><html><head><meta property="og:title" content="${name} on the App Store"><meta property="og:image" content="https://example.com/icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script></head><body><a aria-label="Developer's Privacy Policy" href="https://example.com/privacy">Privacy Policy</a><script id="serialized-server-data" type="application/json">${blob}</script></body></html>`;
};
const html = (body, headers = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});
const json = (body, status = 200, headers = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const LOOKUP = json({
  resultCount: 1,
  results: [
    {
      version: "1.0.0",
      currentVersionReleaseDate: "2026-01-02T03:04:05Z",
      releaseNotes: "Fixture release notes",
      price: 0,
      currency: "USD",
      formattedPrice: "Free",
      primaryGenreId: 6002,
      primaryGenreName: "Utilities",
      contentAdvisoryRating: "4+",
    },
  ],
});
const scrapeOf = (name, types = [LINKED]) => [html(page(name, types)), LOOKUP];
const RATE_LIMITED = status(429, { "retry-after": "30" });

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;
const settled = () =>
  db.prepare("SELECT value FROM app_settings WHERE key = 'sync_running'").get()
    ?.value !== "true" &&
  !db
    .prepare("SELECT value FROM app_settings WHERE key = 'sync_bulk_state'")
    .get();
async function waitForSync() {
  for (let i = 0; i < 200_000; i++) {
    if (settled()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const tail = db
    .prepare(
      "SELECT summary, detail FROM activity_log ORDER BY rowid DESC LIMIT 2"
    )
    .all();
  const state = db
    .prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('sync_running', 'sync_bulk_state')"
    )
    .all();
  throw new Error(
    `the spawned sync never settled: ${JSON.stringify(tail)} ${JSON.stringify(state)}`
  );
}

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
    replies = [],
    adminToken = null,
    repeat = 1,
    contentLength,
    settle = false,
  } = spec;
  const setup = [...BASE, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.4`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "runners-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const calls = [];
  let cursor = 0;
  globalThis.fetch = async (target, init) => {
    const call = {
      url: String(target),
      headers: [...new Headers(init?.headers)],
    };
    // A POST (the immediate webhook) is recorded with its method and body;
    // a GET carries neither key.
    if (init?.method && init.method !== "GET") {
      call.method = init.method;
      call.body = init.body == null ? null : String(init.body);
    }
    calls.push(call);
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply for ${String(target)}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  db.exec("SAVEPOINT runners_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    _resetSoftBuckets();
    const stream = [];
    recording = stream;
    let expected = null;
    const restore = silence();
    try {
      if (kind === "boot") {
        capturing = true;
        capturedTimers = [];
        await register();
        capturing = false;
      } else if (kind === "callback") {
        await callbackFor(delay)();
        // Only the resume spawns a run without awaiting it; the scheduler
        // check and the drain await theirs.
        if (delay === 10_000) {
          await waitForSync();
        }
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
            };
          } catch (error) {
            expected = {
              status: 500,
              body: "",
              type: null,
              retryAfter: null,
              thrown: String(error?.message ?? error),
            };
          }
        }
      }
    } finally {
      capturing = false;
      restore();
    }
    if (settle) {
      // The immediate webhook is `void`ed: let the detached POST land.
      await new Promise((resolve) => realSetTimeout(resolve, 60));
    }
    recording = null;
    if (cursor !== replies.length) {
      throw new Error(
        `${name}: unused replies ${cursor}/${replies.length} ${JSON.stringify(calls.map((c) => c.url))}`
      );
    }
    const rows = {};
    for (const table of TABLES) {
      const all = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      rows[table] =
        all.length > 100
          ? { count: all.length, head: all.slice(0, 3), tail: all.slice(-3) }
          : all;
    }
    cases.push({
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
      setup,
      replies,
      calls,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO runners_case; RELEASE runners_case");
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
  await run(`${route} ${method} whitespace body`, {
    route,
    method,
    raw: "  \n ",
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

try {
  // ── POST /api/sync/trigger ───────────────────────────────────────
  {
    const route = "/api/sync/trigger";
    const method = "POST";
    const fleet = [
      app(F1, "Fixture One"),
      app(F2, "Fixture Two"),
      liveSnapshot("snap-two", F2, now - 2 * DAY),
    ];
    await run("sync trigger busy on the mutex", {
      route,
      method,
      setup: [setting("sync_running", "true")],
    });
    await run("sync trigger busy on a leftover state blob", {
      route,
      method,
      setup: [syncState([entry(F1, "Fixture One", "pending")])],
    });
    await run("sync trigger with no apps", { route, method });
    await run("sync trigger two apps one changed", {
      route,
      method,
      setup: fleet,
      replies: [...scrapeOf("Fixture One"), ...scrapeOf("Fixture Two")],
    });
    await run("sync trigger one app fails", {
      route,
      method,
      setup: fleet,
      replies: [status(404), ...scrapeOf("Fixture Two")],
    });
    await run("sync trigger rate limited on the first app", {
      route,
      method,
      setup: [...fleet, app(F3, "Fixture Three")],
      replies: [RATE_LIMITED],
    });
    await run("sync trigger rate limited on the last app", {
      route,
      method,
      setup: fleet,
      replies: [...scrapeOf("Fixture One"), RATE_LIMITED],
    });
    await run("sync trigger skips apps without a url", {
      route,
      method,
      setup: [app(F1, "No URL", { url: "" }), app(F2, "Fixture Two")],
      replies: scrapeOf("Fixture Two"),
    });
    await run("sync trigger rate limited", {
      route,
      method,
      setup: [setting("sync_running", "true")],
      repeat: 11,
    });
  }

  // ── POST /api/dev/sync-stop ──────────────────────────────────────
  {
    const route = "/api/dev/sync-stop";
    const method = "POST";
    // The route insists on a configured token: without one it is a 403.
    const admin = {
      adminToken: "secret-token",
      headers: { "x-auditor-admin-token": "secret-token" },
    };
    await run("sync stop a running sync", {
      route,
      method,
      setup: [
        setting("sync_running", "true"),
        syncState([entry(F1, "Fixture One", "in_progress")]),
      ],
      ...admin,
    });
    await run("sync stop with nothing running", { route, method, ...admin });
    await run("sync stop without a configured token", {
      route,
      method,
      setup: [setting("sync_running", "true")],
    });
    await run("sync stop admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("sync stop admin token accepted", {
      route,
      method,
      adminToken: "secret-token",
      headers: { "x-auditor-admin-token": "secret-token" },
    });
    await run("sync stop rate limited", { route, method, repeat: 11 });
  }

  // ── DELETE /api/rate-limit/status ────────────────────────────────
  {
    const route = "/api/rate-limit/status";
    const method = "DELETE";
    const cooling = [
      setting("rate_limit_search_until", String(now + 60_000)),
      setting("rate_limit_search_reason", "HTTP 429 from iTunes Search"),
      setting("rate_limit_scrape_until", String(now + 120_000)),
      setting("rate_limit_scrape_reason", "HTTP 429 from App Store HTML"),
    ];
    await run("rate limit clear all", {
      route,
      method,
      setup: cooling,
      json: { category: "all" },
    });
    await run("rate limit clear search", {
      route,
      method,
      setup: cooling,
      json: { category: "search" },
    });
    await run("rate limit clear scrape", {
      route,
      method,
      setup: cooling,
      json: { category: "scrape" },
    });
    await run("rate limit clear nothing cooling", {
      route,
      method,
      json: { category: "all" },
    });
    await run("rate limit clear invalid category", {
      route,
      method,
      json: { category: "lookup" },
    });
    await run("rate limit clear missing category", {
      route,
      method,
      json: {},
    });
    await run("rate limit clear array body", { route, method, raw: "[]" });
    await run("rate limit clear string body", { route, method, raw: '"x"' });
    await run("rate limit clear null body", { route, method, raw: "null" });
    await bodyCases(route, method, 1024);
    await run("rate limit clear rate limited", {
      route,
      method,
      json: { category: "all" },
      repeat: 11,
    });
  }

  // ── DELETE /api/apps ─────────────────────────────────────────────
  {
    const route = "/api/apps";
    const method = "DELETE";
    const tracked = [
      app(F1, "Fixture One"),
      app(F2, "Fixture Two"),
      importRow("imp_fixture_a", { total: 2, imported: 2 }),
      importRow("imp_fixture_b", { total: 1, imported: 1 }),
      item("iti_fixture_1", "imp_fixture_a", "One", "imported", { appId: F1 }),
      item("iti_fixture_2", "imp_fixture_a", "Two", "imported", { appId: F2 }),
      item("iti_fixture_3", "imp_fixture_b", "One again", "imported", {
        appId: F1,
      }),
      item("iti_fixture_4", "imp_fixture_b", "One removed", "removed", {
        appId: F1,
        removedAppId: "111",
      }),
    ];
    await run("app delete with import rows", {
      route,
      method,
      setup: tracked,
      search: `?id=${F1}`,
    });
    await run("app delete without import rows", {
      route,
      method,
      setup: [app(F1, "Fixture One")],
      search: `?id=${F1}`,
    });
    await run("app delete unknown id", {
      route,
      method,
      search: "?id=999",
    });
    await run("app delete missing id", { route, method });
    await run("app delete invalid id", { route, method, search: "?id=abc" });
    await run("app delete overlong id", {
      route,
      method,
      search: `?id=${"1".repeat(21)}`,
    });
    await run("app delete admin token required", {
      route,
      method,
      setup: [app(F1)],
      search: `?id=${F1}`,
      adminToken: "secret-token",
    });
    await run("app delete admin token accepted", {
      route,
      method,
      setup: [app(F1)],
      search: `?id=${F1}`,
      adminToken: "secret-token",
      headers: { "x-auditor-admin-token": "secret-token" },
    });
    await run("app delete rate limited", {
      route,
      method,
      search: "?id=999",
      repeat: 61,
    });
  }

  // ── instrumentation.ts: boot and the captured tickers ────────────
  {
    await run("boot with nothing stuck", { kind: "boot" });
    await run("boot clears a stale import-queue lock", {
      kind: "boot",
      setup: [
        setting("import_queue_running", "true"),
        setting("import_queue_running_since", String(now - 5000)),
      ],
    });
    await run("boot clears a stale health-check lock", {
      kind: "boot",
      setup: [setting("health_check_running", "true")],
    });

    const fleet = [
      app(F1, "Fixture One"),
      app(F2, "Fixture Two"),
      liveSnapshot("snap-two", F2, now - 2 * DAY),
    ];
    await run("scheduled check not due", {
      kind: "callback",
      delay: 15_000,
      setup: [...fleet, setting("sync_schedule", "manual")],
    });
    await run("scheduled check due", {
      kind: "callback",
      delay: 15_000,
      setup: [
        ...fleet,
        setting("sync_schedule", "daily"),
        setting("last_auto_sync", String(now - 2 * DAY)),
      ],
      replies: [...scrapeOf("Fixture One"), ...scrapeOf("Fixture Two")],
    });
    await run("scheduled check due but busy", {
      kind: "callback",
      delay: 15_000,
      setup: [
        ...fleet,
        setting("sync_schedule", "weekly"),
        setting("sync_running", "true"),
      ],
    });
    await run("scheduled check not yet due", {
      kind: "callback",
      delay: 15_000,
      setup: [
        ...fleet,
        setting("sync_schedule", "daily"),
        setting("last_auto_sync", String(now - 3600_000)),
      ],
    });
    await run("import queue drain tick", {
      kind: "callback",
      delay: 20_000,
      setup: [
        importRow("imp_fixture_a", { total: 1, matched: 1 }),
        item("iti_fixture_1", "imp_fixture_a", "Fixture One", "queued", {
          url: url(F1),
        }),
      ],
      replies: scrapeOf("Fixture One"),
    });
    await run("sync resume with nothing on disk", {
      kind: "callback",
      delay: 10_000,
    });
    await run("sync resume heals a stale mutex", {
      kind: "callback",
      delay: 10_000,
      setup: [setting("sync_running", "true")],
    });
    await run("sync resume clears a finished state blob", {
      kind: "callback",
      delay: 10_000,
      setup: [
        setting("sync_running", "true"),
        syncState([
          entry(F1, "Fixture One", "done", { outcome: "succeeded" }),
          entry(F2, "Fixture Two", "failed", { outcome: "failed" }),
        ]),
      ],
    });
    await run("sync resume continues a crashed run", {
      kind: "callback",
      delay: 10_000,
      setup: [
        ...fleet,
        app(F3, "Fixture Three"),
        setting("sync_running", "true"),
        syncState(
          [
            entry(F1, "Fixture One", "done", {
              startedAt: now - 3000,
              finishedAt: now - 2000,
              outcome: "succeeded",
              changesDetected: false,
            }),
            entry(F2, "Fixture Two", "in_progress", { startedAt: now - 1000 }),
            entry(F3, "Fixture Three", "pending"),
          ],
          {
            currentAppId: F2,
            totals: {
              attempted: 2,
              succeeded: 1,
              changes: 0,
              failed: 0,
              rateLimited: 0,
              skipped: 0,
            },
          }
        ),
      ],
      replies: [...scrapeOf("Fixture Two"), ...scrapeOf("Fixture Three")],
    });
    await run("sync resume with a deleted app in the queue", {
      kind: "callback",
      delay: 10_000,
      setup: [
        app(F1, "Fixture One"),
        syncState([
          entry(F2, "Gone", "pending"),
          entry(F1, "Fixture One", "pending"),
        ]),
      ],
      replies: scrapeOf("Fixture One"),
    });
  }

  // ── The immediate webhook on every runner that scrapes ───────────
  // An app whose scrape records label changes posts the immediate webhook
  // once its commit has landed, before the run moves to the next app.
  // Kept last: each case's forwarded address comes from a counter, so
  // cases added earlier would move every later case's.
  {
    const HOOK = "https://hooks.example.com/pt";
    const HOOK_OK = {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "ok",
    };
    const webhook = [
      setting("notification_webhook_url", HOOK),
      setting("notification_webhook_format", "slack"),
      setting("notification_webhook_frequency", "immediate"),
    ];
    const TRACKING = type("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
      cat("LOCATION", "Location"),
    ]);
    // F1 has no snapshot, so any scrape of it records changes; F2's
    // snapshot matches `page(name)`, so it changes only when given more.
    const fleet = [
      ...webhook,
      app(F1, "Fixture One"),
      app(F2, "Fixture Two"),
      liveSnapshot("snap-two", F2, now - 2 * DAY),
    ];
    await run("sync trigger posts a webhook after each changed app", {
      route: "/api/sync/trigger",
      method: "POST",
      setup: fleet,
      replies: [
        ...scrapeOf("Fixture One"),
        HOOK_OK,
        ...scrapeOf("Fixture Two", [LINKED, TRACKING]),
        HOOK_OK,
      ],
      settle: true,
    });
    await run("scheduled check posts the webhook for the changed app", {
      kind: "callback",
      delay: 15_000,
      setup: [
        ...fleet,
        setting("sync_schedule", "daily"),
        setting("last_auto_sync", String(now - 2 * DAY)),
      ],
      replies: [
        ...scrapeOf("Fixture One"),
        HOOK_OK,
        ...scrapeOf("Fixture Two"),
      ],
      settle: true,
    });
    await run("sync resume posts the webhook for the changed app", {
      kind: "callback",
      delay: 10_000,
      setup: [
        ...fleet,
        syncState([
          entry(F1, "Fixture One", "pending"),
          entry(F2, "Fixture Two", "pending"),
        ]),
      ],
      replies: [
        ...scrapeOf("Fixture One"),
        HOOK_OK,
        ...scrapeOf("Fixture Two"),
      ],
      settle: true,
    });
    await run("import queue drain tick posts the webhook for a tracked app", {
      kind: "callback",
      delay: 20_000,
      setup: [
        ...webhook,
        app(F1, "Fixture One"),
        importRow("imp_fixture_a", { total: 1, matched: 1 }),
        item("iti_fixture_1", "imp_fixture_a", "Fixture One", "queued", {
          url: url(F1),
          appId: F1,
        }),
      ],
      replies: [...scrapeOf("Fixture One"), HOOK_OK],
      settle: true,
    });
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const out = path.join(
  import.meta.dirname,
  "..",
  "tests",
  "fixtures",
  "runners-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
