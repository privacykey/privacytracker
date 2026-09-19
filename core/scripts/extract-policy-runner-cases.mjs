/**
 * Policy bulk-runner oracle for the Rust core (Phase 5, batch 4a).
 *
 * Runs the REAL `runBulkPolicySync` (lib/policy-bulk-runner.ts) through
 * every way Node reaches it in this batch: `POST /api/policy/sync-all`
 * buffered and as an NDJSON stream (the frames are the recorded body),
 * the boot-time resume in `instrumentation.ts` (the real closure
 * `register()` arms at 12 s, captured and invoked), and the runner called
 * directly as the deferred post-update fetch calls it (`initiator:
 * "automatic"`). Each app goes through the real `syncPrivacyPolicyAnalysis`
 * with the network canned: the policy page, the archive lookup, Save Page
 * Now (held until the run is over, as production's slow archive always
 * is) and, for the `all` phase, the model.
 *
 * Recorded per case: the request, the setup rows, every raw fetch, every
 * write in order with its transaction markers, the writes that land after
 * the run, nine tables, and the wire response (or, for a direct run, its
 * result and the frames it wrote).
 *
 * Determinism as in the summariser's oracle: counted ids and nonces, a
 * frozen clock that each awaited fetch moves on by a second, a distinct
 * forwarded address per case, and the feature-flag migration marker
 * preset so `register()` migrates nothing.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-policy-runner-oracle-"));
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

const BASE_NOW = Date.UTC(2026, 8, 15, 12);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TICK = 1000;
let now = BASE_NOW;
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
  size === 15
    ? Buffer.from(String(++idCounter).padStart(20, "0"), "base64url")
    : realRandomBytes(size, ...rest);
syncBuiltinESMExports();

// Timers captured while the startup hook registers its tickers. Only the
// closures matter; the handles satisfy `.unref()`.
let capturedTimers = [];
let capturing = false;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
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

// createNotification's webhook fan-out imports this lazily; warm it so the
// import resolves in the same few ticks in every case.
await import("../../lib/notification-webhooks.ts");
const { runBulkPolicySync } = await import("../../lib/policy-bulk-runner.ts");
const ROUTE = "/api/policy/sync-all";
const { POST } = await import("../../app/api/policy/sync-all/route.ts");

const TABLES = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()
  .map((r) => r.name);
const wipe = () => {
  db.pragma("foreign_keys = OFF");
  for (const name of TABLES) {
    db.exec(`DELETE FROM "${name}"`);
  }
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all()) {
    db.exec(`DROP TRIGGER "${name}"`);
  }
  db.pragma("foreign_keys = ON");
};
const DUMPED = [
  "apps",
  "privacy_policy_analyses",
  "privacy_policy_versions",
  "privacy_snapshots",
  "notifications",
  "activity_log",
  "ai_debug_log",
  "audit_log",
  "app_settings",
];
const dump = () =>
  Object.fromEntries(
    DUMPED.map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ])
  );

const quiet = ["error", "warn", "info", "log"];
const silence = () => {
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  return () => {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  };
};

// ── The startup hook ─────────────────────────────────────────────────
db.prepare(
  "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
).run("feature_flag_migration_version", "2");
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
const RESUME_DELAY = 12_000;
const resumeCallback = capturedTimers.find(
  (t) => t.kind === "timeout" && t.ms === RESUME_DELAY
)?.fn;
if (!resumeCallback) {
  throw new Error("no 12 s timer captured from register()");
}

// ── Texts ────────────────────────────────────────────────────────────
const SENTENCES = [
  "We collect personal information such as your name, email address and device identifiers when you create an account.",
  "We use your information to provide, operate and improve the service and to personalize your experience.",
  "We share information with service providers and partners who process it on our behalf.",
  "We use cookies and analytics tools to understand how the app is used.",
  "You may request access to or deletion of your personal information at any time.",
  "We retain your information for as long as necessary to provide the service.",
  "Our service is not directed to children under 13.",
  "We do not use your information for interest-based advertising or marketing.",
];
const policyText = (count, tag = "") =>
  Array.from(
    { length: count },
    (_, i) => `${SENTENCES[i % SENTENCES.length]} Section ${i + 1}${tag}.`
  ).join("\n\n");
const TEXT = {
  a: policyText(30, " (alpha)"),
  b: policyText(30, " (bravo)"),
  c: policyText(30, " (charlie)"),
};

// ── Replies ──────────────────────────────────────────────────────────
const json = (body, code = 200, headers = {}) => ({
  status: code,
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const plain = (body, code = 200) => ({
  status: code,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});
const status = (code, headers = {}, body = "") => ({
  status: code,
  headers,
  body,
});
const availNone = (url) => json({ url, archived_snapshots: {} });
const saveOk = (url) =>
  status(302, {
    location: `https://web.archive.org/web/20260915120005/${url}`,
  });

const LENS_KEYS = [
  "collection_scope",
  "product_use",
  "ads_marketing",
  "third_party_sharing",
  "tracking_analytics",
  "user_controls",
  "data_retention",
  "children_minors",
];
const MODEL_SUMMARY = {
  overview:
    "The app collects account and device data to run the service. It shares data with service providers.",
  highlights: [
    "Collects name, email and device identifiers.",
    "Shares data with service providers.",
  ],
  lenses: LENS_KEYS.map((key, i) => ({
    key,
    rating: ["favorable", "mixed", "concerning", "unclear"][i % 4],
    summary: `Lens ${i + 1} is grounded in section ${i + 1} of the policy.`,
  })),
};
const openaiJson = (value) =>
  json({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_789_473_600,
    model: "gpt-4.1-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(value),
          refusal: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600 },
  });

// ── Setup statements ─────────────────────────────────────────────────
const sha = (t) => nodeCrypto.createHash("sha256").update(t).digest("hex");
const words = (t) => (t ? t.split(/\s+/).filter(Boolean).length : 0);
const sql = (text, ...params) => ({ sql: text, params });
const insert = (table, row) => {
  const cols = Object.keys(row);
  return sql(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c])
  );
};
const setting = (key, value) =>
  sql(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const A = {
  id: "2000000001",
  name: "Alpha Notes",
  url: "https://alpha.example/privacy",
};
const B = {
  id: "2000000002",
  name: "Bravo Maps",
  url: "https://bravo.example/privacy",
};
const C = {
  id: "2000000003",
  name: "charlie Chat",
  url: "https://charlie.example/privacy",
};
const D = { id: "2000000004", name: "Delta Tools", url: null };
const app = (a, policyUrl = a.url) =>
  insert("apps", {
    id: a.id,
    name: a.name,
    url: `https://apps.apple.com/us/app/fixture/id${a.id}`,
    iconUrl: "",
    developer: `${a.name} Developer`,
    privacyPolicyUrl: policyUrl,
    firstSeen: BASE_NOW - 30 * DAY,
    lastSynced: BASE_NOW - DAY,
    changeCount: 0,
  });
const snapshot = (a) =>
  insert("privacy_snapshots", {
    id: `snap-${a.id}`,
    app_id: a.id,
    scraped_at: BASE_NOW - DAY,
    snapshot_json: JSON.stringify([
      {
        identifier: "DATA_LINKED_TO_YOU",
        title: "Data Linked to You",
        categories: [{ identifier: "CONTACT_INFO", title: "Contact Info" }],
      },
    ]),
    changes_detected: 0,
    changes_summary: "[]",
  });
const analysis = (a, text, over = {}) =>
  insert("privacy_policy_analyses", {
    app_id: a.id,
    policy_url: a.url,
    status: "ready",
    source_title: new URL(a.url).hostname,
    source_content_type: "text/plain; charset=utf-8",
    source_text: text,
    source_word_count: words(text),
    source_origin: "direct",
    source_final_url: a.url,
    content_hash: sha(text),
    analysis_mode: "direct",
    summary_json: JSON.stringify({ overview: "An earlier summary." }),
    previous_summary_json: null,
    previous_summary_at: null,
    model: "gpt-4.1-mini",
    error: null,
    updated_at: BASE_NOW - 2 * DAY,
    last_run_log: null,
    source_fetched_at: BASE_NOW - 2 * DAY,
    run_status: "idle",
    run_started_at: null,
    ...over,
  });
const openaiSettings = [
  setting("ai_provider", "openai"),
  setting("ai_api_key", "sk-fixture-key"),
  setting("ai_debug_logging", "false"),
];
const zero = () => ({
  attempted: 0,
  succeeded: 0,
  failed: 0,
  throttled: 0,
  skipped: 0,
});
const entry = (a, status_, extra = {}) => ({
  appId: a.id,
  appName: a.name,
  policyUrl: a.url ?? "https://gone.example/privacy",
  status: status_,
  ...extra,
});
const bulkState = (queue, extra = {}) =>
  setting(
    "policy_bulk_state",
    JSON.stringify({
      version: 1,
      runId: extra.runId ?? "run-fixture-1",
      startedAt: extra.startedAt ?? BASE_NOW - 3600_000,
      initiator: extra.initiator ?? "manual",
      updatedAt: extra.updatedAt ?? BASE_NOW - 1800_000,
      phase: extra.phase ?? "fetch",
      force: extra.force ?? false,
      currentAppId: extra.currentAppId ?? null,
      queue,
      totals: extra.totals ?? zero(),
      streamRequested: extra.streamRequested ?? false,
    })
  );
const HELD = setting("policy_sync_running", "true");
const DISABLED = setting("policy_scrape_disabled", "true");
// A state write the database refuses once an app is marked in flight:
// the loop's own write throws, which is the runner's outer catch.
const refuseInFlight = sql(
  "CREATE TRIGGER refuse_in_flight BEFORE INSERT ON app_settings WHEN NEW.key = 'policy_bulk_state' AND NEW.value LIKE '%\"in_progress\"%' BEGIN SELECT RAISE(ABORT, 'state write refused'); END"
);

// ── Driver ───────────────────────────────────────────────────────────
function stubFetch(replies, calls) {
  let cursor = 0;
  const held = [];
  const missing = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const call = { url, headers: [...new Headers(init?.headers)] };
    if (init?.method && init.method !== "GET") {
      call.method = init.method;
      call.body = init.body == null ? null : String(init.body);
    }
    calls.push(call);
    const r = replies[cursor++];
    if (!r) {
      missing.push(url);
      return Promise.reject(new Error(`Missing fixture reply for ${url}`));
    }
    const saveNow = url.startsWith("https://web.archive.org/save/");
    if (!saveNow) {
      now += r.advance ?? TICK;
    }
    const answer = () => {
      if (r.throws) {
        throw new TypeError(r.throws);
      }
      const response = new Response(
        [204, 205, 304].includes(r.status)
          ? null
          : Buffer.from(r.body ?? "", "utf8"),
        { status: r.status, headers: r.headers }
      );
      Object.defineProperty(response, "url", {
        value: url,
        configurable: true,
      });
      return response;
    };
    if (saveNow) {
      return new Promise((resolve, reject) => {
        held.push(() => {
          try {
            resolve(answer());
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    try {
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { held, missing, used: () => cursor };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 15));
  }
};
const settled = () =>
  db
    .prepare("SELECT value FROM app_settings WHERE key = 'policy_sync_running'")
    .get()?.value !== "true";
async function waitForRun() {
  for (let i = 0; i < 400_000; i++) {
    if (settled()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the resumed run never settled");
}

const cases = [];
let ipCounter = 0;
async function run(
  name,
  {
    kind = "route",
    setup = [],
    json: payload,
    raw,
    contentLength,
    repeat = 1,
    options = null,
    replies = [],
    at = BASE_NOW,
  }
) {
  wipe();
  now = at;
  idCounter = 0;
  recording = null;
  for (const s of setup) {
    db.prepare(s.sql).run(...s.params);
  }
  // The runner mutates a resumed blob in place; record it as passed.
  const recordedOptions = options && JSON.parse(JSON.stringify(options));
  ipCounter += 1;
  const headers = {
    "x-forwarded-for": `10.8.${ipCounter}.3`,
    "user-agent": "policy-runner-oracle/1.0",
    "content-type": "application/json",
  };
  if (contentLength !== undefined) {
    headers["content-length"] = String(contentLength);
  }
  const body = payload === undefined ? (raw ?? null) : JSON.stringify(payload);
  const calls = [];
  const { held, missing, used } = stubFetch(replies, calls);
  const stream = [];
  const late = [];
  const frames = [];
  const restore = silence();
  let expected = null;
  recording = stream;
  try {
    if (kind === "callback") {
      await resumeCallback();
      await waitForRun();
    } else if (kind === "runner") {
      try {
        const result = await runBulkPolicySync({
          ...JSON.parse(JSON.stringify(options)),
          streamWriter: (frame) =>
            frames.push(JSON.parse(JSON.stringify(frame))),
        });
        expected = { ok: true, result };
      } catch (error) {
        expected = { ok: false, error: String(error?.message ?? error) };
      }
    } else {
      for (let i = 0; i < repeat; i++) {
        const request = new NextRequest(`http://127.0.0.1:3000${ROUTE}`, {
          method: "POST",
          headers,
          body,
        });
        try {
          const response = await POST(request);
          expected = {
            status: response.status,
            type: response.headers.get("content-type"),
            retryAfter: response.headers.get("retry-after"),
            cacheControl: response.headers.get("cache-control"),
            body: await response.text(),
          };
        } catch (error) {
          expected = {
            status: 500,
            type: null,
            retryAfter: null,
            cacheControl: null,
            body: "",
            thrown: String(error?.message ?? error),
          };
        }
      }
    }
    recording = late;
    await settle();
    for (const release of held.splice(0)) {
      release();
    }
    await settle();
  } finally {
    recording = null;
    restore();
  }
  if (missing.length) {
    throw new Error(`${name}: no reply for ${missing.join(", ")}`);
  }
  if (used() !== replies.length) {
    throw new Error(`${name}: unused replies ${used()}/${replies.length}`);
  }
  cases.push({
    name,
    kind,
    now: at,
    setup,
    headers,
    body,
    repeat,
    options: recordedOptions,
    replies,
    calls,
    stream,
    late,
    frames,
    rows: dump(),
    expected,
  });
}

// One app's fetch: a page that lands, new text or not, is looked up in
// the archive and submitted to Save Page Now; a 404 is one request.
const firstCapture = (a, text) => [
  plain(text),
  availNone(a.url),
  saveOk(a.url),
];
const fetchError = () => [
  status(404, { "content-type": "text/html" }, "Not found"),
];
const recentlyFetched = (a, text) =>
  analysis(a, text, { source_fetched_at: BASE_NOW - 10 * MIN });

try {
  // ══ POST /api/policy/sync-all: the refusals ═══════════════════════
  await run("sync-all: the fifth in a minute is refused", {
    setup: [DISABLED],
    json: { phase: "fetch" },
    repeat: 5,
  });
  await run("sync-all: an unparseable body", { raw: "{not json" });
  await run("sync-all: an empty body", {});
  await run("sync-all: a declared body over the cap", {
    json: {},
    contentLength: 2049,
  });
  await run("sync-all: a streamed body over the cap", {
    raw: `{"pad":"${"x".repeat(2048)}"}`,
  });
  await run("sync-all: a null body reads as a fetch with no apps", {
    raw: "null",
  });
  await run("sync-all: the kill-switch refuses", {
    setup: [app(A), DISABLED],
    json: { phase: "all" },
  });
  await run("sync-all: busy on the mutex", {
    setup: [app(A), HELD],
    json: {},
  });
  await run("sync-all: busy on a leftover state blob", {
    setup: [app(A), bulkState([entry(A, "pending")])],
    json: {},
  });
  await run("sync-all: no apps with a policy link", {
    setup: [app(D), app({ ...A, url: "   " })],
    json: { phase: " all ", force: true },
  });
  await run("sync-all: an unknown phase is a fetch", {
    setup: [app(D)],
    json: { phase: "summarise", force: "yes", stream: "true" },
  });

  // ══ POST: runs ═════════════════════════════════════════════════════
  const fleet = [
    app(A),
    app(B),
    app(C),
    app(D),
    snapshot(A),
    snapshot(B),
    snapshot(C),
  ];
  await run("sync-all: a buffered fetch across the fleet", {
    setup: [...fleet, recentlyFetched(C, TEXT.c)],
    json: { phase: "fetch" },
    replies: [...firstCapture(A, TEXT.a), ...fetchError()],
  });
  await run("sync-all: a streamed fetch across the fleet", {
    setup: [...fleet, recentlyFetched(C, TEXT.c)],
    json: { phase: "fetch", stream: true },
    replies: [...firstCapture(A, TEXT.a), ...fetchError()],
  });
  await run("sync-all: force fetches past the throttle", {
    setup: [
      app(A),
      app(C),
      snapshot(C),
      analysis(A, TEXT.a),
      recentlyFetched(C, TEXT.c),
    ],
    json: { phase: "fetch", force: true, stream: true },
    replies: [...firstCapture(A, TEXT.a), ...firstCapture(C, TEXT.c)],
  });
  await run("sync-all: all fetches and summarises", {
    setup: [app(A), app(B), snapshot(A), snapshot(B), ...openaiSettings],
    json: { phase: "all", stream: true },
    replies: [
      ...firstCapture(A, TEXT.a),
      openaiJson(MODEL_SUMMARY),
      ...firstCapture(B, TEXT.b),
      openaiJson(MODEL_SUMMARY),
    ],
  });
  await run("sync-all: all without an AI provider", {
    setup: [app(A), snapshot(A), analysis(A, TEXT.a)],
    json: { phase: "all" },
    replies: [...firstCapture(A, TEXT.a)],
  });
  await run("sync-all: a state write refused mid-run, buffered", {
    setup: [app(A), app(B), refuseInFlight],
    json: { phase: "fetch" },
  });
  await run("sync-all: a state write refused mid-run, streamed", {
    setup: [app(A), app(B), refuseInFlight],
    json: { phase: "fetch", stream: true },
  });

  // ══ The runner as the deferred post-update fetch starts it ═════════
  const automatic = { initiator: "automatic", phase: "fetch", force: false };
  await run("runner: an automatic fetch", {
    kind: "runner",
    setup: [app(A), app(B), snapshot(A), analysis(B, TEXT.b)],
    options: automatic,
    replies: [...firstCapture(A, TEXT.a), ...firstCapture(B, TEXT.b)],
  });
  await run("runner: nothing stored behind the kill-switch is skipped", {
    kind: "runner",
    setup: [app(A), app(B), analysis(B, TEXT.b), DISABLED],
    options: automatic,
  });
  await run("runner: an automatic run with no apps", {
    kind: "runner",
    setup: [app(D)],
    options: automatic,
  });
  await run("runner: the outer catch rethrows and leaves the lock", {
    kind: "runner",
    setup: [app(A), refuseInFlight],
    options: { ...automatic, actorIp: "10.0.0.9", userAgent: "fixture/1" },
  });

  // ══ The boot-time resume (12 s) ════════════════════════════════════
  await run("resume: nothing to do", { kind: "callback" });
  await run("resume: the kill-switch clears the queue", {
    kind: "callback",
    setup: [app(A), HELD, bulkState([entry(A, "pending")]), DISABLED],
  });
  await run("resume: the kill-switch with only a lock", {
    kind: "callback",
    setup: [HELD, DISABLED],
  });
  await run("resume: a stale lock is cleared", {
    kind: "callback",
    setup: [HELD],
  });
  await run("resume: a finished queue is cleared", {
    kind: "callback",
    setup: [
      bulkState([entry(A, "done", { outcome: "succeeded" })], {
        totals: { ...zero(), attempted: 1, succeeded: 1 },
      }),
    ],
  });
  await run("resume: an unreadable blob with a lock", {
    kind: "callback",
    setup: [HELD, setting("policy_bulk_state", "{not json")],
  });
  await run("resume: pending work is finished", {
    kind: "callback",
    setup: [
      ...fleet,
      HELD,
      bulkState(
        [
          entry(A, "done", {
            startedAt: BASE_NOW - 3000_000,
            finishedAt: BASE_NOW - 2900_000,
            outcome: "succeeded",
            analysisStatus: "source_ready",
          }),
          entry(B, "in_progress", { startedAt: BASE_NOW - 2800_000 }),
          entry(C, "pending"),
          entry(D, "pending"),
          entry({ id: "2000000099", name: "Gone App", url: null }, "pending"),
        ],
        {
          currentAppId: B.id,
          totals: { ...zero(), attempted: 2, succeeded: 1 },
          streamRequested: true,
        }
      ),
    ],
    replies: [...fetchError(), ...firstCapture(C, TEXT.c)],
  });
  await run("resume: an all run resumes as all", {
    kind: "callback",
    setup: [
      app(A),
      snapshot(A),
      ...openaiSettings,
      bulkState([entry(A, "pending")], {
        phase: "all",
        force: true,
        initiator: "manual",
      }),
    ],
    replies: [...firstCapture(A, TEXT.a), openaiJson(MODEL_SUMMARY)],
  });
  await run("resume: notifications off still resumes", {
    kind: "callback",
    setup: [
      app(A),
      insert("feature_flag_overrides", {
        flag_key: "flag.notifications.resume.enabled",
        override_value: "off",
        set_at: BASE_NOW - DAY,
        set_by: "user",
        previous_focus: null,
        quarantined: 0,
      }),
      bulkState([entry(A, "pending")]),
    ],
    replies: [...fetchError()],
  });

  // ══ Appended: what only the frames show ════════════════════════════
  // A resumed queue that meets an app with no link and one that is gone
  // names each reason in its frames; the resume callback has no writer.
  await run("runner: a resumed queue names why it skips", {
    kind: "runner",
    setup: [app(A), app(D), snapshot(A)],
    options: {
      initiator: "resume",
      phase: "fetch",
      force: false,
      resumeState: {
        version: 1,
        runId: "run-fixture-2",
        startedAt: BASE_NOW - 3600_000,
        initiator: "automatic",
        updatedAt: BASE_NOW - 1800_000,
        phase: "fetch",
        force: false,
        currentAppId: D.id,
        queue: [
          entry(D, "in_progress", { startedAt: BASE_NOW - 2000_000 }),
          entry({ id: "2000000099", name: "Gone App", url: null }, "pending"),
          entry(A, "pending"),
        ],
        totals: { ...zero(), attempted: 1 },
        streamRequested: false,
      },
    },
    replies: [...firstCapture(A, TEXT.a)],
  });
  // A sync that throws (its run marker refused) fails its app and the
  // run carries on with the next.
  await run("runner: a sync that throws fails its app", {
    kind: "runner",
    setup: [
      app(A),
      app(B),
      snapshot(B),
      analysis(A, TEXT.a),
      sql(
        "CREATE TRIGGER refuse_run_marker BEFORE UPDATE OF run_status ON privacy_policy_analyses WHEN NEW.run_status = 'running' BEGIN SELECT RAISE(ABORT, 'run marker refused'); END"
      ),
    ],
    options: automatic,
    replies: [...firstCapture(B, TEXT.b)],
  });
  // Scraping switched off while a run is under way: the trigger switches
  // it off as the first app's new policy version lands. Every app after
  // that meets the store's kill-switch and is handed back as stored, and
  // is counted and logged as a skip whatever it stored: Bravo's stored
  // fetch error is not a failure, charlie Chat's summary is not a success.
  await run(
    "runner: scraping switched off mid-run skips what the rest stored",
    {
      kind: "runner",
      setup: [
        app(A),
        app(B),
        app(C),
        snapshot(A),
        analysis(B, TEXT.b, {
          status: "fetch_error",
          error: "HTTP 404 Not Found",
        }),
        analysis(C, TEXT.c),
        sql(
          "CREATE TRIGGER kill_switch_mid_run AFTER INSERT ON privacy_policy_versions BEGIN INSERT OR REPLACE INTO app_settings (key, value) VALUES ('policy_scrape_disabled', 'true'); END"
        ),
      ],
      options: automatic,
      replies: [...firstCapture(A, TEXT.a)],
    }
  );

  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  const stray = text
    .match(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
    )
    ?.filter((u) => !u.startsWith("00000000-0000-4000-8000-"));
  if (stray?.length) {
    throw new Error(
      `non-deterministic ids leaked into the fixture: ${stray.slice(0, 3).join(", ")}`
    );
  }
  writeFileSync(
    new URL("../tests/fixtures/policy-runner-cases.json", import.meta.url),
    text
  );
  const count = (kind) => cases.filter((c) => c.kind === kind).length;
  console.log(
    `Recorded ${count("route")} route, ${count("runner")} runner and ${count("callback")} resume cases from the real Node runner; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
