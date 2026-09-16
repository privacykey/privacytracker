/**
 * Library-write oracle for the Rust server (Phase 4, batch 2).
 *
 * Runs the REAL Next handlers of the twenty-three library writes — the
 * `POST`/`PUT`/`PATCH`/`DELETE` exports of eighteen route files: annotations,
 * verdicts, shortlist, review actions and their undo, notifications,
 * user tasks and visits, queue sessions, devices, the device scope and
 * manual apps — against a scratch database and records, per case, the
 * request, the admin-token state, the setup rows, every write in order
 * with its transaction markers, the fifteen tables a library write can
 * touch, and the wire response.
 *
 * Unlike the settings oracle, foreign keys stay ON: Node's device delete
 * relies on the cascade, and the verdict and annotation inserts fail on an
 * unknown app. Fixture apps therefore exist as real rows.
 *
 * Determinism as before: frozen clock, counted ids (both the global
 * `crypto` and the `node:crypto` module — the latter synced into the
 * builtin ESM facade because lib/devices.ts imports `randomUUID` by
 * name), a distinct forwarded address per case, and `repeat` for the
 * limit+1 bursts.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-library-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;
delete process.env.PRIVACYTRACKER_RUNTIME;
delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;

const now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
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

const ROUTES = [
  "shortlist",
  "verdicts",
  "verdicts/bulk",
  "notifications",
  "annotations",
  "annotations/[id]",
  "apps/[id]/acknowledge",
  "apps/[id]/acknowledge/undo",
  "user-tasks",
  "user-tasks/visit",
  "activity/queue-session",
  "devices",
  "devices/[id]",
  "device-scope",
  "manual-apps",
  "manual-apps/[id]",
  "manual-apps/bulk",
  "manual-apps/[id]/restore",
];
const handlers = {};
for (const route of ROUTES) {
  handlers[`/api/${route}`] = await import(`../../app/api/${route}/route.ts`);
}

for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = [
  "apps",
  "annotations",
  "app_verdicts",
  "shortlist_entries",
  "devices",
  "app_devices",
  "imports",
  "manual_apps",
  "manual_app_events",
  "manual_app_policy_versions",
  "change_review_actions",
  "notifications",
  "privacy_snapshots",
  "activity_log",
  "audit_log",
  "app_settings",
];

// ── Fixture rows ─────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const A1 = "1001";
const A2 = "1002";
const A3 = "1003";
const A4 = "1004";
const D1 = "d-one";
const D2 = "d-two";
const D3 = "d-three";
const app = (id, name = `App ${id}`, extra = {}) =>
  stmt(
    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, changes_acknowledged_at, changes_snoozed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    `https://apps.apple.com/us/app/x/id${id}`,
    1_600_000_000_000,
    1_600_000_000_000,
    extra.changeCount ?? 0,
    extra.ackAt ?? 0,
    extra.snoozedUntil ?? 0
  );
const device = (id, name, extra = {}) =>
  stmt(
    "INSERT INTO devices (id, name, ecid, model, ios_version, device_class, created_at, last_synced_at, is_unknown_placeholder, owner_label, owner_audience, permission_acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    name,
    extra.ecid ?? null,
    extra.model ?? null,
    extra.iosVersion ?? null,
    extra.deviceClass ?? null,
    extra.createdAt ?? 1_700_000_000_000,
    extra.lastSyncedAt ?? 1_700_000_000_000,
    extra.ownerLabel ?? null,
    extra.ownerAudience ?? null,
    extra.ack ?? null
  );
const link = (appId, deviceId) =>
  stmt(
    "INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
    appId,
    deviceId,
    1_700_000_000_000,
    1_700_000_000_000
  );
const annotation = (id, appId, extra = {}) =>
  stmt(
    "INSERT INTO annotations (id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    extra.content ?? "a note",
    extra.source ?? "user",
    extra.sourceName ?? null,
    extra.visibility ?? "export",
    extra.tag ?? null,
    extra.createdAt ?? 1_700_000_000_000,
    extra.updatedAt ?? 1_700_000_000_000,
    extra.deletedAt ?? null
  );
const verdict = (id, appId, value, source = "user", sourceName = null) =>
  stmt(
    "INSERT INTO app_verdicts (id, app_id, verdict, rationale, source, source_name, set_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    value,
    null,
    source,
    sourceName,
    1_700_000_000_000,
    1_700_000_000_000
  );
const shortlist = (id, source, candidate, extra = {}) =>
  stmt(
    "INSERT INTO shortlist_entries (id, source_app_id, candidate_apple_id, candidate_name, candidate_developer, candidate_icon_url, candidate_store_url, candidate_bundle_id, note, added_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    source,
    candidate,
    extra.name ?? "Candidate",
    extra.developer ?? null,
    extra.iconUrl ?? null,
    extra.storeUrl ?? `https://apps.apple.com/us/app/x/id${candidate}`,
    extra.bundleId ?? null,
    extra.note ?? null,
    extra.addedAt ?? 1_700_000_000_000,
    extra.mode ?? "privacy"
  );
const manualApp = (id, name, extra = {}) =>
  stmt(
    "INSERT INTO manual_apps (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    extra.source ?? "sideloaded",
    extra.developer ?? null,
    extra.privacyPolicyUrl ?? null,
    extra.sourceUrl ?? null,
    extra.notes ?? null,
    extra.firstSeen ?? 1_700_000_000_000,
    extra.updatedAt ?? 1_700_000_000_000
  );
const manualEvent = (id, manualAppId) =>
  stmt(
    "INSERT INTO manual_app_events (id, manual_app_id, event_type, occurred_at, detail) VALUES (?, ?, ?, ?, ?)",
    id,
    manualAppId,
    "field_change",
    1_700_000_000_000,
    '{"kind":"field_change","field":"name","from":"a","to":"b"}'
  );
const policyVersion = (id, manualAppId) =>
  stmt(
    "INSERT INTO manual_app_policy_versions (id, manual_app_id, content_hash, first_fetched_at, last_fetched_at, source_word_count, source_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    manualAppId,
    "hash",
    1_700_000_000_000,
    1_700_000_000_000,
    3,
    "some policy text"
  );
const notification = (id, appId, read = 0) =>
  stmt(
    "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "App",
    "[]",
    1_700_000_000_000,
    read
  );
const snapshot = (id, appId, scrapedAt, changesDetected, summary) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source) VALUES (?, ?, ?, ?, ?, ?, 'live')",
    id,
    appId,
    scrapedAt,
    "[]",
    changesDetected,
    summary
  );
const reviewAction = (id, appId) =>
  stmt(
    "INSERT INTO change_review_actions (id, app_id, action, acted_at, covered_count) VALUES (?, ?, ?, ?, ?)",
    id,
    appId,
    "reviewed",
    1_700_000_000_000,
    2
  );
const importRow = (id, deviceId) =>
  stmt(
    "INSERT INTO imports (id, created_at, completed_at, source, total) VALUES (?, ?, ?, ?, ?)",
    id,
    1_700_000_000_000,
    1_700_000_000_000,
    "cfgutil",
    1
  ).params.length && {
    sql: "INSERT INTO imports (id, created_at, completed_at, source, total, device_id) VALUES (?, ?, ?, ?, ?, ?)",
    params: [id, 1_700_000_000_000, 1_700_000_000_000, "cfgutil", 1, deviceId],
  };
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const privacyType = (id, appId, identifier) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    appId,
    identifier,
    identifier
  );
const privacyCategory = (id, typeId, identifier) =>
  stmt(
    "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    typeId,
    identifier,
    identifier
  );

const APPS = [
  app(A1, "Instagram"),
  app(A2, "Signal"),
  app(A3, "Maps"),
  app(A4, "Notes"),
];
const STRICT = {
  CONTACT_INFO: "not_linked",
  HEALTH_AND_FITNESS: "not_collected",
  FINANCIAL_INFO: "not_linked",
  LOCATION: "not_collected",
  SENSITIVE_INFO: "not_collected",
  CONTACTS: "not_collected",
  USER_CONTENT: "not_linked",
  BROWSING_HISTORY: "not_collected",
  SEARCH_HISTORY: "not_linked",
  IDENTIFIERS: "not_linked",
  PURCHASES: "not_linked",
  USAGE_DATA: "not_linked",
  DIAGNOSTICS: "not_linked",
  OTHER: "not_collected",
};

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;
async function run(name, spec) {
  const {
    route,
    method,
    param,
    search = "",
    json,
    raw,
    headers = {},
    setup = [],
    adminToken = null,
    repeat = 1,
    contentLength,
  } = spec;
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.2`;
  const body = json === undefined ? (raw ?? null) : JSON.stringify(json);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "library-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const pathname =
    param === undefined
      ? route
      : route.replace("[id]", encodeURIComponent(param));
  db.exec("SAVEPOINT library_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let expected;
    for (let i = 0; i < repeat; i++) {
      const request = new NextRequest(
        `http://127.0.0.1:3000${pathname}${search}`,
        {
          method,
          headers: sent,
          body: body === null ? undefined : body,
        }
      );
      const handler = handlers[route][method];
      try {
        const response =
          param === undefined
            ? await handler(request)
            : await handler(request, {
                params: Promise.resolve({ id: param }),
              });
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
      }
    }
    recording = null;
    const rows = {};
    for (const table of TABLES) {
      rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    cases.push({
      name,
      route,
      method,
      param: param ?? null,
      pathname,
      search,
      query: [...new URLSearchParams(search)],
      headers: sent,
      body,
      adminToken,
      repeat,
      setup,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO library_case; RELEASE library_case");
  }
}

async function bodyCases(route, method, limit, extra = {}) {
  await run(`${route} ${method} empty body`, { route, method, ...extra });
  await run(`${route} ${method} invalid json`, {
    route,
    method,
    raw: "{not json",
    ...extra,
  });
  await run(`${route} ${method} whitespace body`, {
    route,
    method,
    raw: "  \n ",
    ...extra,
  });
  await run(`${route} ${method} declared too large`, {
    route,
    method,
    json: {},
    contentLength: limit + 1,
    ...extra,
  });
  await run(`${route} ${method} streamed too large`, {
    route,
    method,
    raw: `{"pad":"${"x".repeat(limit)}"}`,
    ...extra,
  });
}

async function adminCases(route, method, extra = {}) {
  await run(`${route} ${method} admin token required`, {
    route,
    method,
    adminToken: "secret-token",
    ...extra,
  });
  await run(`${route} ${method} admin token accepted`, {
    route,
    method,
    adminToken: "secret-token",
    headers: { "x-auditor-admin-token": "secret-token" },
    ...extra,
  });
}

// ── /api/shortlist ───────────────────────────────────────────────────
{
  const route = "/api/shortlist";
  const base = [...APPS];
  await run("shortlist manifest body (tracked candidate)", {
    route,
    method: "POST",
    setup: base,
    json: {
      sourceAppId: A1,
      candidateAppleId: A2,
      candidateName: "Parity Candidate",
      candidateStoreUrl: `https://apps.apple.com/us/app/id${A2}`,
    },
  });
  await run("shortlist tracked candidate with profile badge", {
    route,
    method: "POST",
    setup: [
      ...base,
      setting("privacy_profile", JSON.stringify(STRICT)),
      privacyType("pt-1", A2, "DATA_USED_TO_TRACK_YOU"),
      privacyCategory("pc-1", "pt-1", "LOCATION"),
      privacyCategory("pc-2", "pt-1", "CONTACT_INFO"),
    ],
    json: {
      sourceAppId: A1,
      candidateAppleId: A2,
      candidateName: "Signal",
      candidateStoreUrl: `https://apps.apple.com/us/app/id${A2}`,
    },
  });
  await run("shortlist tracked candidate without privacy rows and a profile", {
    route,
    method: "POST",
    setup: [...base, setting("privacy_profile", JSON.stringify(STRICT))],
    json: {
      sourceAppId: A1,
      candidateAppleId: A3,
      candidateName: "Maps",
      candidateStoreUrl: `https://apps.apple.com/us/app/id${A3}`,
    },
  });
  await run("shortlist untracked candidate with every field", {
    route,
    method: "POST",
    setup: base,
    json: {
      sourceAppId: ` ${A1} `,
      candidateAppleId: "9001",
      candidateName: "  Bolt ",
      candidateDeveloper: " Bolt Tech ",
      candidateIconUrl: " https://icon.example/1.png ",
      candidateStoreUrl: " https://apps.apple.com/us/app/id9001 ",
      candidateBundleId: " com.bolt ",
      note: " cheaper ",
      modes: ["accessibility", " PRIVACY ", "bogus", 5],
    },
  });
  await run("shortlist re-shortlist merges modes and refreshes metadata", {
    route,
    method: "POST",
    setup: [
      ...base,
      shortlist("s-1", A1, "9001", {
        mode: "privacy",
        note: "old",
        addedAt: 5,
      }),
    ],
    json: {
      sourceAppId: A1,
      candidateAppleId: "9001",
      candidateName: "Bolt 2",
      candidateStoreUrl: "https://apps.apple.com/us/app/id9001",
      modes: "accessibility",
      note: "",
    },
  });
  await run("shortlist modes as string and empty developer", {
    route,
    method: "POST",
    setup: base,
    json: {
      sourceAppId: A1,
      candidateAppleId: "9002",
      candidateName: "Lyft",
      candidateStoreUrl: "https://apps.apple.com/us/app/id9002",
      modes: "accessibility, privacy",
      candidateDeveloper: "   ",
      candidateIconUrl: 5,
    },
  });
  await run("shortlist modes empty array and number", {
    route,
    method: "POST",
    setup: base,
    json: {
      sourceAppId: A1,
      candidateAppleId: "9003",
      candidateName: "Didi",
      candidateStoreUrl: "https://apps.apple.com/us/app/id9003",
      modes: [],
    },
  });
  await run("shortlist modes number", {
    route,
    method: "POST",
    setup: base,
    json: {
      sourceAppId: A1,
      candidateAppleId: "9003",
      candidateName: "Didi",
      candidateStoreUrl: "https://apps.apple.com/us/app/id9003",
      modes: 7,
    },
  });
  for (const [label, body, extraSetup] of [
    [
      "missing source",
      { candidateAppleId: "9001", candidateName: "x", candidateStoreUrl: "u" },
      [],
    ],
    [
      "missing candidate",
      { sourceAppId: A1, candidateName: "x", candidateStoreUrl: "u" },
      [],
    ],
    [
      "missing name",
      {
        sourceAppId: A1,
        candidateAppleId: "9001",
        candidateName: "  ",
        candidateStoreUrl: "u",
      },
      [],
    ],
    [
      "missing store url",
      { sourceAppId: A1, candidateAppleId: "9001", candidateName: "x" },
      [],
    ],
    [
      "unknown source app",
      {
        sourceAppId: "5",
        candidateAppleId: "9001",
        candidateName: "x",
        candidateStoreUrl: "u",
      },
      [],
    ],
    [
      "numeric source app id",
      {
        sourceAppId: 1001,
        candidateAppleId: "9001",
        candidateName: "x",
        candidateStoreUrl: "u",
      },
      [],
    ],
    [
      "same app",
      {
        sourceAppId: A1,
        candidateAppleId: A1,
        candidateName: "x",
        candidateStoreUrl: "u",
      },
      [],
    ],
  ]) {
    await run(`shortlist ${label}`, {
      route,
      method: "POST",
      setup: [...base, ...extraSetup],
      json: body,
    });
  }
  await run("shortlist null body", {
    route,
    method: "POST",
    setup: base,
    json: null,
  });
  await run("shortlist string body", {
    route,
    method: "POST",
    setup: base,
    json: "x",
  });
  await bodyCases(route, "POST", 8 * 1024, { setup: base });
  await adminCases(route, "POST", {
    setup: base,
    json: {
      sourceAppId: A1,
      candidateAppleId: "9001",
      candidateName: "x",
      candidateStoreUrl: "https://a.example/",
    },
  });
  await run("shortlist POST rate limited", {
    route,
    method: "POST",
    setup: base,
    repeat: 61,
    json: {
      sourceAppId: A1,
      candidateAppleId: "9001",
      candidateName: "x",
      candidateStoreUrl: "https://a.example/",
    },
  });

  const seeded = [
    ...base,
    shortlist("s-1", A1, "9001"),
    shortlist("s-2", A1, A2, { mode: "accessibility" }),
    shortlist("s-3", A2, "9005"),
  ];
  await run("shortlist delete all (manifest)", {
    route,
    method: "DELETE",
    search: "?all=1",
    setup: seeded,
  });
  await run("shortlist delete all true when empty", {
    route,
    method: "DELETE",
    search: "?all=true",
    setup: base,
  });
  await run("shortlist delete by id", {
    route,
    method: "DELETE",
    search: "?id=s-2",
    setup: seeded,
  });
  await run("shortlist delete by missing id", {
    route,
    method: "DELETE",
    search: "?id=s-9",
    setup: seeded,
  });
  await run("shortlist delete by pair", {
    route,
    method: "DELETE",
    search: `?sourceAppId=${A1}&candidateAppleId=9001`,
    setup: seeded,
  });
  await run("shortlist delete by missing pair", {
    route,
    method: "DELETE",
    search: `?sourceAppId=${A1}&candidateAppleId=9999`,
    setup: seeded,
  });
  await run("shortlist delete id wins over pair", {
    route,
    method: "DELETE",
    search: `?id=s-3&sourceAppId=${A1}&candidateAppleId=9001`,
    setup: seeded,
  });
  await run("shortlist delete empty id and half a pair", {
    route,
    method: "DELETE",
    search: `?id=&sourceAppId=${A1}`,
    setup: seeded,
  });
  await run("shortlist delete all=0 falls through", {
    route,
    method: "DELETE",
    search: "?all=0",
    setup: seeded,
  });
  await adminCases(route, "DELETE", { setup: seeded, search: "?id=s-1" });
  await run("shortlist DELETE rate limited", {
    route,
    method: "DELETE",
    setup: seeded,
    repeat: 61,
    search: "?id=s-9",
  });
}

// ── /api/verdicts and /api/verdicts/bulk ─────────────────────────────
{
  const route = "/api/verdicts";
  const base = [...APPS];
  await run("verdict manifest body", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, verdict: "safe" },
  });
  await run("verdict updates an existing user verdict", {
    route,
    method: "POST",
    setup: [
      ...base,
      verdict("v-1", A1, "safe"),
      verdict("v-2", A1, "uninstall", "imported", "Mum"),
    ],
    json: { appId: A1, verdict: "replace", rationale: "  slow  " },
  });
  await run("verdict empty rationale is null", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A2, verdict: "uninstall", rationale: "   " },
  });
  await run("verdict null rationale", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A2, verdict: "uninstall", rationale: null },
  });
  await run("verdict rationale wrong type", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A2, verdict: "safe", rationale: 5 },
  });
  await run("verdict invalid value", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A2, verdict: "maybe" },
  });
  await run("verdict missing appId", {
    route,
    method: "POST",
    setup: base,
    json: { verdict: "safe" },
  });
  await run("verdict empty appId", {
    route,
    method: "POST",
    setup: base,
    json: { appId: "", verdict: "safe" },
  });
  await run("verdict numeric appId", {
    route,
    method: "POST",
    setup: base,
    json: { appId: 1001, verdict: "safe" },
  });
  await run("verdict unknown app fails the foreign key", {
    route,
    method: "POST",
    setup: base,
    json: { appId: "nope", verdict: "safe" },
  });
  await run("verdict null body", {
    route,
    method: "POST",
    setup: base,
    json: null,
  });
  await run("verdict string body", {
    route,
    method: "POST",
    setup: base,
    json: "x",
  });
  await bodyCases(route, "POST", 8 * 1024, { setup: base });

  const seededVerdicts = [
    ...base,
    verdict("v-1", A1, "safe"),
    verdict("v-2", A1, "uninstall", "imported", "Mum"),
  ];
  await run("verdict clear (manifest)", {
    route,
    method: "DELETE",
    search: `?appId=${A1}`,
    setup: seededVerdicts,
  });
  await run("verdict clear when none", {
    route,
    method: "DELETE",
    search: `?appId=${A2}`,
    setup: seededVerdicts,
  });
  await run("verdict clear imported", {
    route,
    method: "DELETE",
    search: `?appId=${A1}&source=imported&sourceName=Mum`,
    setup: seededVerdicts,
  });
  await run("verdict clear imported without name", {
    route,
    method: "DELETE",
    search: `?appId=${A1}&source=imported`,
    setup: seededVerdicts,
  });
  await run("verdict clear unknown source is user", {
    route,
    method: "DELETE",
    search: `?appId=${A1}&source=bogus&sourceName=Mum`,
    setup: seededVerdicts,
  });
  await run("verdict clear empty appId", {
    route,
    method: "DELETE",
    search: "?appId=",
    setup: seededVerdicts,
  });

  const bulk = "/api/verdicts/bulk";
  await run("bulk verdict manifest body", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1], verdict: "safe" },
  });
  await run("bulk verdict updates and inserts", {
    route: bulk,
    method: "POST",
    setup: [...base, verdict("v-1", A1, "safe")],
    json: { appIds: [A1, A2, A1], verdict: "uninstall", rationale: " gone " },
  });
  await run("bulk verdict empty ids", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [], verdict: "safe" },
  });
  await run("bulk verdict not an array", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: A1, verdict: "safe" },
  });
  await run("bulk verdict over the cap", {
    route: bulk,
    method: "POST",
    setup: base,
    json: {
      appIds: Array.from({ length: 501 }, (_, i) => String(i)),
      verdict: "safe",
    },
  });
  await run("bulk verdict non-string id", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1, 5], verdict: "safe" },
  });
  await run("bulk verdict empty string id", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1, ""], verdict: "safe" },
  });
  await run("bulk verdict invalid value", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1], verdict: "keep" },
  });
  await run("bulk verdict rationale wrong type", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1], verdict: "safe", rationale: [] },
  });
  await run("bulk verdict unknown app rolls back", {
    route: bulk,
    method: "POST",
    setup: base,
    json: { appIds: [A1, "nope"], verdict: "safe" },
  });
  await run("bulk verdict null body", {
    route: bulk,
    method: "POST",
    setup: base,
    json: null,
  });
  await bodyCases(bulk, "POST", 64 * 1024, { setup: base });
}

// ── /api/notifications ───────────────────────────────────────────────
{
  const route = "/api/notifications";
  const method = "POST";
  const seeded = [
    ...APPS,
    notification("n-1", A1, 0),
    notification("n-2", A1, 1),
    notification("n-3", A2, 0),
  ];
  await run("notifications mark read (manifest)", {
    route,
    method,
    setup: seeded,
    json: { action: "mark_read" },
  });
  await run("notifications mark unread by ids", {
    route,
    method,
    setup: seeded,
    json: { action: "mark_unread", ids: ["n-2", 5, "", "n-9", "n-1"] },
  });
  await run("notifications mark unread empty", {
    route,
    method,
    setup: seeded,
    json: { action: "mark_unread", ids: [] },
  });
  await run("notifications mark unread not array", {
    route,
    method,
    setup: seeded,
    json: { action: "mark_unread", ids: "n-2" },
  });
  await run("notifications mark unread capped at 200", {
    route,
    method,
    setup: seeded,
    json: {
      action: "mark_unread",
      ids: [...Array.from({ length: 200 }, (_, i) => `x-${i}`), "n-2"],
    },
  });
  await run("notifications unknown action", {
    route,
    method,
    setup: seeded,
    json: { action: "delete" },
  });
  await run("notifications no body", { route, method, setup: seeded });
  await run("notifications invalid json is an unknown action", {
    route,
    method,
    setup: seeded,
    raw: "{nope",
  });
  await run("notifications whitespace body", {
    route,
    method,
    setup: seeded,
    raw: "   ",
  });
  await run("notifications null body", {
    route,
    method,
    setup: seeded,
    json: null,
  });
  await run("notifications declared too large", {
    route,
    method,
    setup: seeded,
    json: {},
    contentLength: 32 * 1024 + 1,
  });
  await run("notifications streamed too large", {
    route,
    method,
    setup: seeded,
    raw: `{"pad":"${"x".repeat(32 * 1024)}"}`,
  });
}

// ── /api/annotations and /api/annotations/[id] ───────────────────────
{
  const route = "/api/annotations";
  const base = [...APPS];
  await run("annotation manifest body", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "parity note", visibility: "export" },
  });
  await run("annotation with tag, private and imported", {
    route,
    method: "POST",
    setup: base,
    json: {
      appId: A1,
      content: " tagged ",
      tag: "concern",
      visibility: "private",
      source: "imported",
      sourceName: "Mum",
    },
  });
  await run("annotation explicit null tag and source user", {
    route,
    method: "POST",
    setup: base,
    json: {
      appId: A2,
      content: "x",
      tag: null,
      source: "user",
      sourceName: null,
    },
  });
  await run("annotation blank content", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "   " },
  });
  await run("annotation content too long", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "c".repeat(8001) },
  });
  await run("annotation content at the limit", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "c".repeat(8000) },
  });
  await run("annotation bad tag", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "x", tag: "urgent" },
  });
  await run("annotation bad visibility", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "x", visibility: "public" },
  });
  await run("annotation bad source", {
    route,
    method: "POST",
    setup: base,
    json: { appId: A1, content: "x", source: "bot" },
  });
  await run("annotation missing appId", {
    route,
    method: "POST",
    setup: base,
    json: { content: "x" },
  });
  await run("annotation numeric appId", {
    route,
    method: "POST",
    setup: base,
    json: { appId: 1001, content: "x" },
  });
  await run("annotation unknown app fails the foreign key", {
    route,
    method: "POST",
    setup: base,
    json: { appId: "nope", content: "x" },
  });
  await run("annotation null body", {
    route,
    method: "POST",
    setup: base,
    json: null,
  });
  await bodyCases(route, "POST", 8 * 1024, { setup: base });

  const one = "/api/annotations/[id]";
  const seeded = [
    ...base,
    annotation("ann-1", A1, { content: "first", tag: "positive" }),
    annotation("ann-2", A1, {
      content: "recent delete",
      deletedAt: now - 10_000,
    }),
    annotation("ann-3", A1, { content: "old delete", deletedAt: now - 60_000 }),
  ];
  await run("annotation patch manifest body", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { content: "parity note (edited)" },
  });
  await run("annotation patch tag visibility content", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { tag: "follow_up", visibility: "private", content: "" },
  });
  await run("annotation patch clears tag", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { tag: null },
  });
  await run("annotation patch empty object", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: {},
  });
  await run("annotation patch content wrong type", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { content: 5 },
  });
  await run("annotation patch content too long", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { content: "c".repeat(8001) },
  });
  await run("annotation patch bad tag", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { tag: "x" },
  });
  await run("annotation patch bad visibility", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: { visibility: "x" },
  });
  await run("annotation patch missing", {
    route: one,
    method: "PATCH",
    param: "ann-9",
    setup: seeded,
    json: { content: "x" },
  });
  await run("annotation patch soft-deleted", {
    route: one,
    method: "PATCH",
    param: "ann-2",
    setup: seeded,
    json: { content: "x" },
  });
  await run("annotation patch null body", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: null,
  });
  await run("annotation patch string body", {
    route: one,
    method: "PATCH",
    param: "ann-1",
    setup: seeded,
    json: "x",
  });
  await bodyCases(one, "PATCH", 8 * 1024, { setup: seeded, param: "ann-1" });

  await run("annotation delete", {
    route: one,
    method: "DELETE",
    param: "ann-1",
    setup: seeded,
  });
  await run("annotation delete already deleted", {
    route: one,
    method: "DELETE",
    param: "ann-2",
    setup: seeded,
  });
  await run("annotation delete missing", {
    route: one,
    method: "DELETE",
    param: "ann-9",
    setup: seeded,
  });
  await run("annotation delete percent-encoded id", {
    route: one,
    method: "DELETE",
    param: "ann 1",
    setup: seeded,
  });

  await run("annotation restore within window", {
    route: one,
    method: "PUT",
    param: "ann-2",
    setup: seeded,
  });
  await run("annotation restore after window", {
    route: one,
    method: "PUT",
    param: "ann-3",
    setup: seeded,
  });
  await run("annotation restore not deleted", {
    route: one,
    method: "PUT",
    param: "ann-1",
    setup: seeded,
  });
  await run("annotation restore missing", {
    route: one,
    method: "PUT",
    param: "ann-9",
    setup: seeded,
  });
}

// ── /api/apps/[id]/acknowledge and undo ──────────────────────────────
{
  const route = "/api/apps/[id]/acknowledge";
  const method = "POST";
  const base = [
    app(A1, "Instagram", { changeCount: 3, ackAt: 500, snoozedUntil: 0 }),
    app(A2, "Signal", {
      changeCount: 0,
      ackAt: 0,
      snoozedUntil: now + 86_400_000,
    }),
    app(A3),
    app(A4),
    snapshot(
      "snap-1",
      A1,
      1000,
      1,
      JSON.stringify([
        { type: "added", label: "a" },
        { type: "removed", label: "b" },
        { type: "changed" },
      ])
    ),
    snapshot("snap-2", A1, 2000, 1, "{bad"),
    snapshot("snap-3", A1, 3000, 0, "[]"),
    snapshot("snap-4", A1, 400, 1, JSON.stringify([{ type: "added" }])),
    snapshot("snap-5", A2, 5000, 1, JSON.stringify([{ type: "added" }])),
    notification("n-1", A1, 0),
    notification("n-2", A1, 1),
    notification("n-3", A2, 0),
  ];
  await run("acknowledge manifest (no body)", {
    route,
    method,
    param: A1,
    setup: base,
  });
  await run("acknowledge empty object", {
    route,
    method,
    param: A1,
    setup: base,
    json: {},
  });
  await run("acknowledge dismissed", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: "dismissed" },
  });
  await run("acknowledge snoozed 30", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: "snoozed", snoozeDays: 30 },
  });
  await run("acknowledge snoozed string days", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: "snoozed", snoozeDays: "1" },
  });
  await run("acknowledge snoozed bad days", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: "snoozed", snoozeDays: 3 },
  });
  await run("acknowledge unsnoozed", {
    route,
    method,
    param: A2,
    setup: base,
    json: { action: "unsnoozed" },
  });
  await run("acknowledge reviewed on a snoozed app", {
    route,
    method,
    param: A2,
    setup: base,
    json: { action: " reviewed " },
  });
  await run("acknowledge non-string action", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: 5 },
  });
  await run("acknowledge invalid action", {
    route,
    method,
    param: A1,
    setup: base,
    json: { action: "later" },
  });
  await run("acknowledge unknown app", {
    route,
    method,
    param: "nope",
    setup: base,
  });
  await run("acknowledge null body", {
    route,
    method,
    param: A1,
    setup: base,
    json: null,
  });
  await run("acknowledge invalid json", {
    route,
    method,
    param: A1,
    setup: base,
    raw: "{nope",
  });
  await run("acknowledge whitespace body", {
    route,
    method,
    param: A1,
    setup: base,
    raw: " \n",
  });
  await run("acknowledge declared too large", {
    route,
    method,
    param: A1,
    setup: base,
    json: {},
    contentLength: 2049,
  });
  await run("acknowledge streamed too large", {
    route,
    method,
    param: A1,
    setup: base,
    raw: `{"pad":"${"x".repeat(2048)}"}`,
  });

  const undo = "/api/apps/[id]/acknowledge/undo";
  const withAction = [...base, reviewAction("ra-1", A1)];
  await run("undo manifest-shaped", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: {
      actionId: "ra-1",
      preState: {
        changeCount: 0,
        changesAcknowledgedAt: 0,
        changesSnoozedUntil: 0,
      },
    },
  });
  await run("undo restores floats and strings", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: {
      actionId: " ra-1 ",
      preState: {
        changeCount: "2.9",
        changesAcknowledgedAt: 100.5,
        changesSnoozedUntil: "0",
      },
    },
  });
  await run("undo wrong app", {
    route: undo,
    method,
    param: A2,
    setup: withAction,
    json: {
      actionId: "ra-1",
      preState: {
        changeCount: 0,
        changesAcknowledgedAt: 0,
        changesSnoozedUntil: 0,
      },
    },
  });
  await run("undo missing action id", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: {
      preState: {
        changeCount: 0,
        changesAcknowledgedAt: 0,
        changesSnoozedUntil: 0,
      },
    },
  });
  await run("undo missing prestate", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: { actionId: "ra-1" },
  });
  await run("undo negative prestate", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: {
      actionId: "ra-1",
      preState: {
        changeCount: -1,
        changesAcknowledgedAt: 0,
        changesSnoozedUntil: 0,
      },
    },
  });
  await run("undo no body", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
  });
  await run("undo invalid json", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    raw: "{nope",
  });
  await run("undo null body", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: null,
  });
  await run("undo declared too large", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    json: {},
    contentLength: 4097,
  });
  await run("undo streamed too large", {
    route: undo,
    method,
    param: A1,
    setup: withAction,
    raw: `{"pad":"${"x".repeat(4096)}"}`,
  });
}

// ── /api/user-tasks and /api/user-tasks/visit ────────────────────────
{
  const route = "/api/user-tasks";
  const method = "POST";
  const blob = JSON.stringify({
    version: 1,
    tasks: {
      view_privacy_map: { dismissed_at: 1_700_000_000_000, started_at: 5 },
      zzz: { started_at: 1 },
      compare_two_apps: { started_at: "soon", opted_in_at: 1_700_000_000_001 },
    },
  });
  await run("user-tasks start", {
    route,
    method,
    json: { id: "view_privacy_map", action: "start" },
  });
  await run("user-tasks start keeps key positions", {
    route,
    method,
    setup: [setting("user_tasks_state", blob)],
    json: { id: "view_privacy_map", action: "start" },
  });
  await run("user-tasks start with bypassed prerequisite", {
    route,
    method,
    json: {
      id: "review_mismatches",
      action: "start",
      missingPrerequisite: "create_privacy_profile",
    },
  });
  await run("user-tasks start with unknown prerequisite", {
    route,
    method,
    json: {
      id: "review_mismatches",
      action: "start",
      missingPrerequisite: "nope",
    },
  });
  await run("user-tasks dismiss", {
    route,
    method,
    setup: [setting("user_tasks_state", blob)],
    json: { id: "compare_two_apps", action: "dismiss" },
  });
  await run("user-tasks reset", {
    route,
    method,
    setup: [setting("user_tasks_state", blob)],
    json: { id: "view_privacy_map", action: "reset" },
  });
  await run("user-tasks reset absent", {
    route,
    method,
    setup: [setting("user_tasks_state", blob)],
    json: { id: "import_label_history", action: "reset" },
  });
  await run("user-tasks opt in", {
    route,
    method,
    json: { id: "setup_background_mode", action: "opt_in" },
  });
  await run("user-tasks opt in twice", {
    route,
    method,
    setup: [
      setting(
        "user_tasks_state",
        JSON.stringify({
          version: 1,
          tasks: { setup_background_mode: { opted_in_at: 7 } },
        })
      ),
    ],
    json: { id: "setup_background_mode", action: "opt_in" },
  });
  await run("user-tasks opt in non opt-in task", {
    route,
    method,
    json: { id: "view_privacy_map", action: "opt_in" },
  });
  await run("user-tasks clear all", {
    route,
    method,
    setup: [setting("user_tasks_state", blob)],
    json: { action: "clear_all" },
  });
  await run("user-tasks corrupt blob", {
    route,
    method,
    setup: [setting("user_tasks_state", "{nope")],
    json: { id: "view_privacy_map", action: "start" },
  });
  await run("user-tasks wrong version blob", {
    route,
    method,
    setup: [
      setting(
        "user_tasks_state",
        '{"version":2,"tasks":{"view_privacy_map":{"started_at":1}}}'
      ),
    ],
    json: { id: "compare_two_apps", action: "start" },
  });
  await run("user-tasks invalid action", {
    route,
    method,
    json: { id: "view_privacy_map", action: "finish" },
  });
  await run("user-tasks unknown id", {
    route,
    method,
    json: { id: "nope", action: "start" },
  });
  await run("user-tasks missing id", {
    route,
    method,
    json: { action: "start" },
  });
  await run("user-tasks array body", { route, method, json: [] });
  await run("user-tasks null body", { route, method, json: null });
  await bodyCases(route, method, 4 * 1024);
  await run("user-tasks rate limited", {
    route,
    method,
    repeat: 61,
    json: { action: "clear_all" },
  });

  const visit = "/api/user-tasks/visit";
  await run("visit manifest body", {
    route: visit,
    method,
    json: { surface: "app_detail" },
  });
  await run("visit already stamped", {
    route: visit,
    method,
    setup: [setting("task_visit.compare_at", "123")],
    json: { surface: "compare" },
  });
  await run("visit stamped empty", {
    route: visit,
    method,
    setup: [setting("task_visit.privacy_map_at", "")],
    json: { surface: "privacy_map" },
  });
  await run("visit invalid surface", {
    route: visit,
    method,
    json: { surface: "settings" },
  });
  await run("visit string body", { route: visit, method, json: "x" });
  await run("visit null body", { route: visit, method, json: null });
  await bodyCases(visit, method, 1024);
  await run("visit rate limited", {
    route: visit,
    method,
    repeat: 61,
    json: { surface: "compare" },
  });
}

// ── /api/activity/queue-session ──────────────────────────────────────
{
  const route = "/api/activity/queue-session";
  const method = "POST";
  await run("queue session full", {
    route,
    method,
    json: {
      totals: { decided: 3, safe: 1, replace: 1, uninstall: 1, notesAdded: 2 },
      preflight: { scope: "all", sort: "risk", split: 25 },
    },
  });
  await run("queue session manifest body", { route, method, json: {} });
  await run("queue session nothing decided", {
    route,
    method,
    json: { totals: { decided: 0, safe: 4 } },
  });
  await run("queue session string totals and unknown preflight", {
    route,
    method,
    json: {
      totals: { decided: "2", safe: "1" },
      preflight: { scope: "everything", sort: 5, split: "10" },
    },
  });
  await run("queue session null split", {
    route,
    method,
    json: { totals: { decided: 1 }, preflight: { split: null } },
  });
  await run("queue session NaN decided", {
    route,
    method,
    json: { totals: { decided: "x" } },
  });
  await run("queue session null body", { route, method, json: null });
  await bodyCases(route, method, 4 * 1024);
}

// ── /api/devices and /api/devices/[id] ───────────────────────────────
{
  const route = "/api/devices";
  const method = "POST";
  const base = [
    ...APPS,
    device(D1, "My iPhone", {
      ecid: "0xABC123",
      model: "iPhone15,2",
      lastSyncedAt: 1_700_000_000_002,
    }),
    device(D2, "Mum's iPad", {
      ownerLabel: "Mum",
      ownerAudience: "loved_one",
      ack: 1_700_000_000_000,
      lastSyncedAt: 1_700_000_000_001,
    }),
    device(D3, "Spare", { lastSyncedAt: 1_700_000_000_000 }),
    link(A1, D1),
    link(A1, D2),
    link(A2, D1),
    link(A3, D1),
    link(A4, D2),
    annotation("ann-1", A3),
    shortlist("s-1", A2, "9001"),
    importRow("imp-1", D1),
  ];
  await run("device create manifest body", {
    route,
    method,
    setup: base,
    json: { name: "Parity Device", model: "iPhone" },
  });
  await run("device create trims and nulls", {
    route,
    method,
    setup: base,
    json: {
      name: " Work phone ",
      ecid: "  ",
      model: " iPhone16,1 ",
      iosVersion: "18.0",
      deviceClass: 5,
    },
  });
  await run("device create existing ecid refreshes metadata", {
    route,
    method,
    setup: base,
    json: {
      name: "Renamed",
      ecid: " 0xABC123 ",
      model: "iPhone16,1",
      iosVersion: "18.1",
      deviceClass: "iPhone",
    },
  });
  await run("device create existing ecid unchanged", {
    route,
    method,
    setup: base,
    json: { name: "Renamed", ecid: "0xABC123", model: "iPhone15,2" },
  });
  await run("device create new ecid", {
    route,
    method,
    setup: base,
    json: { name: "New", ecid: "0xDEF" },
  });
  await run("device create with ownership and acknowledgement", {
    route,
    method,
    setup: base,
    json: {
      name: "Dad's phone",
      ownerLabel: " Dad ",
      ownerAudience: "loved_one",
      permissionAcknowledged: true,
    },
  });
  await run("device create self owner ignores acknowledgement", {
    route,
    method,
    setup: base,
    json: {
      name: "Mine",
      ownerLabel: "",
      ownerAudience: "self",
      permissionAcknowledged: true,
    },
  });
  await run("device create label only", {
    route,
    method,
    setup: base,
    json: { name: "Kid", ownerLabel: "Leo" },
  });
  await run("device create audience null", {
    route,
    method,
    setup: base,
    json: { name: "Kid", ownerAudience: null },
  });
  await run("device create existing ecid with ownership", {
    route,
    method,
    setup: base,
    json: {
      name: "x",
      ecid: "0xABC123",
      ownerAudience: "guardian",
      permissionAcknowledged: true,
    },
  });
  await run("device create bad label", {
    route,
    method,
    setup: base,
    json: { name: "x", ownerLabel: 5 },
  });
  await run("device create bad audience", {
    route,
    method,
    setup: base,
    json: { name: "x", ownerAudience: "friend" },
  });
  await run("device create bad acknowledgement", {
    route,
    method,
    setup: base,
    json: { name: "x", permissionAcknowledged: "yes" },
  });
  await run("device create missing name", {
    route,
    method,
    setup: base,
    json: { model: "iPhone" },
  });
  await run("device create blank name", {
    route,
    method,
    setup: base,
    json: { name: "   " },
  });
  await run("device create array body", {
    route,
    method,
    setup: base,
    json: [],
  });
  await run("device create null body", {
    route,
    method,
    setup: base,
    json: null,
  });
  await bodyCases(route, method, 4 * 1024, { setup: base });
  await run("device create rate limited", {
    route,
    method,
    setup: base,
    repeat: 21,
    json: { name: "x" },
  });

  const one = "/api/devices/[id]";
  await run("device patch manifest body", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { name: "Parity Device (edited)" },
  });
  await run("device patch name and owner", {
    route: one,
    method: "PATCH",
    param: D3,
    setup: base,
    json: {
      name: " Nan's tablet ",
      ownerLabel: "Nan",
      ownerAudience: "loved_one",
      permissionAcknowledged: true,
    },
  });
  await run("device patch owner to self clears acknowledgement", {
    route: one,
    method: "PATCH",
    param: D2,
    setup: base,
    json: { ownerAudience: "self" },
  });
  await run("device patch clear owner", {
    route: one,
    method: "PATCH",
    param: D2,
    setup: base,
    json: { ownerLabel: null, ownerAudience: null },
  });
  await run("device patch acknowledge only", {
    route: one,
    method: "PATCH",
    param: D2,
    setup: base,
    json: { permissionAcknowledged: true },
  });
  await run("device patch withdraw acknowledgement", {
    route: one,
    method: "PATCH",
    param: D2,
    setup: base,
    json: { permissionAcknowledged: false },
  });
  await run("device patch acknowledge unowned", {
    route: one,
    method: "PATCH",
    param: D3,
    setup: base,
    json: { permissionAcknowledged: true },
  });
  await run("device patch label only blank", {
    route: one,
    method: "PATCH",
    param: D2,
    setup: base,
    json: { ownerLabel: "  " },
  });
  await run("device patch merge", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { mergeIntoDeviceId: D2 },
  });
  await run("device patch merge with name ignored", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { mergeIntoDeviceId: ` ${D2} `, name: "ignored" },
  });
  await run("device patch merge into self", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { mergeIntoDeviceId: D1 },
  });
  await run("device patch merge into missing", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { mergeIntoDeviceId: "d-nine" },
  });
  await run("device patch merge blank falls through", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { mergeIntoDeviceId: "  ", name: "Kept" },
  });
  await run("device patch nothing to update", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { name: "  ", other: 1 },
  });
  await run("device patch bad label", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { ownerLabel: 5 },
  });
  await run("device patch bad audience", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { ownerAudience: "friend" },
  });
  await run("device patch bad acknowledgement", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: { permissionAcknowledged: "yes" },
  });
  await run("device patch missing device", {
    route: one,
    method: "PATCH",
    param: "d-nine",
    setup: base,
    json: { name: "x" },
  });
  await run("device patch missing device with oversized body", {
    route: one,
    method: "PATCH",
    param: "d-nine",
    setup: base,
    raw: `{"pad":"${"x".repeat(4096)}"}`,
  });
  await run("device patch array body", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: [],
  });
  await run("device patch null body", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    json: null,
  });
  await bodyCases(one, "PATCH", 4 * 1024, { setup: base, param: D1 });
  await run("device patch rate limited", {
    route: one,
    method: "PATCH",
    param: D1,
    setup: base,
    repeat: 31,
    json: { name: "x" },
  });

  await run("device delete with orphan sweep", {
    route: one,
    method: "DELETE",
    param: D1,
    setup: base,
  });
  await run("device delete leaf device", {
    route: one,
    method: "DELETE",
    param: D3,
    setup: base,
  });
  await run("device delete keeps app with verdict", {
    route: one,
    method: "DELETE",
    param: D2,
    setup: [...base, verdict("v-1", A4, "safe")],
  });
  await run("device delete imported verdict does not protect", {
    route: one,
    method: "DELETE",
    param: D2,
    setup: [...base, verdict("v-1", A4, "safe", "imported", "Mum")],
  });
  await run("device delete missing", {
    route: one,
    method: "DELETE",
    param: "d-nine",
    setup: base,
  });
  await run("device delete rate limited", {
    route: one,
    method: "DELETE",
    param: "d-nine",
    setup: base,
    repeat: 16,
  });

  const scope = "/api/device-scope";
  await run("scope save subset", {
    route: scope,
    method: "PUT",
    setup: base,
    json: {
      scope: {
        mode: "subset",
        deviceIds: [D2, "nope", D1, D1],
        includeUnattached: false,
      },
    },
  });
  await run("scope save unattached only", {
    route: scope,
    method: "PUT",
    setup: base,
    json: { scope: { mode: "subset", deviceIds: [], includeUnattached: true } },
  });
  await run("scope save everything collapses", {
    route: scope,
    method: "PUT",
    setup: base,
    json: {
      scope: {
        mode: "subset",
        deviceIds: [D1, D2, D3],
        includeUnattached: true,
      },
    },
  });
  await run("scope save empty subset", {
    route: scope,
    method: "PUT",
    setup: base,
    json: { scope: { mode: "subset", deviceIds: ["nope"] } },
  });
  await run("scope save mode all", {
    route: scope,
    method: "PUT",
    setup: base,
    json: { scope: { mode: "all", deviceIds: [D1] } },
  });
  await run("scope save array scope", {
    route: scope,
    method: "PUT",
    setup: base,
    json: { scope: [] },
  });
  await run("scope save non-string ids", {
    route: scope,
    method: "PUT",
    setup: base,
    json: {
      scope: { mode: "subset", deviceIds: [5, D3], includeUnattached: "yes" },
    },
  });
  await run("scope save string scope", {
    route: scope,
    method: "PUT",
    setup: base,
    json: { scope: "all" },
  });
  await run("scope save missing", {
    route: scope,
    method: "PUT",
    setup: base,
    json: {},
  });
  await run("scope save null body", {
    route: scope,
    method: "PUT",
    setup: base,
    json: null,
  });
  await bodyCases(scope, "PUT", 8 * 1024, { setup: base });
  await run("scope save rate limited", {
    route: scope,
    method: "PUT",
    setup: base,
    repeat: 61,
    json: { scope: { mode: "all" } },
  });
  await run("scope reset", {
    route: scope,
    method: "DELETE",
    setup: [
      ...base,
      setting(
        "device.scope",
        '{"v":1,"mode":"subset","deviceIds":["d-one"],"includeUnattached":false}'
      ),
    ],
  });
  await run("scope reset no devices", { route: scope, method: "DELETE" });
  await run("scope reset rate limited", {
    route: scope,
    method: "DELETE",
    setup: base,
    repeat: 21,
  });
}

// ── /api/manual-apps ─────────────────────────────────────────────────
{
  const route = "/api/manual-apps";
  await run("manual create manifest body", {
    route,
    method: "POST",
    json: {
      name: "Parity Manual App",
      developer: "Parity",
      source: "sideloaded",
    },
  });
  await run("manual create every field", {
    route,
    method: "POST",
    json: {
      name: " Beta ",
      source: "testflight",
      developer: "  ",
      privacyPolicyUrl: " HTTPS://Example.com/privacy ",
      sourceUrl: "https://testflight.apple.com/join/abc",
      notes: " keep ",
    },
  });
  await run("manual create bad policy url", {
    route,
    method: "POST",
    json: {
      name: "x",
      source: "web_clip",
      privacyPolicyUrl: "ftp://x.example/",
    },
  });
  await run("manual create private source url", {
    route,
    method: "POST",
    json: { name: "x", source: "web_clip", sourceUrl: "http://10.0.0.1/" },
  });
  await run("manual create blank name", {
    route,
    method: "POST",
    json: { name: "  ", source: "web_clip" },
  });
  await run("manual create numeric name", {
    route,
    method: "POST",
    json: { name: 5, source: "own_build" },
  });
  await run("manual create bad source", {
    route,
    method: "POST",
    json: { name: "x", source: "appstore" },
  });
  await run("manual create null body", { route, method: "POST", json: null });
  await run("manual create string body", { route, method: "POST", json: "x" });
  await bodyCases(route, "POST", 8 * 1024);
  await adminCases(route, "POST", {
    json: { name: "x", source: "sideloaded" },
  });
  await run("manual create rate limited", {
    route,
    method: "POST",
    repeat: 31,
    json: { name: "x", source: "sideloaded" },
  });

  const one = "/api/manual-apps/[id]";
  const seeded = [
    manualApp("m-1", "Alpha", {
      developer: "Dev",
      notes: "n",
      sourceUrl: "https://a.example/",
    }),
    manualApp("m-2", "Beta", {
      source: "testflight",
      updatedAt: 1_700_000_000_001,
    }),
    manualEvent("ev-1", "m-1"),
    policyVersion("pv-1", "m-1"),
  ];
  await run("manual update manifest body", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: { name: "Parity Manual App (edited)" },
  });
  await run("manual update several fields", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: {
      name: "Alpha",
      developer: null,
      privacyPolicyUrl: "https://p.example/",
      sourceUrl: "  ",
      notes: 5,
      source: "own_build",
    },
  });
  await run("manual update empty object", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: {},
  });
  await run("manual update blank name", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: { name: " " },
  });
  await run("manual update bad source", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: { source: "x" },
  });
  await run("manual update bad url", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: { privacyPolicyUrl: "nope" },
  });
  await run("manual update missing", {
    route: one,
    method: "PUT",
    param: "m-9",
    setup: seeded,
    json: { name: "x" },
  });
  await run("manual update long id", {
    route: one,
    method: "PUT",
    param: "m".repeat(129),
    setup: seeded,
    json: { name: "x" },
  });
  await run("manual update null body", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: null,
  });
  await run("manual update string body", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    json: "x",
  });
  await bodyCases(one, "PUT", 8 * 1024, { setup: seeded, param: "m-1" });
  await adminCases(one, "PUT", {
    setup: seeded,
    param: "m-1",
    json: { name: "x" },
  });
  await run("manual update rate limited", {
    route: one,
    method: "PUT",
    param: "m-1",
    setup: seeded,
    repeat: 31,
    json: { name: "x" },
  });

  await run("manual delete", {
    route: one,
    method: "DELETE",
    param: "m-1",
    setup: seeded,
  });
  await run("manual delete missing", {
    route: one,
    method: "DELETE",
    param: "m-9",
    setup: seeded,
  });
  await run("manual delete long id", {
    route: one,
    method: "DELETE",
    param: "m".repeat(129),
    setup: seeded,
  });
  await adminCases(one, "DELETE", { setup: seeded, param: "m-2" });
  await run("manual delete rate limited", {
    route: one,
    method: "DELETE",
    param: "m-9",
    setup: seeded,
    repeat: 31,
  });

  const bulk = "/api/manual-apps/bulk";
  await run("manual bulk manifest body", {
    route: bulk,
    method: "POST",
    json: {
      apps: [
        { name: "Parity Bulk App", developer: "Parity", source: "sideloaded" },
      ],
    },
  });
  await run("manual bulk mixed rows", {
    route: bulk,
    method: "POST",
    json: {
      apps: [
        null,
        { name: "x", source: "appstore" },
        { name: "  ", source: "web_clip" },
        {
          name: " Good ",
          source: "own_build",
          developer: 5,
          privacyPolicyUrl: "ftp://ignored",
        },
        "str",
      ],
    },
  });
  await run("manual bulk all failed", {
    route: bulk,
    method: "POST",
    json: { apps: [{ name: "", source: "web_clip" }] },
  });
  await run("manual bulk empty", {
    route: bulk,
    method: "POST",
    json: { apps: [] },
  });
  await run("manual bulk not array", {
    route: bulk,
    method: "POST",
    json: { apps: "x" },
  });
  await run("manual bulk too many", {
    route: bulk,
    method: "POST",
    json: {
      apps: Array.from({ length: 1001 }, () => ({
        name: "x",
        source: "web_clip",
      })),
    },
  });
  await run("manual bulk null body", {
    route: bulk,
    method: "POST",
    json: null,
  });
  await bodyCases(bulk, "POST", 256 * 1024);
  await adminCases(bulk, "POST", {
    json: { apps: [{ name: "x", source: "web_clip" }] },
  });
  await run("manual bulk rate limited", {
    route: bulk,
    method: "POST",
    repeat: 11,
    json: { apps: [{ name: "x", source: "web_clip" }] },
  });

  const restore = "/api/manual-apps/[id]/restore";
  const snapshotBody = {
    id: "m-9",
    name: " Restored ",
    source: "web_clip",
    developer: "Dev",
    privacyPolicyUrl: "https://p.example/",
    sourceUrl: null,
    notes: 5,
    firstSeen: 1_690_000_000_000,
    updatedAt: 1_695_000_000_000,
  };
  await run("manual restore", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: snapshotBody,
  });
  await run("manual restore bad timestamps", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: { ...snapshotBody, firstSeen: "x", updatedAt: 5 },
  });
  await run("manual restore updated before first", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: { ...snapshotBody, firstSeen: 2_000_000_000_000.7, updatedAt: 1_000 },
  });
  await run("manual restore id mismatch", {
    route: restore,
    method: "POST",
    param: "m-8",
    setup: seeded,
    json: snapshotBody,
  });
  await run("manual restore bad source", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: { ...snapshotBody, source: "x" },
  });
  await run("manual restore existing", {
    route: restore,
    method: "POST",
    param: "m-1",
    setup: seeded,
    json: { ...snapshotBody, id: "m-1" },
  });
  await run("manual restore blank name", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: { ...snapshotBody, name: " " },
  });
  await run("manual restore long id", {
    route: restore,
    method: "POST",
    param: "m".repeat(129),
    setup: seeded,
    json: snapshotBody,
  });
  await run("manual restore null body", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    json: null,
  });
  await bodyCases(restore, "POST", 8 * 1024, { setup: seeded, param: "m-9" });
  await adminCases(restore, "POST", {
    setup: seeded,
    param: "m-9",
    json: snapshotBody,
  });
  await run("manual restore rate limited", {
    route: restore,
    method: "POST",
    param: "m-9",
    setup: seeded,
    repeat: 31,
    json: { ...snapshotBody, id: "m-8" },
  });
}

writeFileSync(
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../tests/fixtures/library-cases.json"
  ),
  `${JSON.stringify({ now, cases }, null, 1)}\n`
);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  `Recorded ${cases.length} actual Node library-write cases; no network.`
);
