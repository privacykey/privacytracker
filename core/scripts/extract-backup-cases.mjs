/**
 * Backup oracle for the Rust server (Phase 4, batch 5b).
 *
 * Runs the REAL handlers of the backup family — `PUT` and `POST
 * /api/backup/snapshots`, `GET /api/backup/snapshots/[filename]`, `GET
 * /api/backup/export`, `POST /api/backup/preview`, `POST
 * /api/backup/restore` — and the startup hook's own 35 s snapshot
 * closure. Records, per case, the request or the callback, the setup
 * rows, the signing key and the snapshot files on disk beforehand, every
 * write in order with its transaction markers, the tables a backup
 * carries, the snapshot directory and the key file afterwards, and the
 * wire response with its download headers.
 *
 * Unlike the other oracles this one does NOT wrap a case in a SAVEPOINT:
 * `PRAGMA foreign_keys` is a no-op inside a transaction, and the restore
 * turns enforcement off around its own. A savepoint would leave it ON,
 * and a backup whose rows arrive child-first would fail on the INSERT
 * instead of reaching `foreign_key_check` — not what production does.
 * Each case wipes every table and the data directory instead.
 *
 * Determinism: frozen clock, counted ids, a fixed signing key written
 * before each case (or a counted `randomBytes(32)` where the case is the
 * key's creation), fixed mtimes on seeded files, a distinct forwarded
 * address per case, and the data directory spelled `<DATA_DIR>` wherever
 * a response names it. A snapshot whose name carries a collision suffix
 * is listed by its real mtime, so that one figure is blanked on both
 * sides (`compare: "collision"`).
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-backup-oracle-"));
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
delete process.env.PRIVACYTRACKER_PARENT_PID;

const now = Date.UTC(2026, 8, 15, 12);
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

// The install's signing key, and the one a case that has none will mint.
const KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 255)
).toString("base64");
const FRESH_KEY_BYTES = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255)
);
const FRESH_KEY = FRESH_KEY_BYTES.toString("base64");

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
  if (size === 9) {
    return Buffer.from(String(++idCounter).padStart(12, "0"), "base64url");
  }
  if (size === 32) {
    return Buffer.from(FRESH_KEY_BYTES);
  }
  return realRandomBytes(size, ...rest);
};
syncBuiltinESMExports();

// Timers captured while the startup hook registers its tickers. Only the
// closures matter; the handles satisfy `.unref()`.
let capturedTimers = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
let capturing = false;
const fakeHandle = () => ({
  unref() {
    return this;
  },
  ref() {
    return this;
  },
  hasRef() {
    return false;
  },
  refresh() {
    return this;
  },
  [Symbol.toPrimitive]() {
    return 0;
  },
});
globalThis.setTimeout = (fn, ms, ...args) => {
  if (capturing) {
    capturedTimers.push({ kind: "timeout", fn, ms });
    return fakeHandle();
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.setInterval = (fn, ms, ...args) => {
  if (capturing) {
    capturedTimers.push({ kind: "interval", fn, ms });
    return fakeHandle();
  }
  return realSetInterval(fn, ms, ...args);
};

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
  "/api/backup/snapshots": await import(
    "../../app/api/backup/snapshots/route.ts"
  ),
  "/api/backup/snapshots/[filename]": await import(
    "../../app/api/backup/snapshots/[filename]/route.ts"
  ),
  "/api/backup/export": await import("../../app/api/backup/export/route.ts"),
  "/api/backup/preview": await import("../../app/api/backup/preview/route.ts"),
  "/api/backup/restore": await import("../../app/api/backup/restore/route.ts"),
};
const { TABLES_IN_INSERT_ORDER, exportBackup } = await import(
  "../../lib/backup.ts"
);

const ALL_TABLES = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()
  .map((r) => r.name);
function wipeDatabase() {
  db.pragma("foreign_keys = OFF");
  for (const name of ALL_TABLES) {
    db.exec(`DELETE FROM "${name}"`);
  }
  db.pragma("foreign_keys = ON");
}
wipeDatabase();

// Every table a backup carries: a restore replaces all of them.
const TABLES = [...TABLES_IN_INSERT_ORDER];

// ── Fixture rows ─────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
// The migration marker (so `register()` migrates nothing) and the runtime
// marker its first, unrecorded run writes.
const BASE = [
  setting("feature_flag_migration_version", "2"),
  setting("runtime_environment", ""),
];
for (const { sql, params } of BASE) {
  db.prepare(sql).run(...params);
}

const quiet = ["error", "warn", "info", "log"];
function silence() {
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  return () => {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  };
}

const { register } = await import("../../instrumentation.ts");
capturing = true;
capturedTimers = [];
{
  const restore = silence();
  try {
    await register();
  } finally {
    restore();
  }
}
capturing = false;
const bootTimers = capturedTimers;
const callbackFor = (delay) => {
  const found = bootTimers.find((t) => t.kind === "timeout" && t.ms === delay);
  if (!found) {
    throw new Error(`no ${delay}ms timer captured from register()`);
  }
  return found.fn;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const url = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;
const A1 = "1001";
const A2 = "1002";
const app = (id, name) =>
  stmt(
    "INSERT INTO apps (id, name, url, iconUrl, privacyPolicyUrl, firstSeen, lastSynced, changeCount, priceAmount, priceCurrency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    url(id),
    `https://is1-ssl.mzstatic.com/image/${id}.png`,
    `https://example.com/${id}/privacy`,
    now - 5 * DAY,
    now - DAY,
    2,
    4.99,
    "USD"
  );
const device = (id, name) =>
  stmt(
    "INSERT INTO devices (id, name, ecid, created_at, last_synced_at, is_unknown_placeholder, owner_label, owner_audience) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    id,
    name,
    null,
    now - 4 * DAY,
    now - DAY,
    "Mum",
    "loved_one"
  );
const appDevice = (appId, deviceId) =>
  stmt(
    "INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
    appId,
    deviceId,
    now - 4 * DAY,
    now - DAY
  );
const privacyType = (id, appId) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    appId,
    "DATA_LINKED_TO_YOU",
    "Data Linked to You"
  );
const privacyCategory = (id, typeId) =>
  stmt(
    "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    typeId,
    "CONTACT_INFO",
    "Contact Info"
  );
const accessibility = (id, appId) =>
  stmt(
    "INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "VOICEOVER",
    "VoiceOver",
    null,
    null
  );
const snapshot = (id, appId) =>
  stmt(
    "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary, source, triggered_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    appId,
    now - DAY,
    '[{"identifier":"DATA_LINKED_TO_YOU","categories":[]}]',
    "[]",
    "live",
    "manual"
  );
const notification = (id, appId) =>
  stmt(
    "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    appId,
    "App",
    "[]",
    now - DAY,
    0
  );
const annotation = (id, appId) =>
  stmt(
    "INSERT INTO annotations (id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    'a "quoted" note\nwith a newline, a tab\t and a snowman ☃',
    "user",
    null,
    "export",
    null,
    now - DAY,
    now - DAY,
    null
  );
const manualApp = (id, name) =>
  stmt(
    "INSERT INTO manual_apps (id, name, source, developer, privacy_policy_url, source_url, notes, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    "sideloaded",
    null,
    "https://example.com/manual/privacy",
    null,
    null,
    now - DAY,
    now - DAY
  );
const related = (source, relatedId) =>
  stmt(
    "INSERT INTO related_apps_observed (source_app_id, related_apple_id, related_name, related_developer, related_icon_url, related_store_url, shelf_type, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    source,
    relatedId,
    "Related",
    null,
    null,
    url(relatedId),
    "may_also_like",
    now - DAY
  );
const flagOverride = (key, value) =>
  stmt(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, 'user', ?, 0)",
    key,
    value,
    now - DAY,
    null
  );
const auditRow = (id) =>
  stmt(
    "INSERT INTO audit_log (id, created_at, action, actor_ip, user_agent, detail, success) VALUES (?, ?, ?, ?, ?, ?, 1)",
    id,
    now - DAY,
    "settings.write",
    "10.9.9.9",
    "seed/1.0",
    null
  );
const corpus = [
  app(A1, "Instagram 📸"),
  app(A2, "Signal"),
  device("dev-1", "Mum's iPad"),
  appDevice(A1, "dev-1"),
  privacyType("pt-1", A1),
  privacyCategory("pc-1", "pt-1"),
  accessibility("af-1", A1),
  snapshot("s-1", A1),
  snapshot("s-2", A2),
  notification("n-1", A1),
  annotation("an-1", A1),
  manualApp("m-1", "Sideloaded"),
  related(A1, "2001"),
  flagOverride("flag.dashboard.stats", "off"),
  auditRow("au-1"),
  setting("sync_schedule", "daily"),
  // Scrubbed on the way out, whoever asks for the export.
  setting("ai_api_key", "sk-secret"),
  setting("notification_webhook_url", "https://hooks.example.com/secret"),
];
// A different install, for a restore to replace.
const other = [
  app("9001", "Replaced"),
  privacyType("pt-9", "9001"),
  notification("n-9", "9001"),
  setting("sync_schedule", "weekly"),
  setting("flag.devopts.cfgutil_uninstall", "on"),
];

// ── Signing, as lib/backup.ts signs ──────────────────────────────────
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
    .join(",")}}`;
}
/**
 * Sign a hand-built envelope with `key` the way `exportBackup` would.
 * The MAC covers the envelope `parseEnvelope` rebuilds, not the upload:
 * a table keeps only its `columns` and `rows`. Every case that relies on
 * this asserts the trust the real verifier then reports.
 */
function sign(envelope, key = KEY) {
  const tables = {};
  for (const [name, t] of Object.entries(envelope.tables ?? {})) {
    if (!(t && typeof t === "object" && Array.isArray(t.rows))) {
      continue;
    }
    const columns = Array.isArray(t.columns)
      ? t.columns.filter((c) => typeof c === "string")
      : t.rows[0] && typeof t.rows[0] === "object"
        ? Object.keys(t.rows[0])
        : [];
    tables[name] = { columns, rows: t.rows };
  }
  const covered = {
    version: envelope.version,
    exportedAt:
      typeof envelope.exportedAt === "number" ? envelope.exportedAt : null,
    appName:
      typeof envelope.appName === "string"
        ? envelope.appName
        : "privacytracker",
    tables,
  };
  const mac = nodeCrypto
    .createHmac("sha256", Buffer.from(key, "base64"))
    .update(canonicalize(covered))
    .digest("base64");
  return { ...envelope, signature: { alg: "HMAC-SHA256", mac } };
}

// ── Disk ─────────────────────────────────────────────────────────────
const backupsDir = path.join(dir, "backups");
const keyFile = path.join(dir, "backup-signing.key");
function resetDisk(key, files) {
  rmSync(backupsDir, { recursive: true, force: true });
  rmSync(keyFile, { force: true });
  if (key !== null) {
    writeFileSync(keyFile, key, { mode: 0o600 });
  }
  if (files.length) {
    mkdirSync(backupsDir, { recursive: true });
  }
  for (const file of files) {
    const full = path.join(backupsDir, file.name);
    writeFileSync(full, file.content);
    utimesSync(full, file.mtimeMs / 1000, file.mtimeMs / 1000);
  }
}
function listDisk() {
  if (!existsSync(backupsDir)) {
    return null;
  }
  return readdirSync(backupsDir)
    .sort()
    .map((name) => {
      const full = path.join(backupsDir, name);
      const content = readFileSync(full);
      return {
        name,
        size: statSync(full).size,
        sha256: nodeCrypto.createHash("sha256").update(content).digest("hex"),
      };
    });
}
const anon = (text) =>
  typeof text === "string" ? text.split(dir).join("<DATA_DIR>") : text;

/** A snapshot named by a collision lists by its real mtime: blank it. */
const STRICT_NAME =
  /^privacytracker-snapshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;
function blankCollisions(body) {
  const parsed = JSON.parse(body);
  for (const list of [parsed.snapshots, parsed.pruned]) {
    for (const row of list ?? []) {
      if (!STRICT_NAME.test(row.filename)) {
        row.createdAt = 0;
      }
    }
  }
  return JSON.stringify(parsed);
}

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;

async function run(name, spec) {
  const {
    kind = "route",
    delay = null,
    route = null,
    method = null,
    search = "",
    param = null,
    json: jsonBody,
    raw,
    headers = {},
    setup: extraSetup = [],
    adminToken = null,
    repeat = 1,
    contentLength,
    compare = "exact",
    key = `${KEY}\n`,
    files = [],
    expectTrust = null,
  } = spec;
  const setup = [...BASE, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.7`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "backup-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  wipeDatabase();
  resetDisk(key, files);
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let expected = null;
    const restore = silence();
    try {
      if (kind === "callback") {
        await callbackFor(delay)();
      } else {
        for (let i = 0; i < repeat; i++) {
          const target =
            param === null
              ? route
              : route.replace("[filename]", encodeURIComponent(param));
          const request = new NextRequest(
            `http://127.0.0.1:3000${target}${search}`,
            {
              method,
              headers: sent,
              body: body === null ? undefined : body,
            }
          );
          const context =
            param === null
              ? undefined
              : { params: Promise.resolve({ filename: param }) };
          try {
            const response = await handlers[route][method](request, context);
            expected = {
              status: response.status,
              body: anon(await response.text()),
              type: response.headers.get("content-type"),
              retryAfter: response.headers.get("retry-after"),
              disposition: response.headers.get("content-disposition"),
              cacheControl: response.headers.get("cache-control"),
              backupVersion: response.headers.get("x-backup-version"),
            };
          } catch (error) {
            expected = {
              status: 500,
              body: "",
              type: null,
              retryAfter: null,
              disposition: null,
              cacheControl: null,
              backupVersion: null,
              thrown: String(error?.message ?? error),
            };
          }
        }
      }
    } finally {
      restore();
    }
    recording = null;
    if (expectTrust !== null) {
      const got = JSON.parse(expected.body).trust;
      if (got !== expectTrust) {
        throw new Error(`${name}: expected trust ${expectTrust}, got ${got}`);
      }
    }
    if (compare === "collision" && expected) {
      expected.body = blankCollisions(expected.body);
    }
    const rows = {};
    for (const table of TABLES) {
      rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    cases.push({
      name,
      kind,
      delay,
      route,
      method,
      search,
      query: [...new URLSearchParams(search)],
      param,
      headers: sent,
      body,
      adminToken,
      repeat,
      compare,
      key,
      files,
      setup,
      stream,
      rows,
      disk: listDisk(),
      keyAfter: existsSync(keyFile) ? readFileSync(keyFile, "utf8") : null,
      foreignKeys: db.pragma("foreign_keys", { simple: true }),
      expected,
    });
  } finally {
    recording = null;
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
}

/** The envelope `exportBackup` produces over `rows`, signed with KEY. */
function exportOf(rows) {
  wipeDatabase();
  resetDisk(`${KEY}\n`, []);
  for (const { sql, params } of [...BASE, ...rows]) {
    db.prepare(sql).run(...params);
  }
  const restore = silence();
  try {
    return JSON.parse(JSON.stringify(exportBackup()));
  } finally {
    restore();
  }
}

const admin = {
  adminToken: "secret-token",
  headers: { "x-auditor-admin-token": "secret-token" },
};
const iso = (ms) => new RealDate(ms).toISOString().replace(/[:.]/g, "-");
const snapshotName = (ms) => `privacytracker-snapshot-${iso(ms)}.json`;
const seeded = (ms, content = "{}") => ({
  name: snapshotName(ms),
  content,
  mtimeMs: ms + 5000,
});

try {
  const backup = exportOf(corpus);
  const MIB_100 = 100 * 1024 * 1024;

  // ── PUT /api/backup/snapshots ────────────────────────────────────
  {
    const route = "/api/backup/snapshots";
    const method = "PUT";
    await run("snapshot settings saved", {
      route,
      method,
      json: { enabled: true, intervalHours: 48, retentionCount: 5 },
    });
    await run("snapshot settings clamped low and high", {
      route,
      method,
      json: { enabled: false, intervalHours: 0, retentionCount: 999 },
    });
    await run("snapshot settings clamped high and low", {
      route,
      method,
      json: { intervalHours: 1e6, retentionCount: -4 },
    });
    await run("snapshot settings rounded", {
      route,
      method,
      json: { intervalHours: 2.5, retentionCount: 7.4 },
    });
    await run("snapshot settings from strings", {
      route,
      method,
      json: { enabled: "yes", intervalHours: " 36h", retentionCount: "1e3" },
    });
    await run("snapshot settings from junk fall back to the defaults", {
      route,
      method,
      json: { enabled: 0, intervalHours: "soon", retentionCount: {} },
    });
    await run("snapshot settings from null, a boolean and an array", {
      route,
      method,
      json: { enabled: null, intervalHours: true, retentionCount: [12] },
    });
    await run("snapshot settings partial leaves the rest alone", {
      route,
      method,
      setup: [
        setting("backup_snapshot_enabled", "true"),
        setting("backup_snapshot_interval_hours", "6"),
        setting("backup_snapshot_retention_count", "3"),
        setting("backup_snapshot_last_run_at", String(now - 2 * HOUR)),
      ],
      json: { retentionCount: 4 },
    });
    await run("snapshot settings list what is on disk", {
      route,
      method,
      files: [
        seeded(now - 3 * DAY, '{"a":1}'),
        seeded(now - DAY, '{"b":22}'),
        { name: "notes.txt", content: "not a snapshot", mtimeMs: now - DAY },
        {
          name: "privacytracker-snapshot-by-hand.json",
          content: "[]",
          mtimeMs: now - 2 * DAY + 250,
        },
      ],
      json: {},
    });
    for (const [label, value] of [
      ["an array", []],
      ["null", null],
      ["a number", 5],
      ["a string", "enabled"],
    ]) {
      await run(`snapshot settings body is ${label}`, {
        route,
        method,
        json: value,
      });
    }
    await bodyCases(route, method, 4 * 1024);
    await run(`${route} ${method} streamed too large`, {
      route,
      method,
      raw: `{"pad":"${"x".repeat(4 * 1024)}"}`,
    });
    await run("snapshot settings admin token required", {
      route,
      method,
      adminToken: "secret-token",
      json: { enabled: true },
    });
    await run("snapshot settings admin token accepted", {
      route,
      method,
      ...admin,
      json: { enabled: true },
    });
    await run("snapshot settings rate limited", {
      route,
      method,
      json: {},
      repeat: 21,
    });
  }

  // ── POST /api/backup/snapshots ───────────────────────────────────
  {
    const route = "/api/backup/snapshots";
    const method = "POST";
    await run("snapshot created on an empty install", { route, method });
    await run("snapshot created over the corpus", {
      route,
      method,
      setup: corpus,
    });
    await run("snapshot creation mints the signing key", {
      route,
      method,
      setup: corpus,
      key: null,
    });
    await run("snapshot creation replaces a key that is too short", {
      route,
      method,
      key: "QUJD\n",
    });
    await run("snapshot creation reads a key with stray whitespace", {
      route,
      method,
      key: `\n  ${KEY}  \n\n`,
    });
    await run("snapshot creation prunes past the retention count", {
      route,
      method,
      setup: [setting("backup_snapshot_retention_count", "2")],
      files: [
        seeded(now - 3 * DAY),
        seeded(now - 2 * DAY),
        seeded(now - DAY),
        { name: "notes.txt", content: "kept", mtimeMs: now - 9 * DAY },
      ],
    });
    await run("snapshot creation ranks a hand-named file by its mtime", {
      route,
      method,
      setup: [setting("backup_snapshot_retention_count", "2")],
      files: [
        seeded(now - 3 * DAY),
        {
          name: "privacytracker-snapshot-by-hand.json",
          content: "[]",
          mtimeMs: now - 2 * DAY + 250,
        },
      ],
    });
    await run("snapshot created twice in one millisecond", {
      route,
      method,
      repeat: 2,
      compare: "collision",
    });
    await run("snapshot collision pruned by retention", {
      route,
      method,
      setup: [setting("backup_snapshot_retention_count", "1")],
      repeat: 2,
      compare: "collision",
    });
    await run("snapshot creation admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("snapshot creation admin token accepted", {
      route,
      method,
      ...admin,
    });
    await run("snapshot creation rate limited", {
      route,
      method,
      repeat: 6,
    });
  }

  // ── GET /api/backup/snapshots/[filename] ─────────────────────────
  {
    const route = "/api/backup/snapshots/[filename]";
    const method = "GET";
    const files = [
      seeded(now - DAY, '{\n  "version": 1,\n  "note": "naïve ☃"\n}'),
      {
        name: 'privacytracker-snapshot-a b"c é📸.json',
        content: "{}",
        mtimeMs: now - DAY,
      },
      { name: "notes.txt", content: "not a snapshot", mtimeMs: now - DAY },
    ];
    await run("snapshot download", {
      route,
      method,
      files,
      param: snapshotName(now - DAY),
    });
    await run("snapshot download sanitises the attachment name", {
      route,
      method,
      files,
      param: 'privacytracker-snapshot-a b"c é📸.json',
    });
    await run("snapshot download missing", {
      route,
      method,
      files,
      param: snapshotName(now - 2 * DAY),
    });
    await run("snapshot download refuses another file", {
      route,
      method,
      files,
      param: "notes.txt",
    });
    await run("snapshot download refuses a traversal", {
      route,
      method,
      files,
      param: "../backups/privacytracker-snapshot-x.json",
    });
    await run("snapshot download refuses the database", {
      route,
      method,
      files,
      param: "../privacy.db",
    });
    await run("snapshot download with no directory", {
      route,
      method,
      param: snapshotName(now - DAY),
    });
  }

  // ── GET /api/backup/export ───────────────────────────────────────
  {
    const route = "/api/backup/export";
    const method = "GET";
    await run("export over the corpus", { route, method, setup: corpus });
    await run("export of an empty install", { route, method });
    await run("export mints the signing key", {
      route,
      method,
      setup: corpus,
      key: null,
    });
    await run("export admin token required", {
      route,
      method,
      adminToken: "secret-token",
    });
    await run("export admin token accepted", {
      route,
      method,
      setup: corpus,
      ...admin,
    });
    await run("export rate limited", { route, method, repeat: 13 });
  }

  // ── POST /api/backup/preview ─────────────────────────────────────
  {
    const route = "/api/backup/preview";
    const method = "POST";
    await run("preview of an export", { route, method, json: backup });
    await run("preview of an unsigned backup", {
      route,
      method,
      json: { ...backup, signature: undefined },
    });
    await run("preview warns about tables it does not know", {
      route,
      method,
      json: {
        version: 1,
        exportedAt: "yesterday",
        tables: {
          zeta: { rows: [{ a: 1 }, { a: 2 }] },
          notifications: { rows: [{ id: "n" }] },
          alpha: { rows: [] },
          10: { rows: [1, 2, 3] },
          Alpha: { columns: ["a"], rows: [{ a: 1 }] },
          apps: { columns: ["id"], rows: [{ id: "1" }, { id: "2" }] },
          "not-rows": { rows: "three" },
          nothing: null,
          scalar: 7,
        },
      },
    });
    await run("preview of tables given as an array", {
      route,
      method,
      json: { version: 1, tables: [{ rows: [1, 2] }, "skipped"] },
    });
    for (const [label, payload] of [
      ["null", null],
      ["a number", 12],
      ["a string", "backup"],
      ["an array", []],
      ["missing a version", { tables: {} }],
      ["a string version", { version: "1", tables: {} }],
      ["version zero", { version: 0, tables: {} }],
      ["a newer version", { version: 2, tables: {} }],
      ["a fractional version", { version: 1.5, tables: {} }],
      ["missing tables", { version: 1 }],
      ["tables as a string", { version: 1, tables: "apps" }],
      ["tables as null", { version: 1, tables: null }],
    ]) {
      await run(`preview rejects ${label}`, { route, method, json: payload });
    }
    await bodyCases(route, method, MIB_100);
  }

  // ── POST /api/backup/restore ─────────────────────────────────────
  {
    const route = "/api/backup/restore";
    const method = "POST";
    await run("restore of a trusted backup replaces the install", {
      route,
      method,
      setup: other,
      json: backup,
      expectTrust: "trusted",
    });
    await run("restore onto an empty install", {
      route,
      method,
      json: backup,
      expectTrust: "trusted",
    });
    const tampered = structuredClone(backup);
    tampered.tables.apps.rows[0].name = "Tampered";
    await run("restore refuses a tampered backup", {
      route,
      method,
      setup: other,
      json: tampered,
    });
    await run("restore refuses an unsigned backup", {
      route,
      method,
      setup: other,
      json: { ...backup, signature: undefined },
    });
    await run("restore refuses another algorithm", {
      route,
      method,
      json: {
        ...backup,
        signature: { alg: "HMAC-SHA512", mac: backup.signature.mac },
      },
    });
    await run("restore drops a signature that is not two strings", {
      route,
      method,
      json: { ...backup, signature: { alg: "HMAC-SHA256", mac: 5 } },
    });
    await run("restore refuses a short mac", {
      route,
      method,
      json: { ...backup, signature: { alg: "HMAC-SHA256", mac: "QUJD" } },
    });
    await run("restore refuses an empty mac", {
      route,
      method,
      json: { ...backup, signature: { alg: "HMAC-SHA256", mac: "" } },
    });
    await run("restore reads a mac the way Buffer.from reads base64", {
      route,
      method,
      json: {
        ...backup,
        signature: {
          alg: "HMAC-SHA256",
          mac: ` ${backup.signature.mac
            .replace(/[=]+$/, "")
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/^(.{10})/, "$1\n!")}`,
        },
      },
      expectTrust: "trusted",
    });
    await run("restore of a backup signed elsewhere", {
      route,
      method,
      json: backup,
      key: null,
    });
    await run("restore of an unsigned backup mints no key", {
      route,
      method,
      json: { ...backup, signature: undefined },
      key: null,
    });
    await run("restore of a tampered backup allowed by query 1", {
      route,
      method,
      search: "?allowUntrusted=1",
      setup: other,
      json: tampered,
      expectTrust: "untrusted",
    });
    await run("restore of an unsigned backup allowed by query true", {
      route,
      method,
      search: "?allowUntrusted=true",
      json: { ...backup, signature: undefined },
      expectTrust: "untrusted",
    });
    await run("restore of a tampered backup allowed by header", {
      route,
      method,
      headers: { "x-allow-untrusted-backup": "true" },
      json: tampered,
      expectTrust: "untrusted",
    });
    await run("restore not allowed by another spelling", {
      route,
      method,
      search: "?allowUntrusted=yes",
      headers: { "x-allow-untrusted-backup": "TRUE" },
      json: tampered,
    });
    const crafted = sign({
      version: 1,
      exportedAt: now - HOUR,
      appName: "privacytracker",
      extra: "ignored",
      tables: {
        apps: {
          columns: [
            "id",
            "name",
            "url",
            "iconUrl",
            "privacyPolicyUrl",
            "firstSeen",
            "lastSynced",
            "priceAmount",
            "legacy_column",
            7,
          ],
          extra: "dropped from the MAC",
          rows: [
            {
              id: "1",
              name: "Hostile",
              url: "javascript:alert(1)",
              iconUrl: "http://169.254.169.254/latest/meta-data",
              privacyPolicyUrl: "https://example.com/ok path?q=1#frag",
              firstSeen: 1,
              lastSynced: 2.5,
              priceAmount: 0.1,
              legacy_column: "gone",
            },
            {
              id: "2",
              name: "Private",
              url: "https://apps.apple.com/us/app/x/id2",
              iconUrl: "http://localhost:3000/icon.png",
              privacyPolicyUrl: 42,
              firstSeen: 1e21,
              lastSynced: -0,
            },
            null,
            5,
            "row",
          ],
        },
        manual_apps: {
          rows: [
            {
              id: "m-1",
              name: "Manual",
              source: "sideloaded",
              privacy_policy_url: "ftp://example.com/policy",
              source_url: "https://user:pass@example.com/",
              first_seen: 1,
              updated_at: true,
            },
          ],
        },
        related_apps_observed: {
          rows: [
            {
              source_app_id: "1",
              related_apple_id: "3",
              related_name: "Related",
              related_icon_url: "data:image/png;base64,AAAA",
              related_store_url: null,
              shelf_type: "may_also_like",
              observed_at: 3,
            },
          ],
        },
        privacy_snapshots: {
          rows: [
            {
              id: "s-1",
              app_id: "1",
              scraped_at: 4,
              snapshot_json: [
                { identifier: "X", n: 1.5, deep: { b: 1, a: [] } },
              ],
              changes_detected: false,
              changes_summary: { added: [] },
              source: "live",
            },
          ],
        },
        app_settings: {
          columns: ["key", "value"],
          rows: [
            { key: "sync_schedule", value: "weekly" },
            { key: "flag.devopts.cfgutil_uninstall", value: "on" },
            { key: "AUDITOR_ADMIN_TOKEN", value: "planted" },
            { key: "auditor_lowercase", value: "kept" },
            { key: 12, value: 34 },
          ],
        },
        notifications: { columns: ["legacy_only"], rows: [{ legacy_only: 1 }] },
        imports: { columns: [], rows: [{ id: "imp" }] },
        zeta: { rows: [{ a: 1 }] },
      },
    });
    await run("restore sanitises urls, settings and values", {
      route,
      method,
      setup: other,
      json: crafted,
      expectTrust: "trusted",
    });
    await run("restore aborts on a foreign-key violation", {
      route,
      method,
      setup: other,
      json: sign({
        version: 1,
        exportedAt: now,
        tables: {
          privacy_types: {
            rows: [
              {
                id: "pt-x",
                app_id: "missing",
                identifier: "DATA_LINKED_TO_YOU",
                title: "Data Linked to You",
              },
            ],
          },
        },
      }),
    });
    await run("restore aborts on a missing required column", {
      route,
      method,
      setup: other,
      json: sign({
        version: 1,
        exportedAt: now,
        tables: { apps: { rows: [{ id: "1", url: "https://example.com/" }] } },
      }),
    });
    await run("restore aborts on a duplicate key", {
      route,
      method,
      setup: other,
      json: sign({
        version: 1,
        exportedAt: now,
        tables: {
          app_settings: {
            rows: [
              { key: "a", value: "1" },
              { key: "a", value: "2" },
            ],
          },
        },
      }),
    });
    await run("restore of a backup with no tables empties the install", {
      route,
      method,
      setup: other,
      json: sign({ version: 1, tables: {} }),
      expectTrust: "trusted",
    });
    await run("restore rejects a malformed backup", {
      route,
      method,
      setup: other,
      json: { version: 3, tables: {} },
    });
    await run("restore rejects a payload that is not an object", {
      route,
      method,
      json: "backup",
    });
    await run("restore waits for a running sync before reading the body", {
      route,
      method,
      setup: [setting("sync_running", "true")],
      raw: "{not json",
    });
    await bodyCases(route, method, MIB_100, { setup: other });
    await run("restore admin token required", {
      route,
      method,
      adminToken: "secret-token",
      json: backup,
    });
    await run("restore admin token accepted", {
      route,
      method,
      ...admin,
      json: backup,
      expectTrust: "trusted",
    });
    await run("restore rate limited", {
      route,
      method,
      json: { version: 9, tables: {} },
      repeat: 4,
    });
  }

  // ── instrumentation.ts: the 35 s snapshot tick ───────────────────
  {
    const tick = { kind: "callback", delay: 35_000 };
    await run("scheduled snapshot disabled", { ...tick, setup: corpus });
    await run("scheduled snapshot due on its first run", {
      ...tick,
      setup: [...corpus, setting("backup_snapshot_enabled", "true")],
    });
    await run("scheduled snapshot not yet due", {
      ...tick,
      setup: [
        setting("backup_snapshot_enabled", "true"),
        setting("backup_snapshot_interval_hours", "6"),
        setting("backup_snapshot_last_run_at", String(now - 6 * HOUR + 1)),
      ],
    });
    await run("scheduled snapshot due to the millisecond", {
      ...tick,
      setup: [
        setting("backup_snapshot_enabled", "true"),
        setting("backup_snapshot_interval_hours", "6"),
        setting("backup_snapshot_retention_count", "1"),
        setting("backup_snapshot_last_run_at", String(now - 6 * HOUR)),
      ],
      files: [seeded(now - 6 * HOUR), seeded(now - 12 * HOUR)],
    });
    await run("scheduled snapshot with an unreadable last run", {
      ...tick,
      setup: [
        setting("backup_snapshot_enabled", "true"),
        setting("backup_snapshot_last_run_at", "never"),
      ],
    });
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const out = path.join(
  import.meta.dirname,
  "..",
  "tests",
  "fixtures",
  "backup-cases.json"
);
writeFileSync(
  out,
  `${JSON.stringify({ now, key: KEY, freshKey: FRESH_KEY, cases }, null, 2)}\n`
);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
