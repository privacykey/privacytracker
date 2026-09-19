/**
 * Policy-summariser oracle for the Rust core (Phase 5, batch 3a).
 *
 * Runs the REAL `syncPrivacyPolicyAnalysis` with `phase: "summarise"` and
 * `phase: "all"` — `summariseStoredPolicy`, the AI configuration read from
 * settings, `buildPolicySummary` direct and in chunks (with the chunk notes
 * persisted after every chunk and reused on a retry), the prompts with
 * their nonce-wrapped untrusted blocks, the OpenAI `json_schema` call, the
 * custom endpoint's `json_object` call with its streamed reply, the
 * Anthropic tool call, the per-phase timeouts with their one retry and the
 * debounced timeout notification, and the AI debug log — plus the real
 * `summarizeSamplePrivacyPolicy` and `buildPolicySummaryPromptPreview`,
 * which batch 3b's routes serve. Every provider reply is canned, never the
 * network: the shapes are the providers' documented response formats
 * (there is no key to capture live ones with).
 *
 * Recorded per case: every raw fetch (URL, headers, method, body), every
 * write in order, the policy, notification, activity, debug-log and
 * settings tables, and the return value or the thrown message.
 *
 * Randomness: `randomUUID` is a counter, and so is `randomBytes(15)` — the
 * nonce `wrapUntrusted` puts in every untrusted block — spelled as the
 * zero-padded 20-digit counter its base64url round-trips to, sharing the
 * one counter so the interleaving of ids and nonces is pinned.
 *
 * Time: the clock is frozen, and each fetch the code awaits advances it one
 * second unless the reply says otherwise (a timeout advances it by the time
 * the request would have hung). Save Page Now, fired and forgotten after a
 * first capture in the `all` phase, is free and answered after the sync
 * returns, into a separate `late` stream.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-policy-summary-oracle-"));
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

const {
  buildPolicySummaryPromptPreview,
  summarizeSamplePrivacyPolicy,
  syncPrivacyPolicyAnalysis,
} = await import("../../lib/privacy-policy.ts");

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
const SHORT_CRLF = paragraphs(3, " (crlf)").join("\r\n\r\n");
// Past the 8,000-character direct limit of a model that needs chunking,
// which splits it into 4,000-character chunks.
const LONG = paragraphs(100).join("\n\n");
// One paragraph longer than a chunk, sliced by the `[\s\S]{1,3000}(?:\s|$)`
// scan, with a 3,500-character run the scan cannot end inside: its first
// 500 characters are never matched and so never summarised.
const SLICED = [
  paragraphs(2, " (lead)").join(" "),
  [
    paragraphs(26, " (words)").join(" "),
    "x".repeat(3500),
    paragraphs(22, " (tail)").join(" "),
  ].join(" "),
  paragraphs(2, " (end)").join(" "),
].join("\n\n");

// The chunk count the real `chunkPolicyText` will produce, so each chunked
// case can supply exactly one reply per chunk plus the merge. A copy of
// the function, used only to size the reply lists; the recorded behaviour
// is the module's own.
function chunkCount(text, maxChars) {
  const parts = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of parts) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const slices = paragraph.match(
        new RegExp(
          `[\\s\\S]{1,${Math.max(1000, maxChars - 1000)}}(?:\\s|$)`,
          "g"
        )
      ) ?? [paragraph];
      for (const slice of slices) {
        if (slice.trim()) {
          chunks.push(slice.trim());
        }
      }
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks.length : 1;
}

// ── Replies ──────────────────────────────────────────────────────────
const APP = "1000000001";
const P = "https://example.com/privacy";
const WEBHOOK = "https://hooks.example.com/pt";
const json = (body, code = 200) => ({
  status: code,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const plain = (body) => ({
  status: 200,
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
    "The app collects account and device data to run the service.\n  It shares data with service providers.",
  highlights: [
    "Collects name, email and device identifiers.",
    "Shares data with service providers.",
    "Collects name, email and device identifiers.",
    "   Uses cookies   for analytics.  ",
    "",
    "Keeps data as long as necessary.",
    "Not directed to children under 13.",
  ],
  lenses: LENS_KEYS.map((key, i) => ({
    key,
    rating: RATINGS[i % RATINGS.length],
    summary: `Lens ${i + 1} is grounded in section ${i + 1} of the policy.`,
  })),
};
const SAFETY = {
  paragraph:
    "The policy says the app is not directed to children under 13 and describes no age gate.",
  concerns: [
    "Data is shared with service providers.",
    "Cookies are used for analytics.",
    "Data is shared with service providers.",
  ],
};
const ODD_SUMMARY = {
  overview: 42,
  highlights: "not a list",
  lenses: [
    { key: "collection_scope", rating: "terrible", summary: "  " },
    { key: "made_up_lens", rating: "favorable", summary: "Ignored." },
    { key: "ads_marketing", rating: "favorable", summary: 7 },
    { key: "ads_marketing", rating: "mixed", summary: "The last entry wins." },
    "not an object",
  ],
  externalReferences: [
    {
      source: "tosdr",
      label: "ToS;DR",
      url: "https://tosdr.org/x",
      summary: "Grade C.",
      scoreLabel: "C",
    },
    { source: "other", label: "Skipped", url: "https://x", summary: "No." },
  ],
  safetySummary: { paragraph: "   ", concerns: ["dropped"] },
};
const NOTE = (i) => ({
  summary: `Chunk ${i} describes collection and sharing.`,
  highlights: [
    `Chunk ${i} collects device identifiers.`,
    `Chunk ${i} shares data with vendors.`,
    `Chunk ${i} keeps data as long as necessary.`,
  ],
});

const openai = (content, extra = {}) =>
  json({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_789_473_600,
    model: "gpt-4.1-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null, ...extra },
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
    content: [
      { type: "text", text: "Here is the analysis." },
      { type: "tool_use", id: "toolu_fixture", name, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1200, output_tokens: 400 },
  });
const anthropicText = (...texts) =>
  json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-latest",
    content: texts.map((text) => ({ type: "text", text })),
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 400 },
  });
// An OpenAI-compatible event stream: the content split into `pieces`
// deltas, then `[DONE]`, cut into transport chunks of `size` bytes (so a
// frame, and a character, can straddle two chunks).
const b64 = (buffer) => ({ b64: Buffer.from(buffer).toString("base64") });
const chunked = (text, size, extra = {}) => {
  const bytes = Buffer.from(text, "utf8");
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(b64(bytes.subarray(i, i + size)));
  }
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks,
    ...extra,
  };
};
const frame = (delta) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
const sseText = (content, pieces = 3) => {
  const step = Math.ceil(content.length / pieces);
  const frames = [frame({ role: "assistant", content: "" })];
  for (let i = 0; i < content.length; i += step) {
    frames.push(frame({ content: content.slice(i, i + step) }));
  }
  return `${frames.join("")}data: [DONE]\n\n`;
};
const sse = (value, { pieces = 3, size = 97 } = {}) =>
  chunked(sseText(JSON.stringify(value), pieces), size);

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
const PREVIOUS = JSON.stringify({ overview: "An older summary." });
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
const debugRow = (i) =>
  insert("ai_debug_log", {
    id: `debug-${String(i).padStart(3, "0")}`,
    created_at: BASE_NOW - (60 - i) * MIN,
    app_id: APP,
    app_name: "Policy Fixture",
    provider: "openai",
    model: "gpt-4.1-mini",
    phase: "direct-summary",
    prompt: `Prompt ${i}`,
    response: `Response ${i}`,
    duration_ms: 1000 + i,
    error: null,
  });

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
      return Promise.reject(new Error(`Missing fixture reply for ${url}`));
    }
    const saveNow = url.startsWith("https://web.archive.org/save/");
    if (!(saveNow || url === WEBHOOK)) {
      now += r.advance ?? TICK;
    }
    const answer = () => {
      if (r.throws === "timeout") {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        );
      }
      if (r.throws === "abort") {
        throw new DOMException("This operation was aborted", "AbortError");
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
          // One chunk per pull, then the close or the error: an error
          // raised while chunks are queued would discard them.
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
          // A byte body, so undici stamps no Content-Type the server did
          // not send; it arrives as one chunk.
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
  return { held, used: () => cursor };
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
function begin(setup, at) {
  wipe();
  now = at;
  idCounter = 0;
  recording = null;
  for (const s of setup) {
    db.prepare(s.sql).run(...s.params);
  }
}

async function sync(
  name,
  {
    setup = [],
    request = {},
    phase = "summarise",
    options = {},
    replies = [],
    at = BASE_NOW,
  }
) {
  begin(setup, at);
  const req = {
    appId: APP,
    appName: "Policy Fixture",
    developer: "Fixture Developer",
    policyUrl: P,
    ...request,
  };
  const calls = [];
  const { held, used } = stubFetch(replies, calls);
  const stream = [];
  const late = [];
  const restore = silence();
  let expected;
  recording = stream;
  try {
    const result = await syncPrivacyPolicyAnalysis(req, {
      phase,
      ...options,
    });
    expected = { ok: true, result: result ?? null };
  } catch (error) {
    expected = { ok: false, error: error?.message ?? String(error) };
  }
  recording = late;
  await settle();
  for (const release of held.splice(0)) {
    release();
  }
  await settle();
  recording = null;
  restore();
  if (used() !== replies.length) {
    throw new Error(`${name}: unused replies ${used()}/${replies.length}`);
  }
  cases.push({
    name,
    kind: "sync",
    now: at,
    setup,
    request: req,
    options: { phase, ...options },
    replies,
    calls,
    stream,
    late,
    rows: dump(),
    expected,
  });
}

async function sample(
  name,
  { setup = [], aiConfig, audience, replies = [], at = BASE_NOW }
) {
  begin(setup, at);
  const calls = [];
  const { used } = stubFetch(replies, calls);
  const stream = [];
  const restore = silence();
  let expected;
  recording = stream;
  try {
    const result = await summarizeSamplePrivacyPolicy({
      aiConfig,
      ...(audience ? { audience } : {}),
    });
    expected = { ok: true, result };
  } catch (error) {
    expected = { ok: false, error: error?.message ?? String(error) };
  }
  await settle();
  recording = null;
  restore();
  if (used() !== replies.length) {
    throw new Error(`${name}: unused replies ${used()}/${replies.length}`);
  }
  cases.push({
    name,
    kind: "sample",
    now: at,
    setup,
    aiConfig,
    audience: audience ?? null,
    replies,
    calls,
    stream,
    rows: dump(),
    expected,
  });
}

function preview(name, input) {
  begin([], BASE_NOW);
  cases.push({
    name,
    kind: "preview",
    input,
    expected: buildPolicySummaryPromptPreview(input),
  });
}

// ── Cases ────────────────────────────────────────────────────────────
const TIMEOUT = { throws: "timeout", advance: 90 * 1000 };
const guardian = setting("flag.focus.audience", "guardian");
const chunkReplies = (text, maxChars, reply, merge) => [
  ...Array.from({ length: chunkCount(text, maxChars) }, (_, i) =>
    reply(NOTE(i + 1))
  ),
  merge,
];

try {
  // ── Gating: what never reaches a model ──
  await sync("summarise without an AI provider needs configuration", {
    setup: [app(), analysis()],
  });
  await sync("summarise with OpenAI and no key needs configuration", {
    setup: [app(), analysis(), ...aiSettings({ apiKey: "  " })],
  });
  await sync("a blank model setting needs configuration", {
    setup: [app(), analysis(), ...aiSettings({ model: "   " })],
  });
  await sync("an existing summary is already current", {
    setup: [
      app(),
      analysis({
        status: "ready",
        summary_json: JSON.stringify(MODEL_SUMMARY),
      }),
      ...aiSettings(),
    ],
  });
  await sync("an imported summary is not summarised again", {
    setup: [
      app(),
      analysis({
        status: "ready",
        summary_json: JSON.stringify(MODEL_SUMMARY),
        model: "imported",
      }),
      ...aiSettings(),
    ],
    options: { forceResummarise: true },
  });
  await sync("a fetch error cannot be summarised", {
    setup: [app(), analysis({ status: "fetch_error" }), ...aiSettings()],
  });
  await sync("an app with nothing stored cannot be summarised", {
    setup: [app(), ...aiSettings()],
  });
  await sync("summarise with no policy URL clears the analysis", {
    setup: [app(), analysis()],
    request: { policyUrl: undefined },
  });

  // ── OpenAI: json_schema, one reply ──
  await sync("OpenAI summarises the stored policy", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("a forced resummarise keeps the summary it replaces", {
    setup: [
      app(),
      analysis({
        status: "ready",
        summary_json: PREVIOUS,
        updated_at: BASE_NOW - 3 * DAY,
      }),
      ...aiSettings(),
    ],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("the current summary becomes the previous one over a stored one", {
    setup: [
      app(),
      analysis({
        summary_json: JSON.stringify({ overview: "Current." }),
        previous_summary_json: PREVIOUS,
        previous_summary_at: BASE_NOW - 9 * DAY,
      }),
      ...aiSettings(),
    ],
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("OpenAI refuses", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [openai(null, { refusal: "I can't help with that." })],
  });
  await sync("an OpenAI error status quotes its body", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [
      json(
        {
          error: {
            message: `Rate limit reached for gpt-4.1-mini. ${"Please retry later. ".repeat(20)}`,
            type: "requests",
          },
        },
        429
      ),
    ],
  });
  await sync("an OpenAI reply that is not JSON", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body>Bad gateway</body></html>",
      },
    ],
  });
  await sync("OpenAI content parts are joined", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [
      openai([
        { type: "text", text: JSON.stringify(MODEL_SUMMARY).slice(0, 40) },
        { type: "text" },
        { type: "text", text: JSON.stringify(MODEL_SUMMARY).slice(40) },
      ]),
    ],
  });
  await sync("OpenAI returns no content", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [openai("  \n ")],
  });
  await sync("OpenAI content that is not JSON", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [openai("Here is the summary you asked for: {}")],
  });
  await sync("OpenAI content in a code fence", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [openai(`\`\`\`json\n${JSON.stringify(MODEL_SUMMARY)}\n\`\`\``)],
  });
  await sync("OpenAI output with unknown lenses and ratings", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [openaiJson(ODD_SUMMARY)],
  });
  await sync("OpenAI output that is an array", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [openaiJson([MODEL_SUMMARY])],
  });
  await sync("a guardian gets the safety summary", {
    setup: [app(), analysis(), guardian, ...aiSettings({ debug: true })],
    replies: [openaiJson({ ...MODEL_SUMMARY, safetySummary: SAFETY })],
  });
  await sync("a missing developer is named as unknown", {
    setup: [app(), analysis({ source_text: SHORT_CRLF }), ...aiSettings()],
    request: { developer: undefined },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("debug logging keeps the newest fifty rows", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ debug: true }),
      ...Array.from({ length: 50 }, (_, i) => debugRow(i + 1)),
    ],
    replies: [openaiJson(MODEL_SUMMARY)],
  });

  // ── Timeouts, the retry and the notification ──
  await sync("an OpenAI timeout is retried once", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [TIMEOUT, openaiJson(MODEL_SUMMARY)],
  });
  await sync("OpenAI times out twice", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [TIMEOUT, TIMEOUT],
  });
  await sync("a recent timeout notification is not repeated", {
    setup: [
      app(),
      analysis(),
      ...aiSettings(),
      // Five minutes before the run, six and a half by the time the
      // 90-second timeout lands: inside the ten-minute window.
      setting("ai_timeout_notify_direct_at", String(BASE_NOW - 5 * MIN)),
    ],
    replies: [TIMEOUT, openaiJson(MODEL_SUMMARY)],
  });
  await sync("a stale timeout notification is repeated", {
    setup: [
      app(),
      analysis(),
      ...aiSettings(),
      setting("ai_timeout_notify_direct_at", String(BASE_NOW - 11 * MIN)),
    ],
    replies: [TIMEOUT, openaiJson(MODEL_SUMMARY)],
  });
  await sync("a timeout setting below the floor is clamped", {
    setup: [
      app(),
      analysis(),
      ...aiSettings(),
      setting("ai_timeout_direct_ms", "5000"),
    ],
    replies: [{ ...TIMEOUT, advance: 10_000 }, openaiJson(MODEL_SUMMARY)],
  });
  await sync("a timeout setting that is not a number uses the default", {
    setup: [
      app(),
      analysis(),
      ...aiSettings(),
      setting("ai_timeout_direct_ms", "soon"),
    ],
    replies: [TIMEOUT, openaiJson(MODEL_SUMMARY)],
  });
  await sync("an abort is retried like a timeout", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [{ throws: "abort" }, openaiJson(MODEL_SUMMARY)],
  });
  await sync("an error status that mentions a timeout is retried", {
    setup: [app(), analysis(), ...aiSettings()],
    replies: [
      status(504, { "content-type": "text/plain" }, "upstream timeout"),
      openaiJson(MODEL_SUMMARY),
    ],
  });
  await sync("a network failure is not retried", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [{ throws: "fetch failed" }],
  });
  await sync("an OpenAI redirect is refused", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [status(302, { location: "http://127.0.0.1:8080/steal" })],
  });
  await sync("an OpenAI reply over two megabytes", {
    setup: [app(), analysis(), ...aiSettings({ debug: true })],
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        fill: { char: "a", bytes: 2 * 1024 * 1024 + 1 },
      },
    ],
  });

  // ── The custom endpoint: json_object, streamed ──
  await sync("a custom endpoint streams its summary", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      chunked(
        sseText(
          JSON.stringify({
            ...MODEL_SUMMARY,
            overview: "Collecte des données — résumé.",
          }),
          5
        ),
        61
      ),
    ],
  });
  await sync("a custom endpoint sends the whole message at the end", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      chunked(
        [
          frame({ role: "assistant", content: "" }),
          "data: {not json}\n\n",
          ": keep-alive comment\n\n",
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, message: { role: "assistant", content: JSON.stringify(MODEL_SUMMARY) } }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        4096
      ),
    ],
  });
  await sync("a custom stream cut off by the timeout is retried", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      {
        ...chunked(sseText(JSON.stringify(MODEL_SUMMARY)).slice(0, 700), 250),
        streamError: "timeout",
        advance: 180 * 1000,
      },
      sse(MODEL_SUMMARY),
    ],
  });
  await sync("a custom stream that breaks is not retried", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      {
        ...chunked(sseText(JSON.stringify(MODEL_SUMMARY)).slice(0, 300), 120),
        streamError: "terminated",
      },
    ],
  });
  await sync("a custom stream with no content", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      chunked(
        `${frame({ role: "assistant", content: "" })}data: [DONE]\n\n`,
        64
      ),
    ],
  });
  await sync("a custom stream with CRLF frames", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      chunked(
        sseText(JSON.stringify(MODEL_SUMMARY)).replace(/\n/g, "\r\n"),
        128
      ),
    ],
  });
  await sync("a custom stream that ends inside a character", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        chunks: [
          sseText(JSON.stringify(MODEL_SUMMARY), 2),
          {
            b64: Buffer.from([
              0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2, 0x82,
            ]).toString("base64"),
          },
        ],
      },
    ],
  });
  await sync("a custom endpoint error status", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      status(500, { "content-type": "text/plain" }, "model not loaded"),
    ],
  });
  await sync("a custom stream over two megabytes", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: [
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        chunks: [
          frame({ content: "{" }),
          { fill: { char: "y", bytes: 2 * 1024 * 1024 } },
        ],
      },
    ],
  });
  await sync("a custom base URL without a scheme", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({
        provider: "custom",
        baseUrl: "  localhost:11434///  ",
        apiKey: "local-key",
        model: "qwen2.5:7b",
      }),
    ],
    replies: [sse(MODEL_SUMMARY)],
  });
  await sync("a custom base URL with a path keeps it", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({
        provider: "custom",
        baseUrl: "https://llm.example.net/openai/V1",
      }),
    ],
    replies: [sse(MODEL_SUMMARY)],
  });
  await sync("a custom base URL at a metadata address is refused", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({
        provider: "custom",
        baseUrl: "http://169.254.169.254/latest",
        debug: true,
      }),
    ],
  });
  await sync("the legacy ollama provider is the custom one", {
    setup: [app(), analysis(), ...aiSettings({ provider: "ollama" })],
    replies: [sse(MODEL_SUMMARY)],
  });

  // ── Anthropic: a forced tool call ──
  await sync("Anthropic answers with its tool", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1/",
        debug: true,
      }),
    ],
    replies: [anthropicTool("privacy_policy_summary", MODEL_SUMMARY)],
  });
  await sync("Anthropic answers in text", {
    setup: [app(), analysis(), ...aiSettings({ provider: "anthropic" })],
    replies: [
      anthropicText("```json\n", JSON.stringify(MODEL_SUMMARY), "\n```"),
    ],
  });
  await sync("an Anthropic reply that is not JSON", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "anthropic", debug: true }),
    ],
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"content": [',
      },
    ],
  });
  await sync("an Anthropic reply with no text", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "anthropic", debug: true }),
    ],
    replies: [anthropicText(" ")],
  });
  await sync("an Anthropic error status", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "anthropic", debug: true }),
    ],
    replies: [
      json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        401
      ),
    ],
  });
  await sync("an Anthropic body cut off by the timeout is retried", {
    setup: [
      app(),
      analysis(),
      ...aiSettings({ provider: "anthropic", debug: true }),
    ],
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: ['{"id":"msg_fixture","content":['],
        streamError: "timeout",
      },
      anthropicTool("privacy_policy_summary", MODEL_SUMMARY),
    ],
  });

  // ── Chunks: a model that needs them, and a long policy ──
  await sync("a long policy is summarised in chunks", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({ provider: "custom", debug: true }),
    ],
    replies: chunkReplies(LONG, 4000, (n) => sse(n), sse(MODEL_SUMMARY)),
  });
  await sync("stored chunk notes are reused for the merge", {
    setup: [
      app(),
      analysis({
        source_text: LONG,
        chunk_notes_json: JSON.stringify(
          Array.from({ length: chunkCount(LONG, 4000) }, (_, i) => NOTE(i + 1))
        ),
        chunk_notes_hash: sha(LONG),
      }),
      ...aiSettings({ provider: "custom" }),
    ],
    replies: [sse(MODEL_SUMMARY)],
  });
  await sync("stale chunk notes are not reused", {
    setup: [
      app(),
      analysis({
        source_text: LONG,
        chunk_notes_json: JSON.stringify([NOTE(1), NOTE(2), NOTE(3)]),
        chunk_notes_hash: sha(SHORT),
      }),
      ...aiSettings({ provider: "custom" }),
    ],
    replies: chunkReplies(LONG, 4000, (n) => sse(n), sse(MODEL_SUMMARY)),
  });
  await sync("a failed chunk keeps the notes before it", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({ provider: "custom" }),
    ],
    replies: [sse(NOTE(1)), status(500, {}, "out of memory")],
  });
  await sync("chunk notes the model left empty are filled in", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({ provider: "custom" }),
    ],
    replies: [
      ...Array.from({ length: chunkCount(LONG, 4000) }, (_, i) =>
        sse(
          i === 0
            ? { summary: "  ", highlights: ["", 3, "  "] }
            : { summary: `Chunk ${i + 1}.`, highlights: "none" }
        )
      ),
      sse(MODEL_SUMMARY),
    ],
  });
  await sync("a paragraph longer than a chunk is sliced", {
    setup: [
      app(),
      analysis({ source_text: SLICED }),
      ...aiSettings({ provider: "custom" }),
    ],
    replies: chunkReplies(SLICED, 4000, (n) => sse(n), sse(MODEL_SUMMARY)),
  });
  await sync("a guardian's merge asks for the safety summary", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      guardian,
      ...aiSettings({ provider: "custom" }),
    ],
    replies: chunkReplies(
      LONG,
      4000,
      (n) => sse(n),
      sse({ ...MODEL_SUMMARY, safetySummary: SAFETY })
    ),
  });
  await sync("an OpenAI model that needs chunks is not streamed", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({ model: "llama-3.1-70b" }),
    ],
    replies: chunkReplies(
      LONG,
      4000,
      (n) => openaiJson(n),
      openaiJson(MODEL_SUMMARY)
    ),
  });
  await sync("Anthropic summarises a long policy in chunks", {
    setup: [
      app(),
      analysis({ source_text: LONG }),
      ...aiSettings({ provider: "anthropic", model: "mistral-large" }),
    ],
    replies: chunkReplies(
      LONG,
      4000,
      (n) => anthropicTool("privacy_policy_chunk_note", n),
      anthropicTool("privacy_policy_summary_from_chunks", MODEL_SUMMARY)
    ),
  });

  // ── The whole run: fetch, then summarise ──
  await sync("fetch then summarise in one run", {
    setup: [app(), ...aiSettings({ debug: true })],
    phase: "all",
    replies: [
      plain(paragraphs(30).join("\n\n")),
      AVAIL_NONE,
      SAVE_OK,
      openaiJson(MODEL_SUMMARY),
    ],
  });
  await sync("an unchanged source with a summary is not summarised again", {
    setup: [
      app(),
      analysis({
        status: "ready",
        source_text: paragraphs(30).join("\n\n"),
        summary_json: JSON.stringify(MODEL_SUMMARY),
        model: "gpt-4.1-mini",
      }),
      ...aiSettings(),
    ],
    phase: "all",
    replies: [plain(paragraphs(30).join("\n\n")), AVAIL_NONE, SAVE_OK],
  });
  await sync("a failed fetch is not summarised", {
    setup: [
      app(),
      analysis({ status: "ready", summary_json: PREVIOUS }),
      ...aiSettings(),
    ],
    phase: "all",
    replies: [status(404, { "content-type": "text/html" }, "Not found")],
  });
  await sync("the kill-switch stops a first run before the summary", {
    setup: [app(), ...aiSettings(), setting("policy_scrape_disabled", "true")],
    phase: "all",
  });

  // ── The sample policy and the prompt preview ──
  const openaiConfig = {
    provider: "openai",
    apiKey: "sk-fixture-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    label: "OpenAI",
  };
  await sample("the sample policy summarised by OpenAI", {
    setup: [...aiSettings({ debug: true })],
    aiConfig: openaiConfig,
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sample("the sample policy failing", {
    aiConfig: openaiConfig,
    replies: [status(500, { "content-type": "text/plain" }, "overloaded")],
  });
  await sample("the sample policy for a guardian with Anthropic", {
    aiConfig: {
      provider: "anthropic",
      apiKey: "sk-ant-fixture",
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-5-haiku-latest",
      label: "Anthropic",
    },
    audience: "guardian",
    replies: [
      anthropicTool("privacy_policy_summary", {
        ...MODEL_SUMMARY,
        safetySummary: SAFETY,
      }),
    ],
  });
  await sample("the sample policy on a local model", {
    aiConfig: {
      provider: "custom",
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "gemma3n:e4b",
      label: "Custom AI endpoint",
    },
    replies: [sse(MODEL_SUMMARY)],
  });
  preview("the prompt preview", {
    appName: "Preview App",
    developer: "Preview Dev",
    policyUrl: P,
    policyText: SHORT,
  });
  preview("the prompt preview for a guardian", {
    appName: "Preview App",
    policyUrl: P,
    policyText: SHORT_CRLF,
    audience: "guardian",
  });

  // ── Declined after a failed or unusable fetch ──
  // Appended after every other case, so none of their recordings move. A
  // failed or unusable rescrape keeps the last good text on the row. The
  // summarise phase declines that earlier capture and logs a skip, not the
  // stored failure. The forced options are the ones the route sends.
  await sync("a fetch error with its message cannot be summarised", {
    setup: [
      app(),
      analysis({
        status: "fetch_error",
        error: "HTTP 503",
        summary_json: PREVIOUS,
      }),
      ...aiSettings(),
    ],
    options: { forceResummarise: true },
  });
  await sync("a too-short fetch cannot be summarised", {
    setup: [
      app(),
      analysis({
        status: "too_short",
        error:
          "The fetched privacy-policy text was too short to summarize reliably.",
      }),
      ...aiSettings(),
    ],
    options: { forceResummarise: true },
  });
  await sync("an unsupported fetch cannot be summarised", {
    setup: [
      app(),
      analysis({
        status: "unsupported_content_type",
        error: "Unsupported privacy-policy content type: application/pdf",
      }),
      ...aiSettings(),
    ],
    options: { forceResummarise: true },
  });

  // ── Summarised again after a failed AI run or no provider ──
  // Appended after every other case, so none of their recordings move. Only
  // the summarise phase writes 'analysis_error' and 'needs_ai_config', over
  // a clean capture it accepted, and any later fetch replaces them, so the
  // text stored with them is still the latest clean capture. It is
  // summarised again, forced or not, and scraping being disabled does not
  // stop it.
  const failedSummary = () =>
    analysis({
      status: "analysis_error",
      error: "OpenAI request timed out after 90 seconds.",
      model: "gpt-4.1-mini",
      previous_summary_json: PREVIOUS,
      previous_summary_at: BASE_NOW - 9 * DAY,
    });
  const noProviderSummary = () =>
    analysis({
      status: "needs_ai_config",
      error:
        "Configure an AI provider in Settings to enable privacy-policy summaries.",
    });
  await sync("a failed AI summary is summarised again", {
    setup: [app(), failedSummary(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("an unforced summarise retries a failed AI summary", {
    setup: [app(), failedSummary(), ...aiSettings()],
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("a failed AI summary that fails again stores the new error", {
    setup: [app(), failedSummary(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [status(500, { "content-type": "text/plain" }, "overloaded")],
  });
  await sync("a summary that met no AI provider is made once one is set up", {
    setup: [app(), noProviderSummary(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("an unforced summarise that still finds no AI provider", {
    setup: [app(), noProviderSummary()],
  });
  await sync("scraping disabled does not stop a summary of the stored text", {
    setup: [
      app(),
      failedSummary(),
      ...aiSettings(),
      setting("policy_scrape_disabled", "true"),
    ],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });

  // ── A failed resummarise keeps the summary it was replacing ──
  // Appended after every other case, so none of their recordings move. A
  // summary run that fails replaces nothing: the summary stays, with the
  // mode and model that made it (not the configured model that failed),
  // and only the status, the error and the run log record the failure. The
  // next run that makes a summary moves the kept one into previous_*, as it
  // moves any summary it replaces, and so does a forced resummarise that
  // succeeds first time.
  const CURRENT = JSON.stringify({ overview: "The summary on the tab." });
  const summarised = (over = {}) =>
    analysis({
      status: "ready",
      analysis_mode: "direct",
      summary_json: CURRENT,
      previous_summary_json: PREVIOUS,
      previous_summary_at: BASE_NOW - 9 * DAY,
      model: "gpt-4o",
      ...over,
    });
  const keptAfterFailure = (over = {}) =>
    summarised({
      status: "analysis_error",
      error: "OpenAI request failed (500): overloaded",
      updated_at: BASE_NOW - DAY,
      ...over,
    });
  await sync("a failed forced resummarise keeps the summary it was replacing", {
    setup: [app(), summarised(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [status(500, { "content-type": "text/plain" }, "overloaded")],
  });
  await sync(
    "a forced resummarise keeps the summary it replaces over an older one",
    {
      setup: [app(), summarised(), ...aiSettings()],
      options: { forceResummarise: true },
      replies: [openaiJson(MODEL_SUMMARY)],
    }
  );
  await sync("a summary a failed run kept becomes the previous one", {
    setup: [app(), keptAfterFailure(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync(
    "an unforced summarise retries a failed run that kept its summary",
    {
      setup: [app(), keptAfterFailure(), ...aiSettings()],
      replies: [openaiJson(MODEL_SUMMARY)],
    }
  );
  await sync(
    "an unchanged fetch after a failed resummarise is its kept summary",
    {
      setup: [
        app(),
        keptAfterFailure({ source_text: paragraphs(30).join("\n\n") }),
        ...aiSettings(),
      ],
      phase: "all",
      replies: [plain(paragraphs(30).join("\n\n")), AVAIL_NONE, SAVE_OK],
    }
  );

  // ── A run that finds no AI provider keeps the summary it was replacing ──
  // Appended after every other case, so none of their recordings move. A
  // summary run that finds no usable AI provider (none chosen, or a blank
  // key or model) replaces nothing, as a failed run does: the summary
  // stays, with the mode and model that made it, beside the needs-config
  // status and error. The next run that makes a summary moves the kept one
  // into previous_*, and a later fetch that finds the text unchanged is a
  // cache hit that makes the kept summary ready again, provider or not.
  const keptWithoutProvider = (over = {}) =>
    summarised({
      status: "needs_ai_config",
      error:
        "Configure an AI provider in Settings to enable privacy-policy summaries.",
      updated_at: BASE_NOW - DAY,
      ...over,
    });
  await sync("a forced resummarise with no API key keeps the summary", {
    setup: [app(), summarised(), ...aiSettings({ apiKey: "  " })],
    options: { forceResummarise: true },
  });
  await sync("a forced resummarise with a blank model keeps the summary", {
    setup: [app(), summarised(), ...aiSettings({ model: "   " })],
    options: { forceResummarise: true },
  });
  await sync("a summary kept with no provider is kept while none is set up", {
    setup: [app(), keptWithoutProvider()],
  });
  await sync("a summary kept with no provider becomes the previous one", {
    setup: [app(), keptWithoutProvider(), ...aiSettings()],
    options: { forceResummarise: true },
    replies: [openaiJson(MODEL_SUMMARY)],
  });
  await sync("an unchanged fetch after no provider is its kept summary", {
    setup: [
      app(),
      keptWithoutProvider({ source_text: paragraphs(30).join("\n\n") }),
      ...aiSettings({ apiKey: "  " }),
    ],
    phase: "all",
    replies: [plain(paragraphs(30).join("\n\n")), AVAIL_NONE, SAVE_OK],
  });

  // ── A skipped fetch is logged as a skip ──
  // Appended after every other case, so none of their recordings move. The
  // throttle and the kill-switch hand back the stored analysis with their
  // own line last, and the activity row is told by that line, not by the
  // stored status. A fetch and summary that meets the kill-switch over a
  // clean capture still summarises it, and is logged as that summary.
  await sync("a throttled fetch and summary is logged as a skip", {
    setup: [
      app(),
      analysis({
        status: "ready",
        analysis_mode: "direct",
        summary_json: JSON.stringify(MODEL_SUMMARY),
        model: "gpt-4.1-mini",
        source_fetched_at: BASE_NOW - 10 * MIN,
      }),
      ...aiSettings(),
    ],
    phase: "all",
  });
  await sync("the kill-switch over a stored fetch error is logged as a skip", {
    setup: [
      app(),
      analysis({
        status: "fetch_error",
        error: "HTTP 404 Not Found",
        analysis_mode: "direct",
        summary_json: PREVIOUS,
        model: "gpt-4.1-mini",
      }),
      ...aiSettings(),
      setting("policy_scrape_disabled", "true"),
    ],
    phase: "all",
  });
  await sync(
    "the kill-switch before a summary of the stored text is logged as the summary",
    {
      setup: [
        app(),
        analysis(),
        ...aiSettings(),
        setting("policy_scrape_disabled", "true"),
      ],
      phase: "all",
      replies: [openaiJson(MODEL_SUMMARY)],
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
  const nonces = [...text.matchAll(/UNTRUSTED_[A-Z_]+:([^>]+)>>>/g)].map(
    (m) => m[1]
  );
  const random = nonces.filter((n) => !/^\d{20}$/.test(n));
  if (random.length) {
    throw new Error(`non-deterministic nonces leaked: ${random.slice(0, 3)}`);
  }
  writeFileSync(
    new URL("../tests/fixtures/policy-summary-cases.json", import.meta.url),
    text
  );
  const count = (kind) => cases.filter((c) => c.kind === kind).length;
  console.log(
    `Recorded ${count("sync")} sync, ${count("sample")} sample and ${count("preview")} preview cases from the real Node summariser; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
