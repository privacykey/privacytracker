/**
 * Historical-import oracle for the Rust scraper (Phase 3, batch 4).
 *
 * Runs the REAL `importAppHistory` from lib/historical-import.ts with the
 * raw `fetch` routed to recorded archive.org replies — the CDX index, the
 * availability API keyed by probe date, page replays keyed by capture
 * timestamp, and Save Page Now — never the network. Records, per case,
 * every raw fetch in order (URL and headers), every write with
 * transaction markers, the privacy_snapshots and apps rows afterwards,
 * and the result object or the error the import throws.
 *
 * Same determinism as the other scrape oracles: frozen clock (which is
 * also `today` for the target walk), TZ=UTC, counted ids on both the
 * global crypto and the node:crypto module.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-history-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;

let now = Date.UTC(2021, 10, 1, 12);
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
const { importAppHistory } = await import("../../lib/historical-import.ts");
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
const dump = () =>
  Object.fromEntries(
    ["privacy_snapshots", "apps"].map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ])
  );

// ── Pages and replies ────────────────────────────────────────────────
const APP_ID = "555000111";
const APP_URL = `https://apps.apple.com/us/app/fixture/id${APP_ID}`;
const APP = { id: APP_ID, name: "Fixture", url: APP_URL };
const cat = (identifier, title = identifier) => ({ identifier, title });
const linked = (cats) => ({
  identifier: "DATA_LINKED_TO_YOU",
  title: "Data Linked to You",
  categories: cats.map((c) => cat(c)),
});
const tracking = (cats) => ({
  identifier: "DATA_USED_TO_TRACK_YOU",
  title: "Data Used to Track You",
  categories: cats.map((c) => cat(c)),
});
const A = [linked(["CONTACT_INFO"])];
const B = [linked(["CONTACT_INFO", "LOCATION"]), tracking(["LOCATION"])];
const modernPage = (types) =>
  `<html><head><script id="serialized-server-data">${JSON.stringify({ data: [{ data: { shelfMapping: { privacyTypes: { items: types } } } }] })}</script></head><body></body></html>`;
const escapeHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const shoeboxPage = (types) => {
  const inner = JSON.stringify({
    d: [
      {
        attributes: {
          privacy: {
            privacyTypes: types.map((t) => ({
              identifier: t.identifier,
              privacyType: t.title,
              dataCategories: t.categories.map((c) => ({
                identifier: c.identifier,
                dataCategory: c.title,
              })),
            })),
          },
        },
      },
    ],
  });
  return `<html><head><script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">${escapeHtml(JSON.stringify({ "cache.key": inner }))}</script></head><body></body></html>`;
};
const emberPage = (types) =>
  `<html><head><script type="fastboot/shoebox" id="shoebox-ember-data-store">${escapeHtml(
    JSON.stringify({
      [APP_ID]: {
        data: {
          attributes: {
            privacy: {
              privacyTypes: types.map((t) => ({
                identifier: t.identifier,
                privacyType: t.title,
                dataCategories: t.categories.map((c) => ({
                  identifier: c.identifier,
                  dataCategory: c.title,
                })),
              })),
            },
          },
        },
      },
    })
  )}</script></head><body></body></html>`;
const NO_LABELS_PAGE = `<html><head><script id="serialized-server-data">{"data":[{"data":{"shelfMapping":{}}}]}</script></head><body>No privacy section</body></html>`;
const NOT_A_PRODUCT_PAGE =
  "<html><body>Wayback Machine has not archived that URL.</body></html>";
const html = (body) => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body,
});
const json = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const cdx = (timestamps) =>
  json([["timestamp", "statuscode"], ...timestamps.map((ts) => [ts, "200"])]);
const closest = (timestamp, over = {}) =>
  json({
    archived_snapshots: {
      closest: {
        available: true,
        url: `http://web.archive.org/web/${timestamp}/${APP_URL}`,
        timestamp,
        status: "200",
        ...over,
      },
    },
  });
const NONE = json({ archived_snapshots: {} });
const ts = (y, mo, d, h = 12) =>
  `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}${String(h).padStart(2, "0")}0000`;

// ── Driver ───────────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
function route(replies, url) {
  if (url.startsWith("https://web.archive.org/cdx/search/cdx?")) {
    return replies.cdx;
  }
  if (url.startsWith("https://archive.org/wayback/available?")) {
    const key = new URL(url).searchParams.get("timestamp") ?? "latest";
    return replies.availability?.[key] ?? replies.availability?.default;
  }
  const replay = url.match(
    /^https:\/\/web\.archive\.org\/web\/(\d{4,14})id_\//
  );
  if (replay) {
    return replies.replay?.[replay[1]];
  }
  if (url.startsWith("https://web.archive.org/save/")) {
    return replies.save;
  }
}
async function drive(replies, options) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: [...new Headers(init?.headers)] });
    const r = route(replies, url);
    if (!r) {
      throw new Error(`Unexpected fetch: ${url}`);
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
  try {
    const result = await importAppHistory(APP, options);
    return { calls, expected: { ok: true, result } };
  } catch (error) {
    return { calls, expected: { ok: false, error: error.message } };
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
}

const cases = [];
const sql = (text, ...params) => ({ sql: text, params });
const appRow = (firstSeen = 0) =>
  sql(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced) VALUES (?, ?, ?, ?, ?)",
    APP_ID,
    "Fixture",
    APP_URL,
    firstSeen,
    1_600_000_000_000
  );
const snapshotRow = (id, scrapedAt, snapshot, changes, source, waybackUrl) =>
  sql(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source, wayback_snapshot_url, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    APP_ID,
    scrapedAt,
    JSON.stringify(snapshot),
    changes.length > 0 ? 1 : 0,
    JSON.stringify(changes),
    source,
    waybackUrl,
    source === "wayback" ? "wayback" : "manual"
  );
async function run(name, { setup = [appRow()], at, options = {}, replies }) {
  wipe();
  now = at ?? Date.UTC(2021, 10, 1, 12);
  idPrefix = "00000000-0000-4000-8000-";
  idCounter = 0;
  for (const step of setup) {
    db.prepare(step.sql).run(...step.params);
  }
  const stream = [];
  recording = stream;
  const { calls, expected } = await drive(replies, options);
  recording = null;
  cases.push({
    name,
    now,
    setup,
    app: APP,
    options,
    replies,
    calls,
    stream,
    rows: dump(),
    expected,
  });
}

try {
  const recent = ts(2021, 10, 20);
  // 1. Three quarterly targets from the index: a baseline, an unchanged
  //    capture, then a change — through both shoebox shapes and the modern one.
  await run("index captures imported", {
    replies: {
      cdx: cdx([ts(2021, 2, 15), ts(2021, 5, 1), ts(2021, 8, 10), recent]),
      replay: {
        [ts(2021, 2, 15)]: html(shoeboxPage(A)),
        [ts(2021, 5, 1)]: html(emberPage(A)),
        [ts(2021, 8, 10)]: html(modernPage(B)),
      },
    },
  });

  // 2. Rows already inside the dedupe window are skipped without a fetch.
  await run("existing rows inside the window are skipped", {
    setup: [
      appRow(),
      snapshotRow(
        "w1",
        Date.UTC(2021, 1, 20),
        A,
        [],
        "wayback",
        `https://web.archive.org/web/${ts(2021, 2, 20)}/${APP_URL}`
      ),
      snapshotRow(
        "w2",
        Date.UTC(2021, 4, 5),
        A,
        [],
        "wayback",
        `https://web.archive.org/web/${ts(2021, 5, 5)}/${APP_URL}`
      ),
      snapshotRow(
        "w3",
        Date.UTC(2021, 7, 3),
        B,
        [],
        "wayback",
        `https://web.archive.org/web/${ts(2021, 8, 3)}/${APP_URL}`
      ),
    ],
    replies: {
      cdx: cdx([ts(2021, 2, 20), ts(2021, 5, 5), ts(2021, 8, 3), recent]),
    },
  });

  // 3. force re-probes the date window; the capture URL still dedupes, with
  //    http:// and https:// treated as the same capture.
  await run("force re-probes but the capture url still dedupes", {
    setup: [
      appRow(),
      snapshotRow(
        "w1",
        Date.UTC(2021, 1, 15, 12),
        A,
        [],
        "wayback",
        `http://web.archive.org/web/${ts(2021, 2, 15)}/${APP_URL}`
      ),
    ],
    options: { force: true },
    replies: {
      cdx: cdx([ts(2021, 2, 15), ts(2021, 5, 1), recent]),
      replay: {
        [ts(2021, 5, 1)]: html(modernPage(B)),
        [recent]: html(modernPage(B)),
      },
    },
  });

  // 4–5. A throttled or broken index is an error for the app.
  await run("index rate limited throws", {
    replies: { cdx: status(429, { "retry-after": "120" }) },
  });
  await run("index unavailable throws", { replies: { cdx: status(503) } });

  // 6. A missing index falls back to availability probes per target:
  //    in tolerance, drifted, none — then Save Page Now for the newest.
  await run("index missing falls back to availability probes", {
    replies: {
      cdx: status(404),
      availability: {
        20210201: closest(ts(2021, 2, 20)),
        20210501: closest(ts(2021, 9, 1)),
        20210417: closest(ts(2021, 9, 1)),
        20210515: closest(ts(2021, 9, 1)),
        20210403: closest(ts(2021, 9, 1)),
        20210529: closest(ts(2021, 9, 1)),
        20210320: closest(ts(2021, 9, 1)),
        20210612: closest(ts(2021, 9, 1)),
        default: NONE,
      },
      replay: { [ts(2021, 2, 20)]: html(modernPage(A)) },
      save: status(302, {
        location: `https://web.archive.org/web/${ts(2021, 11, 1)}/${APP_URL}`,
      }),
    },
  });
  await run("availability unavailable throws", {
    replies: {
      cdx: status(404),
      availability: {
        default: status(503, {
          "retry-after": "Mon, 01 Nov 2021 12:02:00 GMT",
        }),
      },
    },
  });

  // 7. Replay failures: a page with no privacy section (skipped, and the
  //    same capture is not fetched again), a transport failure, and Save
  //    Page Now throttled.
  await run("replay outcomes and a reused unusable capture", {
    replies: {
      cdx: cdx([ts(2021, 3, 17), ts(2021, 8, 1)]),
      replay: {
        [ts(2021, 3, 17)]: html(NO_LABELS_PAGE),
        [ts(2021, 8, 1)]: { error: "fetch failed" },
      },
      save: status(429, { "retry-after": "60" }),
    },
  });
  await run("replay not found and not a product page", {
    replies: {
      cdx: cdx([ts(2021, 2, 15), ts(2021, 5, 1), ts(2021, 8, 10), recent]),
      replay: {
        [ts(2021, 2, 15)]: status(404),
        [ts(2021, 5, 1)]: html(NOT_A_PRODUCT_PAGE),
        [ts(2021, 8, 10)]: html(modernPage(A)),
      },
    },
  });
  await run("replay unavailable throws after earlier rows committed", {
    replies: {
      cdx: cdx([ts(2021, 2, 15), ts(2021, 5, 1), recent]),
      replay: {
        [ts(2021, 2, 15)]: html(modernPage(A)),
        [ts(2021, 5, 1)]: status(503),
      },
    },
  });

  // 8. An older capture landing later re-diffs the wayback row after it; a
  //    live row is never rewritten.
  await run("successor wayback row is re-diffed", {
    setup: [
      appRow(),
      snapshotRow(
        "aug",
        Date.UTC(2021, 7, 10),
        B,
        [],
        "wayback",
        `https://web.archive.org/web/${ts(2021, 8, 10)}/${APP_URL}`
      ),
      snapshotRow("live", Date.UTC(2021, 9, 5), B, [], "live", null),
    ],
    replies: {
      cdx: cdx([ts(2021, 2, 15), ts(2021, 5, 1), ts(2021, 8, 10), recent]),
      replay: {
        [ts(2021, 2, 15)]: html(modernPage(A)),
        [ts(2021, 5, 1)]: html(modernPage(A)),
      },
    },
  });

  // 9. A live row before the capture is its diff base, so the first import
  //    is a change, not a baseline.
  await run("live row before the capture is the diff base", {
    setup: [
      appRow(),
      snapshotRow("live", Date.UTC(2021, 0, 15), B, [], "live", null),
    ],
    replies: {
      cdx: cdx([ts(2021, 2, 15), recent]),
      replay: { [ts(2021, 2, 15)]: html(modernPage(A)) },
    },
  });

  // 10–16. Save Page Now, reached through an empty index.
  const saveCase = (name, save) =>
    run(name, { replies: { cdx: json("[]"), save } });
  await saveCase(
    "save now via location",
    status(302, { location: `/web/${ts(2021, 11, 1)}/${APP_URL}` })
  );
  await saveCase(
    "save now via content-location",
    status(200, {
      "content-location": `https://web.archive.org/web/${ts(2021, 11, 1)}/${APP_URL}`,
    })
  );
  await saveCase("save now rate limited", status(429));
  await saveCase("save now server error", status(500));
  await saveCase("save now without a snapshot url", status(200));
  await saveCase("save now transport failure", { error: "fetch failed" });
  await saveCase(
    "save now location on another host",
    status(302, { location: "https://example.com/web/20211101120000/x" })
  );

  // 17–19. The install anchor.
  await run("install anchor is probed", {
    setup: [appRow(Date.UTC(2021, 5, 15, 9))],
    replies: {
      cdx: cdx([ts(2021, 6, 15), recent]),
      replay: { [ts(2021, 6, 15)]: html(modernPage(A)) },
    },
  });
  await run("fresh install anchor is not probed", {
    setup: [appRow(Date.UTC(2021, 9, 20))],
    replies: { cdx: cdx([recent]) },
  });
  await run("anchor coinciding with a target is deduped", {
    setup: [appRow(Date.UTC(2021, 4, 1, 6))],
    replies: { cdx: cdx([recent]) },
  });

  // 20. A monthly cadence: drift, in-tolerance imports, url dedupe after an
  //     import, and a second capture later in the year.
  await run("monthly cadence", {
    options: { intervalMonths: 1 },
    replies: {
      cdx: cdx([ts(2021, 6, 1), ts(2021, 10, 15)]),
      replay: {
        [ts(2021, 6, 1)]: html(modernPage(A)),
        [ts(2021, 10, 15)]: html(modernPage(B)),
      },
    },
  });

  // 21–22. Index parsing quirks and garbage.
  await run("index parsing quirks", {
    replies: {
      cdx: json([
        ["timestamp", "statuscode"],
        ["2021", "200"],
        [ts(2021, 8, 10), "200"],
        [ts(2021, 8, 10), "200"],
        [ts(2021, 2, 15), "200"],
        "junk",
        [42, "200"],
        [recent, "200"],
      ]),
      replay: {
        [ts(2021, 2, 15)]: html(modernPage(A)),
        [ts(2021, 8, 10)]: html(modernPage(A)),
      },
    },
  });
  await run("index garbage falls back to probes", {
    replies: {
      cdx: json("{not json"),
      availability: { default: NONE },
      save: status(500),
    },
  });

  // 23. setUTCMonth overflow: 31 May minus three months lands on 3 March.
  await run("target walk from a month end", {
    at: Date.UTC(2021, 4, 31, 12),
    replies: { cdx: json("[]"), save: status(500) },
  });

  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  const stray = text
    .match(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
    )
    ?.filter((u) => !/^00000000-0000-4000-8000-/.test(u));
  if (stray?.length) {
    throw new Error(
      `non-deterministic ids leaked into the fixture: ${stray.slice(0, 3).join(", ")}`
    );
  }
  writeFileSync(
    new URL("../tests/fixtures/history-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} actual Node historical-import cases; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
