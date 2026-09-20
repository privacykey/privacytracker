/**
 * Device-route oracle for the Rust server (Phase 6, batch 2a).
 *
 * Runs the REAL Next handlers of the five device routes Phase 4 set aside
 * — `POST /api/device-actions/backup`, `GET` and `POST
 * /api/device-actions/uninstall`, `POST /api/device-sync/preview` and
 * `POST /api/device-sync/commit` — against a scratch database and a
 * MobileSync-shaped directory tree, and records, per case, the request,
 * the setup rows, every write in order with its transaction markers, the
 * ten tables these routes can touch, and the wire response.
 *
 * The backup check reads the disk. The tree is described as data
 * (`tree`, written into the fixture) so the replay builds the same one;
 * it lives under a scratch base whose realpath is spelled `<BASE>`
 * everywhere in the fixture (requests, setup, responses, writes, rows).
 * Every Manifest.db mtime is set relative to the frozen clock, which is
 * behind the wall clock: a file written now would read as from the
 * future.
 *
 * Determinism as the library oracle: frozen clock, counted ids (both the
 * global `crypto` and `node:crypto`), a distinct forwarded address per
 * case, `repeat` for the limit+1 bursts, and each case in a SAVEPOINT.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const BASE = realpathSync(
  mkdtempSync(path.join(tmpdir(), "pt-device-oracle-"))
);
const DATA_DIR = path.join(BASE, "data");
mkdirSync(DATA_DIR);
const ROOT = path.join(BASE, "MobileSync", "Backup");
process.env.PRIVACYTRACKER_DATA_DIR = DATA_DIR;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
process.env.PRIVACYTRACKER_TEST_MOBILESYNC_ROOT = ROOT;
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

// ── The disk ─────────────────────────────────────────────────────────
const HOUR = 3_600_000;
/** Relative to BASE, created in this order. */
const TREE = [
  {
    path: "MobileSync/Backup/FRESH/Manifest.db",
    kind: "file",
    size: 1024,
    mtime: now - HOUR,
  },
  {
    path: "MobileSync/Backup/SECOND/Manifest.db",
    kind: "file",
    size: 2048,
    mtime: now - 2 * HOUR,
  },
  {
    path: "MobileSync/Backup/STALE/Manifest.db",
    kind: "file",
    size: 512,
    mtime: now - 48 * HOUR,
  },
  {
    path: "MobileSync/Backup/EMPTY/Manifest.db",
    kind: "file",
    size: 0,
    mtime: now - HOUR,
  },
  {
    path: "MobileSync/Backup/FUTURE/Manifest.db",
    kind: "file",
    size: 100,
    mtime: now + HOUR,
  },
  { path: "MobileSync/Backup/NOMANIFEST", kind: "dir" },
  { path: "MobileSync/Backup/DIRMANIFEST/Manifest.db", kind: "dir" },
  { path: "MobileSync/Backup/LINKMANIFEST", kind: "dir" },
  {
    path: "MobileSync/Backup/LINKMANIFEST/Manifest.db",
    kind: "symlink",
    target: "../FRESH/Manifest.db",
  },
  { path: "MobileSync/Backup/LINKED", kind: "symlink", target: "FRESH" },
  {
    path: "MobileSync/Backup/FILEENTRY",
    kind: "file",
    size: 10,
    mtime: now - HOUR,
  },
  {
    path: "MobileSync/Backup/NESTED/INNER/Manifest.db",
    kind: "file",
    size: 100,
    mtime: now - HOUR,
  },
  {
    path: "Elsewhere/Manifest.db",
    kind: "file",
    size: 100,
    mtime: now - HOUR,
  },
  // The root's parent, with a Manifest.db of its own, so only the
  // direct-child test refuses it: `path.relative` spells it `..`, one
  // segment with no separator.
  {
    path: "MobileSync/Manifest.db",
    kind: "file",
    size: 300,
    mtime: now - HOUR,
  },
  // The root, with a Manifest.db of its own, so only the direct-child test
  // refuses it too: its relative form is empty.
  {
    path: "MobileSync/Backup/Manifest.db",
    kind: "file",
    size: 200,
    mtime: now - HOUR,
  },
];
for (const entry of TREE) {
  const full = path.join(BASE, entry.path);
  mkdirSync(path.dirname(full), { recursive: true });
  if (entry.kind === "dir") {
    mkdirSync(full, { recursive: true });
  } else if (entry.kind === "symlink") {
    symlinkSync(entry.target, full);
  } else {
    writeFileSync(full, "x".repeat(entry.size));
    utimesSync(full, entry.mtime / 1000, entry.mtime / 1000);
  }
}
const at = (relative) => path.join(ROOT, relative);

// ── The database, recorded ──────────────────────────────────────────
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

const handlers = {
  "/api/device-actions/backup": await import(
    "../../app/api/device-actions/backup/route.ts"
  ),
  "/api/device-actions/uninstall": await import(
    "../../app/api/device-actions/uninstall/route.ts"
  ),
  "/api/device-sync/preview": await import(
    "../../app/api/device-sync/preview/route.ts"
  ),
  "/api/device-sync/commit": await import(
    "../../app/api/device-sync/commit/route.ts"
  ),
};

for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = [
  "apps",
  "devices",
  "app_devices",
  "annotations",
  "app_verdicts",
  "shortlist_entries",
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
const A5 = "1005";
const A6 = "1006";
const D1 = "d-one";
const D2 = "d-two";
const ECID = "0x9118908BB6027";
const ECID_KEY = "9118908BB6027";
const app = (id, name = `App ${id}`, bundleId = null) =>
  stmt(
    "INSERT INTO apps (id, name, url, bundleId, firstSeen, lastSynced, changeCount) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    `https://apps.apple.com/us/app/x/id${id}`,
    bundleId,
    1_600_000_000_000,
    1_600_000_000_000,
    0
  );
const device = (id, name, extra = {}) =>
  stmt(
    "INSERT INTO devices (id, name, ecid, model, ios_version, device_class, created_at, last_synced_at, is_unknown_placeholder, owner_label, owner_audience, permission_acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    name,
    extra.ecid ?? null,
    null,
    null,
    null,
    1_700_000_000_000,
    1_700_000_000_000,
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
const annotation = (id, appId) =>
  stmt(
    "INSERT INTO annotations (id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "a note",
    "user",
    null,
    "export",
    null,
    1_700_000_000_000,
    1_700_000_000_000,
    null
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
const shortlist = (id, source, candidate, name) =>
  stmt(
    "INSERT INTO shortlist_entries (id, source_app_id, candidate_apple_id, candidate_name, candidate_developer, candidate_icon_url, candidate_store_url, candidate_bundle_id, note, added_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    source,
    candidate,
    name,
    null,
    null,
    `https://apps.apple.com/us/app/x/id${candidate}`,
    null,
    null,
    1_700_000_000_000,
    "privacy"
  );
const snapshot = (id, appId) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source) VALUES (?, ?, ?, ?, ?, ?, 'live')",
    id,
    appId,
    1_700_000_000_000,
    "[]",
    0,
    null
  );
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const audience = (value) => setting("flag.focus.audience", value);
const FLAG_ON = stmt(
  "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, quarantined) VALUES (?, ?, ?, ?, 0)",
  "flag.devopts.cfgutil_uninstall",
  "on",
  1_700_000_000_000,
  "user"
);
const stamp = (value, key = ECID_KEY) =>
  setting(
    `cfgutil_last_backup_${key}`,
    typeof value === "string" ? value : JSON.stringify(value)
  );
const freshStamp = {
  finishedAt: now - HOUR,
  manifestBytes: 1024,
  path: at("FRESH"),
};

// ── The runner ───────────────────────────────────────────────────────
const anon = (value) =>
  JSON.parse(JSON.stringify(value).split(BASE).join("<BASE>"));

const cases = [];
let ipCounter = 0;
async function run(name, spec) {
  const {
    route,
    method = "POST",
    search = "",
    json,
    raw,
    headers = {},
    setup = [],
    repeat = 1,
    contentLength,
    mobileSyncRoot = null,
  } = spec;
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.2`;
  const body = json === undefined ? (raw ?? null) : JSON.stringify(json);
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "device-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  process.env.PRIVACYTRACKER_TEST_MOBILESYNC_ROOT =
    mobileSyncRoot === null ? ROOT : path.join(BASE, mobileSyncRoot);
  db.exec("SAVEPOINT device_case");
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
        `http://127.0.0.1:3000${route}${search}`,
        {
          method,
          headers: sent,
          body: body === null ? undefined : body,
        }
      );
      try {
        const response = await handlers[route][method](request);
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
    cases.push(
      anon({
        name,
        route,
        method,
        search,
        query: [...new URLSearchParams(search)],
        headers: sent,
        body,
        repeat,
        mobileSyncRoot,
        setup,
        stream,
        rows,
        expected,
      })
    );
  } finally {
    recording = null;
    db.exec("ROLLBACK TO device_case; RELEASE device_case");
  }
}

async function bodyCases(route, limit, extra = {}) {
  await run(`${route} empty body`, { route, ...extra });
  await run(`${route} invalid json`, { route, raw: "{not json", ...extra });
  await run(`${route} whitespace body`, { route, raw: "  \n ", ...extra });
  await run(`${route} declared too large`, {
    route,
    json: {},
    contentLength: limit + 1,
    ...extra,
  });
  await run(`${route} streamed too large`, {
    route,
    raw: `{"pad":"${"x".repeat(limit)}"}`,
    ...extra,
  });
}

// ── POST /api/device-actions/backup ──────────────────────────────────
{
  const route = "/api/device-actions/backup";
  const record = (overrides = {}) => ({
    ecid: ECID,
    path: at("FRESH"),
    deviceName: "Kid's iPad",
    ...overrides,
  });
  await run("backup: refused for a helper audience, before the body", {
    route,
    setup: [audience("loved_one")],
    json: record(),
  });
  await run("backup: the audience refusal beats an unreadable body", {
    route,
    setup: [audience("guardian")],
    raw: "{not json",
  });
  await run("backup: an unknown stored audience is not self", {
    route,
    setup: [audience("martian")],
    json: record(),
  });
  await bodyCases(route, 8 * 1024);
  await run("backup: a JSON null body", { route, raw: "null" });
  await run("backup: an array body", { route, json: [] });
  await run("backup: no ecid", { route, json: { path: at("FRESH") } });
  await run("backup: a numeric ecid", {
    route,
    json: record({ ecid: 9_118_908 }),
  });
  await run("backup: an ecid that is not hex", {
    route,
    json: record({ ecid: "0xNOTHEXATALL" }),
  });
  await run("backup: an ecid seven digits long", {
    route,
    json: record({ ecid: "0x1234567" }),
  });
  await run("backup: an ecid twenty-five digits long", {
    route,
    json: record({ ecid: "1234567890123456789012345" }),
  });
  await run("backup: no path", { route, json: { ecid: ECID } });
  await run("backup: an empty path", { route, json: record({ path: "" }) });
  await run("backup: a numeric path", { route, json: record({ path: 7 }) });
  const refusals = [
    ["a relative path", "relative/FRESH"],
    ["a symlinked backup", at("LINKED")],
    ["a path that does not exist", at("NOPE")],
    ["a backup outside the root", path.join(BASE, "Elsewhere")],
    ["a nested backup", at("NESTED/INNER")],
    ["a file where the backup should be", at("FILEENTRY")],
    ["a backup with no manifest", at("NOMANIFEST")],
    ["a manifest that is a directory", at("DIRMANIFEST")],
    ["a symlinked manifest", at("LINKMANIFEST")],
    ["an empty manifest", at("EMPTY")],
    ["a manifest from the future", at("FUTURE")],
  ];
  for (const [label, target] of refusals) {
    await run(`backup: ${label}`, { route, json: record({ path: target }) });
  }
  await run("backup: the MobileSync root is missing", {
    route,
    json: record(),
    mobileSyncRoot: "Missing/Backup",
  });
  await run("backup: recorded, the name trimmed into the summary", {
    route,
    json: record({ deviceName: "  Kid's iPad  " }),
  });
  await run("backup: recorded with a blank name", {
    route,
    json: record({ deviceName: "   " }),
  });
  await run("backup: recorded with no name", {
    route,
    json: { ecid: ECID, path: at("FRESH") },
  });
  await run("backup: recorded with a numeric name", {
    route,
    json: record({ deviceName: 42 }),
  });
  await run("backup: a lower-case ecid keys the upper-case stamp", {
    route,
    json: record({ ecid: "  0x9118908bb6027 " }),
  });
  await run("backup: an older backup replaces the stamp", {
    route,
    setup: [stamp(freshStamp)],
    json: record({ path: at("SECOND") }),
  });
  await run("backup: a client completion time is ignored", {
    route,
    json: record({ finishedAt: now + 999_999 }),
  });
  await run("backup: a trailing slash canonicalises", {
    route,
    json: record({ path: `${at("FRESH")}/` }),
  });
  await run("backup: a dot-dot path canonicalises", {
    route,
    json: record({ path: at("NOMANIFEST/../FRESH") }),
  });
  await run("backup: the root's parent is not a child", {
    route,
    json: record({ path: path.join(BASE, "MobileSync") }),
  });
}

// ── GET /api/device-actions/uninstall ────────────────────────────────
{
  const route = "/api/device-actions/uninstall";
  const get = (name, search, setup = []) =>
    run(`uninstall GET: ${name}`, { route, method: "GET", search, setup });
  const q = (ecid = ECID, extra = "") =>
    `?ecid=${encodeURIComponent(ecid)}${extra}`;
  await get("no ecid", "");
  await get("an empty ecid", "?ecid=");
  await get("the flag is off by default", q());
  await get("no backup yet", q(), [FLAG_ON]);
  await get(
    "the backup acknowledged with 1",
    q(ECID, "&acknowledgeNoBackup=1"),
    [FLAG_ON]
  );
  await get(
    "the backup acknowledged with true",
    q(ECID, "&acknowledgeNoBackup=true"),
    [FLAG_ON]
  );
  await get(
    "only 1 or true acknowledge",
    q(ECID, "&acknowledgeNoBackup=TRUE&acknowledgeNoBackup=1"),
    [FLAG_ON]
  );
  await get("the first ecid wins", `?ecid=${ECID}&ecid=zz`, [
    FLAG_ON,
    stamp(freshStamp),
  ]);
  await get("a fresh backup", q(), [FLAG_ON, stamp(freshStamp)]);
  await get("a stale backup", q(), [
    FLAG_ON,
    stamp({
      finishedAt: now - 48 * HOUR,
      manifestBytes: 512,
      path: at("STALE"),
    }),
  ]);
  await get("a fresh stamp over a stale manifest", q(), [
    FLAG_ON,
    stamp({ finishedAt: now - HOUR, manifestBytes: 512, path: at("STALE") }),
  ]);
  await get("a stamp whose backup is gone", q(), [
    FLAG_ON,
    stamp({ finishedAt: now - HOUR, manifestBytes: 1024, path: at("NOPE") }),
  ]);
  await get("an unreadable stamp", q(), [FLAG_ON, stamp("{broken")]);
  await get("a stamp of null", q(), [FLAG_ON, stamp("null")]);
  await get("a stamp from the future", q(), [
    FLAG_ON,
    stamp({ finishedAt: now + 1, path: at("FRESH") }),
  ]);
  await get("a stamp with a string time", q(), [
    FLAG_ON,
    stamp({ finishedAt: String(now - HOUR), path: at("FRESH") }),
  ]);
  await get("a stamp with no size and a numeric path", q(), [
    FLAG_ON,
    stamp({ finishedAt: now - HOUR, manifestBytes: "1024", path: 5 }),
  ]);
  await get("a stamp read under another spelling", q("9118908bb6027"), [
    FLAG_ON,
    stamp(freshStamp),
  ]);
  await get("an ecid that does not parse", q("zz"), [
    FLAG_ON,
    stamp(freshStamp),
  ]);
  await get("a helper audience with no device", q(), [
    FLAG_ON,
    audience("loved_one"),
  ]);
  await get("someone else's device, no permission yet", q(), [
    FLAG_ON,
    audience("loved_one"),
    device(D1, "Mum's iPhone", {
      ecid: "9118908bb6027",
      ownerLabel: "  Mum  ",
      ownerAudience: "loved_one",
    }),
  ]);
  await get("someone else's device in self mode", q(), [
    FLAG_ON,
    device(D1, "Mum's iPhone", {
      ecid: ECID,
      ownerLabel: "Mum",
      ownerAudience: "loved_one",
      ack: 1_700_000_000_000,
    }),
  ]);
  await get("someone else's device with permission, backed up", q(), [
    FLAG_ON,
    audience("loved_one"),
    stamp(freshStamp),
    device(D1, "Mum's iPhone", {
      ecid: ECID,
      ownerLabel: "Mum",
      ownerAudience: "loved_one",
      ack: 1_700_000_000_000,
    }),
  ]);
  await get("a permission stamp of zero is no permission", q(), [
    FLAG_ON,
    audience("guardian"),
    device(D1, "Leo's iPad", {
      ecid: ECID,
      ownerAudience: "guardian",
      ack: 0,
    }),
  ]);
  await get("my own device in self mode, flag off", q(), [
    device(D1, "My iPhone", { ecid: ECID, ownerAudience: "self" }),
  ]);
  await get("an unrecognised owner reads as none", q(), [
    FLAG_ON,
    audience("loved_one"),
    device(D1, "Odd", { ecid: ECID, ownerAudience: "martian" }),
  ]);
  await get("the first matching device wins", q(), [
    FLAG_ON,
    device(D1, "First", {
      ecid: "0x9118908bb6027",
      ownerAudience: "guardian",
      ownerLabel: "   ",
    }),
    device(D2, "Second", { ecid: ECID_KEY, ownerAudience: "self" }),
  ]);
}

// ── POST /api/device-actions/uninstall ───────────────────────────────
{
  const route = "/api/device-actions/uninstall";
  const outcome = (overrides = {}) => ({
    ecid: ECID,
    bundleId: "com.burbn.instagram",
    appId: A1,
    appName: "Instagram",
    ok: true,
    error: null,
    acknowledgeNoBackup: true,
    ...overrides,
  });
  const allowed = [FLAG_ON];
  await bodyCases(route, 8 * 1024);
  await run("uninstall POST: a JSON null body throws", { route, raw: "null" });
  await run("uninstall POST: a string body", { route, json: "x" });
  await run("uninstall POST: an array body", { route, json: [] });
  await run("uninstall POST: no ecid", {
    route,
    json: outcome({ ecid: undefined }),
  });
  await run("uninstall POST: a numeric ecid", {
    route,
    json: outcome({ ecid: 5 }),
  });
  await run("uninstall POST: no bundle id", {
    route,
    json: outcome({ bundleId: "" }),
  });
  await run("uninstall POST: a numeric bundle id", {
    route,
    json: outcome({ bundleId: 5 }),
  });
  await run("uninstall POST: no outcome", {
    route,
    json: outcome({ ok: undefined }),
  });
  await run("uninstall POST: a string outcome", {
    route,
    json: outcome({ ok: "true" }),
  });
  await run("uninstall POST: refused while the flag is off", {
    route,
    json: outcome(),
  });
  await run("uninstall POST: refused for a helper audience", {
    route,
    setup: [FLAG_ON, audience("loved_one")],
    json: outcome(),
  });
  await run("uninstall POST: an acknowledgement must be true", {
    route,
    setup: allowed,
    json: outcome({ acknowledgeNoBackup: "true" }),
  });
  await run("uninstall POST: recorded without a backup, acknowledged", {
    route,
    setup: allowed,
    json: outcome(),
  });
  await run("uninstall POST: recorded with a fresh backup", {
    route,
    setup: [FLAG_ON, stamp(freshStamp)],
    json: outcome({ acknowledgeNoBackup: false }),
  });
  await run("uninstall POST: a failure is recorded too", {
    route,
    setup: allowed,
    json: outcome({ ok: false, error: "cfgutil exited 1" }),
  });
  await run("uninstall POST: no name falls back to the bundle id", {
    route,
    setup: allowed,
    json: outcome({ appName: undefined, appId: undefined, error: undefined }),
  });
  await run("uninstall POST: an empty name is kept", {
    route,
    setup: allowed,
    json: outcome({ appName: "" }),
  });
  await run("uninstall POST: a numeric name", {
    route,
    setup: allowed,
    json: outcome({ appName: 42.5, error: 1.5e300 }),
  });
  await run("uninstall POST: a boolean name", {
    route,
    setup: allowed,
    json: outcome({ appName: false }),
  });
  await run("uninstall POST: an object name", {
    route,
    setup: allowed,
    json: outcome({ appName: { a: 1 } }),
  });
  await run("uninstall POST: an array name", {
    route,
    setup: allowed,
    json: outcome({ appName: [1, [2, null], "x"] }),
  });
  await run("uninstall POST: a numeric app id binds as a double", {
    route,
    setup: allowed,
    json: outcome({ appId: 12_345 }),
  });
  await run("uninstall POST: a boolean app id cannot bind", {
    route,
    setup: allowed,
    json: outcome({ appId: true }),
  });
  await run("uninstall POST: an object app id cannot bind", {
    route,
    setup: allowed,
    json: outcome({ appId: { x: 1 } }),
  });
}

// ── POST /api/device-sync/preview ────────────────────────────────────
{
  const route = "/api/device-sync/preview";
  const fleet = [
    app(A1, "Instagram", "com.burbn.instagram"),
    app(A2, "Signal", "org.whispersystems.signal"),
    app(A3, "Maps", null),
    app(A4, "Notes", "com.apple.notes"),
    app(A5, "Signal (old)", "org.whispersystems.signal"),
    app(A6, "Threads", "com.burbn.barcelona"),
    device(D1, "My iPhone"),
    device(D2, "My iPad"),
    link(A1, D1),
    link(A2, D1),
    link(A3, D1),
    link(A5, D1),
  ];
  await run("preview: the limit, then refused with Retry-After", {
    route,
    repeat: 31,
    setup: fleet,
    json: { deviceId: D1, currentImport: [] },
  });
  await bodyCases(route, 512 * 1024);
  for (const [label, value] of [
    ["a null", null],
    ["a string", "x"],
    ["a number", 5],
  ]) {
    await run(`preview: ${label} body`, { route, json: value });
  }
  await run("preview: an array body has no device", { route, json: [] });
  await run("preview: no device", { route, json: { currentImport: [] } });
  await run("preview: a numeric device", {
    route,
    json: { deviceId: 5, currentImport: [] },
  });
  await run("preview: a blank device", {
    route,
    json: { deviceId: "  ", currentImport: [] },
  });
  await run("preview: no import list", { route, json: { deviceId: D1 } });
  await run("preview: an import list that is an object", {
    route,
    json: { deviceId: D1, currentImport: {} },
  });
  await run("preview: more than two thousand apps", {
    route,
    json: {
      deviceId: D1,
      currentImport: Array.from({ length: 2001 }, () => ({})),
    },
  });
  await run("preview: an unknown device", {
    route,
    setup: fleet,
    json: { deviceId: "d-nope", currentImport: [] },
  });
  await run("preview: adds, removes and unchanged", {
    route,
    setup: [...fleet, link(A3, D2), verdict("v1", A2, "safe")],
    json: {
      deviceId: `  ${D1} `,
      currentImport: [
        { appId: A1, name: "Instagram" },
        { appId: A4, name: "Notes", developer: "Apple" },
        { appId: A1, name: "Instagram again" },
        { appId: "9999", name: "New", url: "u", iconUrl: "i", bundleId: "b" },
      ],
    },
  });
  await run("preview: entries are cleaned", {
    route,
    setup: fleet,
    json: {
      deviceId: D1,
      currentImport: [
        null,
        5,
        "x",
        [],
        { appId: 5 },
        { appId: "   " },
        {
          appId: ` ${A4} `,
          name: 7,
          developer: "Dev",
          url: 3,
          iconUrl: "i",
          bundleId: "",
        },
      ],
    },
  });
  await run("preview: a bundle id from the library fills an add", {
    route,
    setup: fleet,
    json: {
      deviceId: D1,
      currentImport: [{ appId: A6, name: "Threads" }, { appId: A1 }],
    },
  });
  await run("preview: a bundle id from the library finds a merge", {
    route,
    // Signal (1002) is in the library but not on this device; its old
    // twin (1005, same bundle) is.
    setup: fleet.filter(
      (s) =>
        !(s.sql.startsWith("INSERT INTO app_devices") && s.params[0] === A2)
    ),
    json: {
      deviceId: D1,
      currentImport: [{ appId: A2, name: "Signal" }, { appId: A1 }],
    },
  });
  await run("preview: an incoming bundle id finds a merge", {
    route,
    setup: fleet,
    json: {
      deviceId: D1,
      currentImport: [
        {
          appId: "2002",
          name: "Signal",
          bundleId: "org.whispersystems.signal",
        },
      ],
    },
  });
  await run("preview: what counts as user data", {
    route,
    setup: [
      ...fleet,
      verdict("v1", A1, "safe", "imported", "Friend"),
      annotation("n1", A3),
      shortlist("s1", A5, "4242", "Other"),
    ],
    json: { deviceId: D1, currentImport: [] },
  });
}

// ── POST /api/device-sync/commit ─────────────────────────────────────
{
  const route = "/api/device-sync/commit";
  const fleet = [
    app(A1, "Instagram", "com.burbn.instagram"),
    app(A2, "Signal", "org.whispersystems.signal"),
    app(A3, "Maps", null),
    app(A4, "Notes", "com.apple.notes"),
    app(A5, "Signal (old)", "org.whispersystems.signal"),
    app(A6, "Threads", "com.burbn.barcelona"),
    device(D1, "My iPhone"),
    device(D2, "My iPad"),
    link(A1, D1),
    link(A2, D1),
    link(A3, D1),
    link(A5, D1),
    link(A3, D2),
  ];
  const empty = { deviceId: D1, addAppIds: [], removeAppIds: [] };
  await run("commit: the limit, then refused with Retry-After", {
    route,
    repeat: 16,
    setup: fleet,
    json: empty,
  });
  await bodyCases(route, 256 * 1024);
  for (const [label, value] of [
    ["a null", null],
    ["a string", "x"],
    ["a number", 5],
  ]) {
    await run(`commit: ${label} body`, { route, json: value });
  }
  await run("commit: an array body has no device", { route, json: [] });
  await run("commit: a blank device", {
    route,
    json: { ...empty, deviceId: " " },
  });
  await run("commit: adds that are not an array", {
    route,
    json: { deviceId: D1, addAppIds: "x", removeAppIds: [] },
  });
  await run("commit: no removes", {
    route,
    json: { deviceId: D1, addAppIds: [] },
  });
  await run("commit: an unknown device", {
    route,
    setup: fleet,
    json: { ...empty, deviceId: "d-nope" },
  });
  await run("commit: nothing selected still touches the device", {
    route,
    setup: fleet,
    json: { ...empty, deviceId: `  ${D1} ` },
  });
  await run("commit: adds", {
    route,
    setup: fleet,
    json: {
      deviceId: D1,
      addAppIds: [A4, A4, A1, "9999", 5, "", null],
      removeAppIds: [],
    },
  });
  await run("commit: removes and the orphan sweep", {
    route,
    setup: [
      ...fleet,
      verdict("v1", A5, "safe"),
      shortlist("s1", A2, "4242", "Other"),
    ],
    json: {
      deviceId: D1,
      addAppIds: [],
      removeAppIds: [A2, A3, A4, A5, A2],
    },
  });
  await run("commit: a merge moves the user's data", {
    route,
    setup: [
      ...fleet,
      link(A5, D2),
      annotation("n1", A5),
      verdict("v1", A5, "uninstall"),
      verdict("v2", A2, "safe"),
      verdict("v3", A5, "safe", "imported", "Friend"),
      shortlist("s1", A5, "4242", "Same"),
      shortlist("s2", A2, "4343", "Same"),
      shortlist("s3", A5, "4444", "Only"),
      snapshot("p1", A5),
    ],
    json: {
      deviceId: D1,
      addAppIds: [],
      removeAppIds: [A5],
      bundleIdMerges: [{ previousAppId: A5, incomingAppId: A2, extra: 1 }],
    },
  });
  await run("commit: merges that are skipped", {
    route,
    setup: fleet,
    json: {
      deviceId: D1,
      addAppIds: [],
      removeAppIds: [],
      bundleIdMerges: [
        null,
        [],
        { previousAppId: A1 },
        { previousAppId: "", incomingAppId: A1 },
        { previousAppId: A2, incomingAppId: A2 },
        { previousAppId: "9998", incomingAppId: A1 },
        { previousAppId: A1, incomingAppId: "9998" },
      ],
    },
  });
  await run("commit: merges that are not an array", {
    route,
    setup: fleet,
    json: { ...empty, bundleIdMerges: { previousAppId: A5 } },
  });
  await run("commit: any two apps can be merged", {
    route,
    setup: fleet,
    json: {
      ...empty,
      bundleIdMerges: [{ previousAppId: A3, incomingAppId: A1 }],
    },
  });
}

// ── POST /api/device-actions/backup: the direct-child test ───────────
// Appended last: each case's forwarded address comes from a global
// counter, so a case added up in the route's own block would shift every
// later case. Template strings, not `path.join`, which would resolve the
// `..` before the handler sees it.
{
  const route = "/api/device-actions/backup";
  const record = (target) => ({
    ecid: ECID,
    path: target,
    deviceName: "Kid's iPad",
  });
  await run("backup: the root's parent spelled with a dot-dot", {
    route,
    json: record(`${ROOT}/..`),
  });
  await run("backup: the root itself is not a child", {
    route,
    json: record(ROOT),
  });
  await run("backup: a dot-dot path back to the root", {
    route,
    json: record(`${at("FRESH")}/..`),
  });
}

const fixture = {
  source:
    "the real app/api/device-actions/{backup,uninstall} and app/api/device-sync/{preview,commit} handlers over lib/device-actions.ts, lib/device-backup-verification.ts and lib/device-sync.ts",
  now,
  tree: TREE,
  cases,
};
writeFileSync(
  new URL("../tests/fixtures/device-routes-cases.json", import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`
);
rmSync(BASE, { recursive: true, force: true });
console.log(
  `Recorded ${cases.length} device-route cases from the real Node handlers; no network.`
);
