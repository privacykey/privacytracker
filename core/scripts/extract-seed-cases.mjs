/**
 * Seed oracle for the Rust server (Phase 4, batch 5d).
 *
 * Runs the REAL handler of `POST /api/dev/seed-sample-data` — the canned
 * demo set and the live top-charts walk — against a scratch database and
 * records, per case, the request, the setup rows, every raw fetch (URL and
 * headers), every write in order with its transaction markers, the tables
 * a seed can touch, and the wire response.
 *
 * It also writes `core/src/server/sample_apps.json`: the demo set itself
 * (`SAMPLE_APPS`), the accessibility catalogue its features resolve
 * against, and the lens order and lens sentences its summaries are built
 * from. That file is DATA the core embeds, as `flag_rules.json` is; what
 * the route does with it is ported by hand and held by the cases here.
 *
 * The network is a stub, as in the imports oracle: each case lists its
 * replies in the order the handler will ask for them, and a case that
 * leaves one unused is a design error the run refuses. Every App Store
 * page served here has NO privacy-policy link. The live walk scrapes with
 * `summarizePolicies` on, and for an app with no policy link that step is
 * one DELETE, which the core runs too; for an app WITH one it is the
 * policy pipeline — fetch, hash, summarise — which is Phase 5 and is not
 * pinned by this oracle.
 *
 * Determinism as before: frozen clock (so `durationMs` is 0 and the
 * 250 ms spacer between live apps is real time the recording never sees),
 * counted ids, foreign keys ON, a distinct forwarded address per case,
 * the soft pacers reset per case, `repeat` for the limit+1 burst.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-seed-oracle-"));
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

const now = Date.UTC(2026, 8, 15, 12, 34, 56, 789);
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

const { _resetSoftBuckets } = await import("../../lib/rate-limit.ts");
const ROUTE = "/api/dev/seed-sample-data";
const handler = (await import("../../app/api/dev/seed-sample-data/route.ts"))
  .POST;
const { SAMPLE_APPS, SAMPLE_LENS_NOTE_BY_RATING } = await import(
  "../../lib/sample-apps.ts"
);
const { POLICY_LENSES } = await import("../../lib/policy-summary-meta.ts");
const { CANONICAL_ACCESSIBILITY_FEATURES } = await import(
  "../../lib/accessibility-types.ts"
);

// ── The data table the core embeds ───────────────────────────────────
const dataOut = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "src",
  "server",
  "sample_apps.json"
);
writeFileSync(
  dataOut,
  `${JSON.stringify(
    {
      lensOrder: POLICY_LENSES.map((lens) => lens.key),
      lensNotes: SAMPLE_LENS_NOTE_BY_RATING,
      accessibility: CANONICAL_ACCESSIBILITY_FEATURES.map((f) => ({
        identifier: f.identifier,
        title: f.title,
        fallbackDescription: f.fallbackDescription,
        iconTemplate: f.iconTemplate,
      })),
      apps: SAMPLE_APPS.map((s) => ({
        id: s.id,
        name: s.name,
        developer: s.developer,
        hasPrivacyDetails: s.hasPrivacyDetails,
        hasAccessibilityLabels: s.hasAccessibilityLabels,
        accessibilityFeatures: s.accessibilityFeatures ?? null,
        privacyTypes: s.privacyTypes,
        aiSummary: s.aiSummary,
        aiSummaryPrevious: s.aiSummaryPrevious ?? null,
        history: (s.history ?? []).map((step) => ({
          daysAgo: step.daysAgo,
          privacyTypes: step.privacyTypes,
          version: step.version ?? null,
          waybackUrl: step.waybackUrl ?? null,
        })),
      })),
    },
    null,
    2
  )}\n`
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
  "accessibility_features",
  "related_apps_observed",
  "privacy_snapshots",
  "privacy_policy_analyses",
  "privacy_policy_versions",
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
// Held for the whole run, as in the imports oracle: a successful scrape
// arms a deferred policy fetch on a real timer, and with the runner's
// mutex held that timer finds it busy and writes nothing.
const POLICY_LOCK = setting("policy_sync_running", "true");
db.prepare(POLICY_LOCK.sql).run(...POLICY_LOCK.params);

const DAY = 86_400_000;
const storeUrl = (id, country = "au") =>
  `https://apps.apple.com/${country}/app/fixture/id${id}`;
const app = (id, name = `App ${id}`) =>
  stmt(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
    id,
    name,
    storeUrl(id),
    now - 5 * DAY,
    now - 5 * DAY
  );
const privacyType = (id, appId) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    appId,
    "DATA_LINKED_TO_YOU",
    "Data Linked to You"
  );

// The canned set's ids, as the route derives them.
const syntheticIdFor = (slug) => {
  const hash = nodeCrypto.createHash("sha1").update(slug).digest("hex");
  const numeric = Number.parseInt(hash.slice(0, 6), 16) % 9_000_000;
  return `9${String(numeric).padStart(7, "0")}`;
};
const CANNED_IDS = SAMPLE_APPS.map((s) => syntheticIdFor(s.id));

// ── Pages and replies ────────────────────────────────────────────────
const cat = (identifier, title) => ({ identifier, title });
const type = (identifier, title, categories) => ({
  identifier,
  title,
  detail: `${title} detail`,
  categories,
});
const CONTACT = cat("CONTACT_INFO", "Contact Info");
const LOCATION = cat("LOCATION", "Location");
const IDENTIFIERS = cat("IDENTIFIERS", "Identifiers");
const USAGE = cat("USAGE_DATA", "Usage Data");
const linked = (...cats) =>
  type("DATA_LINKED_TO_YOU", "Data Linked to You", cats);
const tracking = (...cats) =>
  type("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", cats);
// No privacy-policy link on any page: see the header.
const page = (name, types) => {
  const blob = JSON.stringify({
    data: [
      {
        data: { title: name, shelfMapping: { privacyTypes: { items: types } } },
      },
    ],
    userTokenHash: "fixture",
  });
  return `<!doctype html><html><head><meta property="og:title" content="${name} on the App Store"><meta property="og:image" content="https://example.com/icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script></head><body><script id="serialized-server-data" type="application/json">${blob}</script></body></html>`;
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
      currency: "AUD",
      formattedPrice: "Free",
      primaryGenreId: 6002,
      primaryGenreName: "Utilities",
      contentAdvisoryRating: "4+",
    },
  ],
});
// A scrape is the page and then the version lookup.
const scrapeOf = (name, types) => [html(page(name, types)), LOOKUP];
const entry = (id, name, over = {}) => ({
  id: {
    label: over.url ?? `${storeUrl(id, over.country)}?uo=2`,
    attributes: { "im:id": over.imId ?? id },
  },
  "im:name": { label: name },
  "im:artist": { label: "Fixture Dev" },
});
const rss = (entries) => json({ feed: { entry: entries } });

// ── The runner ───────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
const cases = [];
let ipCounter = 0;
// The route's guard is the strict one: an admin token has to be
// CONFIGURED (403 otherwise) and presented (401 otherwise), loopback or
// not. So every case runs with one configured and sent, except the three
// that are about exactly that.
const TOKEN = "seed-oracle-token";
async function run(name, spec = {}) {
  const {
    search = "",
    headers = {},
    setup: extraSetup = [],
    replies = [],
    adminToken = TOKEN,
    presented = TOKEN,
    repeat = 1,
  } = spec;
  const setup = [POLICY_LOCK, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.5`;
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "seed-oracle/1.0",
    ...(presented ? { "x-auditor-admin-token": presented } : {}),
    ...headers,
  };
  const calls = [];
  let cursor = 0;
  globalThis.fetch = async (target, init) => {
    calls.push({
      url: String(target),
      headers: [...new Headers(init?.headers)],
    });
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
  db.exec("SAVEPOINT seed_case");
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
        `http://127.0.0.1:3000${ROUTE}${search}`,
        {
          method: "POST",
          headers: sent,
        }
      );
      for (const k of quiet) {
        console[k] = () => {};
      }
      try {
        const response = await handler(request);
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
    recording = null;
    if (cursor !== replies.length) {
      throw new Error(
        `${name}: unused replies ${cursor}/${replies.length} ${JSON.stringify(calls.map((c) => c.url))}`
      );
    }
    const rows = {};
    for (const table of TABLES) {
      rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    cases.push({
      name,
      route: ROUTE,
      method: "POST",
      param: null,
      search,
      query: [...new URLSearchParams(search)],
      headers: sent,
      body: null,
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
    db.exec("ROLLBACK TO seed_case; RELEASE seed_case");
  }
}

// The id the canned seed will mint for its FIRST privacy type, found by
// running it once and looking: a row already holding that id is how a
// case makes the seed fail part-way, inside its transaction.
async function firstCannedTypeId() {
  db.exec("SAVEPOINT seed_probe");
  try {
    idCounter = 0;
    _resetSoftBuckets();
    const saved = quiet.map((k) => [k, console[k]]);
    for (const k of quiet) {
      console[k] = () => {};
    }
    let response;
    process.env.AUDITOR_ADMIN_TOKEN = TOKEN;
    try {
      response = await handler(
        new NextRequest(`http://127.0.0.1:3000${ROUTE}?source=canned`, {
          method: "POST",
          headers: {
            "x-forwarded-for": "10.250.0.5",
            "x-auditor-admin-token": TOKEN,
          },
        })
      );
    } finally {
      for (const [k, fn] of saved) {
        console[k] = fn;
      }
    }
    const first = db
      .prepare("SELECT id FROM privacy_types ORDER BY rowid LIMIT 1")
      .get();
    if (!first) {
      throw new Error(
        `the probe seed wrote no privacy type: HTTP ${response.status} ${await response.text()}`
      );
    }
    return first.id;
  } finally {
    db.exec("ROLLBACK TO seed_probe; RELEASE seed_probe");
  }
}

try {
  // ── the canned set ───────────────────────────────────────────────
  await run("canned onto an empty install", { search: "?source=canned" });
  await run("canned twice is all skipped the second time", {
    search: "?source=canned",
    repeat: 2,
  });
  await run("canned tops up what is missing", {
    search: "?source=canned",
    setup: [app(CANNED_IDS[0], "Already here"), app(CANNED_IDS[4], "And this")],
  });
  await run("canned ignores country and limit but reports the region", {
    search: "?source=canned&country=GB&limit=2",
  });
  await run("canned reports a stored region", {
    search: "?source=canned",
    setup: [setting("app_country", " nz ")],
  });
  await run("canned reports the default for a blank stored region", {
    search: "?source=canned",
    setup: [setting("app_country", "   ")],
  });
  await run("canned reports an unknown stored region as the system default", {
    search: "?source=canned",
    setup: [setting("app_country", "zz")],
  });
  {
    const taken = await firstCannedTypeId();
    await run("canned fails part-way and rolls back", {
      search: "?source=canned",
      setup: [app("4242", "Bystander"), privacyType(taken, "4242")],
    });
  }
  await run("source is canned only when spelled so", {
    search: "?source=CANNED",
    replies: [rss([])],
  });

  // ── the guard ────────────────────────────────────────────────────
  await run("refused when no admin token is configured", {
    search: "?source=canned",
    adminToken: null,
    presented: null,
  });
  await run("refused when no admin token is configured, even if one is sent", {
    search: "?source=canned",
    adminToken: null,
  });
  await run("refused without the admin token", {
    search: "?source=canned",
    presented: null,
  });
  await run("refused with the wrong admin token", {
    search: "?source=canned",
    presented: "not-the-token",
  });
  await run("the thirty-first seed in ten minutes is refused", {
    search: "?source=canned",
    setup: CANNED_IDS.map((id) => app(id)),
    repeat: 31,
  });

  // ── the live walk: the chart request ─────────────────────────────
  await run("live asks for ten of the default region", {
    replies: [rss([])],
  });
  await run("live limit from the query", {
    search: "?limit=3",
    replies: [rss([])],
  });
  await run("live limit is capped at twenty-five", {
    search: "?limit=99",
    replies: [rss([])],
  });
  await run("live limit of zero is the default", {
    search: "?limit=0",
    replies: [rss([])],
  });
  await run("live negative limit is the default", {
    search: "?limit=-4",
    replies: [rss([])],
  });
  await run("live limit that is not a number is the default", {
    search: "?limit=abc",
    replies: [rss([])],
  });
  await run("live limit is read the way parseInt reads it", {
    search: "?limit=7.9apps",
    replies: [rss([])],
  });
  await run("live region from the query", {
    search: "?country=GB",
    replies: [rss([])],
  });
  await run("live unknown region from the query", {
    search: "?country=zz",
    replies: [rss([])],
  });
  await run("live empty region in the query falls to the setting", {
    search: "?country=",
    setup: [setting("app_country", "ca")],
    replies: [rss([])],
  });
  await run("live region from the setting", {
    setup: [setting("app_country", "JP")],
    replies: [rss([])],
  });

  // ── the live walk: what the chart can answer ─────────────────────
  await run("live chart rate limited with a retry-after", {
    replies: [status(429, { "retry-after": "30" })],
  });
  await run("live chart rate limited with no retry-after", {
    replies: [status(429)],
  });
  await run("live chart rate limited with a retry-after that is not a number", {
    replies: [status(429, { "retry-after": "soon" })],
  });
  await run("live chart rate limited with a retry-after of zero", {
    replies: [status(429, { "retry-after": "0" })],
  });
  await run("live chart rate limited with a fractional retry-after", {
    replies: [status(429, { "retry-after": "1.5" })],
  });
  await run("live chart answers 503", { replies: [status(503)] });
  await run("live chart answers 404 for the region", {
    search: "?country=nz",
    replies: [status(404)],
  });
  await run("live chart is not json", {
    replies: [json("<html>not json</html>")],
  });
  await run("live chart has no feed", { replies: [json({})] });
  await run("live chart feed has no entries", {
    replies: [json({ feed: {} })],
  });
  await run("live chart request fails", {
    replies: [{ error: "connect ECONNREFUSED 127.0.0.1:443" }],
  });
  await run("live chart entries without an id or a link are dropped", {
    replies: [
      rss([
        { "im:name": { label: "No id at all" } },
        { id: { label: storeUrl("7001") }, "im:name": { label: "No im:id" } },
        {
          id: { attributes: { "im:id": "7002" } },
          "im:name": { label: "No link" },
        },
      ]),
    ],
  });

  // ── the live walk: the apps ──────────────────────────────────────
  await run("live seeds two apps with back-dated history", {
    replies: [
      rss([entry("7101", "Chart One"), entry("7102", "Chart Two")]),
      ...scrapeOf("Chart One", [
        linked(CONTACT, LOCATION, IDENTIFIERS),
        tracking(USAGE),
      ]),
      ...scrapeOf("Chart Two", [linked(CONTACT, LOCATION)]),
    ],
  });
  await run("live app with one category per type gets no history", {
    replies: [
      rss([entry("7103", "Single")]),
      ...scrapeOf("Single", [linked(CONTACT), tracking(USAGE)]),
    ],
  });
  await run("live history trims only the first type, down to nothing", {
    replies: [
      rss([entry("7104", "Second Is Bigger")]),
      ...scrapeOf("Second Is Bigger", [
        linked(CONTACT),
        tracking(USAGE, LOCATION, IDENTIFIERS),
      ]),
    ],
  });
  await run("live app with no labels gets no history", {
    replies: [rss([entry("7105", "No Labels")]), ...scrapeOf("No Labels", [])],
  });
  await run("live skips an app already tracked", {
    setup: [app("7106", "Tracked")],
    replies: [
      rss([entry("7106", "Tracked"), entry("7107", "Fresh")]),
      ...scrapeOf("Fresh", [linked(CONTACT, LOCATION)]),
    ],
  });
  await run("live with every app already tracked fetches only the chart", {
    setup: [app("7108"), app("7109")],
    replies: [rss([entry("7108", "One"), entry("7109", "Two")])],
  });
  await run("live chart id that differs from the link's id", {
    replies: [
      rss([entry("7110", "Mismatch", { imId: "7999" })]),
      ...scrapeOf("Mismatch", [linked(CONTACT, LOCATION)]),
    ],
  });
  await run("live app page answers 404 and the walk carries on", {
    replies: [
      rss([entry("7111", "Gone"), entry("7112", "Still Here")]),
      status(404),
      ...scrapeOf("Still Here", [linked(CONTACT, LOCATION)]),
    ],
  });
  await run(
    "live link that is not the App Store is refused and the walk carries on",
    {
      replies: [
        rss([
          entry("7113", "Elsewhere", {
            url: "https://evil.example/app/id7113",
          }),
          entry("7114", "Fine"),
        ]),
        ...scrapeOf("Fine", [linked(CONTACT, LOCATION)]),
      ],
    }
  );
  await run("live stops at Apple's rate limit and keeps what it has", {
    replies: [
      rss([
        entry("7115", "First"),
        entry("7116", "Throttled"),
        entry("7117", "Never Reached"),
      ]),
      ...scrapeOf("First", [linked(CONTACT, LOCATION)]),
      status(429, { "retry-after": "45" }),
    ],
  });
  await run("live stops at once during a scrape cooldown", {
    setup: [
      setting("rate_limit_scrape_until", String(now + 90_000)),
      setting("rate_limit_scrape_reason", "HTTP 429 from App Store HTML"),
    ],
    replies: [rss([entry("7118", "Cooling")])],
  });
  await run("live page that cannot be parsed is an error row", {
    replies: [
      rss([entry("7119", "Garbled")]),
      html("<html><body>nothing here</body></html>"),
    ],
  });
  await run("live in another region", {
    search: "?country=gb&limit=2",
    replies: [
      rss([
        entry("7120", "British", { country: "gb" }),
        entry("7121", "Also British", { country: "gb" }),
      ]),
      ...scrapeOf("British", [linked(CONTACT, LOCATION)]),
      ...scrapeOf("Also British", [linked(CONTACT)]),
    ],
  });
  // The feed is XML converted to JSON: a chart of ONE app carries its
  // entry as a bare object, not a one-element array. This is what Apple
  // really answers to `limit=1`, and it used to be a 502.
  await run("live chart of one app carries it as an object", {
    search: "?limit=1",
    replies: [
      json({ feed: { entry: entry("7122", "Only One") } }),
      ...scrapeOf("Only One", [linked(CONTACT, LOCATION)]),
    ],
  });
  await run("live chart of one app, already tracked", {
    search: "?limit=1",
    setup: [app("7123", "Only And Tracked")],
    replies: [json({ feed: { entry: entry("7123", "Only And Tracked") } })],
  });
  await run("live chart entry that is a string is no entries", {
    replies: [json({ feed: { entry: "not an entry" } })],
  });
  await run("live chart entry that is a number is no entries", {
    replies: [json({ feed: { entry: 7 } })],
  });
  await run("live chart entry that is null is no entries", {
    replies: [json({ feed: { entry: null } })],
  });
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "tests",
  "fixtures",
  "seed-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
console.log(`wrote the sample-app table to ${dataOut}`);
process.exit(0);
