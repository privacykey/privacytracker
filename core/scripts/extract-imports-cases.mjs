/**
 * Import-pipeline oracle for the Rust server (Phase 4, batch 3).
 *
 * Runs the REAL Next handlers of the twelve import-pipeline writes — the
 * `POST`/`DELETE` exports of ten route files: the import session and its
 * items, the item update, the queue drain, the completion, the per-item
 * retry and match change, the iTunes search, the App Store scrape and the
 * per-app Wayback import — against a scratch database and records, per
 * case, the request, the setup rows, every raw fetch (URL and headers),
 * every write in order with its transaction markers, the fourteen tables
 * an import write can touch, and the wire response.
 *
 * The network is a stub: each case lists its replies in the order the
 * handler will ask for them, exactly as the Phase 3 fetch, search and
 * history oracles did, and a case that leaves a reply unused is a design
 * error the run refuses. Foreign keys stay ON — the match change relies
 * on the apps cascade and the import delete on the items cascade.
 *
 * Determinism as before: frozen clock, counted ids (the global `crypto`,
 * the `node:crypto` module, and — new here — `randomBytes(9)`, which
 * lib/imports.ts turns into its `imp_`/`iti_` ids: twelve base64url
 * characters round-trip to exactly nine bytes, so a zero-padded counter
 * decodes and re-encodes to itself), a distinct forwarded address per
 * case, the soft pacers reset per case, and `repeat` for the limit+1
 * bursts. Successful imports and scrapes arm a deferred policy fetch on
 * a real timer; every case holds the `policy_sync_running` mutex so that
 * timer finds the runner busy and writes nothing.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-imports-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
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
  "imports",
  "imports/items",
  "imports/items/update",
  "imports/queue",
  "imports/complete",
  "imports/items/retry",
  "imports/items/change-match",
  "search",
  "scrape",
  "apps/[id]/import-history",
];
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
  "devices",
  "app_devices",
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
// Held for the whole run (outside the per-case savepoint) so the deferred
// policy fetch a successful import arms can never start; also part of
// every recorded setup so the replay sees the same row.
const POLICY_LOCK = setting("policy_sync_running", "true");
db.prepare(POLICY_LOCK.sql).run(...POLICY_LOCK.params);

const DAY = 86_400_000;
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;
const A1 = "1001";
const A2 = "1002";
const A3 = "1003";
const F1 = "555000111";
const F2 = "555000222";
const D1 = "d-one";
const I1 = "imp_fixture_a";
const I2 = "imp_fixture_b";
const app = (id, name = `App ${id}`, extra = {}) =>
  stmt(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
    id,
    name,
    extra.url === undefined ? url(id) : extra.url,
    extra.firstSeen ?? now - 5 * DAY,
    extra.lastSynced ?? now - 5 * DAY
  );
const device = (id, name) =>
  stmt(
    "INSERT INTO devices (id, name, ecid, model, ios_version, device_class, created_at, last_synced_at, is_unknown_placeholder, owner_label, owner_audience, permission_acknowledged_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, NULL, NULL, NULL)",
    id,
    name,
    1_700_000_000_000,
    1_700_000_000_000
  );
const link = (appId, deviceId) =>
  stmt(
    "INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
    appId,
    deviceId,
    1_700_000_000_000,
    1_700_000_000_000
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
const notification = (id, appId) =>
  stmt(
    "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read) VALUES (?, ?, ?, ?, ?, 0)",
    id,
    appId,
    "App",
    "[]",
    1_700_000_000_000
  );
const snapshot = (id, appId, scrapedAt, source, triggeredBy) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source, triggered_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    appId,
    scrapedAt,
    "[]",
    "[]",
    source,
    triggeredBy
  );
const privacyType = (id, appId) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    appId,
    "DATA_LINKED_TO_YOU",
    "Data Linked to You"
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
const TRACKING = type("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
  cat("LOCATION", "Location"),
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
const archivedPage = (types) =>
  `<html><head><script id="serialized-server-data">${JSON.stringify({ data: [{ data: { shelfMapping: { privacyTypes: { items: types } } } }] })}</script></head><body></body></html>`;
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
// A scrape is the page and then the version lookup.
const scrapeOf = (name, types = [LINKED]) => [html(page(name, types)), LOOKUP];
const RATE_LIMITED = status(429, { "retry-after": "30" });
const itunes = (results) => json({ resultCount: results.length, results }, 200);
const candidate = (n, over = {}) => ({
  trackId: 90_000_100 + n,
  trackName: `App ${n}`,
  artistName: `Dev ${n}`,
  artworkUrl100: `https://example.com/${n}/100x100bb.png`,
  trackViewUrl: `https://apps.apple.com/us/app/app-${n}/id${90_000_100 + n}?uo=4`,
  bundleId: `com.example.app${n}`,
  contentAdvisoryRating: "4+",
  ...over,
});
const ts = (y, mo, d, h = 12) =>
  `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}${String(h).padStart(2, "0")}0000`;
const cdx = (timestamps) =>
  json([["timestamp", "statuscode"], ...timestamps.map((t) => [t, "200"])]);
// Targets walk back from today in interval steps, so the newest quarterly
// target is mid-June: one capture within 45 days of it, but more than 45
// days before today, is one index read, one replay, then Save Page Now.
const SAVE_OK = status(302, {
  location: `https://web.archive.org/web/${ts(2026, 9, 15)}/${url(F1)}`,
});
const ARCHIVE_RUN = [
  cdx([ts(2026, 7, 20)]),
  html(archivedPage([LINKED, TRACKING])),
  SAVE_OK,
];

// ── The runner ───────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
const cases = [];
let ipCounter = 0;
async function run(name, spec) {
  const {
    route,
    method,
    param,
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
  const setup = [POLICY_LOCK, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.3`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "imports-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const pathname =
    param === undefined
      ? route
      : route.replace("[id]", encodeURIComponent(param));
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
  const saved = quiet.map((k) => [k, console[k]]);
  db.exec("SAVEPOINT imports_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    _resetSoftBuckets();
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
      for (const k of quiet) {
        console[k] = () => {};
      }
      try {
        const response =
          param === undefined
            ? await handler(request)
            : await handler(request, {
                params: Promise.resolve({ id: param }),
              });
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
      } finally {
        for (const [k, fn] of saved) {
          console[k] = fn;
        }
      }
    }
    if (settle) {
      // The immediate webhook is `void`ed: let the detached POST land.
      await new Promise((resolve) => setTimeout(resolve, 60));
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
      // The replay's dump abbreviates a long table the same way.
      rows[table] =
        all.length > 100
          ? { count: all.length, head: all.slice(0, 3), tail: all.slice(-3) }
          : all;
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
      replies,
      calls,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO imports_case; RELEASE imports_case");
  }
}

async function bodyCases(route, method, limit, extra = {}) {
  const { streamed = true, ...rest } = extra;
  await run(`${route} ${method} empty body`, { route, method, ...rest });
  await run(`${route} ${method} invalid json`, {
    route,
    method,
    raw: "{not json",
    ...rest,
  });
  await run(`${route} ${method} whitespace body`, {
    route,
    method,
    raw: "  \n ",
    ...rest,
  });
  await run(`${route} ${method} declared too large`, {
    route,
    method,
    json: {},
    contentLength: limit + 1,
    ...rest,
  });
  if (streamed) {
    await run(`${route} ${method} streamed too large`, {
      route,
      method,
      raw: `{"pad":"${"x".repeat(limit)}"}`,
      ...rest,
    });
  }
}

try {
  // ── /api/imports ─────────────────────────────────────────────────
  {
    const route = "/api/imports";
    await run("imports create manifest body", {
      route,
      method: "POST",
      json: { source: "manual" },
    });
    await run("imports create every field", {
      route,
      method: "POST",
      setup: [device(D1, "Mum's iPhone")],
      json: {
        source: "screenshots",
        sourceLabel: "Mum's iPhone",
        total: 7,
        deviceId: " d-one ",
      },
    });
    await run("imports create non-string extras", {
      route,
      method: "POST",
      json: { source: "file", sourceLabel: 5, total: "5", deviceId: "   " },
    });
    await run("imports create fractional total", {
      route,
      method: "POST",
      json: { source: "file", total: 2.5 },
    });
    await run("imports create unknown device is stored", {
      route,
      method: "POST",
      json: { source: "manual", deviceId: "nope" },
    });
    await run("imports create invalid source", {
      route,
      method: "POST",
      json: { source: "email" },
    });
    await run("imports create missing source", {
      route,
      method: "POST",
      json: { sourceLabel: "x" },
    });
    await run("imports create null body", {
      route,
      method: "POST",
      raw: "null",
    });
    await bodyCases(route, "POST", 8 * 1024);

    const deletable = [
      app(A1),
      app(A2),
      app(A3),
      importRow(I1, { total: 3, imported: 1, matched: 2, unmatched: 1 }),
      item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
      item("iti_fixture_2", I1, "Two", "matched", { appId: A2 }),
      item("iti_fixture_3", I1, "Three", "removed", { removedAppId: A3 }),
      item("iti_fixture_4", I1, "Four", "unmatched"),
    ];
    await run("imports delete removing apps", {
      route,
      method: "DELETE",
      setup: deletable,
      search: `?id=${I1}&removeApps=true`,
    });
    await run("imports delete keeping apps", {
      route,
      method: "DELETE",
      setup: deletable,
      search: `?id=${I1}&removeApps=1`,
    });
    await run("imports delete unknown import", {
      route,
      method: "DELETE",
      search: "?id=imp_missing&removeApps=true",
    });
    await run("imports delete missing id", { route, method: "DELETE" });
    await run("imports delete empty id", {
      route,
      method: "DELETE",
      search: "?id=&removeApps=true",
    });
  }

  // ── /api/imports/items ───────────────────────────────────────────
  {
    const route = "/api/imports/items";
    const base = [importRow(I1)];
    await run("items add manifest body", {
      route,
      method: "POST",
      setup: base,
      json: {
        importId: I1,
        items: [{ query: "Parity Test App", status: "unmatched" }],
      },
    });
    await run("items add every field", {
      route,
      method: "POST",
      setup: [...base, app(A1)],
      json: {
        importId: ` ${I1} `,
        items: [
          {
            query: " Tracked ",
            editedQuery: "  Trimmed  ",
            status: "matched",
            appId: A1,
            appName: "Tracked App",
            developer: "Dev",
            url: url(A1),
            iconUrl: "https://example.com/icon.png",
            country: "gb",
            scrapeError: "old error",
          },
          {
            query: "Untracked",
            status: "matched",
            appId: "9999",
            appName: 5,
            editedQuery: "   ",
          },
          { query: "Queued", status: "queued", retryAfterMs: 5000 },
          {
            query: "Pending",
            status: "pending_search",
            nextAttemptAt: 1_789_473_700_000,
            retryAfterMs: 1,
          },
          { query: "Matched wait", status: "matched", retryAfterMs: 5000 },
          {
            query: "Queued nothing",
            status: "queued",
            nextAttemptAt: 0,
            retryAfterMs: -5,
          },
          {
            query: "Queued string stamp",
            status: "queued",
            nextAttemptAt: "123",
            retryAfterMs: 100,
          },
        ],
      },
    });
    await run("items add drops invalid rows", {
      route,
      method: "POST",
      setup: base,
      json: {
        importId: I1,
        items: [
          { query: "  ", status: "matched" },
          { query: "Bad status", status: "bogus" },
          { query: 5, status: "matched" },
          "junk",
          null,
          { query: "Keep", status: "skipped" },
        ],
      },
    });
    await run("items add all rows invalid", {
      route,
      method: "POST",
      setup: base,
      json: { importId: I1, items: [{ query: "", status: "matched" }] },
    });
    await run("items add items not an array", {
      route,
      method: "POST",
      setup: base,
      json: { importId: I1, items: "nope" },
    });
    await run("items add missing importId", {
      route,
      method: "POST",
      setup: base,
      json: { items: [{ query: "X", status: "matched" }] },
    });
    await run("items add non-string importId", {
      route,
      method: "POST",
      setup: base,
      json: { importId: 5, items: [{ query: "X", status: "matched" }] },
    });
    await run("items add unknown import", {
      route,
      method: "POST",
      json: {
        importId: "imp_missing",
        items: [{ query: "X", status: "matched" }],
      },
    });
    await run("items add too many", {
      route,
      method: "POST",
      setup: base,
      json: { importId: I1, items: new Array(5001).fill({}) },
    });
    await run("items add upserts existing rows", {
      route,
      method: "POST",
      setup: [
        ...base,
        app(A1),
        item("iti_fixture_1", I1, "Alpha", "matched", {
          developer: "Keep Dev",
          country: "gb",
        }),
        item("iti_fixture_2", I1, "Beta", "removed", { removedAppId: A1 }),
        item("iti_fixture_3", I1, "Gamma", "queued", {
          url: url(A1),
          nextAttemptAt: 5,
          attemptCount: 2,
        }),
      ],
      json: {
        importId: I1,
        items: [
          {
            query: "Alpha",
            status: "imported",
            appId: A1,
            appName: "Alpha App",
            url: url(A1),
          },
          { query: "Beta", status: "matched", appId: A1 },
          { query: "Gamma", status: "error", scrapeError: "boom" },
          { query: "Delta", status: "unmatched" },
        ],
      },
    });
    await run("items add duplicate queries in one batch", {
      route,
      method: "POST",
      setup: base,
      json: {
        importId: I1,
        items: [
          { query: "Dup", status: "matched" },
          { query: "Dup", status: "unmatched" },
        ],
      },
    });
    await run("items add two chunks", {
      route,
      method: "POST",
      setup: base,
      json: {
        importId: I1,
        items: Array.from({ length: 201 }, (_, i) => ({
          query: `App ${String(i + 1).padStart(3, "0")}`,
          status: i % 2 ? "matched" : "unmatched",
        })),
      },
    });
    await bodyCases(route, "POST", 512 * 1024, { streamed: false });
    await run("items add rate limited", {
      route,
      method: "POST",
      json: { importId: "x", items: [] },
      repeat: 31,
    });
  }

  // ── /api/imports/items/update ────────────────────────────────────
  {
    const route = "/api/imports/items/update";
    const E1 = "iti_fixture_1";
    const base = [
      app(A1),
      importRow(I1, { total: 2, matched: 1, unmatched: 1 }),
      item(E1, I1, "Alpha", "matched", {
        developer: "Keep Dev",
        country: "gb",
        nextAttemptAt: 5,
      }),
      item("iti_fixture_2", I1, "Beta", "unmatched"),
    ];
    await run("items update manifest body", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, status: "skipped" },
    });
    await run("items update every field", {
      route,
      method: "POST",
      setup: base,
      json: {
        itemId: ` ${E1} `,
        query: " New Query ",
        editedQuery: "  ",
        status: "matched",
        appId: A1,
        appName: "Alpha App",
        developer: 5,
        url: url(A1),
        iconUrl: "https://example.com/icon.png",
        country: "us",
        scrapeError: null,
        retryAfterMs: 5000,
      },
    });
    await run("items update queued with backoff", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, status: "queued", retryAfterMs: 90_000 },
    });
    await run("items update queued without backoff", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, status: "queued", retryAfterMs: "90" },
    });
    await run("items update unknown app id", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, appId: "9999" },
    });
    await run("items update app id null", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, appId: null, appName: null, developer: null },
    });
    await run("items update app id number", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, appId: 5 },
    });
    await run("items update no fields", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1 },
    });
    await run("items update blank query only", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, query: "   ", status: 5 },
    });
    await run("items update invalid status", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: E1, status: "bogus" },
    });
    await run("items update unknown item", {
      route,
      method: "POST",
      setup: base,
      json: { itemId: "iti_missing", status: "skipped" },
    });
    await run("items update missing itemId", {
      route,
      method: "POST",
      setup: base,
      json: { status: "skipped" },
    });
    await bodyCases(route, "POST", 32 * 1024);
  }

  // ── /api/imports/queue ───────────────────────────────────────────
  {
    const route = "/api/imports/queue";
    const method = "POST";
    await run("queue run empty", { route, method });
    await run("queue run busy", {
      route,
      method,
      setup: [
        setting("import_queue_running", "true"),
        setting("import_queue_running_since", String(now - 10_000)),
        setting("import_queue_paused_until", String(now + 50_000)),
      ],
    });
    await run("queue run busy without a stamp", {
      route,
      method,
      setup: [setting("import_queue_running", "true")],
    });
    await run("queue run clears a stale lock", {
      route,
      method,
      setup: [
        setting("import_queue_running", "true"),
        setting("import_queue_running_since", String(now - 100_000)),
      ],
    });
    await run("queue run one success completes the import", {
      route,
      method,
      setup: [
        device(D1, "Phone"),
        importRow(I1, {
          total: 1,
          matched: 1,
          deviceId: D1,
          sourceLabel: "Phone",
        }),
        item("iti_fixture_1", I1, "Fixture One", "queued", {
          url: url(F1),
          developer: "Queued Dev",
          iconUrl: "https://example.com/q.png",
          nextAttemptAt: now + 500_000,
          attemptCount: 1,
        }),
      ],
      replies: scrapeOf("Fixture One"),
    });
    await run("queue run untracked before tracked", {
      route,
      method,
      setup: [
        app(A1, "Tracked"),
        importRow(I1, { total: 2, matched: 2 }),
        item("iti_fixture_1", I1, "Tracked", "queued", {
          url: url(A1),
          appId: A1,
        }),
        item("iti_fixture_2", I1, "Fixture Two", "queued", { url: url(F2) }),
      ],
      replies: [...scrapeOf("Fixture Two"), ...scrapeOf("Tracked")],
    });
    await run("queue run no url and not found", {
      route,
      method,
      setup: [
        importRow(I1, { total: 2, matched: 2, source: "file" }),
        item("iti_fixture_1", I1, "No URL", "queued"),
        item("iti_fixture_2", I1, "Gone", "queued", { url: url(F1) }),
      ],
      replies: [status(404)],
    });
    await run("queue run rate limited pauses the queue", {
      route,
      method,
      setup: [
        importRow(I1, { total: 2, matched: 2 }),
        item("iti_fixture_1", I1, "First", "queued", {
          url: url(F1),
          attemptCount: 2,
          scrapeError: "earlier",
        }),
        item("iti_fixture_2", I1, "Second", "queued", { url: url(F2) }),
      ],
      replies: [RATE_LIMITED],
    });
    await run("queue run claims ten of eleven", {
      route,
      method,
      setup: [
        importRow(I1, { total: 11, matched: 11 }),
        ...Array.from({ length: 11 }, (_, i) =>
          item(`iti_fixture_${i + 1}`, I1, `Row ${i + 1}`, "queued", {
            url: url(F1),
          })
        ),
      ],
      replies: [RATE_LIMITED],
    });
  }

  // ── /api/imports/complete ────────────────────────────────────────
  {
    const route = "/api/imports/complete";
    const method = "POST";
    const mixed = [
      app(A1),
      app(A2),
      importRow(I1, { total: 4, sourceLabel: "Mum's iPhone", source: "file" }),
      item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
      item("iti_fixture_2", I1, "Two", "imported", { appId: A2 }),
      item("iti_fixture_3", I1, "Three", "unmatched"),
      item("iti_fixture_4", I1, "Four", "error", { scrapeError: "boom" }),
    ];
    await run("complete manifest body", {
      route,
      method,
      setup: mixed,
      json: { importId: I1 },
    });
    await run("complete with device links", {
      route,
      method,
      setup: [
        app(A1),
        app(A2),
        device(D1, "Phone"),
        link(A1, D1),
        importRow(I1, { total: 2, deviceId: D1 }),
        item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
        item("iti_fixture_2", I1, "Two", "imported", { appId: A2 }),
        item("iti_fixture_3", I1, "Two again", "imported", { appId: A2 }),
      ],
      json: { importId: ` ${I1} ` },
    });
    await run("complete nothing persisted", {
      route,
      method,
      setup: [importRow(I1, { total: 3, sourceLabel: "CSV" })],
      json: { importId: I1 },
    });
    await run("complete everything failed", {
      route,
      method,
      setup: [
        importRow(I1, { total: 2, source: "screenshots" }),
        item("iti_fixture_1", I1, "One", "error"),
        item("iti_fixture_2", I1, "Two", "error"),
      ],
      json: { importId: I1 },
    });
    await run("complete one app failed", {
      route,
      method,
      setup: [
        app(A1),
        importRow(I1, { total: 1 }),
        item("iti_fixture_1", I1, "One", "error"),
      ],
      json: { importId: I1 },
    });
    await run("complete with queued rows", {
      route,
      method,
      setup: [
        app(A1),
        importRow(I1, { total: 2 }),
        item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
        item("iti_fixture_2", I1, "Two", "queued", { url: url(F1) }),
      ],
      json: { importId: I1 },
    });
    await run("complete rows missing from history", {
      route,
      method,
      setup: [
        app(A1),
        app(A2),
        importRow(I1, { total: 5 }),
        item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
        item("iti_fixture_2", I1, "Two", "imported", { appId: A2 }),
      ],
      json: { importId: I1 },
    });
    await run("complete prompt debounced", {
      route,
      method,
      setup: [
        ...mixed,
        setting("manual_apps_prompt_notified_at", String(now - 1000)),
      ],
      json: { importId: I1 },
    });
    await run("complete prompt after the window", {
      route,
      method,
      setup: [
        ...mixed,
        setting("manual_apps_prompt_notified_at", String(now - DAY - 1)),
      ],
      json: { importId: I1 },
    });
    await run("complete twice", {
      route,
      method,
      setup: [
        app(A1),
        importRow(I1, { total: 1, imported: 1, completedAt: now - 1000 }),
        item("iti_fixture_1", I1, "One", "imported", { appId: A1 }),
      ],
      json: { importId: I1 },
    });
    await run("complete blank source label", {
      route,
      method,
      setup: [
        importRow(I1, { total: 1, sourceLabel: "  " }),
        item("iti_fixture_1", I1, "One", "skipped"),
      ],
      json: { importId: I1 },
    });
    await run("complete unknown import", {
      route,
      method,
      json: { importId: "imp_missing" },
    });
    await run("complete missing importId", {
      route,
      method,
      json: { importId: 5 },
    });
    await bodyCases(route, method, 4 * 1024);
  }

  // ── /api/imports/items/retry ─────────────────────────────────────
  {
    const route = "/api/imports/items/retry";
    const method = "POST";
    const P1 = "iti_fixture_1";
    const pending = (extra = {}) => [
      importRow(I1, { total: 1 }),
      item(P1, I1, "Clock", "pending_search", {
        developer: "Dev 1",
        country: "gb",
        nextAttemptAt: now - 1,
        scrapeError: "iTunes Search rate-limited; will retry later",
        ...extra,
      }),
    ];
    await run("retry pending search matched", {
      route,
      method,
      setup: pending(),
      json: { itemId: P1 },
      replies: [itunes([candidate(1), candidate(2)])],
    });
    await run("retry pending search edited query wins", {
      route,
      method,
      setup: pending({
        editedQuery: " Weather ",
        country: null,
        developer: null,
      }),
      json: { itemId: ` ${P1} ` },
      replies: [itunes([candidate(3)])],
    });
    await run("retry pending search no match", {
      route,
      method,
      setup: pending(),
      json: { itemId: P1 },
      replies: [itunes([]), itunes([])],
    });
    await run("retry pending search rate limited", {
      route,
      method,
      setup: pending(),
      json: { itemId: P1 },
      replies: [status(429, { "retry-after": "12" })],
    });
    await run("retry queued without url", {
      route,
      method,
      setup: [importRow(I1, { total: 1 }), item(P1, I1, "No URL", "queued")],
      json: { itemId: P1 },
    });
    await run("retry queued success", {
      route,
      method,
      setup: [
        importRow(I1, { total: 1, matched: 1 }),
        item(P1, I1, "Fixture One", "queued", {
          url: url(F1),
          developer: "Queued Dev",
          iconUrl: "https://example.com/q.png",
          attemptCount: 1,
        }),
      ],
      json: { itemId: P1 },
      replies: scrapeOf("Fixture One"),
    });
    await run("retry queued rate limited", {
      route,
      method,
      setup: [
        importRow(I1, { total: 1, matched: 1 }),
        item(P1, I1, "Fixture One", "queued", {
          url: url(F1),
          attemptCount: 2,
        }),
      ],
      json: { itemId: P1 },
      replies: [RATE_LIMITED],
    });
    await run("retry queued not found", {
      route,
      method,
      setup: [
        importRow(I1, { total: 1, matched: 1 }),
        item(P1, I1, "Fixture One", "queued", { url: url(F1) }),
      ],
      json: { itemId: P1 },
      replies: [status(404)],
    });
    await run("retry matched row with url", {
      route,
      method,
      setup: [
        importRow(I1, { total: 2, matched: 2 }),
        item(P1, I1, "Fixture One", "matched", { url: url(F1) }),
        item("iti_fixture_2", I1, "Other", "matched", { url: url(F2) }),
      ],
      json: { itemId: P1 },
      replies: scrapeOf("Fixture One"),
    });
    await run("retry unknown item", {
      route,
      method,
      json: { itemId: "iti_missing" },
    });
    await run("retry missing itemId", { route, method, json: { itemId: "" } });
    await bodyCases(route, method, 4 * 1024);
    await run("retry rate limited", {
      route,
      method,
      json: { itemId: "iti_missing" },
      repeat: 31,
    });
  }

  // ── /api/imports/items/change-match ──────────────────────────────
  {
    const route = "/api/imports/items/change-match";
    const method = "POST";
    const C1 = "iti_fixture_1";
    const previous = [
      app(A1, "Old Match"),
      privacyType("pt-old", A1),
      notification("n-old", A1),
      importRow(I1, { total: 1, imported: 1 }),
      item(C1, I1, "Old query", "imported", {
        appId: A1,
        appName: "Old Match",
        editedQuery: "Old edited",
      }),
    ];
    await run("change-match replaces and removes the previous app", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: ` ${url(F1)} ` },
      replies: scrapeOf("Fixture One"),
    });
    await run("change-match previous app still referenced", {
      route,
      method,
      setup: [
        ...previous,
        importRow(I2, { total: 1, imported: 1 }),
        item("iti_fixture_2", I2, "Old query", "imported", { appId: A1 }),
      ],
      json: { itemId: C1, url: url(F1) },
      replies: scrapeOf("Fixture One"),
    });
    await run("change-match tombstoned previous app", {
      route,
      method,
      setup: [
        app(A1, "Old Match"),
        importRow(I1, { total: 1 }),
        item(C1, I1, "Old query", "removed", { removedAppId: A1 }),
      ],
      json: { itemId: C1, url: url(F1) },
      replies: scrapeOf("Fixture One"),
    });
    await run("change-match same app", {
      route,
      method,
      setup: [
        app(F1, "Fixture One"),
        importRow(I1, { total: 1, imported: 1 }),
        item(C1, I1, "Fixture One", "imported", { appId: F1 }),
      ],
      json: { itemId: C1, url: url(F1) },
      replies: scrapeOf("Fixture One", [LINKED, TRACKING]),
    });
    await run("change-match explicit edited query", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: url(F1), editedQuery: " Custom " },
      replies: scrapeOf("Fixture One"),
    });
    await run("change-match scrape not found", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: url(F1) },
      replies: [status(404)],
    });
    await run("change-match scrape rate limited", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: url(F1) },
      replies: [RATE_LIMITED],
    });
    await run("change-match invalid url", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: "https://example.com/us/app/x/id1" },
    });
    await run("change-match url without id", {
      route,
      method,
      setup: previous,
      json: { itemId: C1, url: "https://apps.apple.com/us/app/x" },
    });
    await run("change-match missing itemId", {
      route,
      method,
      setup: previous,
      json: { url: url(F1) },
    });
    await run("change-match unknown item", {
      route,
      method,
      setup: previous,
      json: { itemId: "iti_missing", url: url(F1) },
    });
    await bodyCases(route, method, 16 * 1024);
  }

  // ── /api/search ──────────────────────────────────────────────────
  {
    const route = "/api/search";
    const method = "POST";
    await run("search names", {
      route,
      method,
      json: { names: ["Clock", "Weather"] },
      replies: [itunes([candidate(1), candidate(2)]), itunes([candidate(3)])],
    });
    await run("search names sanitised", {
      route,
      method,
      json: {
        names: [
          "  Facebook 500.0.0.46.78 ",
          "facebook",
          "",
          7,
          "Word 2024",
          "|",
          "Outlook — 1.2.3",
        ],
      },
      replies: [
        itunes([candidate(4)]),
        itunes([candidate(5)]),
        itunes([candidate(6)]),
      ],
    });
    await run("search rows with developer hints", {
      route,
      method,
      json: {
        rows: [
          { name: "Clock 1.2.3", developer: "Acme, Inc." },
          { name: "clock" },
          { name: "" },
          "junk",
          { name: "Weather", developer: "v1.2.3", likelyWebClip: true },
          { name: "Weather", developer: "Sky Labs" },
          { name: "Mail", developer: "app name" },
        ],
      },
      replies: [
        itunes([candidate(1), candidate(7, { artistName: "Acme" })]),
        itunes([candidate(3)]),
        itunes([candidate(8)]),
      ],
    });
    await run("search bundle ids", {
      route,
      method,
      json: {
        bundleIds: ["com.example.app1", " com.example.app2 ", "", 5],
        names: ["Ignored"],
      },
      replies: [itunes([candidate(1), candidate(2)])],
    });
    await run("search bundle ids all blank", {
      route,
      method,
      json: { bundleIds: ["", "  ", 5] },
    });
    await run("search bundle ids rate limited", {
      route,
      method,
      json: { bundleIds: ["com.example.app1"] },
      replies: [status(429, { "retry-after": "7" })],
    });
    await run("search names rate limited mid batch", {
      route,
      method,
      json: { names: ["Clock", "Weather", "Mail"] },
      replies: [itunes([candidate(1)]), status(429, { "retry-after": "7" })],
    });
    await run("search names none usable", {
      route,
      method,
      json: { names: ["", "a", 5, "  "] },
    });
    await run("search rows none usable", {
      route,
      method,
      json: { rows: [{ name: "" }, "x", { developer: "Acme" }] },
    });
    await run("search country", {
      route,
      method,
      json: { names: ["Clock"], country: " GB " },
      replies: [itunes([candidate(1)])],
    });
    await run("search country unknown", {
      route,
      method,
      json: { names: ["Clock"], country: "xx" },
      replies: [itunes([candidate(1)])],
    });
    await run("search country non-string", {
      route,
      method,
      json: { names: ["Clock"], country: 12 },
      replies: [itunes([candidate(1)])],
    });
    await run("search invalid payload", {
      route,
      method,
      json: { names: "Clock", rows: {}, bundleIds: [] },
    });
    await run("search empty arrays", {
      route,
      method,
      json: { names: [], rows: [] },
    });
    await run("search null body", { route, method, raw: "null" });
    await run("search array body", { route, method, raw: "[]" });
    await run("search string body", { route, method, raw: '"x"' });
    await bodyCases(route, method, 256 * 1024, { streamed: false });
    await run("search rate limited", {
      route,
      method,
      json: {},
      repeat: 61,
    });
  }

  // ── /api/scrape ──────────────────────────────────────────────────
  {
    const route = "/api/scrape";
    const method = "POST";
    await run("scrape two urls", {
      route,
      method,
      json: { urls: [url(F1), url(F2)] },
      replies: [...scrapeOf("Fixture One"), ...scrapeOf("Fixture Two")],
    });
    await run("scrape resync existing app", {
      route,
      method,
      setup: [app(F1, "Fixture One")],
      json: { urls: [url(F1)], resync: true },
      replies: scrapeOf("Fixture One", [LINKED, TRACKING]),
    });
    await run("scrape trigger override", {
      route,
      method,
      json: { urls: [url(F1)], trigger: "wayback", resync: "true" },
      replies: scrapeOf("Fixture One"),
    });
    await run("scrape unknown trigger", {
      route,
      method,
      json: { urls: [url(F1)], trigger: "bogus" },
      replies: scrapeOf("Fixture One"),
    });
    await run("scrape one not found", {
      route,
      method,
      json: { urls: [url(F1), url(F2)] },
      replies: [status(404), ...scrapeOf("Fixture Two")],
    });
    await run("scrape rate limited stops the batch", {
      route,
      method,
      json: { urls: [url(F1), url(F2), url(A1)] },
      replies: [...scrapeOf("Fixture One"), RATE_LIMITED],
    });
    await run("scrape rejects a foreign host", {
      route,
      method,
      json: { urls: [url(F1), "https://example.com/us/app/x/id1"] },
    });
    await run("scrape rejects a non-string", {
      route,
      method,
      json: { urls: [5] },
    });
    await run("scrape rejects a url without id", {
      route,
      method,
      json: { urls: ["https://apps.apple.com/us/app/x"] },
    });
    await run("scrape rejects an overlong url", {
      route,
      method,
      json: { urls: [`${url(F1)}?${"x".repeat(2100)}`] },
    });
    await run("scrape too many urls", {
      route,
      method,
      json: { urls: new Array(101).fill(url(F1)) },
    });
    await run("scrape empty urls", { route, method, json: { urls: [] } });
    await run("scrape urls not an array", {
      route,
      method,
      json: { urls: url(F1) },
    });
    await run("scrape null body", { route, method, raw: "null" });
    await bodyCases(route, method, 256 * 1024, { streamed: false });
    await run("scrape rate limited", {
      route,
      method,
      json: { urls: [] },
      repeat: 31,
    });
  }

  // ── /api/apps/[id]/import-history ────────────────────────────────
  {
    const route = "/api/apps/[id]/import-history";
    const base = [app(F1, "Fixture One")];
    await run("history import manifest body", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: {},
      replies: ARCHIVE_RUN,
    });
    await run("history import forced with interval", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: { intervalMonths: 6.9, force: true },
      replies: ARCHIVE_RUN,
    });
    await run("history import six-month cadence", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: { intervalMonths: 6 },
      replies: [cdx([ts(2026, 7, 20)]), SAVE_OK],
    });
    await run("history import interval out of range", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: { intervalMonths: 7, force: "yes" },
      replies: ARCHIVE_RUN,
    });
    await run("history import archive rate limited", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: { force: true },
      replies: [status(429, { "retry-after": "30" })],
    });
    await run("history import archive unavailable", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      replies: [status(503)],
    });
    await run("history import app not found", {
      route,
      method: "POST",
      param: "999",
      setup: base,
    });
    await run("history import app without url", {
      route,
      method: "POST",
      param: A1,
      setup: [app(A1, "No URL", { url: "" })],
    });
    await run("history import invalid body falls back", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      raw: "{bad",
      replies: ARCHIVE_RUN,
    });
    await run("history import declared too large", {
      route,
      method: "POST",
      param: F1,
      setup: base,
      json: {},
      contentLength: 4097,
    });
    await run("history import throttled", {
      route,
      method: "POST",
      param: "999",
      repeat: 4,
    });
    await run("history remove", {
      route,
      method: "DELETE",
      param: F1,
      setup: [
        ...base,
        app(F2, "Fixture Two"),
        snapshot("s1", F1, now - 3 * DAY, "wayback", "wayback"),
        snapshot("s2", F1, now - 2 * DAY, "live", "wayback"),
        snapshot("s3", F1, now - DAY, "live", "manual"),
        snapshot("s4", F2, now - DAY, "wayback", "wayback"),
      ],
    });
    await run("history remove nothing", {
      route,
      method: "DELETE",
      param: F1,
      setup: base,
    });
    await run("history remove app not found", {
      route,
      method: "DELETE",
      param: "999",
    });
  }

  // ── The immediate webhook on every path that scrapes ─────────────
  // A scrape that records label changes posts the immediate webhook once
  // its commit has landed. Kept last: each case's forwarded address comes
  // from a counter, so cases added earlier would move every later case's.
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
    const changed = (name) => scrapeOf(name, [LINKED, TRACKING]);
    await run("scrape resync with label changes posts the immediate webhook", {
      route: "/api/scrape",
      method: "POST",
      setup: [...webhook, app(F1, "Fixture One")],
      json: { urls: [url(F1)], resync: true },
      replies: [...changed("Fixture One"), HOOK_OK],
      settle: true,
    });
    await run("queue run posts a webhook per tracked app with changes", {
      route: "/api/imports/queue",
      method: "POST",
      setup: [
        ...webhook,
        app(A1, "Tracked One"),
        app(A2, "Tracked Two"),
        importRow(I1, { total: 2, matched: 2 }),
        item("iti_fixture_1", I1, "Tracked One", "queued", {
          url: url(A1),
          appId: A1,
        }),
        item("iti_fixture_2", I1, "Tracked Two", "queued", {
          url: url(A2),
          appId: A2,
        }),
      ],
      replies: [
        ...changed("Tracked One"),
        HOOK_OK,
        ...changed("Tracked Two"),
        HOOK_OK,
      ],
      settle: true,
    });
    await run("retry onto a tracked app posts the immediate webhook", {
      route: "/api/imports/items/retry",
      method: "POST",
      setup: [
        ...webhook,
        app(F1, "Fixture One"),
        importRow(I1, { total: 1, matched: 1 }),
        item("iti_fixture_1", I1, "Fixture One", "queued", { url: url(F1) }),
      ],
      json: { itemId: "iti_fixture_1" },
      replies: [...changed("Fixture One"), HOOK_OK],
      settle: true,
    });
    await run("change-match onto a tracked app posts the immediate webhook", {
      route: "/api/imports/items/change-match",
      method: "POST",
      setup: [
        ...webhook,
        app(F1, "Fixture One"),
        importRow(I1, { total: 1, imported: 1 }),
        item("iti_fixture_1", I1, "Fixture One", "imported", { appId: F1 }),
      ],
      json: { itemId: "iti_fixture_1", url: url(F1) },
      replies: [...changed("Fixture One"), HOOK_OK],
      settle: true,
    });
    // The Wayback importer writes changed snapshots but raises no bell, so
    // it posts nothing either.
    await run("history import with label changes posts no webhook", {
      route: "/api/apps/[id]/import-history",
      method: "POST",
      param: F1,
      setup: [
        ...webhook,
        app(F1, "Fixture One"),
        snapshot("s-live", F1, Date.UTC(2026, 0, 10), "live", "import"),
      ],
      json: {},
      replies: ARCHIVE_RUN,
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
  "imports-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
