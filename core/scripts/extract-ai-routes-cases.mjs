/**
 * AI-routes oracle for the Rust core (Phase 5, batch 3b).
 *
 * Runs the REAL route handlers of `POST /api/policy/regenerate` (answered
 * whole and as an NDJSON phase stream), `POST /api/ai/policy-sample`,
 * `POST /api/ai/test` and `POST /api/ai/models`, each request built as
 * the browser sends it: rate limits, the admin-token gate where a route
 * has one, the bounded body read with each route's own phrasing of its
 * failures, the provider and base-URL checks, and then the provider
 * itself — the model list, the connection test, the sample summary, and
 * for regenerate the whole `syncPrivacyPolicyAnalysis` run behind it.
 * Every reply is canned, never the network: the shapes are the
 * providers' documented formats, and a policy page is plain text.
 *
 * Recorded per case: the response as it went over the wire (status,
 * Content-Type, Retry-After, Cache-Control and the body text, or a throw
 * Next would answer with a bare 500), every raw fetch, every write in
 * order, what landed after the response (Save Page Now's held reply), and
 * nine tables.
 *
 * Randomness and time are pinned as in the summariser's oracle: counted
 * ids and nonces sharing one counter, a frozen clock that each awaited
 * fetch moves on by a second (or by the time a timeout hung for), and
 * Save Page Now held until the response is complete.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-ai-routes-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.NEXT_RUNTIME = "nodejs";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;
delete process.env.PRIVACYTRACKER_RUNTIME;

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

const TEST = "/api/ai/test";
const MODELS = "/api/ai/models";
const SAMPLE = "/api/ai/policy-sample";
const REGEN = "/api/policy/regenerate";
const ROUTES = {
  [TEST]: (await import("../../app/api/ai/test/route.ts")).POST,
  [MODELS]: (await import("../../app/api/ai/models/route.ts")).POST,
  [SAMPLE]: (await import("../../app/api/ai/policy-sample/route.ts")).POST,
  [REGEN]: (await import("../../app/api/policy/regenerate/route.ts")).POST,
};

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
  "privacy_policy_analyses",
  "privacy_policy_versions",
  "privacy_snapshots",
  "notifications",
  "activity_log",
  "ai_debug_log",
  "app_settings",
  "audit_log",
  "apps",
];
const dump = () =>
  Object.fromEntries(
    DUMPED.map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ])
  );

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
const paragraphs = (count, tag = "") =>
  Array.from(
    { length: count },
    (_, i) => `${SENTENCES[i % SENTENCES.length]} Section ${i + 1}${tag}.`
  );
const SHORT = paragraphs(5).join("\n\n");
const V1 = paragraphs(30).join("\n\n");
// Past the 8,000-character direct limit of a model that needs chunking.
const LONG = paragraphs(100).join("\n\n");

// A copy of `chunkPolicyText`'s paragraph packing, used only to size the
// reply lists; the recorded behaviour is the module's own.
function chunkCount(text, maxChars) {
  const parts = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let count = 0;
  let current = "";
  for (const paragraph of parts) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars && current) {
      count += 1;
      current = paragraph;
    } else {
      current = next;
    }
  }
  return current ? count + 1 : Math.max(count, 1);
}

// ── Replies ──────────────────────────────────────────────────────────
const APP = "1000000001";
const P = "https://example.com/privacy";
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
const AVAIL_NONE = json({ url: P, archived_snapshots: {} });
const SAVE_OK = status(302, {
  location:
    "https://web.archive.org/web/20260915120005/https://example.com/privacy",
});
const TIMEOUT = { throws: "timeout", advance: 90 * 1000 };
const LIST_TIMEOUT = { throws: "timeout", advance: 10 * 1000 };
const NETWORK = { throws: "fetch failed" };

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
const RATINGS = ["favorable", "mixed", "concerning", "unclear"];
const MODEL_SUMMARY = {
  overview:
    "The app collects account and device data to run the service. It shares data with service providers.",
  highlights: [
    "Collects name, email and device identifiers.",
    "Shares data with service providers.",
    "Uses cookies for analytics.",
    "Keeps data as long as necessary.",
  ],
  lenses: LENS_KEYS.map((key, i) => ({
    key,
    rating: RATINGS[i % RATINGS.length],
    summary: `Lens ${i + 1} is grounded in section ${i + 1} of the policy.`,
  })),
};
const NOTE = (i) => ({
  summary: `Chunk ${i} describes collection and sharing.`,
  highlights: [
    `Chunk ${i} collects device identifiers.`,
    `Chunk ${i} shares data with vendors.`,
  ],
});
const openai = (content) =>
  json({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_789_473_600,
    model: "gpt-4.1-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600 },
  });
const openaiJson = (value) => openai(JSON.stringify(value));
const anthropicTool = (name, input) =>
  json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-latest",
    content: [{ type: "tool_use", id: "toolu_fixture", name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1200, output_tokens: 400 },
  });
// An OpenAI-compatible event stream cut into transport chunks of `size`
// bytes, so a frame can straddle two chunks.
const b64 = (buffer) => ({ b64: Buffer.from(buffer).toString("base64") });
const frame = (delta) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
const sse = (value, size = 97) => {
  const content = JSON.stringify(value);
  const step = Math.ceil(content.length / 3);
  const frames = [frame({ role: "assistant", content: "" })];
  for (let i = 0; i < content.length; i += step) {
    frames.push(frame({ content: content.slice(i, i + step) }));
  }
  const bytes = Buffer.from(`${frames.join("")}data: [DONE]\n\n`, "utf8");
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(b64(bytes.subarray(i, i + size)));
  }
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks,
  };
};
// The model lists, in the providers' documented shapes.
const openaiList = (ids) =>
  json({
    object: "list",
    data: ids.map((id) =>
      typeof id === "string"
        ? { id, object: "model", created: 1_700_000_000, owned_by: "system" }
        : id
    ),
  });
const anthropicPage = (items, hasMore, lastId) =>
  json({
    data: items.map((item) =>
      typeof item === "string"
        ? {
            type: "model",
            id: item,
            display_name: item,
            created_at: "2025-01-01T00:00:00Z",
          }
        : item
    ),
    has_more: hasMore,
    first_id: items[0]?.id ?? items[0] ?? null,
    last_id: lastId,
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
const app = (id = APP, policyUrl = P) =>
  insert("apps", {
    id,
    name: "Policy Fixture",
    url: `https://apps.apple.com/us/app/fixture/id${id}`,
    iconUrl: "",
    developer: "Fixture Developer",
    privacyPolicyUrl: policyUrl,
    firstSeen: BASE_NOW - 30 * DAY,
    lastSynced: BASE_NOW - DAY,
    changeCount: 0,
  });
const setting = (key, value) =>
  sql(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const analysis = (over = {}) => {
  const text = over.source_text ?? SHORT;
  return insert("privacy_policy_analyses", {
    app_id: APP,
    policy_url: P,
    status: "source_ready",
    source_title: "example.com",
    source_content_type: "text/plain; charset=utf-8",
    source_text: text,
    source_word_count: words(text),
    source_origin: "direct",
    source_final_url: P,
    content_hash: sha(text),
    analysis_mode: null,
    summary_json: null,
    previous_summary_json: null,
    previous_summary_at: null,
    model: null,
    error: null,
    updated_at: BASE_NOW - 2 * DAY,
    last_run_log: null,
    source_fetched_at: BASE_NOW - 2 * DAY,
    run_status: "idle",
    run_started_at: null,
    ...over,
  });
};
const snapshot = (id, at) =>
  insert("privacy_snapshots", {
    id,
    app_id: APP,
    scraped_at: at,
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
const aiSettings = ({
  provider = "openai",
  model,
  baseUrl,
  apiKey = provider === "custom" ? undefined : "sk-fixture-key",
  debug = false,
} = {}) => [
  setting("ai_provider", provider),
  ...(model === undefined ? [] : [setting("ai_model", model)]),
  ...(baseUrl === undefined ? [] : [setting("ai_base_url", baseUrl)]),
  ...(apiKey === undefined ? [] : [setting("ai_api_key", apiKey)]),
  setting("ai_debug_logging", debug ? "true" : "false"),
];
// A write that fails where Node marks the run as started, so the sync
// throws before its try: better-sqlite3 and rusqlite both report the
// trigger's own message.
const refuseRunMarker = sql(
  "CREATE TRIGGER refuse_run_marker BEFORE UPDATE OF run_status ON privacy_policy_analyses WHEN NEW.run_status = 'running' BEGIN SELECT RAISE(ABORT, 'run marker refused'); END"
);

// ── Driver ───────────────────────────────────────────────────────────
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
// A chunk is text, base64 bytes, or a run of one character — the last so a
// multi-megabyte reply stays a few bytes in the fixture.
const chunkBytes = (c) => {
  if (typeof c === "string") {
    return Buffer.from(c, "utf8");
  }
  if (c.fill) {
    return Buffer.alloc(c.fill.bytes, c.fill.char);
  }
  return Buffer.from(c.b64, "base64");
};
const bodyOf = (r) =>
  r.fill
    ? Buffer.alloc(r.fill.bytes, r.fill.char)
    : Buffer.from(r.body ?? "", "utf8");
const streamError = (kind) =>
  kind === "timeout"
    ? new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      )
    : new TypeError("terminated");
const quiet = ["error", "warn", "info", "log"];
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
      if (r.throws === "timeout") {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        );
      }
      if (r.throws) {
        throw new TypeError(r.throws);
      }
      // `redirect: "error"` is what the AI calls ask for: undici turns any
      // redirect status into a network error, whatever the Location says.
      if (init?.redirect === "error" && REDIRECT_STATUSES.includes(r.status)) {
        throw new TypeError("fetch failed");
      }
      let body = null;
      if (![204, 205, 304].includes(r.status)) {
        if (r.chunks) {
          // One chunk per pull, then the close or the error.
          const parts = r.chunks.map(chunkBytes);
          let next = 0;
          body = new ReadableStream({
            pull(controller) {
              if (next < parts.length) {
                controller.enqueue(new Uint8Array(parts[next++]));
              } else if (r.streamError) {
                controller.error(streamError(r.streamError));
              } else {
                controller.close();
              }
            },
          });
        } else {
          body = bodyOf(r);
        }
      }
      const response = new Response(body, {
        status: r.status,
        headers: r.headers,
      });
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
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
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

const cases = [];
let ipCounter = 0;
async function route(
  name,
  {
    route: path_,
    setup = [],
    json: payload,
    raw,
    contentLength,
    headers: extra = {},
    adminToken = null,
    repeat = 1,
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
  ipCounter += 1;
  const headers = {
    "x-forwarded-for": `10.9.${ipCounter}.7`,
    "user-agent": "ai-routes-oracle/1.0",
    "content-type": "application/json",
    ...extra,
  };
  if (contentLength !== undefined) {
    headers["content-length"] = String(contentLength);
  }
  const body = payload === undefined ? (raw ?? null) : JSON.stringify(payload);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const calls = [];
  const { held, missing, used } = stubFetch(replies, calls);
  const stream = [];
  const late = [];
  const restore = silence();
  let expected;
  recording = stream;
  try {
    for (let i = 0; i < repeat; i++) {
      const request = new NextRequest(`http://127.0.0.1:3000${path_}`, {
        method: "POST",
        headers,
        body,
      });
      try {
        const response = await ROUTES[path_](request);
        expected = {
          status: response.status,
          type: response.headers.get("content-type"),
          retryAfter: response.headers.get("retry-after"),
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        };
      } catch (error) {
        // A throw is Next's generic 500; only the status is contractual.
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
    recording = late;
    await settle();
    for (const release of held.splice(0)) {
      release();
    }
    await settle();
  } finally {
    recording = null;
    restore();
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  if (missing.length) {
    throw new Error(`${name}: no reply for ${missing.join(", ")}`);
  }
  if (used() !== replies.length) {
    throw new Error(`${name}: unused replies ${used()}/${replies.length}`);
  }
  cases.push({
    name,
    route: path_,
    now: at,
    setup,
    adminToken,
    headers,
    body,
    repeat,
    replies,
    calls,
    stream,
    late,
    rows: dump(),
    expected,
  });
}

// The refusals every JSON route shares, each phrased by the route.
async function bodyRefusals(prefix, path_, limit) {
  await route(`${prefix}: an unparseable body`, {
    route: path_,
    raw: "{not json",
  });
  await route(`${prefix}: an empty body`, { route: path_ });
  await route(`${prefix}: a declared body over the cap`, {
    route: path_,
    json: {},
    contentLength: limit + 1,
  });
  await route(`${prefix}: a streamed body over the cap`, {
    route: path_,
    raw: `{"pad":"${"x".repeat(limit)}"}`,
  });
  await route(`${prefix}: a null body`, { route: path_, raw: "null" });
}

try {
  // ══ /api/ai/test ══════════════════════════════════════════════════
  await route("test: no provider", { route: TEST, json: {} });
  await route("test: a provider named in the wrong case is none", {
    route: TEST,
    json: { provider: "OpenAI", apiKey: "sk-fixture-key" },
  });
  await route("test: an array body names no provider", {
    route: TEST,
    raw: "[1]",
  });
  await route("test: OpenAI without a key", {
    route: TEST,
    json: { provider: "openai", apiKey: "   " },
  });
  await route("test: the masked key with nothing stored", {
    route: TEST,
    json: { provider: "openai", apiKey: " __SET__ " },
  });
  await route("test: the masked key reads the stored one", {
    route: TEST,
    setup: [setting("ai_api_key", "  sk-stored  ")],
    json: { provider: "openai", apiKey: "__SET__" },
    replies: [openaiList(["gpt-4.1-mini", "gpt-4o"])],
  });
  await route("test: one model is listed in the singular", {
    route: TEST,
    json: { provider: "openai", apiKey: "  sk-padded  " },
    replies: [openaiList(["gpt-4.1-mini"])],
  });
  await route("test: an Ollama-style models array", {
    route: TEST,
    json: { provider: "ollama", baseUrl: "localhost:11434" },
    replies: [json({ models: [{ name: "a" }, { name: "b" }, { name: "c" }] })],
  });
  await route("test: a local endpoint with a key sends it", {
    route: TEST,
    json: {
      provider: "custom",
      baseUrl: "http://127.0.0.1:8080/v1/",
      apiKey: "local-key",
    },
    replies: [plain("OK")],
  });
  await route("test: a JSON reply with no list", {
    route: TEST,
    json: { provider: "custom", baseUrl: "http://10.0.0.5:8000" },
    replies: [json({ object: "list" })],
  });
  await route("test: a null JSON reply", {
    route: TEST,
    json: { provider: "custom", baseUrl: "http://10.0.0.5:8000" },
    replies: [json("null")],
  });
  for (const code of [401, 403, 404, 429, 500]) {
    await route(`test: HTTP ${code}`, {
      route: TEST,
      json: { provider: "openai", apiKey: "sk-fixture-key" },
      replies: [json({ error: { message: "nope" } }, code)],
    });
  }
  await route("test: a redirect is reported, not followed", {
    route: TEST,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [status(302, { location: "https://elsewhere.example/models" })],
  });
  await route("test: Anthropic", {
    route: TEST,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [
      anthropicPage(
        ["claude-3-5-haiku-latest"],
        true,
        "claude-3-5-haiku-latest"
      ),
    ],
  });
  await route("test: Anthropic on a /v1/ base URL", {
    route: TEST,
    json: {
      provider: "anthropic",
      apiKey: "sk-ant-fixture",
      baseUrl: "https://api.anthropic.com/v1/",
    },
    replies: [json({ type: "error" })],
  });
  await route("test: an upper-case /V1 is not doubled", {
    route: TEST,
    json: {
      provider: "openai",
      apiKey: "sk-fixture-key",
      baseUrl: "https://api.openai.com/V1",
    },
    replies: [openaiList([])],
  });
  await route("test: a proxy path is kept", {
    route: TEST,
    json: {
      provider: "openai",
      apiKey: "sk-fixture-key",
      baseUrl: "https://proxy.example.com/openai/",
    },
    replies: [openaiList(["gpt-4o"])],
  });
  await route("test: a scheme inside the host", {
    route: TEST,
    json: {
      provider: "openai",
      apiKey: "sk-fixture-key",
      baseUrl: "ftp://example.com",
    },
    replies: [openaiList(["gpt-4o"])],
  });
  await route("test: a metadata address is blocked", {
    route: TEST,
    json: { provider: "custom", baseUrl: "http://169.254.169.254" },
  });
  await route("test: a metadata host name is blocked", {
    route: TEST,
    json: { provider: "custom", baseUrl: "metadata.google.internal" },
  });
  await route("test: an unparseable base URL", {
    route: TEST,
    json: { provider: "custom", baseUrl: "http://exa mple.com" },
  });
  await route("test: a base URL over 512 characters", {
    route: TEST,
    json: {
      provider: "custom",
      baseUrl: `https://example.com/${"p".repeat(500)}`,
    },
  });
  await route("test: a base URL with credentials", {
    route: TEST,
    json: {
      provider: "openai",
      apiKey: "sk-fixture-key",
      baseUrl: "https://user:pass@example.com/v1",
    },
  });
  await route("test: a timeout", {
    route: TEST,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [LIST_TIMEOUT],
  });
  await route("test: a network failure", {
    route: TEST,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [NETWORK],
  });
  await route("test: a body cut off", {
    route: TEST,
    json: { provider: "custom" },
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: ['{"data":['],
        streamError: "terminated",
      },
    ],
  });
  await route("test: a body that stalls", {
    route: TEST,
    json: { provider: "custom" },
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: ['{"data":['],
        streamError: "timeout",
      },
    ],
  });
  await route("test: a declared reply over the cap", {
    route: TEST,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [json(openaiList([]).body, 200, { "content-length": "2000000" })],
  });
  await route("test: a reply over the cap", {
    route: TEST,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        fill: { bytes: 1024 * 1024 + 1, char: " " },
      },
    ],
  });
  await bodyRefusals("test", TEST, 16 * 1024);
  await route("test: the eleventh in a minute is refused", {
    route: TEST,
    json: {},
    repeat: 11,
  });
  await route("test: a configured admin token is required", {
    route: TEST,
    adminToken: "secret-token",
    json: { provider: "openai", apiKey: "sk-fixture-key" },
  });
  await route("test: the limit is checked before the token", {
    route: TEST,
    adminToken: "secret-token",
    json: {},
    repeat: 11,
  });
  await route("test: a valid admin token passes", {
    route: TEST,
    adminToken: "secret-token",
    headers: { "x-auditor-admin-token": "secret-token" },
    json: { provider: "custom" },
    replies: [openaiList(["llama3"])],
  });

  // ══ /api/ai/models ════════════════════════════════════════════════
  await route("models: no provider", { route: MODELS, json: {} });
  await route("models: OpenAI without a key", {
    route: MODELS,
    json: { provider: "openai" },
  });
  await route("models: OpenAI keeps the text models", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [
      openaiList([
        "gpt-4.1-mini",
        "gpt-4o",
        " gpt-4o ",
        "GPT-4O-MINI",
        "o3-mini",
        "o1",
        "chatgpt-4o-latest",
        "ft:gpt-4o-mini:acme::abc123",
        "ft:davinci-002:acme::x",
        "davinci-002",
        "text-embedding-3-small",
        "whisper-1",
        "tts-1",
        "dall-e-3",
        "gpt-image-1",
        "gpt-4o-audio-preview",
        "gpt-4o-transcribe",
        "gpt-4o-realtime-preview",
        "omni-moderation-latest",
        "   ",
        { id: 5 },
        null,
        { object: "model" },
      ]),
    ],
  });
  await route("models: OpenAI HTTP 401", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [json({ error: { message: "bad key" } }, 401)],
  });
  await route("models: OpenAI answers with a page", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<!doctype html><html><body>Sign in</body></html>",
      },
    ],
  });
  await route("models: a parse error that mentions a timeout", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [plain("timeout exceeded")],
  });
  await route("models: OpenAI with no list", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [json({ object: "list" })],
  });
  await route("models: OpenAI answers null", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [json("null")],
  });
  await route("models: OpenAI times out", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [LIST_TIMEOUT],
  });
  await route("models: OpenAI over the cap", {
    route: MODELS,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [{ fill: { bytes: 1024 * 1024, char: " " } }, "[]"],
      },
    ],
  });
  await route("models: Anthropic pages through the list", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [
      anthropicPage(
        [
          {
            type: "model",
            id: "claude-opus-4-1",
            display_name: " Claude Opus 4.1 ",
          },
          { type: "model", id: "claude-sonnet-4", display_name: "   " },
          { type: "model", id: " ", display_name: "Blank" },
        ],
        true,
        "claude-sonnet-4"
      ),
      anthropicPage(
        [
          { type: "model", id: "claude-sonnet-4", display_name: "Again" },
          { type: "model", id: "claude-3-5-haiku-latest", display_name: 7 },
        ],
        false,
        "claude-3-5-haiku-latest"
      ),
    ],
  });
  await route("models: Anthropic stops after five pages", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [1, 2, 3, 4, 5].map((i) =>
      anthropicPage([`claude-${i}`], true, `claude-${i}`)
    ),
  });
  await route("models: Anthropic stops when the cursor repeats", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [
      anthropicPage(["claude-a"], true, "claude-a"),
      anthropicPage(["claude-b"], true, "claude-a"),
    ],
  });
  await route("models: Anthropic with a numeric cursor", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [
      anthropicPage(["claude-a"], "yes", 7),
      anthropicPage(["claude-b"], 1, 7),
    ],
  });
  await route("models: Anthropic on a query-string base URL", {
    route: MODELS,
    json: {
      provider: "anthropic",
      apiKey: "sk-ant-fixture",
      baseUrl: "https://api.anthropic.com/?region=eu",
    },
    replies: [
      anthropicPage(["claude-a"], true, "claude a+b/c&d=é"),
      anthropicPage(["claude-b"], false, null),
    ],
  });
  await route("models: Anthropic with no list", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [json({ data: "none", has_more: true, last_id: "x" })],
  });
  await route("models: Anthropic HTTP 403", {
    route: MODELS,
    json: { provider: "anthropic", apiKey: "sk-ant-fixture" },
    replies: [json({ type: "error" }, 403)],
  });
  await route("models: a local endpoint lists every model", {
    route: MODELS,
    json: { provider: "custom" },
    replies: [
      openaiList(["llama3:8b", "nomic-embed-text", "llama3:8b", " qwen2 "]),
    ],
  });
  await route("models: a local endpoint falls back to Ollama tags", {
    route: MODELS,
    json: { provider: "custom", baseUrl: "http://localhost:11434/v1/" },
    replies: [
      json({ error: "not found" }, 404),
      json({
        models: [
          { name: "llama3:8b", size: 1 },
          { name: "llama3:8b" },
          { name: " " },
          { model: "no-name" },
          { name: " gemma3n:e4b " },
        ],
      }),
    ],
  });
  await route("models: an empty list falls back too", {
    route: MODELS,
    json: { provider: "custom", baseUrl: "http://gpu.lan:8000/ollama" },
    replies: [openaiList([]), json({ models: [{ name: "phi3" }] })],
  });
  await route("models: a network failure falls back", {
    route: MODELS,
    json: { provider: "custom" },
    replies: [NETWORK, json({ models: [{ name: "phi3" }] })],
  });
  await route("models: both local lists failing is an empty list", {
    route: MODELS,
    json: { provider: "custom" },
    replies: [json({}, 500), LIST_TIMEOUT],
  });
  await route("models: tags that are not JSON", {
    route: MODELS,
    json: { provider: "custom" },
    replies: [plain("nope", 404), plain("nope")],
  });
  await route("models: a metadata address is blocked", {
    route: MODELS,
    json: { provider: "custom", baseUrl: "http://169.254.169.254/latest" },
  });
  await route("models: an unparseable base URL", {
    route: MODELS,
    json: { provider: "custom", baseUrl: "http://[::1" },
  });
  await bodyRefusals("models", MODELS, 16 * 1024);
  await route("models: the eleventh in a minute is refused", {
    route: MODELS,
    json: {},
    repeat: 11,
  });
  await route("models: a configured admin token is required", {
    route: MODELS,
    adminToken: "secret-token",
    json: { provider: "custom" },
  });

  // ══ /api/ai/policy-sample ═════════════════════════════════════════
  const sampleBody = (over = {}) => ({
    provider: "openai",
    apiKey: "sk-fixture-key",
    model: "gpt-4.1-mini",
    ...over,
  });
  await route("sample: no provider", { route: SAMPLE, json: {} });
  await route("sample: no model", {
    route: SAMPLE,
    json: { provider: "openai", apiKey: "sk-fixture-key" },
  });
  await route("sample: a blank model", {
    route: SAMPLE,
    json: sampleBody({ model: "   " }),
  });
  await route("sample: a model over 200 UTF-16 units", {
    route: SAMPLE,
    json: sampleBody({ model: `${"m".repeat(199)}😀` }),
  });
  await route("sample: a model of exactly 200 units needs a key", {
    route: SAMPLE,
    json: { provider: "openai", model: `${"m".repeat(198)}😀` },
  });
  await route("sample: a metadata address is blocked", {
    route: SAMPLE,
    json: {
      provider: "custom",
      model: "gemma3n:e4b",
      baseUrl: "http://169.254.169.254",
    },
  });
  await route("sample: an unparseable base URL", {
    route: SAMPLE,
    json: sampleBody({ baseUrl: "https://exa mple.com" }),
  });
  await route("sample: OpenAI summarises the sample", {
    route: SAMPLE,
    setup: [setting("ai_debug_logging", "true")],
    json: sampleBody(),
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await route("sample: the masked key reads the stored one", {
    route: SAMPLE,
    setup: [setting("ai_api_key", "sk-stored")],
    json: sampleBody({ apiKey: "__SET__", model: "  gpt-4o  " }),
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await route("sample: a local model streams the sample", {
    route: SAMPLE,
    json: {
      provider: "custom",
      model: "gemma3n:e4b",
      baseUrl: "127.0.0.1:11434",
    },
    replies: [sse(MODEL_SUMMARY)],
  });
  await route("sample: Anthropic summarises the sample", {
    route: SAMPLE,
    json: {
      provider: "anthropic",
      apiKey: "sk-ant-fixture",
      model: "claude-3-5-haiku-latest",
    },
    replies: [anthropicTool("privacy_policy_summary", MODEL_SUMMARY)],
  });
  await route("sample: the provider fails", {
    route: SAMPLE,
    json: sampleBody(),
    replies: [status(500, { "content-type": "text/plain" }, "overloaded")],
  });
  await route("sample: a long failure is cut in the activity summary", {
    route: SAMPLE,
    json: sampleBody(),
    replies: [
      json(
        { error: { message: `Invalid request: ${"detail ".repeat(60)}` } },
        400
      ),
    ],
  });
  await route("sample: two timeouts", {
    route: SAMPLE,
    json: sampleBody(),
    replies: [TIMEOUT, TIMEOUT],
  });
  await route("sample: a network failure", {
    route: SAMPLE,
    json: sampleBody(),
    replies: [NETWORK],
  });
  await route("sample: a redirect from the provider", {
    route: SAMPLE,
    json: sampleBody(),
    replies: [status(307, { location: "https://elsewhere.example/v1" })],
  });
  await bodyRefusals("sample", SAMPLE, 16 * 1024);
  await route("sample: the seventh in a minute is refused", {
    route: SAMPLE,
    json: {},
    repeat: 7,
  });

  // ══ /api/policy/regenerate ════════════════════════════════════════
  await route("regenerate: the eleventh in a minute is refused", {
    route: REGEN,
    json: {},
    repeat: 11,
  });
  await bodyRefusals("regenerate", REGEN, 8 * 1024);
  await route("regenerate: a numeric appId", {
    route: REGEN,
    json: { appId: 1_000_000_001 },
  });
  await route("regenerate: a blank appId", {
    route: REGEN,
    json: { appId: "   " },
  });
  await route("regenerate: an appId that is not digits", {
    route: REGEN,
    json: { appId: "12a" },
  });
  await route("regenerate: an appId of 21 digits", {
    route: REGEN,
    json: { appId: "1".repeat(21) },
  });
  await route("regenerate: the kill-switch refuses a fetch", {
    route: REGEN,
    setup: [app(), setting("policy_scrape_disabled", "true")],
    json: { appId: APP, phase: "fetch" },
  });
  await route("regenerate: an unknown phase is all, and refused", {
    route: REGEN,
    setup: [app(), setting("policy_scrape_disabled", "true")],
    json: { appId: APP, phase: "everything" },
  });
  await route("regenerate: the kill-switch lets a summary through", {
    route: REGEN,
    setup: [app(), analysis(), setting("policy_scrape_disabled", "true")],
    json: { appId: APP, phase: " summarise " },
  });
  await route("regenerate: an unknown app", {
    route: REGEN,
    json: { appId: "42" },
  });
  await route("regenerate: an app with no policy link", {
    route: REGEN,
    setup: [app(APP, null)],
    json: { appId: APP },
  });
  await route("regenerate: an app with an empty policy link", {
    route: REGEN,
    setup: [app(APP, "")],
    json: { appId: APP, phase: "summarise" },
  });
  await route("regenerate: summarise with OpenAI", {
    route: REGEN,
    setup: [
      app(),
      analysis({
        status: "ready",
        summary_json: JSON.stringify({ overview: "An older summary." }),
      }),
      ...aiSettings(),
    ],
    json: { appId: APP, phase: "summarise" },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await route("regenerate: fetch a first capture", {
    route: REGEN,
    setup: [app(), snapshot("snap-1", BASE_NOW - DAY)],
    json: { appId: ` ${APP} `, phase: "fetch" },
    replies: [plain(V1), AVAIL_NONE, SAVE_OK],
  });
  await route("regenerate: all, fetched and summarised", {
    route: REGEN,
    setup: [app(), snapshot("snap-1", BASE_NOW - DAY), ...aiSettings()],
    json: { appId: APP },
    replies: [plain(V1), AVAIL_NONE, SAVE_OK, openaiJson(MODEL_SUMMARY)],
  });
  await route("regenerate: a stream flag that is not true", {
    route: REGEN,
    setup: [app(), analysis()],
    json: { appId: APP, phase: "summarise", stream: "true" },
  });
  await route("regenerate: the run marker refused", {
    route: REGEN,
    setup: [app(), analysis(), refuseRunMarker],
    json: { appId: APP, phase: "summarise" },
  });
  await route("regenerate: stream a summary", {
    route: REGEN,
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    json: { appId: APP, phase: "summarise", stream: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await route("regenerate: stream a fetch that fails", {
    route: REGEN,
    setup: [app(), snapshot("snap-1", BASE_NOW - DAY), ...aiSettings()],
    json: { appId: APP, phase: "all", stream: true },
    replies: [plain("Not found", 404)],
  });
  await route("regenerate: stream a capture and its summary", {
    route: REGEN,
    setup: [app(), snapshot("snap-1", BASE_NOW - DAY), ...aiSettings()],
    json: { appId: APP, stream: true },
    replies: [plain(V1), AVAIL_NONE, SAVE_OK, openaiJson(MODEL_SUMMARY)],
  });
  await route("regenerate: stream a chunked summary", {
    route: REGEN,
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({
        provider: "custom",
        model: "gemma3n:e4b",
        baseUrl: "http://127.0.0.1:11434",
      }),
    ],
    json: { appId: APP, phase: "summarise", stream: true },
    replies: [
      ...Array.from({ length: chunkCount(LONG, 4000) }, (_, i) =>
        sse(NOTE(i + 1))
      ),
      sse(MODEL_SUMMARY),
    ],
  });
  await route("regenerate: stream a model that times out twice", {
    route: REGEN,
    setup: [app(), analysis(), ...aiSettings()],
    json: { appId: APP, phase: "summarise", stream: true },
    replies: [TIMEOUT, TIMEOUT],
  });
  await route("regenerate: stream when the run marker is refused", {
    route: REGEN,
    setup: [app(), analysis(), refuseRunMarker],
    json: { appId: APP, phase: "summarise", stream: true },
  });

  // ── The scrape throttle, and the tab's clicks that pass it ──
  // Appended after every other case: each case takes the next forwarded
  // address, so one added earlier would move every case after it. The row
  // was fetched ten minutes ago, inside the default sixty-minute throttle.
  // The AI Policy tab sends `bypassThrottle: true`; onboarding's policy step
  // and API callers send nothing and keep the throttle.
  const recentReady = () =>
    analysis({
      status: "ready",
      source_text: V1,
      summary_json: JSON.stringify({ overview: "An older summary." }),
      model: "gpt-4.1-mini",
      updated_at: BASE_NOW - 10 * MIN,
      source_fetched_at: BASE_NOW - 10 * MIN,
    });
  await route(
    "regenerate: a bypass that is not the boolean true keeps the throttle",
    {
      route: REGEN,
      setup: [app(), recentReady()],
      json: { appId: APP, phase: "fetch", bypassThrottle: "true" },
    }
  );
  await route("regenerate: a rescrape from the tab passes the throttle", {
    route: REGEN,
    setup: [app(), recentReady()],
    json: { appId: APP, phase: "fetch", bypassThrottle: true },
    replies: [plain(V1), AVAIL_NONE, SAVE_OK],
  });
  await route(
    "regenerate: stream a rescrape and summary that passes the throttle",
    {
      route: REGEN,
      setup: [app(), recentReady(), ...aiSettings()],
      json: { appId: APP, stream: true, bypassThrottle: true },
      replies: [plain(V1), AVAIL_NONE, SAVE_OK, openaiJson(MODEL_SUMMARY)],
    }
  );
  await route(
    "regenerate: the kill-switch refuses a fetch that bypasses the throttle",
    {
      route: REGEN,
      setup: [app(), recentReady(), setting("policy_scrape_disabled", "true")],
      json: { appId: APP, phase: "fetch", bypassThrottle: true },
    }
  );

  // ── Summarise with no usable AI provider keeps the summary ──
  // Appended last, for the same reason. The tab's Summarise over a summary
  // while the provider's key is blank: the answer carries the summary the
  // run was replacing, with its model, under the needs-config status.
  await route("regenerate: summarise with a blank key keeps the summary", {
    route: REGEN,
    setup: [
      app(),
      recentReady(),
      ...aiSettings({ model: "gpt-4.1", apiKey: "  " }),
    ],
    json: { appId: APP, phase: "summarise" },
  });

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
  const nonces = [...text.matchAll(/UNTRUSTED_[A-Z_]+:([^>]+)>>>/g)].map(
    (m) => m[1]
  );
  const random = nonces.filter((n) => !/^\d{20}$/.test(n));
  if (random.length) {
    throw new Error(`non-deterministic nonces leaked: ${random.slice(0, 3)}`);
  }
  writeFileSync(
    new URL("../tests/fixtures/ai-routes-cases.json", import.meta.url),
    text
  );
  const count = (path_) => cases.filter((c) => c.route === path_).length;
  console.log(
    `Recorded ${count(REGEN)} regenerate, ${count(SAMPLE)} sample, ${count(TEST)} test and ${count(MODELS)} models cases from the real Node routes; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
