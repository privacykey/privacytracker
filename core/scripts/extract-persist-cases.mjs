/**
 * Persist oracle for the Rust scraper (Phase 3, batch 2).
 *
 * Runs the REAL `fetchAndParseApp` from lib/scraper.ts — the whole thing,
 * from the (stubbed) fetch to the committed rows and the notifications
 * that follow — and records every write it makes, in order: each
 * statement's SQL and bound parameters, plus BEGIN/COMMIT/ROLLBACK markers
 * around the bulk write's transaction. Then it dumps every touched table.
 * The Rust `scrape::persist` must reproduce the stream, the rows and the
 * result object (or the error) for each case.
 *
 * Determinism: the clock is frozen per case (`now`), TZ is UTC for the
 * quiet-hours and date-formatting paths, the bulk write is held inline
 * (`WORKER_DISABLED=1`), and `crypto.randomUUID` is replaced by a counter
 * so snapshot, notification and activity ids are stable — the Rust side
 * takes an id source and mints the same sequence.
 *
 * Setup for a case is either raw SQL or an earlier scrape; either way the
 * statements it actually ran are recorded as `setup`, and Rust replays
 * them verbatim before the recorded scrape.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-persist-oracle-"));
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

// Deterministic ids. lib/scraper.ts and lib/activity.ts reach the global
// `crypto`; lib/notifications.ts imports the `node:crypto` module. Both are
// pointed at the same counter, with a distinct prefix for setup ids so a
// setup snapshot can never collide with the recorded scrape's.
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

// Record every write. `db.prepare` is wrapped so the statement it returns
// records each `.run`; `db.transaction` is wrapped to mark the boundary.
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

const { fetchAndParseApp } = await import("../../lib/scraper.ts");
// The soft pacer is in-memory; the hard cooldown only exists after a 429,
// which no case triggers, so nothing here touches app_settings.
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
  "feature_flag_overrides",
];
/**
 * Every row of every touched table in rowid order — except that a table
 * holding more than 100 rows (the two retention cases seed thousands) is
 * digested to its count plus its first and last three rows, which is
 * enough to pin which rows a prune removed. The Rust replay applies the
 * same digest.
 */
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

// ── Lookup replies and the VersionInfo Node derives from them ────────
const lookupReply = ({
  version = "1.0.0",
  released = "2026-01-02T03:04:05Z",
  notes = "Fixture release notes",
  price = 0,
  currency = "USD",
  formatted = "Free",
  genreId = 6002,
  genreName = "Utilities",
  ageRating = "4+",
} = {}) => ({
  resultCount: 1,
  results: [
    {
      version,
      currentVersionReleaseDate: released,
      releaseNotes: notes,
      price,
      currency,
      formattedPrice: formatted,
      primaryGenreId: genreId,
      primaryGenreName: genreName,
      contentAdvisoryRating: ageRating,
    },
  ],
});
/** `fetchVersionInfo`'s mapping of a successful reply — the Rust input. */
const versionInfoOf = (reply) => {
  const e = reply.results[0];
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const parsed =
    typeof e.currentVersionReleaseDate === "string"
      ? RealDate.parse(e.currentVersionReleaseDate)
      : Number.NaN;
  return {
    ageRating: str(e.contentAdvisoryRating ?? e.trackContentRating),
    currentVersion: str(e.version),
    genreId: num(e.primaryGenreId),
    genreName: str(e.primaryGenreName),
    priceAmount: num(e.price),
    priceCurrency: str(e.currency),
    priceFormatted: str(e.formattedPrice),
    versionUpdatedAt: Number.isNaN(parsed) ? null : parsed,
    whatsNew: str(e.releaseNotes),
  };
};

// ── Page builder ─────────────────────────────────────────────────────
const cat = (identifier, title) => ({ identifier, title });
const type = (identifier, title, categories, detail = `${title} detail`) => ({
  identifier,
  title,
  detail,
  categories,
});
const feature = (title, description = `${title} description`) => ({
  title,
  description,
  artwork: { template: `systemimage://${title.toLowerCase()}` },
});
const related = (n) => ({
  id: 90_000_100 + n,
  name: `Related ${n}`,
  url: `https://apps.apple.com/us/app/related-${n}/id${90_000_100 + n}`,
  artistName: `Dev ${n}`,
  artwork: { url: `https://example.com/${n}/{w}x{h}bb.png` },
});
const LINKED = type("DATA_LINKED_TO_YOU", "Data Linked to You", [
  cat("CONTACT_INFO", "Contact Info"),
]);
const NOT_LINKED = type("DATA_NOT_LINKED_TO_YOU", "Data Not Linked to You", [
  cat("DIAGNOSTICS", "Diagnostics"),
]);
const TRACKING = type("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
  cat("LOCATION", "Location"),
]);
/**
 * `types: null` omits the shelf (undecidable page). `accessibility:
 * undefined` omits the header (Node: null, keep rows); `null` gives the
 * header alone (Node: [], wipe rows); an array is the rich shelf.
 */
const page = ({
  name,
  types = [LINKED],
  accessibility,
  relatedApps,
  extra = "",
  script = true,
}) => {
  const shelfMapping = {};
  if (types) {
    shelfMapping.privacyTypes = { items: types };
  }
  if (accessibility === null) {
    shelfMapping.accessibilityHeader = {};
  } else if (accessibility) {
    shelfMapping.accessibilityHeader = {
      seeAllAction: {
        pageData: {
          shelves: [
            {
              contentType: "accessibilityFeatures",
              items: [{ features: accessibility }],
            },
          ],
        },
      },
    };
  }
  if (relatedApps) {
    shelfMapping.customersAlsoBoughtApps = { items: relatedApps };
  }
  const blob = JSON.stringify({
    data: [{ data: { title: name, shelfMapping } }],
    userTokenHash: "fixture",
  });
  return `<!doctype html><html><head><meta property="og:title" content="${name} on the App Store"><meta property="og:image" content="https://example.com/icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script></head><body>${extra}<a aria-label="Developer's Privacy Policy" href="https://example.com/privacy">Privacy Policy</a>${script ? `<script id="serialized-server-data" type="application/json">${blob}</script>` : ""}</body></html>`;
};
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;

// ── Scrape driver ────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
async function scrape({
  url: target,
  html,
  lookup = lookupReply(),
  resync = false,
  trigger,
}) {
  globalThis.fetch = async (input) => {
    const requested = String(input);
    if (requested === target) {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (requested.startsWith("https://itunes.apple.com/lookup?")) {
      return new Response(JSON.stringify(lookup), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${requested}`);
  };
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  try {
    const args =
      trigger === undefined
        ? [target, resync, false]
        : [target, resync, false, trigger];
    const result = await fetchAndParseApp(...args);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
}

const cases = [];
/**
 * `setup` steps run first, unrecorded except for what they write: a step is
 * `{ sql, params }` or `{ scrape: {...} }`. The main scrape is then run with
 * recording on, at clock `at` (default: 61 s after the previous case).
 */
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
      const outcome = await scrape(step.scrape);
      if (!outcome.ok) {
        throw new Error(`setup scrape failed in ${name}: ${outcome.error}`);
      }
      now += 61_000;
    }
  }
  recording = null;
  idPrefix = "00000000-0000-4000-8000-";
  idCounter = 0;
  const stream = [];
  recording = stream;
  const outcome = await scrape(main);
  recording = null;
  cases.push({
    name,
    now,
    setup: setupStream.filter(
      (s) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(s.sql)
    ),
    url: main.url,
    html: main.html,
    resync: main.resync ?? false,
    trigger: main.trigger ?? (main.resync ? "manual" : "import"),
    version: versionInfoOf(main.lookup ?? lookupReply()),
    stream,
    rows: dump(),
    expected: outcome,
  });
}
const sql = (text, ...params) => ({ sql: text, params });
const flagOn = (key) =>
  sql(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, 'user', NULL, 0)",
    key,
    "on",
    1_700_000_000_000
  );
const setting = (key, value) =>
  sql(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );

try {
  const A = 1584215688;
  const full = page({
    name: "Clock",
    types: [TRACKING, LINKED, NOT_LINKED],
    accessibility: [feature("VoiceOver"), feature("Captions")],
    relatedApps: [related(1), related(2)],
  });

  // 1. A new app: the INSERT path, the initial snapshot, "New app added".
  await run("new app", { url: url(A), html: full });

  // 2. Re-sync with nothing changed: the UPDATE path, no bump, no bell.
  await run("resync unchanged", {
    setup: [{ scrape: { url: url(A), html: full } }],
    url: url(A),
    html: full,
    resync: true,
  });

  // 3. Re-sync with label changes: an added type and an added category.
  const before = page({ name: "Diff", types: [LINKED, NOT_LINKED] });
  const after = page({
    name: "Diff",
    types: [
      type("DATA_LINKED_TO_YOU", "Data Linked to You", [
        cat("CONTACT_INFO", "Contact Info"),
        cat("LOCATION", "Location"),
      ]),
      NOT_LINKED,
      TRACKING,
    ],
  });
  await run("resync label changes", {
    setup: [{ scrape: { url: url(2001), html: before } }],
    url: url(2001),
    html: after,
    resync: true,
  });

  // 4. Exactly one change: the singular summary.
  await run("resync one change", {
    setup: [
      {
        scrape: {
          url: url(2002),
          html: page({ name: "One", types: [LINKED] }),
        },
      },
    ],
    url: url(2002),
    html: page({ name: "One", types: [LINKED, NOT_LINKED] }),
    resync: true,
  });

  // 5. Accessibility changes only: one added, one removed.
  await run("resync accessibility changes", {
    setup: [
      {
        scrape: {
          url: url(2003),
          html: page({
            name: "Access",
            accessibility: [feature("VoiceOver"), feature("Zoom")],
          }),
        },
      },
    ],
    url: url(2003),
    html: page({
      name: "Access",
      accessibility: [feature("VoiceOver"), feature("Captions")],
    }),
    resync: true,
  });

  // 6. No accessibility header on re-sync: null, rows kept, flag kept.
  await run("resync accessibility null keeps rows", {
    setup: [
      {
        scrape: {
          url: url(2004),
          html: page({ name: "Keep", accessibility: [feature("VoiceOver")] }),
        },
      },
    ],
    url: url(2004),
    html: page({ name: "Keep" }),
    resync: true,
  });

  // 7. Header alone on re-sync: empty list, rows wiped, every feature "removed".
  await run("resync accessibility empty wipes rows", {
    setup: [
      {
        scrape: {
          url: url(2005),
          html: page({
            name: "Wipe",
            accessibility: [feature("VoiceOver"), feature("Captions")],
          }),
        },
      },
    ],
    url: url(2005),
    html: page({ name: "Wipe", accessibility: null }),
    resync: true,
  });

  // 8. Version update with no label changes: the version bell, the snapshot's
  //    version stamp, the "Version updated" summary, en-AU date in the text.
  await run("version update", {
    setup: [{ scrape: { url: url(2006), html: page({ name: "Versioned" }) } }],
    url: url(2006),
    html: page({ name: "Versioned" }),
    resync: true,
    lookup: lookupReply({
      version: "2.0.0",
      released: "2026-09-15T12:00:00Z",
      notes: "Big release",
    }),
  });

  // 9. A second version bump inside the one-hour window: no second bell.
  await run("version update dedupe window", {
    setup: [
      { scrape: { url: url(2007), html: page({ name: "Rapid" }) } },
      {
        scrape: {
          url: url(2007),
          html: page({ name: "Rapid" }),
          resync: true,
          lookup: lookupReply({
            version: "2.0.0",
            released: "2026-06-11T00:00:00Z",
          }),
        },
      },
    ],
    url: url(2007),
    html: page({ name: "Rapid" }),
    resync: true,
    lookup: lookupReply({ version: "3.0.0", released: "2026-07-04T00:00:00Z" }),
  });

  // 10. Version update AND a label change: both bells, changes win the summary.
  await run("version update with label change", {
    setup: [
      {
        scrape: {
          url: url(2008),
          html: page({ name: "Both", types: [LINKED] }),
        },
      },
    ],
    url: url(2008),
    html: page({ name: "Both", types: [LINKED, TRACKING] }),
    resync: true,
    lookup: lookupReply({
      version: "1.1.0",
      released: "2024-02-29T00:00:00Z",
      notes: "",
    }),
  });

  // 11. Age rating change: the category-first change entry.
  await run("age rating change", {
    setup: [{ scrape: { url: url(2009), html: page({ name: "Rated" }) } }],
    url: url(2009),
    html: page({ name: "Rated" }),
    resync: true,
    lookup: lookupReply({ ageRating: "12+" }),
  });

  // 12–14. Quiet hours: inside a same-day window, inside a window that wraps
  //        midnight, and outside.
  const quietSetup = (start, end, id) => [
    flagOn("flag.notifications.quiet_hours"),
    setting("notification_quiet_hours_start", start),
    setting("notification_quiet_hours_end", end),
    {
      scrape: { url: url(id), html: page({ name: "Quiet", types: [LINKED] }) },
    },
  ];
  await run("quiet hours inside same-day window", {
    setup: quietSetup("00:00", "23:59", 2010),
    at: Date.UTC(2026, 8, 15, 12, 0, 0),
    url: url(2010),
    html: page({ name: "Quiet", types: [LINKED, NOT_LINKED] }),
    resync: true,
  });
  await run("quiet hours inside window wrapping midnight", {
    setup: quietSetup("22:00", "06:00", 2011),
    at: Date.UTC(2026, 8, 15, 23, 30, 0),
    url: url(2011),
    html: page({ name: "Quiet", types: [LINKED, NOT_LINKED] }),
    resync: true,
  });
  await run("quiet hours outside window", {
    setup: quietSetup("22:00", "06:00", 2012),
    at: Date.UTC(2026, 8, 16, 12, 0, 0),
    url: url(2012),
    html: page({ name: "Quiet", types: [LINKED, NOT_LINKED] }),
    resync: true,
  });

  // 15–16. Parser fallthrough: the bell before the commit, then the cooldown.
  await run("parser fallthrough", {
    url: url(2013),
    html: page({ name: "Blank", types: null }),
  });
  await run("parser fallthrough within cooldown", {
    setup: [
      {
        scrape: {
          url: url(2014),
          html: page({ name: "Blank One", types: null }),
        },
      },
    ],
    url: url(2015),
    html: page({ name: "Blank Two", types: null }),
  });

  // 17–19. Profile mismatch: on import, on a re-sync that adds a mismatching
  //        category, and suppressed inside the 24-hour window.
  const profile = setting(
    "privacy_profile",
    JSON.stringify({ LOCATION: "not_linked", CONTACT_INFO: "linked" })
  );
  await run("profile mismatch on import", {
    setup: [profile],
    url: url(2016),
    html: page({ name: "Profiled", types: [TRACKING, LINKED] }),
  });
  await run("profile mismatch on resync", {
    setup: [
      profile,
      {
        scrape: {
          url: url(2017),
          html: page({ name: "Profiled", types: [LINKED] }),
        },
      },
    ],
    url: url(2017),
    html: page({ name: "Profiled", types: [LINKED, TRACKING] }),
    resync: true,
  });
  await run("profile mismatch dedupe window", {
    setup: [
      profile,
      {
        scrape: {
          url: url(2018),
          html: page({ name: "Profiled", types: [TRACKING] }),
        },
      },
    ],
    url: url(2018),
    html: page({
      name: "Profiled",
      types: [
        TRACKING,
        type("DATA_USED_TO_TRACK_YOU_2", "Unmapped", [cat("X", "x")]),
        type("DATA_LINKED_TO_YOU", "Data Linked to You", [
          cat("CONTACT_INFO", "Contact Info"),
          cat("LOCATION", "Location"),
        ]),
      ],
    }),
    resync: true,
  });

  // 20–21. Commit failures: the transaction rolls back and the error lands
  //        in the activity log.
  await run("duplicate type identifier fails the commit", {
    url: url(2019),
    html: page({
      name: "Dup",
      types: [LINKED, type("DATA_LINKED_TO_YOU", "Again", [])],
    }),
  });
  await run("duplicate related id fails the commit", {
    url: url(2020),
    html: page({ name: "Dup Related", relatedApps: [related(1), related(1)] }),
  });

  // 22. A parse error: the error activity row with its diagnostics.
  await run("parse error activity row", {
    url: url(2021),
    html: page({ name: "Broken", script: false }),
  });

  // 23. The activity log keeps 2000 rows: the oldest go.
  await run("activity log prune", {
    setup: [
      sql(
        "INSERT INTO activity_log (id, type, status, app_id, app_name, summary, detail, started_at, ended_at, duration_ms) WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2001) SELECT 'seed-' || n, 'scrape', 'ok', NULL, NULL, 'seed', NULL, 1000000 + n, 1000000 + n, 0 FROM seq"
      ),
    ],
    url: url(2022),
    html: page({ name: "Pruned" }),
  });

  // 24. The notification writers keep 5000 rows: the oldest read one goes.
  await run("notification prune", {
    setup: [
      { scrape: { url: url(2023), html: page({ name: "Noisy" }) } },
      sql(
        "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, stale, not_before) WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5001) SELECT 'seed-' || n, NULL, 'seed', '[]', 1000000 + n, 1, 0, NULL FROM seq"
      ),
    ],
    url: url(2023),
    html: page({ name: "Noisy" }),
    resync: true,
    lookup: lookupReply({ version: "2.0.0" }),
  });

  // 25. An app row with privacy rows but no snapshot: the previous snapshot
  //     is rebuilt from the rows.
  await run("existing app without snapshot row", {
    setup: [
      sql(
        "INSERT INTO apps (id, name, url, lastSynced) VALUES (?, ?, ?, ?)",
        "2024",
        "Legacy",
        url(2024),
        1_700_000_000_000
      ),
      sql(
        "INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, ?)",
        "2024_DATA_LINKED_TO_YOU",
        "2024",
        "DATA_LINKED_TO_YOU",
        "Data Linked to You",
        "old"
      ),
      sql(
        "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)",
        "2024_DATA_LINKED_TO_YOU_CONTACT_INFO",
        "2024_DATA_LINKED_TO_YOU",
        "CONTACT_INFO",
        "Contact Info"
      ),
    ],
    url: url(2024),
    html: page({ name: "Legacy", types: [NOT_LINKED] }),
    resync: true,
  });

  // 26. Related shelves gone on re-sync: the rows are wiped, not kept.
  await run("resync related shelf gone", {
    setup: [
      {
        scrape: {
          url: url(2025),
          html: page({ name: "Shelved", relatedApps: [related(1)] }),
        },
      },
    ],
    url: url(2025),
    html: page({ name: "Shelved" }),
    resync: true,
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
    new URL("../tests/fixtures/persist-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} actual Node persist cases from fetchAndParseApp; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
