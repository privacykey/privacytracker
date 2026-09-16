/**
 * Search oracle for the Rust scraper (Phase 3, batch 3b).
 *
 * Runs the REAL `searchAppsByName` and `lookupAppsByBundleId` from
 * lib/scraper.ts with the raw `fetch` stubbed by recorded iTunes replies —
 * never the network — and records, per case: every raw fetch (URL and the
 * headers set), every write (the search cooldown a 429 records), the
 * app_settings rows afterwards, and the batch object returned. Neither
 * function throws: a failing query or chunk collapses to empty candidates
 * or null matches, which is what the cases pin.
 *
 * Same determinism as the other scrape oracles: frozen clock, TZ=UTC,
 * inline bulk write. The empty-result retry sleeps 1.2 s for real.
 */
process.env.TZ = "UTC";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-search-oracle-"));
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

const { default: db } = await import("../../lib/db.ts");
let recording = null;
const realPrepare = db.prepare.bind(db);
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
const { lookupAppsByBundleId, searchAppsByName } = await import(
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

// ── Replies ──────────────────────────────────────────────────────────
const itunes = (results, status = 200, headers = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({
    resultCount: Array.isArray(results) ? results.length : 0,
    results,
  }),
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const raw = (body, code = 200) => ({
  status: code,
  headers: { "content-type": "application/json" },
  body,
});
const app = (n, over = {}) => ({
  trackId: 90_000_100 + n,
  trackName: `App ${n}`,
  artistName: `Dev ${n}`,
  artworkUrl100: `https://example.com/${n}/100x100bb.png`,
  trackViewUrl: `https://apps.apple.com/us/app/app-${n}/id${90_000_100 + n}?uo=4`,
  bundleId: `com.example.app${n}`,
  contentAdvisoryRating: "4+",
  ...over,
});

// ── Driver ───────────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
async function drive({ kind, input, options, replies }) {
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
  for (const k of quiet) {
    console[k] = () => {};
  }
  let result;
  try {
    result =
      kind === "search"
        ? await searchAppsByName(input, options ?? {})
        : await lookupAppsByBundleId(input, options ?? {});
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
  if (cursor !== replies.length) {
    throw new Error(`Unused replies: ${cursor}/${replies.length}`);
  }
  return { calls, result };
}

const cases = [];
const sql = (text, ...params) => ({ sql: text, params });
const setting = (key, value) =>
  sql(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
async function run(name, { setup = [], ...main }) {
  wipe();
  _resetSoftBuckets();
  now += 61_000;
  for (const step of setup) {
    db.prepare(step.sql).run(...step.params);
  }
  const stream = [];
  recording = stream;
  const { calls, result } = await drive(main);
  recording = null;
  cases.push({
    name,
    now,
    setup,
    kind: main.kind,
    input: main.input,
    options: main.options ?? {},
    replies: main.replies,
    calls,
    stream,
    settings: db.prepare("SELECT * FROM app_settings ORDER BY rowid").all(),
    // JSON round trip: `undefined` fields vanish exactly as they do on the wire.
    expected: JSON.parse(JSON.stringify(result)),
  });
}

try {
  // ── searchAppsByName ──
  await run("search maps candidates", {
    kind: "search",
    input: ["Clock", { name: "Weather" }],
    replies: [
      itunes([
        app(1),
        app(2, {
          artworkUrl100: undefined,
          trackViewUrl: "https://apps.apple.com/us/app/two/id2",
          contentAdvisoryRating: undefined,
          trackContentRating: "12+",
        }),
        app(3, {
          trackName: undefined,
          bundleId: null,
          contentAdvisoryRating: null,
          trackContentRating: null,
          trackId: "3",
        }),
      ]),
      itunes([
        app(4, {
          artworkUrl100: "https://example.com/4/100x100bb.png?100x100bb=again",
        }),
      ]),
    ],
  });
  await run("developer hint reorders candidates", {
    kind: "search",
    input: [{ name: "Notes", developer: "Acme Labs" }],
    replies: [
      itunes([
        app(1, { artistName: "Other Co" }),
        app(2, { artistName: "acme labs" }),
        app(3, { artistName: "Acme Labs Inc" }),
        app(4, { artistName: "Labs of Acme" }),
        app(5, { artistName: "Zed" }),
        app(6, { artistName: undefined }),
        app(7, { artistName: "Acme Labs" }),
      ]),
    ],
  });
  await run(
    "developer hint with one candidate and with a non-string developer",
    {
      kind: "search",
      input: [
        { name: "One", developer: "Acme" },
        { name: "Bad", developer: "Acme" },
      ],
      replies: [
        itunes([app(1, { artistName: "Someone Else" })]),
        itunes([app(2, { artistName: 42 }), app(3)]),
      ],
    }
  );
  await run("query normalisation", {
    kind: "search",
    input: [
      "  Clock  ",
      "",
      "   ",
      42,
      null,
      { name: "Weather", developer: "  " },
      { name: 5 },
      { name: " Mail ", developer: " Apple " },
    ],
    replies: [
      itunes([app(1)]),
      itunes([app(2)]),
      itunes([app(3, { artistName: "Apple" }), app(4)]),
    ],
  });
  await run("search country from option", {
    kind: "search",
    setup: [setting("app_country", "au")],
    input: ["Clock"],
    options: { country: "GB" },
    replies: [itunes([app(1)])],
  });
  await run("search country from setting", {
    kind: "search",
    setup: [setting("app_country", "au")],
    input: ["Clock"],
    replies: [itunes([app(1)])],
  });
  await run("empty results retried once", {
    kind: "search",
    input: ["Rare"],
    replies: [itunes([]), itunes([app(1)])],
  });
  await run("empty results twice", {
    kind: "search",
    input: ["Rarer", "After"],
    replies: [itunes([]), itunes([]), itunes([app(2)])],
  });
  await run("empty results then rate limited on retry", {
    kind: "search",
    input: ["First", "Rare", "Third"],
    replies: [
      itunes([app(1)]),
      itunes([]),
      status(429, { "retry-after": "45" }),
    ],
  });
  await run("rate limited on the first query", {
    kind: "search",
    input: ["A", { name: "B", developer: "Dev" }],
    replies: [status(429, { "retry-after": "120" })],
  });
  await run("rate limited on the second query", {
    kind: "search",
    input: ["A", "B", "C"],
    replies: [itunes([app(1)]), status(429)],
  });
  await run("retry-after at the cap falls back", {
    kind: "search",
    input: ["A"],
    replies: [status(429, { "retry-after": "600" })],
  });
  await run("retry-after junk falls back", {
    kind: "search",
    input: ["A"],
    replies: [status(429, { "retry-after": "soon" })],
  });
  await run("search cooldown active", {
    kind: "search",
    setup: [
      setting(
        "rate_limit_search_until",
        String(Date.UTC(2026, 8, 15, 12) + 61_000 * 14 + 30_000)
      ),
    ],
    input: ["A", "B"],
    replies: [],
  });
  await run("per-query failures are isolated", {
    kind: "search",
    input: ["Five", "Json", "Missing", "Str", "Null", "Art", "Net", "Fine"],
    replies: [
      status(500),
      raw("{not json"),
      // `{}` reads as zero results, which retries once.
      raw("{}"),
      raw("{}"),
      raw(JSON.stringify({ results: "abc" })),
      itunes([null, app(1)]),
      itunes([app(2, { artworkUrl100: 7 })]),
      { error: "fetch failed" },
      itunes([app(3)]),
    ],
  });
  await run("search terms are uri-encoded", {
    kind: "search",
    input: ["Hello World", "A&B=C", "café ☕", "it's (ok)*!~", "日本語"],
    replies: [
      itunes([app(1)]),
      itunes([app(2)]),
      itunes([app(3)]),
      itunes([app(4)]),
      itunes([app(5)]),
    ],
  });

  // ── lookupAppsByBundleId ──
  await run("lookup matches in input order", {
    kind: "lookup",
    input: ["com.b", "Com.A.App", "com.missing"],
    replies: [
      itunes([
        app(1, { bundleId: "com.a.app" }),
        app(2, { bundleId: "com.b" }),
      ]),
    ],
  });
  await run("lookup dedupes and trims", {
    kind: "lookup",
    input: ["com.x", " com.x ", "", 7, null, "com.y", "COM.X"],
    replies: [
      itunes([app(1, { bundleId: "com.x" }), app(2, { bundleId: "com.y" })]),
    ],
  });
  await run("lookup empty input", {
    kind: "lookup",
    input: ["", "  ", 3],
    replies: [],
  });
  await run("lookup rate limited", {
    kind: "lookup",
    input: ["com.a", "com.b"],
    replies: [status(429, { "retry-after": "30" })],
  });
  await run("lookup rate limited without retry-after", {
    kind: "lookup",
    input: ["com.a"],
    replies: [status(429)],
  });
  await run("lookup cooldown active", {
    kind: "lookup",
    setup: [
      setting(
        "rate_limit_search_until",
        String(Date.UTC(2026, 8, 15, 12) + 61_000 * 22 + 30_000)
      ),
    ],
    input: ["com.a", "com.b"],
    replies: [],
  });
  await run("lookup non-ok chunk", {
    kind: "lookup",
    input: ["com.a", "com.b"],
    replies: [status(500)],
  });
  await run("lookup 503 splits the chunk", {
    kind: "lookup",
    input: ["com.a", "com.b", "com.c", "com.d", "com.e", "com.f"],
    replies: [
      status(503),
      itunes([app(1, { bundleId: "com.a" }), app(3, { bundleId: "com.c" })]),
      itunes([app(5, { bundleId: "com.e" })]),
    ],
  });
  await run("lookup 503 split then rate limited", {
    kind: "lookup",
    input: ["com.a", "com.b", "com.c"],
    replies: [
      status(503),
      itunes([app(1, { bundleId: "com.a" })]),
      status(429, { "retry-after": "20" }),
    ],
  });
  await run("lookup 503 with a single id", {
    kind: "lookup",
    input: ["com.a"],
    replies: [status(503)],
  });
  await run("lookup invalid json and non-array results", {
    kind: "lookup",
    input: ["com.a"],
    replies: [raw("{not json")],
  });
  await run("lookup results not an array", {
    kind: "lookup",
    input: ["com.a"],
    replies: [raw(JSON.stringify({ results: "abc" }))],
  });
  await run("lookup 150 ids in two chunks", {
    kind: "lookup",
    input: Array.from(
      { length: 150 },
      (_, i) => `com.example.chunked.app${i + 1}`
    ),
    replies: [
      itunes([
        app(1, { bundleId: "com.example.chunked.app1" }),
        app(100, { bundleId: "com.example.chunked.app100" }),
      ]),
      itunes([app(150, { bundleId: "com.example.chunked.app150" })]),
    ],
  });
  await run("lookup reply quirks", {
    kind: "lookup",
    input: ["com.dup", "com.nostring"],
    replies: [
      itunes([
        app(1, { bundleId: "com.dup", trackName: "First" }),
        app(2, { bundleId: "com.dup", trackName: "Last" }),
        app(3, { bundleId: 7 }),
        app(4, { bundleId: "" }),
        app(5, {
          bundleId: "com.nostring",
          artworkUrl100: undefined,
          trackViewUrl: undefined,
          contentAdvisoryRating: undefined,
          trackContentRating: undefined,
        }),
      ]),
    ],
  });
  await run("lookup country from option and setting", {
    kind: "lookup",
    setup: [setting("app_country", "nz")],
    input: ["com.a"],
    options: { country: " De " },
    replies: [itunes([app(1, { bundleId: "com.a" })])],
  });

  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  writeFileSync(
    new URL("../tests/fixtures/search-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} actual Node search and bundle-lookup cases; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
