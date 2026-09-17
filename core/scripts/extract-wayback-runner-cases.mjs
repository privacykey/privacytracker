/**
 * Wayback bulk-runner oracle for the Rust server (Phase 4, batch 4b).
 *
 * Runs the REAL `runBulkWaybackImport` through every way Node reaches it:
 * `POST /api/wayback/import-all` buffered and streaming (the NDJSON
 * frames are the recorded body), `PATCH` with its pause, cancel and
 * resume controls (the resume spawns its run; the oracle waits for the
 * mutex to clear), `DELETE`, and the boot-time resume in
 * `instrumentation.ts` — the real closure `register()` armed at 8 s,
 * captured and invoked with the clock frozen. Records, per case, the
 * request or the callback, the setup rows, every raw fetch, every write
 * in order with its transaction markers, the tables these paths touch,
 * and the wire response.
 *
 * Cooperative control mid-run is exercised through the network stub: a
 * case's `hooks` name a fetch (by index) at which the stub first calls
 * the PATCH route — a pause is honoured at the next app boundary; a
 * cancel aborts the in-flight request, which the stub reports the way
 * `fetch` does, with an AbortError — so both sides observe the control
 * at the same point.
 *
 * Determinism as before: frozen clock, counted ids, the network canned
 * per case, foreign keys ON, a distinct forwarded address per case, the
 * policy-sync mutex held, and the feature-flag migration marker preset
 * so `register()` migrates nothing. archive.org's backoff sleeps for
 * real: the throttled case asks for one second.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-wayback-oracle-"));
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

const ROUTES = ["wayback/import-all"];
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
  "privacy_snapshots",
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
const entry = (appId, appName, status, extra = {}) => ({
  appId,
  appName,
  status,
  ...extra,
});
const zero = () => ({
  appsAttempted: 0,
  appsWithImports: 0,
  targetsAttempted: 0,
  imported: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  snapshotsRequested: 0,
});
const bulkState = (queue, extra = {}) =>
  setting(
    "wayback_bulk_state",
    JSON.stringify({
      version: 2,
      runId: extra.runId ?? "run-fixture-1",
      startedAt: extra.startedAt ?? now - 3600_000,
      initiator: extra.initiator ?? "manual",
      updatedAt: extra.updatedAt ?? now - 1800_000,
      currentAppId: extra.currentAppId ?? null,
      status: extra.status ?? "running",
      queue,
      totals: extra.totals ?? zero(),
      streamRequested: extra.streamRequested ?? false,
      ...(extra.pausedAt === undefined ? {} : { pausedAt: extra.pausedAt }),
      ...(extra.pauseCause === undefined
        ? {}
        : { pauseCause: extra.pauseCause }),
      ...(extra.pauseRequestedAt === undefined
        ? {}
        : { pauseRequestedAt: extra.pauseRequestedAt }),
      ...(extra.cancelRequestedAt === undefined
        ? {}
        : { cancelRequestedAt: extra.cancelRequestedAt }),
    })
  );

// ── Archive replies ──────────────────────────────────────────────────
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
const ts = (y, mo, d, h = 12) =>
  `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}${String(h).padStart(2, "0")}0000`;
const cdx = (timestamps) =>
  json([["timestamp", "statuscode"], ...timestamps.map((t) => [t, "200"])]);
const saveOk = (appId) =>
  status(302, {
    location: `https://web.archive.org/web/${ts(2026, 9, 15)}/${url(appId)}`,
  });
// One capture within tolerance of the newest quarterly target: the index
// read, the replay, then Save Page Now (the capture is older than 45 days).
const archiveRun = (appId, types = [LINKED, TRACKING]) => [
  cdx([ts(2026, 7, 20)]),
  html(archivedPage(types)),
  saveOk(appId),
];
// An empty index: every target skipped, then Save Page Now.
const emptyRun = (appId) => [cdx([]), saveOk(appId)];
const THROTTLED = status(429, { "retry-after": "1" });

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;
const settled = () =>
  db
    .prepare(
      "SELECT value FROM app_settings WHERE key = 'wayback_import_running'"
    )
    .get()?.value !== "true";
async function waitForRun() {
  for (let i = 0; i < 400_000; i++) {
    if (settled()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const tail = db
    .prepare("SELECT summary FROM activity_log ORDER BY rowid DESC LIMIT 2")
    .all();
  throw new Error(`the spawned run never settled: ${JSON.stringify(tail)}`);
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
    hooks = [],
    adminToken = null,
    repeat = 1,
    contentLength,
    awaitRun = false,
  } = spec;
  const setup = [...BASE, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.5`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "wayback-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const patch = (action) =>
    handlers["/api/wayback/import-all"].PATCH(
      new NextRequest("http://127.0.0.1:3000/api/wayback/import-all", {
        method: "PATCH",
        headers: sent,
        body: JSON.stringify({ action }),
      })
    );
  const calls = [];
  let cursor = 0;
  globalThis.fetch = async (target, init) => {
    const index = calls.length;
    calls.push({
      url: String(target),
      headers: [...new Headers(init?.headers)],
    });
    const hook = hooks.find((h) => h.atCall === index);
    if (hook?.afterMs) {
      // The control lands a moment after this reply is served — during
      // the runner's backoff sleep, the one window where a pause is read
      // back before the runner's own state write overwrites it.
      setTimeout(() => {
        patch(hook.action).catch(() => {});
      }, hook.afterMs);
    } else if (hook) {
      // The control lands while this request is in flight: a cancel
      // aborts this request; a pause is overwritten by the app's own
      // state write when the app completes.
      await patch(hook.action);
      if (hook.action === "cancel") {
        throw new DOMException("This operation was aborted", "AbortError");
      }
    }
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply for ${String(target)}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  db.exec("SAVEPOINT wayback_case");
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
      if (kind === "callback") {
        await callbackFor(delay)();
        await waitForRun();
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
        if (awaitRun) {
          await waitForRun();
        }
      }
    } finally {
      restore();
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
      awaitRun,
      setup,
      replies,
      hooks,
      calls,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO wayback_case; RELEASE wayback_case");
  }
}

try {
  const route = "/api/wayback/import-all";
  const fleet = [app(F1, "Fixture One"), app(F2, "Fixture Two")];

  // ── POST, buffered ───────────────────────────────────────────────
  await run("bulk import busy on the mutex", {
    route,
    method: "POST",
    setup: [...fleet, setting("wayback_import_running", "true")],
  });
  await run("bulk import busy on a leftover state blob", {
    route,
    method: "POST",
    setup: [...fleet, bulkState([entry(F1, "Fixture One", "pending")])],
  });
  await run("bulk import with no apps", { route, method: "POST" });
  await run("bulk import two apps", {
    route,
    method: "POST",
    setup: fleet,
    replies: [...archiveRun(F1), ...emptyRun(F2)],
  });
  await run("bulk import one app throttled once", {
    route,
    method: "POST",
    setup: fleet,
    replies: [THROTTLED, ...archiveRun(F1), ...emptyRun(F2)],
  });
  await run("bulk import throttled twice pauses the queue", {
    route,
    method: "POST",
    setup: fleet,
    replies: [THROTTLED, THROTTLED],
  });
  await run("bulk import one app fails", {
    route,
    method: "POST",
    setup: fleet,
    replies: [cdx([ts(2026, 7, 20)]), status(404), saveOk(F1), ...emptyRun(F2)],
  });
  await run("bulk import forced over a paused queue", {
    route,
    method: "POST",
    search: "?force=1",
    setup: [
      ...fleet,
      bulkState([entry(F1, "Fixture One", "pending")], {
        status: "paused",
        pausedAt: now - 60_000,
        pauseCause: "user",
      }),
    ],
    replies: [...emptyRun(F1), ...emptyRun(F2)],
  });
  await run("bulk import forced over a stale mutex", {
    route,
    method: "POST",
    search: "?force=true",
    setup: [...fleet, setting("wayback_import_running", "true")],
    replies: [...emptyRun(F1), ...emptyRun(F2)],
  });
  await run("bulk import forced while running", {
    route,
    method: "POST",
    search: "?force=1",
    setup: [
      ...fleet,
      setting("wayback_import_running", "true"),
      bulkState([entry(F1, "Fixture One", "in_progress")], {
        currentAppId: F1,
      }),
    ],
  });
  await run("bulk import cancelled mid-run", {
    route,
    method: "POST",
    setup: fleet,
    replies: [...archiveRun(F1)],
    hooks: [{ atCall: 3, action: "cancel" }],
  });
  // A pause requested while an app is in flight is written to disk, then
  // overwritten by the runner's own state write when the app completes:
  // the run carries on. Pinned as Node behaves.
  await run("bulk import pause requested mid-app is overwritten", {
    route,
    method: "POST",
    setup: fleet,
    replies: [...archiveRun(F1), ...emptyRun(F2)],
    hooks: [{ atCall: 1, action: "pause" }],
  });
  // The pause that takes effect: requested during the backoff sleep, read
  // back at the retry's boundary.
  await run("bulk import paused during the archive backoff", {
    route,
    method: "POST",
    setup: fleet,
    replies: [THROTTLED],
    hooks: [{ atCall: 0, action: "pause", afterMs: 100 }],
  });
  await run("bulk import rate limited", {
    route,
    method: "POST",
    setup: [...fleet, setting("wayback_import_running", "true")],
    repeat: 3,
  });

  // ── POST, streaming ──────────────────────────────────────────────
  await run("bulk import streamed", {
    route,
    method: "POST",
    search: "?stream=1",
    setup: fleet,
    replies: [...archiveRun(F1), ...emptyRun(F2)],
  });
  await run("bulk import streamed and cancelled", {
    route,
    method: "POST",
    search: "?stream=true",
    setup: fleet,
    replies: [...archiveRun(F1)],
    hooks: [{ atCall: 3, action: "cancel" }],
  });
  await run("bulk import streamed and throttled", {
    route,
    method: "POST",
    search: "?stream=1",
    setup: fleet,
    replies: [THROTTLED, THROTTLED],
  });

  // ── PATCH ────────────────────────────────────────────────────────
  const paused = (extra = {}) =>
    bulkState(
      [
        entry(F1, "Fixture One", "done", {
          startedAt: now - 5000,
          finishedAt: now - 4000,
          imported: 1,
          unchanged: 0,
          skipped: 22,
          failed: 0,
          snapshotsRequested: 1,
        }),
        entry(F2, "Fixture Two", "pending"),
      ],
      {
        status: "paused",
        pausedAt: now - 60_000,
        pauseCause: "user",
        totals: {
          appsAttempted: 1,
          appsWithImports: 1,
          targetsAttempted: 23,
          imported: 1,
          unchanged: 0,
          skipped: 22,
          failed: 0,
          snapshotsRequested: 1,
        },
        ...extra,
      }
    );
  await run("control pause with no queue", {
    route,
    method: "PATCH",
    json: { action: "pause" },
  });
  await run("control pause already paused", {
    route,
    method: "PATCH",
    setup: [...fleet, paused()],
    json: { action: "pause" },
  });
  await run("control pause a running queue", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      setting("wayback_import_running", "true"),
      bulkState(
        [
          entry(F1, "Fixture One", "in_progress"),
          entry(F2, "Fixture Two", "pending"),
        ],
        {
          currentAppId: F1,
        }
      ),
    ],
    json: { action: "pause" },
  });
  await run("control pause a crashed queue", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      bulkState(
        [
          entry(F1, "Fixture One", "in_progress"),
          entry(F2, "Fixture Two", "pending"),
        ],
        {
          currentAppId: F1,
        }
      ),
    ],
    json: { action: "pause" },
  });
  await run("control cancel with nothing", {
    route,
    method: "PATCH",
    json: { action: "cancel" },
  });
  await run("control cancel a running queue", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      setting("wayback_import_running", "true"),
      bulkState(
        [
          entry(F1, "Fixture One", "in_progress"),
          entry(F2, "Fixture Two", "pending"),
        ],
        {
          currentAppId: F1,
        }
      ),
    ],
    json: { action: "cancel" },
  });
  await run("control cancel a paused queue", {
    route,
    method: "PATCH",
    setup: [...fleet, paused()],
    json: { action: "cancel" },
  });
  await run("control cancel a stale mutex", {
    route,
    method: "PATCH",
    setup: [setting("wayback_import_running", "true")],
    json: { action: "cancel" },
  });
  await run("control resume with no queue", {
    route,
    method: "PATCH",
    json: { action: "resume" },
  });
  await run("control resume a finished queue", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      bulkState([entry(F1, "Fixture One", "done")], { status: "paused" }),
    ],
    json: { action: "resume" },
  });
  await run("control resume a cancelling queue", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      bulkState([entry(F2, "Fixture Two", "pending")], {
        status: "cancel_requested",
        cancelRequestedAt: now - 1000,
      }),
    ],
    json: { action: "resume" },
  });
  await run("control resume while running", {
    route,
    method: "PATCH",
    setup: [
      ...fleet,
      setting("wayback_import_running", "true"),
      bulkState([entry(F2, "Fixture Two", "pending")]),
    ],
    json: { action: "resume" },
  });
  await run("control resume a paused queue", {
    route,
    method: "PATCH",
    setup: [...fleet, paused()],
    json: { action: "resume" },
    replies: emptyRun(F2),
    awaitRun: true,
  });
  await run("control unknown action", {
    route,
    method: "PATCH",
    json: { action: "restart" },
  });
  await run("control missing action", { route, method: "PATCH", json: {} });
  await run("control invalid body falls back", {
    route,
    method: "PATCH",
    raw: "{bad",
  });
  await run("control declared too large", {
    route,
    method: "PATCH",
    json: { action: "pause" },
    contentLength: 4097,
  });
  await run("control rate limited", {
    route,
    method: "PATCH",
    json: { action: "restart" },
    repeat: 21,
  });

  // ── DELETE ───────────────────────────────────────────────────────
  await run("bulk remove", {
    route,
    method: "DELETE",
    setup: [
      ...fleet,
      snapshot("s1", F1, now - 3 * DAY, "wayback", "wayback"),
      snapshot("s2", F1, now - 2 * DAY, "live", "wayback"),
      snapshot("s3", F2, now - DAY, "live", "manual"),
      snapshot("s4", F2, now - DAY, "wayback", "wayback"),
    ],
  });
  await run("bulk remove nothing", { route, method: "DELETE" });

  // ── instrumentation.ts: the 8 s resume ───────────────────────────
  await run("wayback resume with nothing on disk", {
    kind: "callback",
    delay: 8000,
  });
  await run("wayback resume leaves a paused queue", {
    kind: "callback",
    delay: 8000,
    setup: [...fleet, setting("wayback_import_running", "true"), paused()],
  });
  await run("wayback resume settles a pause request", {
    kind: "callback",
    delay: 8000,
    setup: [
      ...fleet,
      bulkState([entry(F2, "Fixture Two", "pending")], {
        status: "pause_requested",
        pauseRequestedAt: now - 1000,
        currentAppId: F2,
      }),
    ],
  });
  await run("wayback resume clears a cancelled queue", {
    kind: "callback",
    delay: 8000,
    setup: [
      ...fleet,
      setting("wayback_import_running", "true"),
      bulkState([entry(F2, "Fixture Two", "pending")], {
        status: "cancel_requested",
        cancelRequestedAt: now - 1000,
      }),
    ],
  });
  await run("wayback resume heals a stale mutex", {
    kind: "callback",
    delay: 8000,
    setup: [setting("wayback_import_running", "true")],
  });
  await run("wayback resume clears a finished queue", {
    kind: "callback",
    delay: 8000,
    setup: [...fleet, bulkState([entry(F1, "Fixture One", "done")])],
  });
  await run("wayback resume continues a crashed run", {
    kind: "callback",
    delay: 8000,
    setup: [
      ...fleet,
      app(F3, "Fixture Three"),
      setting("wayback_import_running", "true"),
      bulkState(
        [
          entry(F1, "Fixture One", "done", {
            startedAt: now - 5000,
            finishedAt: now - 4000,
          }),
          entry(F2, "Fixture Two", "in_progress", { startedAt: now - 1000 }),
          entry(F3, "Fixture Three", "pending"),
        ],
        { currentAppId: F2, streamRequested: true }
      ),
    ],
    replies: [...emptyRun(F2), ...archiveRun(F3, [LINKED])],
  });
  await run("wayback resume with a deleted app in the queue", {
    kind: "callback",
    delay: 8000,
    setup: [
      app(F1, "Fixture One"),
      bulkState([
        entry(F2, "Gone", "pending"),
        entry(F1, "Fixture One", "pending"),
      ]),
    ],
    replies: emptyRun(F1),
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
  "wayback-runner-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
