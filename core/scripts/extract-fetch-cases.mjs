/**
 * Fetch oracle for the Rust scraper (Phase 3, batch 3).
 *
 * Runs the REAL `fetchAndParseApp` (and `scrapeInitialUrls`) with the raw
 * `fetch` stubbed by recorded replies — never the network — and records,
 * per case: every raw fetch Node made (URL and the headers it set), every
 * write in order with transaction markers, every touched table, and the
 * return value or error. That covers the fetch layer the persist oracle
 * bypassed: URL refusal, the scrape cooldown short-circuit, Apple's
 * rate-limit signal (429 and 403) with Retry-After in its three spellings
 * and the cooldown it records, non-OK statuses, transport failures,
 * redirects through safeFetch, and the iTunes lookup's mapping and misses.
 *
 * The Rust replay feeds the same replies to the same transport loop (the
 * outbound module's hop abstraction), so redirects and size caps are
 * exercised for real on both sides. Same determinism as the persist
 * oracle: frozen clock, TZ=UTC, inline bulk write, counted ids.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-fetch-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;

let now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};
let idPrefix = "00000000-0000-4000-8000-";
let idCounter = 0;
const nextId = () => `${idPrefix}${String(++idCounter).padStart(12, "0")}`;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: nextId,
  configurable: true,
  writable: true,
});
nodeCrypto.randomUUID = nextId;

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

const { fetchAndParseApp, scrapeInitialUrls } = await import(
  "../../lib/scraper.ts"
);
const { _resetSoftBuckets } = await import("../../lib/rate-limit.ts");
db.pragma("foreign_keys = OFF");
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()
  .map((r) => r.name);
const wipe = () => {
  for (const name of tables) {
    db.exec(`DELETE FROM "${name}"`);
  }
};
const DUMPED = [
  "apps",
  "privacy_types",
  "privacy_categories",
  "accessibility_features",
  "related_apps_observed",
  "privacy_snapshots",
  "notifications",
  "activity_log",
  "app_settings",
];
const dump = () =>
  Object.fromEntries(
    DUMPED.map((t) => {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
      return [
        t,
        rows.length > 100
          ? { count: rows.length, head: rows.slice(0, 3), tail: rows.slice(-3) }
          : rows,
      ];
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
const TRACKING = type("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
  cat("LOCATION", "Location"),
]);
const page = ({ name, types = [LINKED], script = true }) => {
  const blob = JSON.stringify({
    data: [
      {
        data: { title: name, shelfMapping: { privacyTypes: { items: types } } },
      },
    ],
    userTokenHash: "fixture",
  });
  return `<!doctype html><html><head><meta property="og:title" content="${name} on the App Store"><meta property="og:image" content="https://example.com/icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script></head><body><a aria-label="Developer's Privacy Policy" href="https://example.com/privacy">Privacy Policy</a>${script ? `<script id="serialized-server-data" type="application/json">${blob}</script>` : ""}</body></html>`;
};
const lookupBody = (over = {}) =>
  JSON.stringify({
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
        ...over,
      },
    ],
  });
const html = (body, headers = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});
const json = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body,
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const LOOKUP = json(lookupBody());
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;

// ── Driver ───────────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
function stubFetch(replies, calls) {
  let cursor = 0;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: [...new Headers(init?.headers)],
    });
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply for ${String(input)}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  return () => {
    if (cursor !== replies.length) {
      throw new Error(`Unused replies: ${cursor}/${replies.length}`);
    }
  };
}
async function drive({ batch, url: target, resync = false, trigger, replies }) {
  const calls = [];
  const check = stubFetch(replies, calls);
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  let expected;
  try {
    if (batch) {
      const results = await scrapeInitialUrls(
        batch.urls,
        batch.resync ?? false,
        false,
        batch.options ?? {}
      );
      expected = { ok: true, results };
    } else {
      const args =
        trigger === undefined
          ? [target, resync, false]
          : [target, resync, false, trigger];
      const result = await fetchAndParseApp(...args);
      expected = { ok: true, result };
    }
  } catch (error) {
    expected = { ok: false, error: error.message };
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
  check();
  return { calls, expected };
}

const cases = [];
async function run(name, { setup = [], at, ...main }) {
  wipe();
  _resetSoftBuckets();
  now = at ?? now + 61_000;
  idPrefix = "11111111-1111-4111-8111-";
  idCounter = 0;
  const setupStream = [];
  recording = setupStream;
  for (const step of setup) {
    if (step.sql) {
      db.prepare(step.sql).run(...(step.params ?? []));
    } else {
      const outcome = await drive(step.scrape);
      if (!outcome.expected.ok) {
        throw new Error(
          `setup scrape failed in ${name}: ${outcome.expected.error}`
        );
      }
      now += 61_000;
    }
  }
  recording = null;
  idPrefix = "00000000-0000-4000-8000-";
  idCounter = 0;
  const stream = [];
  recording = stream;
  const { calls, expected } = await drive(main);
  recording = null;
  const resync = main.resync ?? false;
  cases.push({
    name,
    now,
    setup: setupStream.filter(
      (s) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(s.sql)
    ),
    ...(main.batch
      ? { batch: main.batch }
      : {
          url: main.url,
          resync,
          trigger: main.trigger ?? (resync ? "manual" : "import"),
        }),
    replies: main.replies,
    calls,
    stream,
    rows: dump(),
    expected,
  });
}
const sql = (text, ...params) => ({ sql: text, params });
const setting = (key, value) =>
  sql(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );

try {
  const A = 1584215688;
  const clock = html(page({ name: "Clock", types: [TRACKING, LINKED] }));

  // 1. The happy path through the fetch layer: page then lookup.
  await run("page and lookup", { url: url(A), replies: [clock, LOOKUP] });

  // 2–4. The lookup's storefront comes from the country setting.
  await run("country setting normalised", {
    setup: [setting("app_country", " GB ")],
    url: url(A),
    replies: [clock, LOOKUP],
  });
  await run("country setting invalid falls back", {
    setup: [setting("app_country", "zz")],
    url: url(A),
    replies: [clock, LOOKUP],
  });
  await run("country setting alpha-3 sliced", {
    setup: [setting("app_country", "aus")],
    url: url(A),
    replies: [clock, LOOKUP],
  });

  // 5–7. The scrape cooldown short-circuits before any fetch.
  await run("cooldown active short-circuits", {
    setup: [
      setting(
        "rate_limit_scrape_until",
        String(Date.UTC(2026, 8, 15, 12, 0, 0) + 61_000 * 5 + 30_000)
      ),
      setting("rate_limit_scrape_reason", "earlier 429"),
    ],
    at: Date.UTC(2026, 8, 15, 12, 0, 0) + 61_000 * 5,
    url: url(A),
    replies: [],
  });
  await run("cooldown expired proceeds", {
    setup: [
      setting(
        "rate_limit_scrape_until",
        String(Date.UTC(2026, 8, 15, 12, 0, 0) + 61_000 * 6 - 1)
      ),
    ],
    at: Date.UTC(2026, 8, 15, 12, 0, 0) + 61_000 * 6,
    url: url(A),
    replies: [clock, LOOKUP],
  });
  await run("cooldown setting garbage proceeds", {
    setup: [setting("rate_limit_scrape_until", "abc")],
    url: url(A),
    replies: [clock, LOOKUP],
  });

  // 8–13. Apple's rate-limit signal and the cooldown it records.
  await run("429 with retry-after seconds", {
    url: url(A),
    replies: [status(429, { "retry-after": "120" })],
  });
  await run("429 without retry-after", { url: url(A), replies: [status(429)] });
  await run("403 is a rate limit", {
    url: url(A),
    replies: [status(403, { "retry-after": "5" })],
  });
  await run("retry-after as http date", {
    at: Date.UTC(2026, 8, 15, 13, 0, 0),
    url: url(A),
    replies: [
      status(429, {
        "retry-after": new RealDate(
          Date.UTC(2026, 8, 15, 13, 0, 0) + 90_000
        ).toUTCString(),
      }),
    ],
  });
  await run("retry-after past the cap", {
    url: url(A),
    replies: [status(429, { "retry-after": "3600" })],
  });
  await run("retry-after zero falls back", {
    url: url(A),
    replies: [status(429, { "retry-after": "0" })],
  });
  await run("retry-after junk falls back", {
    url: url(A),
    replies: [status(429, { "retry-after": "soon" })],
  });
  await run("existing negative cooldown is kept in the max", {
    setup: [setting("rate_limit_scrape_until", "-5")],
    url: url(A),
    replies: [status(429, { "retry-after": "10" })],
  });

  // 14–17. Other statuses and transport failures.
  await run("404 not found", { url: url(A), replies: [status(404)] });
  await run("500 upstream", { url: url(A), replies: [status(503)] });
  await run("network failure", {
    url: url(A),
    replies: [{ error: "fetch failed" }],
  });
  await run("timeout", {
    url: url(A),
    replies: [{ error: "The operation was aborted due to timeout" }],
  });

  // 18–21. Redirects through safeFetch.
  await run("redirect followed same origin", {
    url: url(A),
    replies: [status(301, { location: `/us/app/clock/id${A}` }), clock, LOOKUP],
  });
  await run("redirect followed cross origin allowed host", {
    url: url(A),
    replies: [
      status(302, { location: `https://itunes.apple.com/us/app/clock/id${A}` }),
      clock,
      LOOKUP,
    ],
  });
  await run("redirect rejected host", {
    url: url(A),
    replies: [status(302, { location: "https://evil.example/id1" })],
  });
  await run("too many redirects", {
    url: url(A),
    replies: Array.from({ length: 6 }, (_, i) =>
      status(301, { location: `/hop/${i}/id${A}` })
    ),
  });
  await run("redirect without location is the response", {
    url: url(A),
    replies: [status(300)],
  });

  // 22. A declared content-length past the cap is refused before reading.
  await run("declared content-length past the cap", {
    url: url(A),
    replies: [html(page({ name: "Clock" }), { "content-length": "5000000" })],
  });

  // 23–27. The lookup's misses and its field mapping.
  await run("lookup non-ok", {
    url: url(A),
    replies: [clock, json("{}", 500)],
  });
  await run("lookup invalid json", {
    url: url(A),
    replies: [clock, json("{not json")],
  });
  await run("lookup empty results", {
    url: url(A),
    replies: [clock, json(JSON.stringify({ resultCount: 0, results: [] }))],
  });
  await run("lookup network error", {
    url: url(A),
    replies: [clock, { error: "fetch failed" }],
  });
  await run("lookup field coercions", {
    url: url(A),
    replies: [
      clock,
      json(
        lookupBody({
          version: "  2.1 ",
          currentVersionReleaseDate: "not a date",
          releaseNotes: "   ",
          price: "1.99",
          currency: "",
          formattedPrice: 7,
          primaryGenreId: "6002",
          primaryGenreName: " Games ",
          contentAdvisoryRating: undefined,
          trackContentRating: " 17+ ",
        })
      ),
    ],
  });
  await run("lookup results not an array", {
    url: url(A),
    replies: [clock, json(JSON.stringify({ results: "abc" }))],
  });

  // 28–29. Refused URLs never reach the activity boundary.
  await run("refused host", {
    url: "https://evil.example/us/app/x/id1",
    replies: [],
  });
  await run("refused missing id segment", {
    url: "https://apps.apple.com/us/app/no-id",
    replies: [],
  });

  // 30. A re-sync through the fetch layer composes with the persist path.
  await run("resync through fetch", {
    setup: [
      {
        scrape: {
          url: url(2001),
          replies: [html(page({ name: "Diff", types: [LINKED] })), LOOKUP],
        },
      },
    ],
    url: url(2001),
    resync: true,
    replies: [
      html(page({ name: "Diff", types: [LINKED, TRACKING] })),
      json(lookupBody({ version: "2.0.0" })),
    ],
  });

  // 31–32. scrapeInitialUrls: stop on the first rate limit, or carry on.
  await run("initial urls stop on rate limit", {
    batch: { urls: [url(3001), url(3002), url(3003)] },
    replies: [
      html(page({ name: "First" })),
      LOOKUP,
      status(429, { "retry-after": "30" }),
    ],
  });
  // A 429 also starts the cooldown, so every URL after it short-circuits
  // without a fetch even when the loop is told to continue.
  await run("initial urls continue past errors until a rate limit", {
    batch: {
      urls: [url(3001), url(3002), url(3003), url(3004), url(3005)],
      options: { stopOnRateLimit: false },
    },
    replies: [
      { error: "fetch failed" },
      html(page({ name: "Broken", script: false })),
      html(page({ name: "Third" })),
      LOOKUP,
      status(429),
    ],
  });

  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  const stray = text
    .match(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
    )
    ?.filter(
      (u) => !/^(00000000-0000-4000-8000|11111111-1111-4111-8111)-/.test(u)
    );
  if (stray?.length) {
    throw new Error(
      `non-deterministic ids leaked into the fixture: ${stray.slice(0, 3).join(", ")}`
    );
  }
  writeFileSync(
    new URL("../tests/fixtures/fetch-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} actual Node fetch cases from fetchAndParseApp and scrapeInitialUrls; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
