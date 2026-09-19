/**
 * Policy-trigger oracle for the Rust core (Phase 5, batch 4b).
 *
 * The two ways Node starts policy work on its own:
 *
 * - `fetchAndParseApp(url, resync, summarizePolicies = true)`: after the
 *   scrape commits, the app's policy goes through
 *   `syncPrivacyPolicyAnalysis`. `POST /api/scrape` asks for it with
 *   `summarizePolicies: true`, and the dev seed's live walk always does.
 * - `schedulePostAppUpdatePolicyFetch` (lib/post-app-update-policy-fetch.ts):
 *   a successful scrape without that flag, an import that brought apps in,
 *   and a bulk App Store sync that synced any, each ask for one deferred
 *   fetch-only policy run. The requests coalesce behind a two-second
 *   timer; the drain skips while scraping is off, waits (five minutes, at
 *   most three times) while another policy run holds the lock, then runs
 *   `runBulkPolicySync` as `automatic`.
 *
 * Each case is a list of steps through the REAL route handlers — the
 * scrape, the import completion, the sync trigger and the seed — with
 * `drain` steps that run the deferred queue now, through the module's own
 * `__drainForTests`, instead of on its timer, and `sql` steps that change
 * the database between them (not recorded). Recorded per case: each
 * response, every raw fetch, every write in order, what Save Page Now's
 * held replies write after the case, and nine tables.
 *
 * Determinism: counted ids and nonces, a frozen clock (the scrape paths
 * read the time once per request), the network canned per case, and the
 * deferred queue emptied at the end of every case with scraping switched
 * off, so no timer or retry count carries into the next.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-policy-triggers-oracle-"));
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

const now = Date.UTC(2026, 8, 15, 12);
const DAY = 86_400_000;
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
nodeCrypto.randomBytes = (size, ...rest) => {
  if (size === 15) {
    return Buffer.from(String(++idCounter).padStart(20, "0"), "base64url");
  }
  if (size === 9) {
    return Buffer.from(String(++idCounter).padStart(12, "0"), "base64url");
  }
  return realRandomBytes(size, ...rest);
};
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

// createNotification's webhook fan-out imports this lazily; warm it so the
// import resolves in the same few ticks in every case.
await import("../../lib/notification-webhooks.ts");
const { _resetSoftBuckets } = await import("../../lib/rate-limit.ts");
const { __drainForTests } = await import(
  "../../lib/post-app-update-policy-fetch.ts"
);
const ROUTES = {
  "/api/scrape": (await import("../../app/api/scrape/route.ts")).POST,
  "/api/imports/complete": (
    await import("../../app/api/imports/complete/route.ts")
  ).POST,
  "/api/sync/trigger": (await import("../../app/api/sync/trigger/route.ts"))
    .POST,
  "/api/dev/seed-sample-data": (
    await import("../../app/api/dev/seed-sample-data/route.ts")
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
  db.pragma("foreign_keys = ON");
};
const DUMPED = [
  "apps",
  "privacy_policy_analyses",
  "privacy_policy_versions",
  "privacy_snapshots",
  "notifications",
  "activity_log",
  "audit_log",
  "imports",
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

// ── Setup rows ───────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const storeUrl = (id, country = "us") =>
  `https://apps.apple.com/${country}/app/fixture/id${id}`;
const A = "3000000001";
const B = "3000000002";
const POLICY = (id) => `https://policy-${id}.example/privacy`;
const app = (id, name, policyUrl = null) =>
  stmt(
    "INSERT INTO apps (id, name, url, developer, privacyPolicyUrl, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)",
    id,
    name,
    storeUrl(id),
    "Fixture Dev",
    policyUrl,
    now - 5 * DAY,
    now - 5 * DAY
  );
const importRow = (id, extra = {}) =>
  stmt(
    "INSERT INTO imports (id, created_at, completed_at, source, source_label, total, matched, unmatched, imported, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    extra.createdAt ?? now - DAY,
    null,
    "manual",
    null,
    extra.total ?? 1,
    0,
    0,
    0,
    null
  );
const item = (id, importId, query, status, appId = null) =>
  stmt(
    "INSERT INTO import_items (id, import_id, query, edited_query, status, app_id, app_name, developer, url, icon_url, country, scrape_error, removed_app_id, next_attempt_at, attempt_count) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)",
    id,
    importId,
    query,
    status,
    appId
  );
const LOCK = setting("policy_sync_running", "true");
const UNLOCK = setting("policy_sync_running", "false");
const DISABLED = setting("policy_scrape_disabled", "true");

// ── Pages and replies ────────────────────────────────────────────────
const LINKED = {
  identifier: "DATA_LINKED_TO_YOU",
  title: "Data Linked to You",
  detail: "Data Linked to You detail",
  categories: [{ identifier: "CONTACT_INFO", title: "Contact Info" }],
};
// An App Store page, with the developer's policy link when given.
const page = (name, policyUrl) => {
  const blob = JSON.stringify({
    data: [
      {
        data: {
          title: name,
          shelfMapping: { privacyTypes: { items: [LINKED] } },
        },
      },
    ],
    userTokenHash: "fixture",
  });
  const link = policyUrl
    ? `<a aria-label="Developer's Privacy Policy" href="${policyUrl}">Privacy Policy</a>`
    : "";
  return `<!doctype html><html><head><meta property="og:title" content="${name} on the App Store"><meta property="og:image" content="https://example.com/icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script></head><body>${link}<script id="serialized-server-data" type="application/json">${blob}</script></body></html>`;
};
const html = (body) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});
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
const scrapeOf = (name, policyUrl) => [html(page(name, policyUrl)), LOOKUP];
const SENTENCES = [
  "We collect personal information such as your name, email address and device identifiers when you create an account.",
  "We use your information to provide, operate and improve the service and to personalize your experience.",
  "We share information with service providers and partners who process it on our behalf.",
  "We use cookies and analytics tools to understand how the app is used.",
  "You may request access to or deletion of your personal information at any time.",
  "We retain your information for as long as necessary to provide the service.",
];
const policyText = (tag) =>
  Array.from(
    { length: 30 },
    (_, i) => `${SENTENCES[i % SENTENCES.length]} Section ${i + 1} ${tag}.`
  ).join("\n\n");
// A policy page that lands: the text, the archive lookup, Save Page Now.
const policyOf = (id) => [
  plain(policyText(id)),
  json({ url: POLICY(id), archived_snapshots: {} }),
  {
    status: 302,
    headers: {
      location: `https://web.archive.org/web/20260915120005/${POLICY(id)}`,
    },
    body: "",
  },
];
const chartEntry = (id, name) => ({
  id: {
    label: `${storeUrl(id, "au")}?uo=2`,
    attributes: { "im:id": id },
  },
  "im:name": { label: name },
  "im:artist": { label: "Fixture Dev" },
});
const rss = (entries) => json({ feed: { entry: entries } });

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
    if (url.startsWith("https://web.archive.org/save/")) {
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

const cases = [];
let ipCounter = 0;
const TOKEN = "triggers-oracle-token";
async function run(name, { setup = [], steps, replies = [] }) {
  wipe();
  idCounter = 0;
  recording = null;
  _resetSoftBuckets();
  for (const s of setup) {
    db.prepare(s.sql).run(...s.params);
  }
  ipCounter += 1;
  const headers = {
    "x-forwarded-for": `10.6.${ipCounter}.2`,
    "user-agent": "policy-triggers-oracle/1.0",
    "content-type": "application/json",
  };
  const calls = [];
  const { held, missing, used } = stubFetch(replies, calls);
  const stream = [];
  const late = [];
  const wires = [];
  let rows = null;
  const restore = silence();
  try {
    for (const step of steps) {
      if (step.sql) {
        recording = null;
        for (const s of step.sql) {
          db.prepare(s.sql).run(...s.params);
        }
        continue;
      }
      recording = stream;
      if (step.drain) {
        await __drainForTests();
        continue;
      }
      if (step.adminToken) {
        process.env.AUDITOR_ADMIN_TOKEN = step.adminToken;
      } else {
        delete process.env.AUDITOR_ADMIN_TOKEN;
      }
      const request = new NextRequest(
        `http://127.0.0.1:3000${step.route}${step.search ?? ""}`,
        {
          method: "POST",
          headers: {
            ...headers,
            ...(step.adminToken
              ? { "x-auditor-admin-token": step.adminToken }
              : {}),
          },
          body: step.json === undefined ? undefined : JSON.stringify(step.json),
        }
      );
      try {
        const response = await ROUTES[step.route](request);
        wires.push({
          status: response.status,
          type: response.headers.get("content-type"),
          body: await response.text(),
        });
      } catch (error) {
        wires.push({
          status: 500,
          type: null,
          body: "",
          thrown: String(error?.message ?? error),
        });
      }
    }
    recording = late;
    await settle();
    for (const release of held.splice(0)) {
      release();
    }
    await settle();
    recording = null;
    rows = dump();
  } finally {
    // Empty the deferred queue with scraping off: no timer and no retry
    // count survives into the next case, and nothing is recorded.
    recording = null;
    db.prepare(DISABLED.sql).run(...DISABLED.params);
    await __drainForTests();
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
    now,
    setup,
    headers,
    steps,
    replies,
    calls,
    stream,
    late,
    rows,
    wires,
  });
}

try {
  const scrape = (json) => ({ route: "/api/scrape", json });
  const DRAIN = { drain: true };

  // ══ summarizePolicies: the policy after the scrape ════════════════
  await run("scrape with the policy: a page with a link", {
    steps: [scrape({ urls: [storeUrl(A)], summarizePolicies: true })],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A)), ...policyOf(A)],
  });
  await run("scrape with the policy: a page with no link", {
    setup: [
      app(A, "Alpha Fixture", POLICY(A)),
      stmt(
        "INSERT INTO privacy_policy_analyses (app_id, policy_url, status, source_word_count, updated_at) VALUES (?, ?, 'ready', 0, ?)",
        A,
        POLICY(A),
        now - DAY
      ),
    ],
    steps: [scrape({ urls: [storeUrl(A)], summarizePolicies: true })],
    replies: [...scrapeOf("Alpha Fixture", null)],
  });
  await run("scrape with the policy: the policy page fails", {
    steps: [scrape({ urls: [storeUrl(A)], summarizePolicies: true })],
    replies: [
      ...scrapeOf("Alpha Fixture", POLICY(A)),
      { status: 404, headers: { "content-type": "text/html" }, body: "gone" },
    ],
  });
  await run("scrape with the policy: two apps in turn", {
    steps: [
      scrape({ urls: [storeUrl(A), storeUrl(B)], summarizePolicies: true }),
    ],
    replies: [
      ...scrapeOf("Alpha Fixture", POLICY(A)),
      ...policyOf(A),
      ...scrapeOf("Bravo Fixture", POLICY(B)),
      ...policyOf(B),
    ],
  });
  await run("scrape with the policy: the scrape fails", {
    steps: [scrape({ urls: [storeUrl(A)], summarizePolicies: true })],
    replies: [{ status: 404, headers: {}, body: "" }],
  });

  // ══ The deferred fetch: who asks for it ════════════════════════════
  await run("a scrape asks for the deferred fetch", {
    steps: [scrape({ urls: [storeUrl(A)] }), DRAIN],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A)), ...policyOf(A)],
  });
  await run("a resync asks for it too", {
    setup: [app(A, "Alpha Fixture", POLICY(A))],
    steps: [scrape({ urls: [storeUrl(A)], resync: true }), DRAIN],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A)), ...policyOf(A)],
  });
  await run("a failed scrape does not ask", {
    steps: [scrape({ urls: [storeUrl(A)] }), DRAIN],
    replies: [{ status: 404, headers: {}, body: "" }],
  });
  await run("a scrape with the policy does not ask", {
    steps: [scrape({ urls: [storeUrl(A)], summarizePolicies: true }), DRAIN],
    replies: [...scrapeOf("Alpha Fixture", null)],
  });
  await run("an import that brought apps in asks", {
    setup: [
      app(A, "Alpha Fixture", POLICY(A)),
      importRow("imp_fixture_a"),
      item("iti_fixture_1", "imp_fixture_a", "Alpha", "imported", A),
    ],
    steps: [
      { route: "/api/imports/complete", json: { importId: "imp_fixture_a" } },
      DRAIN,
    ],
    replies: [...policyOf(A)],
  });
  await run("an import with nothing imported does not ask", {
    setup: [
      importRow("imp_fixture_a"),
      item("iti_fixture_1", "imp_fixture_a", "Alpha", "unmatched"),
    ],
    steps: [
      { route: "/api/imports/complete", json: { importId: "imp_fixture_a" } },
      DRAIN,
    ],
  });
  await run("a bulk sync that synced an app asks", {
    setup: [app(A, "Alpha Fixture", POLICY(A))],
    steps: [{ route: "/api/sync/trigger" }, DRAIN],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A)), ...policyOf(A)],
  });
  await run("requests coalesce into one run", {
    steps: [
      scrape({ urls: [storeUrl(A)] }),
      scrape({ urls: [storeUrl(B)], resync: true }),
      DRAIN,
      DRAIN,
    ],
    replies: [
      ...scrapeOf("Alpha Fixture", POLICY(A)),
      ...scrapeOf("Bravo Fixture", POLICY(B)),
      ...policyOf(A),
      ...policyOf(B),
    ],
  });

  // ══ The deferred fetch: what the drain decides ═════════════════════
  await run("the drain skips while scraping is off", {
    steps: [scrape({ urls: [storeUrl(A)] }), { sql: [DISABLED] }, DRAIN],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A))],
  });
  await run("the drain waits for a busy run, then runs", {
    steps: [
      scrape({ urls: [storeUrl(A)] }),
      { sql: [LOCK] },
      DRAIN,
      { sql: [UNLOCK] },
      DRAIN,
    ],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A)), ...policyOf(A)],
  });
  await run("the drain gives up after three waits", {
    steps: [
      scrape({ urls: [storeUrl(A)] }),
      { sql: [LOCK] },
      DRAIN,
      DRAIN,
      DRAIN,
      DRAIN,
      { sql: [UNLOCK] },
      DRAIN,
    ],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A))],
  });
  await run("a busy wait still takes a new request", {
    steps: [
      scrape({ urls: [storeUrl(A)] }),
      { sql: [LOCK] },
      DRAIN,
      DRAIN,
      DRAIN,
      scrape({ urls: [storeUrl(B)] }),
      DRAIN,
      { sql: [UNLOCK] },
      DRAIN,
    ],
    replies: [
      ...scrapeOf("Alpha Fixture", POLICY(A)),
      ...scrapeOf("Bravo Fixture", POLICY(B)),
    ],
  });
  await run("a leftover blob keeps the drain waiting", {
    steps: [
      scrape({ urls: [storeUrl(A)] }),
      {
        sql: [
          setting(
            "policy_bulk_state",
            JSON.stringify({
              version: 1,
              runId: "run-fixture-9",
              startedAt: now - DAY,
              initiator: "manual",
              updatedAt: now - DAY,
              phase: "fetch",
              force: false,
              currentAppId: null,
              queue: [],
              totals: {
                attempted: 0,
                succeeded: 0,
                failed: 0,
                throttled: 0,
                skipped: 0,
              },
              streamRequested: false,
            })
          ),
        ],
      },
      DRAIN,
    ],
    replies: [...scrapeOf("Alpha Fixture", POLICY(A))],
  });

  // ══ The dev seed's live walk ═══════════════════════════════════════
  await run("the live seed summarises each new app's policy", {
    steps: [
      {
        route: "/api/dev/seed-sample-data",
        search: "?limit=1",
        adminToken: TOKEN,
      },
    ],
    replies: [
      rss([chartEntry(A, "Alpha Fixture")]),
      ...scrapeOf("Alpha Fixture", POLICY(A)),
      ...policyOf(A),
    ],
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
  writeFileSync(
    new URL("../tests/fixtures/policy-triggers-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} trigger cases from the real Node routes; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
