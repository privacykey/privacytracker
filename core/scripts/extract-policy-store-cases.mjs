/**
 * Policy-store oracle for the Rust core (Phase 5, batch 2).
 *
 * Two halves, one fixture.
 *
 * STORE: runs the REAL `syncPrivacyPolicyAnalysis` with `phase: "fetch"` —
 * the run marker, the persisted run log, `fetchAndStorePolicySource` with
 * its kill-switch, throttle, fetch, failure branches, first/same/changed
 * classification, version backfill and upsert, archive lookup, History row
 * and notification, the cache hit and the source-ready write, then the
 * activity row — over scenarios seeded as SQL, with the raw `fetch`
 * stubbed by recorded replies, never the network.
 *
 * ROUTES: runs the REAL handlers of GET /api/policy/status/[appId],
 * /api/policy/version/[id], /api/policy/version/[id]/diff,
 * /api/manual-apps/[id]/policy-version/[versionId] and
 * POST /api/manual-apps/[id]/scrape.
 *
 * Recorded per case: every raw fetch (URL, headers, a POST's method and
 * body), every write in order, the rows of the policy and manual-app
 * tables, and the return value or the wire response.
 *
 * Time: the clock is frozen, and each fetch the code AWAITS advances it one
 * second, so a timestamp taken before the fetch and one taken after differ
 * and the port has to take each where Node does. The two fetches nothing
 * awaits — Save Page Now and the immediate webhook, both fired and
 * forgotten — are free. Save Page Now's reply is held until the sync has
 * returned, as production's 10 to 30 second archive always is, so what it
 * writes lands in a separate `late` stream in a deterministic order.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-policy-store-oracle-"));
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

const { syncPrivacyPolicyAnalysis } = await import(
  "../../lib/privacy-policy.ts"
);
const ROUTES = {
  "/api/policy/status/[appId]": (
    await import("../../app/api/policy/status/[appId]/route.ts")
  ).GET,
  "/api/policy/version/[id]": (
    await import("../../app/api/policy/version/[id]/route.ts")
  ).GET,
  "/api/policy/version/[id]/diff": (
    await import("../../app/api/policy/version/[id]/diff/route.ts")
  ).GET,
  "/api/manual-apps/[id]/policy-version/[versionId]": (
    await import(
      "../../app/api/manual-apps/[id]/policy-version/[versionId]/route.ts"
    )
  ).GET,
  "/api/manual-apps/[id]/scrape": (
    await import("../../app/api/manual-apps/[id]/scrape/route.ts")
  ).POST,
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
  "manual_app_events",
  "manual_app_policy_versions",
  "audit_log",
];
const dump = () =>
  Object.fromEntries(
    DUMPED.map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ])
  );

// ── Texts, pages and replies ─────────────────────────────────────────
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
const policyText = (count, tag) => paragraphs(count, tag).join("\n\n");
const V0 = policyText(30, " (2024)");
const V1 = policyText(30);
const V2 = policyText(31);
const html = (body, headers = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});
const plain = (body) => ({
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});
const json = (body, code = 200) => ({
  status: code,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const failure = (message) => ({ error: message });
const policyPage = (text) =>
  `<!doctype html><html><head><title>Example Privacy Policy</title></head><body><nav><a href="/">Home</a></nav><main>${text
    .split("\n\n")
    .map((p) => `<p>${p}</p>`)
    .join("\n")}</main></body></html>`;

const APP = "1000000001";
const P = "https://example.com/privacy";
const SNAP =
  "http://web.archive.org/web/20240101000000/https://example.com/privacy";
const AVAIL_NONE = json({ url: P, archived_snapshots: {} });
const AVAIL_SNAP = json({
  url: P,
  archived_snapshots: {
    closest: {
      available: true,
      url: SNAP,
      timestamp: "20240101000000",
      status: "200",
    },
  },
});
const SAVE_OK = status(302, {
  location:
    "https://web.archive.org/web/20260915120005/https://example.com/privacy",
});
const SAVE_FAIL = status(503);
const WEBHOOK = "https://hooks.example.com/pt";
const WEBHOOK_OK = {
  status: 200,
  headers: { "content-type": "text/plain" },
  body: "ok",
};
const SUMMARY = JSON.stringify({ overview: "Fixture summary." });
const PREVIOUS_SUMMARY = JSON.stringify({ overview: "Older summary." });
const LABELS = JSON.stringify([
  {
    identifier: "DATA_LINKED_TO_YOU",
    title: "Data Linked to You",
    categories: [{ identifier: "CONTACT_INFO", title: "Contact Info" }],
  },
]);

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
const override = (key, value) =>
  insert("feature_flag_overrides", {
    flag_key: key,
    override_value: value,
    set_at: BASE_NOW - DAY,
    set_by: "user",
    previous_focus: null,
    quarantined: 0,
  });
const analysis = (over = {}) =>
  insert("privacy_policy_analyses", {
    app_id: APP,
    policy_url: P,
    status: "ready",
    source_title: "example.com",
    source_content_type: "text/plain; charset=utf-8",
    source_text: V1,
    source_word_count: words(V1),
    source_origin: "direct",
    source_final_url: P,
    content_hash: sha(V1),
    analysis_mode: "direct",
    summary_json: SUMMARY,
    previous_summary_json: null,
    previous_summary_at: null,
    model: "fixture-model",
    error: null,
    updated_at: BASE_NOW - 2 * DAY,
    last_run_log: null,
    source_fetched_at: BASE_NOW - 2 * DAY,
    run_status: "idle",
    run_started_at: null,
    ...over,
  });
const version = (id, text, at, over = {}) =>
  insert("privacy_policy_versions", {
    id,
    app_id: APP,
    content_hash: sha(text),
    first_fetched_at: at,
    last_fetched_at: at,
    policy_url: P,
    source_final_url: P,
    source_title: "example.com",
    source_content_type: "text/plain; charset=utf-8",
    source_origin: "direct",
    source_word_count: words(text),
    source_text: text,
    ...over,
  });
const snapshot = (id, at, json_ = LABELS) =>
  insert("privacy_snapshots", {
    id,
    app_id: APP,
    scraped_at: at,
    snapshot_json: json_,
    changes_detected: 0,
    changes_summary: "[]",
  });
const webhook = (format = "slack") => [
  setting("notification_webhook_url", WEBHOOK),
  setting("notification_webhook_format", format),
  setting("notification_webhook_frequency", "immediate"),
];
const toggleOn = override("flag.notifications.types.policy_updates", "on");
const MANUAL = "manual-fixture-1";
const manualApp = (id = MANUAL, policyUrl = P) =>
  insert("manual_apps", {
    id,
    name: "Manual Fixture",
    source: "web_clip",
    developer: null,
    privacy_policy_url: policyUrl,
    source_url: null,
    notes: null,
    first_seen: BASE_NOW - 30 * DAY,
    updated_at: BASE_NOW - 30 * DAY,
  });
const manualVersion = (id, text, at, manualId = MANUAL) =>
  insert("manual_app_policy_versions", {
    id,
    manual_app_id: manualId,
    content_hash: sha(text),
    first_fetched_at: at,
    last_fetched_at: at,
    policy_url: P,
    source_final_url: P,
    source_title: "example.com",
    source_content_type: "text/plain; charset=utf-8",
    source_origin: "direct",
    source_word_count: words(text),
    source_text: text,
  });

// ── Driver ───────────────────────────────────────────────────────────
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
      now += TICK;
    }
    const answer = () => {
      if (r.error) {
        throw new Error(r.error);
      }
      // A byte body, so undici stamps no Content-Type the server did not
      // send; and the hop's URL, which undici's own Response carries.
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

async function store(
  name,
  { setup = [], request = {}, options = {}, replies = [], at = BASE_NOW }
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
      phase: "fetch",
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
    kind: "store",
    now: at,
    setup,
    request: req,
    options,
    replies,
    calls,
    stream,
    late,
    rows: dump(),
    expected,
  });
}

let ipCounter = 0;
async function route(
  name,
  {
    setup = [],
    route: path_,
    params,
    method = "GET",
    replies = [],
    repeat = 1,
    at = BASE_NOW,
  }
) {
  begin(setup, at);
  ipCounter += 1;
  const ip = `10.7.${ipCounter}.9`;
  const headers = {
    "x-forwarded-for": ip,
    "user-agent": "policy-store-oracle/1.0",
  };
  const calls = [];
  const { used } = stubFetch(replies, calls);
  const stream = [];
  const restore = silence();
  let expected;
  recording = stream;
  try {
    for (let i = 0; i < repeat; i++) {
      const request = new NextRequest(`http://127.0.0.1:3000${path_}`, {
        method,
        headers,
      });
      const response = await ROUTES[path_](request, {
        params: Promise.resolve(params),
      });
      expected = {
        status: response.status,
        type: response.headers.get("content-type"),
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
      };
    }
  } finally {
    recording = null;
    restore();
  }
  if (used() !== replies.length) {
    throw new Error(`${name}: unused replies ${used()}/${replies.length}`);
  }
  cases.push({
    name,
    kind: "route",
    now: at,
    setup,
    route: path_,
    method,
    params,
    headers,
    repeat,
    replies,
    calls,
    stream,
    rows: dump(),
    expected,
  });
}

try {
  // ══ STORE ════════════════════════════════════════════════════════
  await store("no policy url clears the analysis", {
    setup: [app(), analysis()],
    request: { policyUrl: undefined },
  });
  await store("no policy url with nothing stored", {
    setup: [app()],
    request: { policyUrl: "" },
  });

  await store("first capture", {
    setup: [app(), snapshot("snap-1", BASE_NOW - DAY)],
    replies: [plain(V1), AVAIL_NONE, SAVE_OK],
  });
  await store("unchanged rescrape with a summary is a cache hit", {
    setup: [
      app(),
      analysis(),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY),
    ],
    replies: [plain(V1), AVAIL_SNAP, SAVE_OK],
  });
  await store("unchanged rescrape without a summary", {
    setup: [
      app(),
      analysis({
        status: "source_ready",
        summary_json: null,
        analysis_mode: null,
        model: null,
      }),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      // Stored with spacing and a float, as no writer here would: the
      // History row re-serialises the latest snapshot.
      snapshot(
        "snap-1",
        BASE_NOW - DAY,
        '[ {"identifier": "DATA_LINKED_TO_YOU", "weight": 1.0, "categories": [] } ]'
      ),
    ],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("changed text with the toggle off", {
    setup: [
      app(),
      analysis(),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY),
    ],
    replies: [plain(V2), AVAIL_NONE, SAVE_FAIL],
  });
  await store(
    "changed text with the toggle on notifies and posts the immediate webhook",
    {
      setup: [
        app(),
        analysis(),
        version("ver-v1", V1, BASE_NOW - 2 * DAY),
        snapshot("snap-1", BASE_NOW - DAY),
        toggleOn,
        ...webhook("slack"),
      ],
      replies: [plain(V2), AVAIL_NONE, SAVE_OK, WEBHOOK_OK],
    }
  );
  await store("quiet hours hold the notification", {
    setup: [
      app(),
      analysis(),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY),
      toggleOn,
      override("flag.notifications.quiet_hours", "on"),
      setting("notification_quiet_hours_start", "11:00"),
      setting("notification_quiet_hours_end", "13:00"),
    ],
    replies: [plain(V2), AVAIL_NONE, SAVE_FAIL],
  });
  await store("reverting to an older text reuses its version", {
    setup: [
      app(),
      analysis(),
      version("ver-v0", V0, BASE_NOW - 5 * DAY),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY),
    ],
    replies: [plain(V0), AVAIL_NONE, SAVE_FAIL],
  });
  await store("an upgrading install seeds the prior text as a version", {
    setup: [app(), analysis(), snapshot("snap-1", BASE_NOW - DAY)],
    replies: [plain(V2), AVAIL_NONE, SAVE_OK],
  });
  await store("the seeded version falls back to updated_at", {
    setup: [
      app(),
      analysis({ source_fetched_at: null }),
      snapshot("snap-1", BASE_NOW - DAY),
    ],
    replies: [plain(V2), AVAIL_NONE, SAVE_FAIL],
  });
  await store("forceResummarise skips the cache hit", {
    setup: [
      app(),
      analysis(),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY),
    ],
    options: { forceResummarise: true },
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("changed text keeps the older summary chain", {
    setup: [
      app(),
      analysis({
        status: "source_ready",
        summary_json: null,
        previous_summary_json: PREVIOUS_SUMMARY,
        previous_summary_at: BASE_NOW - 9 * DAY,
      }),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
    ],
    replies: [plain(V2), AVAIL_NONE, SAVE_FAIL],
  });
  await store("an html policy behind a redirect", {
    setup: [app()],
    replies: [
      status(302, { location: "https://example.com/legal/privacy" }),
      html(policyPage(V1)),
      AVAIL_NONE,
      SAVE_OK,
    ],
  });
  await store("the archive lookup failing is not an error", {
    setup: [app()],
    replies: [plain(V1), failure("ECONNRESET"), SAVE_OK],
  });
  // The run marker's insert is the first write and the analyses table
  // references apps, so this throws before the try: no activity row, no
  // finally, nothing fetched.
  await store("an app the library does not track throws before any write", {
    setup: [],
  });
  await store("a corrupt latest snapshot loses the History row", {
    setup: [
      app(),
      analysis(),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      snapshot("snap-1", BASE_NOW - DAY, "{not json"),
      toggleOn,
    ],
    replies: [plain(V2), AVAIL_NONE, SAVE_FAIL],
  });

  // Failures.
  await store("a 404 is a fetch error that keeps the last good source", {
    setup: [app(), analysis(), version("ver-v1", V1, BASE_NOW - 2 * DAY)],
    replies: [status(404)],
  });
  await store("a refused url is a plain error", {
    setup: [app()],
    request: { policyUrl: "http://127.0.0.1/privacy" },
  });
  await store("a reset connection names its hint", {
    setup: [app()],
    replies: [failure("socket hang up")],
  });
  await store("an out-of-range entity is a fetch error", {
    setup: [app(), analysis()],
    replies: [html(policyPage(`${V1}\n\nBad &#1114112; entity`))],
  });
  await store("an unusable body keeps the last good hash", {
    setup: [app(), analysis(), version("ver-v1", V1, BASE_NOW - 2 * DAY)],
    replies: [plain("Too short.")],
  });
  await store("an unsupported content type is skipped", {
    setup: [app()],
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4",
      },
    ],
  });

  // The kill-switch.
  await store("the kill-switch stops a first fetch", {
    setup: [app(), setting("policy_scrape_disabled", "true")],
  });
  await store("the kill-switch keeps the stored summary", {
    setup: [app(), analysis(), setting("policy_scrape_disabled", "true")],
  });
  await store("bypassThrottle overrides the kill-switch", {
    setup: [app(), setting("policy_scrape_disabled", "true")],
    options: { bypassThrottle: true },
    replies: [plain(V1), AVAIL_NONE, SAVE_OK],
  });

  // The throttle.
  const recent = (ms, over = {}) =>
    analysis({ source_fetched_at: BASE_NOW - ms, ...over });
  await store("the throttle skips a recent fetch", {
    setup: [app(), recent(10 * MIN)],
  });
  await store("the throttle rounds elapsed and remaining minutes", {
    setup: [app(), recent(90_000)],
  });
  await store("the throttle honours its minutes setting", {
    setup: [
      app(),
      recent(4.5 * MIN),
      setting("policy_scrape_throttle_minutes", "5"),
    ],
  });
  await store("the throttle is off for minutes that are not positive", {
    setup: [
      app(),
      recent(10 * MIN),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      setting("policy_scrape_throttle_minutes", "abc"),
    ],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("the throttle is off when disabled", {
    setup: [
      app(),
      recent(10 * MIN),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
      setting("policy_scrape_throttle_enabled", "false"),
    ],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("the throttle only holds a ready analysis", {
    setup: [
      app(),
      recent(10 * MIN, { status: "source_ready", summary_json: null }),
      version("ver-v1", V1, BASE_NOW - 2 * DAY),
    ],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("an elapsed throttle fetches", {
    setup: [app(), recent(61 * MIN), version("ver-v1", V1, BASE_NOW - 2 * DAY)],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });
  await store("a fetch time in the future does not throttle", {
    setup: [app(), recent(-5 * MIN), version("ver-v1", V1, BASE_NOW - 2 * DAY)],
    replies: [plain(V1), AVAIL_NONE, SAVE_FAIL],
  });

  // What the kill-switch and the throttle return when their write is
  // refused: the row as it stands. Only that upsert names `updated_at`, so
  // the trigger refuses it while the run log's own update lands. Store
  // cases take no forwarded address, so these shift no later case.
  const refuseWrite = sql(
    "CREATE TRIGGER refuse_analysis_write BEFORE UPDATE OF updated_at ON privacy_policy_analyses BEGIN SELECT RAISE(ABORT, 'analysis write refused'); END"
  );
  await store("the kill-switch's refused write returns the row as it stands", {
    setup: [
      app(),
      analysis(),
      setting("policy_scrape_disabled", "true"),
      refuseWrite,
    ],
  });
  await store("the throttle's refused write returns the row as it stands", {
    setup: [app(), recent(10 * MIN), refuseWrite],
  });

  // ══ ROUTES ═══════════════════════════════════════════════════════
  const STATUS = "/api/policy/status/[appId]";
  const VERSION = "/api/policy/version/[id]";
  const DIFF = "/api/policy/version/[id]/diff";
  const MVERSION = "/api/manual-apps/[id]/policy-version/[versionId]";
  const SCRAPE = "/api/manual-apps/[id]/scrape";
  const LOG = JSON.stringify([
    { phase: "fetching", at: BASE_NOW - 5000, note: "Requesting example.com" },
    { phase: "no-at" },
    "not an object",
    { phase: "fetch:direct", at: BASE_NOW - 4000, ms: 1000, error: "x" },
  ]);

  await route("status of an app with no analysis", {
    route: STATUS,
    params: { appId: APP },
  });
  await route("status of a running analysis with its log", {
    setup: [
      app(),
      analysis({
        run_status: "running",
        run_started_at: BASE_NOW - 6000,
        last_run_log: LOG,
      }),
    ],
    route: STATUS,
    params: { appId: APP },
  });
  await route("status of an analysis with no run recorded", {
    setup: [app(), analysis({ run_status: null })],
    route: STATUS,
    params: { appId: ` ${APP} ` },
  });
  await route("status refuses an id that is not digits", {
    route: STATUS,
    params: { appId: "abc" },
  });
  await route("status refuses an id of 21 digits", {
    route: STATUS,
    params: { appId: "1".repeat(21) },
  });

  const archived = { archive_url: SNAP, archive_submitted_at: BASE_NOW - DAY };
  await route("a version with its archive link", {
    setup: [app(), version("ver-v1", V1, BASE_NOW - 2 * DAY, archived)],
    route: VERSION,
    params: { id: "ver-v1" },
  });
  await route("a version with no archive link", {
    setup: [app(), version("ver-v1", V1, BASE_NOW - 2 * DAY)],
    route: VERSION,
    params: { id: "ver-v1" },
  });
  await route("an unknown version", {
    route: VERSION,
    params: { id: "ver-missing" },
  });
  await route("a version id over 128 characters", {
    route: VERSION,
    params: { id: "v".repeat(129) },
  });
  await route("the version read limit", {
    route: VERSION,
    params: { id: "ver-missing" },
    repeat: 121,
  });

  const pair = (before, after, over = {}) => [
    app(),
    version("ver-old", before, BASE_NOW - 3 * DAY),
    version("ver-new", after, BASE_NOW - DAY, over),
  ];
  await route("the diff of a one-word edit", {
    setup: pair("The quick brown fox", "The quick red fox"),
    route: DIFF,
    params: { id: "ver-new" },
  });
  await route("the diff of an edit and an appended line", {
    setup: pair(
      "Title\nIntro\nAlpha\nBeta\nGamma\nDelta",
      "Title\nIntro\nALPHA\nBeta\nGamma\nDelta\nappended"
    ),
    route: DIFF,
    params: { id: "ver-new" },
  });
  await route("the diff of a changed last line", {
    setup: pair(
      "Title\nIntro\nAlpha\nBeta\nGamma\nDelta",
      "Title\r\nIntro\r\nAlpha\r\nBeta\r\nGamma\r\nDELTA"
    ),
    route: DIFF,
    params: { id: "ver-new" },
  });
  await route("the diff is against the latest earlier text", {
    setup: [
      app(),
      version("ver-a", "Alpha one", BASE_NOW - 5 * DAY),
      version("ver-b", "Alpha two", BASE_NOW - 3 * DAY),
      version("ver-c", "Alpha three", BASE_NOW - DAY),
      version("ver-d", "Alpha four", BASE_NOW),
    ],
    route: DIFF,
    params: { id: "ver-c" },
  });
  await route("the diff of a long policy is truncated", {
    setup: pair(
      Array.from({ length: 2001 }, (_, i) => `Clause ${i}`).join("\n"),
      Array.from({ length: 2001 }, (_, i) =>
        i === 1000 ? "Clause changed" : `Clause ${i}`
      ).join("\n")
    ),
    route: DIFF,
    params: { id: "ver-new" },
  });
  await route("the first version has nothing to diff against", {
    setup: pair("Only", "Only too").slice(0, 2),
    route: DIFF,
    params: { id: "ver-old" },
  });
  await route("the diff of an unknown version", {
    route: DIFF,
    params: { id: "ver-missing" },
  });
  await route("the diff refuses an id over 128 characters", {
    route: DIFF,
    params: { id: "v".repeat(129) },
  });
  await route("the diff read limit", {
    route: DIFF,
    params: { id: "ver-missing" },
    repeat: 61,
  });

  await route("a manual app's version", {
    setup: [manualApp(), manualVersion("mver-1", V1, BASE_NOW - DAY)],
    route: MVERSION,
    params: { id: MANUAL, versionId: "mver-1" },
  });
  await route("a manual version asked for under another app", {
    setup: [
      manualApp(),
      manualApp("manual-fixture-2"),
      manualVersion("mver-2", V1, BASE_NOW - DAY, "manual-fixture-2"),
    ],
    route: MVERSION,
    params: { id: MANUAL, versionId: "mver-2" },
  });
  await route("a manual version of an unknown app", {
    route: MVERSION,
    params: { id: "manual-missing", versionId: "mver-1" },
  });
  await route("an unknown manual version", {
    setup: [manualApp()],
    route: MVERSION,
    params: { id: MANUAL, versionId: "mver-missing" },
  });
  await route("a manual version with empty ids", {
    route: MVERSION,
    params: { id: "", versionId: "" },
  });
  await route("the manual read limit", {
    route: MVERSION,
    params: { id: "manual-missing", versionId: "mver-1" },
    repeat: 121,
  });

  await route("a manual app's first scrape", {
    setup: [manualApp()],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
    replies: [plain(V1)],
  });
  await route("a manual rescrape of the same text", {
    setup: [manualApp(), manualVersion("mver-1", V1, BASE_NOW - DAY)],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
    replies: [plain(V1)],
  });
  await route("a manual rescrape of changed text", {
    setup: [manualApp(), manualVersion("mver-1", V1, BASE_NOW - DAY)],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
    replies: [html(policyPage(V2))],
  });
  await route("a manual scrape of an unusable page", {
    setup: [manualApp()],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
    replies: [plain("Too short.")],
  });
  await route("a manual scrape that fails to fetch", {
    setup: [manualApp()],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
    replies: [status(404)],
  });
  await route("a manual scrape of a refused url", {
    setup: [manualApp(MANUAL, "http://127.0.0.1/privacy")],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
  });
  await route("a manual app with no policy url", {
    setup: [manualApp(MANUAL, null)],
    route: SCRAPE,
    method: "POST",
    params: { id: MANUAL },
  });
  await route("a manual scrape of an unknown app", {
    route: SCRAPE,
    method: "POST",
    params: { id: "manual-missing" },
  });
  await route("a manual scrape id over 128 characters", {
    route: SCRAPE,
    method: "POST",
    params: { id: "m".repeat(129) },
  });
  await route("the manual scrape limit", {
    route: SCRAPE,
    method: "POST",
    params: { id: "manual-missing" },
    repeat: 11,
  });

  // ══ Appended: a skip is logged as one ════════════════════════════
  // After every other case, so none of their recordings move. The
  // kill-switch hands back a stored fetch error with its own `disabled`
  // line last, and the activity row is told by that line: a skip, not a
  // fresh "Fetch failed" at error status.
  await store("the kill-switch over a stored fetch error is a skip", {
    setup: [
      app(),
      analysis({ status: "fetch_error", error: "HTTP 404 Not Found" }),
      setting("policy_scrape_disabled", "true"),
    ],
  });

  // ══ JSON.parse ═══════════════════════════════════════════════════
  // The History row parses the latest snapshot with JSON.parse, and a
  // failure lands in the run log in V8's own words (the corrupt-snapshot
  // case above). Batch 3's summariser parses every provider reply the same
  // way and stores the message, so the engine's reporting is pinned here
  // on its own: every message kind, the three context shapes, line and
  // column after each newline style, and UTF-16 positions. Valid inputs
  // record their re-serialisation.
  const JSON_INPUTS = [
    "[]",
    '{"a":[1,2,{"b":null}],"c":"d"}',
    ' \n\t {"x": "y"} \r\n',
    "-0",
    "1e5",
    "[1.50, 2e-7, 1E+2, -12.5e-1]",
    '"\\u00e9\\n\\/\\ud83d\\ude00"',
    "null",
    "",
    "   ",
    "[",
    '{"a":',
    "[1,",
    "tru",
    "fals",
    '"abc',
    "-",
    "1.",
    "1e",
    "1e+",
    // An explicit expectation wins over "end of input".
    "{",
    '{"a"',
    "[1",
    '{"a":1',
    '"abc\\',
    "[1,]",
    "]",
    "{1:2}",
    '{"a":1,}',
    '{"a" "b"}',
    '{"a":1 "b":2}',
    "[1 2]",
    '{"a"}',
    "{,}",
    "01",
    "-a",
    "1.a",
    "1ex",
    "trux",
    "nul",
    "nulx",
    '"a\\x"',
    '"\\u12x4"',
    '"\\u12',
    '"a\tb"',
    '"a\u0001"',
    '"\\é"',
    '"\\€"',
    "1 2",
    "{} x",
    "undefined",
    "NaN",
    "Infinity",
    "[object Object]",
    "{not json",
    "abc",
    "x23456789012345678901234567890",
    "[1111111111111111, x, 2222222222222222]",
    "[1111111111111111111111, x",
    '{\n"a": 1,\n"b" 2}',
    '{\r\n"a":\r\n x}',
    '{\r"a"\r:\r?}',
    '["😀😀", x]',
    '["é", x]',
    "[é]",
    "\uFEFF[]",
    "Here is the summary you asked for: {}",
    '```json\n{"overview": "x"}\n```',
  ];
  const json = JSON_INPUTS.map((input) => {
    try {
      return {
        input,
        ok: true,
        stringified: JSON.stringify(JSON.parse(input)),
      };
    } catch (error) {
      return { input, ok: false, error: error.message };
    }
  });

  const text = `${JSON.stringify({ cases, json }, null, 2)}\n`;
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
    new URL("../tests/fixtures/policy-store-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.filter((c) => c.kind === "store").length} store and ${cases.filter((c) => c.kind === "route").length} route cases from the real Node policy store; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
