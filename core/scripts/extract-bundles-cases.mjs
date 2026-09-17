/**
 * Bundles oracle for the Rust server (Phase 4, batch 5c).
 *
 * Runs the REAL handlers of `POST /api/export/audit-bundle`, `POST
 * /api/import/audit-bundle` (JSON and multipart, preview and commit),
 * `GET /api/diagnostics/bundle` and `GET /api/deployment/support-bundle`.
 * Records, per case, the request, the setup rows, every write in order
 * with its transaction markers, the tables an import touches, and the
 * wire response with its download headers.
 *
 * The two diagnostics bundles are mostly this machine's state — memory,
 * uptime, paths — so what is recorded of them is a PROJECTION: the key
 * sets, and the sections that are pure functions of the database (the
 * flag diff, the background-job descriptions, the cooldowns, the recent
 * errors with their redacted fetch diagnostics). The replay projects its
 * own response the same way. The live gate holds the rest to its shape.
 *
 * Determinism as before: frozen clock, counted ids (`randomUUID`, and
 * `randomBytes` of 8 and 12 spelled as a zero-padded decimal counter, so
 * `pt-0000000000000007` is the seventh id minted), foreign keys ON, a
 * distinct forwarded address per case, TZ=UTC for the local-time filename
 * and the duplicate message. That message is `toLocaleString()` in the
 * HOST's locale on Node; it is pinned to en-US here, which is what Node
 * resolves with no LANG set and what the core spells.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-bundles-oracle-"));
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
  toLocaleString(locale, options) {
    // ICU 72 put a NARROW NO-BREAK SPACE before AM/PM and later data took
    // it back out, so the separator depends on the Node that runs this.
    // Pinned to a plain space, which is also what the core writes.
    return super
      .toLocaleString(locale ?? "en-US", options)
      .replaceAll(String.fromCharCode(0x20_2f), " ");
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
  if (size === 9) {
    return Buffer.from(String(++idCounter).padStart(12, "0"), "base64url");
  }
  if (size === 8 || size === 12) {
    return Buffer.from(String(++idCounter).padStart(size * 2, "0"), "hex");
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

const handlers = {
  "/api/export/audit-bundle": await import(
    "../../app/api/export/audit-bundle/route.ts"
  ),
  "/api/import/audit-bundle": await import(
    "../../app/api/import/audit-bundle/route.ts"
  ),
  "/api/diagnostics/bundle": await import(
    "../../app/api/diagnostics/bundle/route.ts"
  ),
  "/api/deployment/support-bundle": await import(
    "../../app/api/deployment/support-bundle/route.ts"
  ),
};
const { buildAuditBundle } = await import("../../lib/audit-bundle.ts");
const { PROFILE_PRESETS } = await import("../../lib/privacy-profile.ts");

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
  "privacy_policy_analyses",
  "annotations",
  "app_verdicts",
  "audit_bundle_imports",
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
const BASE = [setting("feature_flag_migration_version", "2")];

const DAY = 86_400_000;
const HOUR = 3_600_000;
const storeUrl = (id) => `https://apps.apple.com/us/app/fixture/id${id}`;
const app = (id, name, extra = {}) =>
  stmt(
    "INSERT INTO apps (id, name, url, iconUrl, bundleId, developer, privacyPolicyUrl, firstSeen, lastSynced, currentVersion, hasPrivacyDetails, hasAccessibilityLabels, priceAmount, priceCurrency, priceFormatted, hasIap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    storeUrl(id),
    `https://is1-ssl.mzstatic.com/image/${id}.png`,
    extra.bundleId ?? `com.example.app${id}`,
    extra.developer ?? "Example Pty Ltd",
    extra.policyUrl === undefined
      ? `https://example.com/${id}/privacy`
      : extra.policyUrl,
    now - 9 * DAY,
    extra.lastSynced ?? now - 2 * DAY,
    "3.2.1",
    1,
    1,
    extra.price ?? 0,
    "USD",
    extra.price ? "$4.99" : "Free",
    0
  );
const privacyType = (id, appId, identifier, title) =>
  stmt(
    "INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, ?)",
    id,
    appId,
    identifier,
    title,
    null
  );
const privacyCategory = (id, typeId, identifier, title) =>
  stmt(
    "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)",
    id,
    typeId,
    identifier,
    title
  );
const accessibility = (id, appId, identifier, title) =>
  stmt(
    "INSERT INTO accessibility_features (id, app_id, identifier, title, description, icon_template) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    appId,
    identifier,
    title,
    `${title} is supported`,
    null
  );
const analysis = (appId, sourceText) =>
  stmt(
    "INSERT INTO privacy_policy_analyses (app_id, policy_url, status, source_text, source_word_count, analysis_mode, summary_json, model, updated_at, source_fetched_at) VALUES (?, ?, 'ok', ?, ?, 'direct', ?, 'gpt', ?, ?)",
    appId,
    `https://example.com/${appId}/privacy`,
    sourceText,
    sourceText.split(/\s+/).length,
    '{"overview":"Collects contact info."}',
    now - 3 * HOUR,
    now - 4 * HOUR
  );
const annotation = (id, appId, extra = {}) =>
  stmt(
    "INSERT INTO annotations (id, app_id, content, source, source_name, visibility, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    extra.content ?? `note ${id}`,
    extra.source ?? "user",
    extra.sourceName ?? null,
    extra.visibility ?? "export",
    extra.tag ?? null,
    extra.createdAt ?? now - DAY,
    extra.createdAt ?? now - DAY,
    extra.deletedAt ?? null
  );
const verdict = (id, appId, value, extra = {}) =>
  stmt(
    "INSERT INTO app_verdicts (id, app_id, verdict, rationale, source, source_name, set_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    appId,
    value,
    extra.rationale ?? null,
    extra.source ?? "user",
    extra.sourceName ?? null,
    now - DAY,
    extra.updatedAt ?? now - DAY
  );
const flagOverride = (key, value) =>
  stmt(
    "INSERT INTO feature_flag_overrides (flag_key, override_value, set_at, set_by, previous_focus, quarantined) VALUES (?, ?, ?, 'user', ?, 0)",
    key,
    value,
    now - DAY,
    null
  );
const activity = (id, type, status, detail, startedAt) =>
  stmt(
    "INSERT INTO activity_log (id, type, status, app_id, app_name, summary, detail, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    type,
    status,
    null,
    null,
    `${type} ${status}`,
    detail === null ? null : JSON.stringify(detail),
    startedAt,
    startedAt + 1200,
    1200
  );
const importRow = (exportedAt, importedAt) =>
  stmt(
    "INSERT INTO audit_bundle_imports (id, exported_at, imported_at, recommender_name, bundle_app_version, apps_total, apps_added, apps_updated, apps_skipped, annotations_added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "bundle-earlier",
    exportedAt,
    importedAt,
    "Sam",
    "0.1.0",
    3,
    2,
    1,
    0,
    4
  );

const A1 = "1001";
const A2 = "1002";
const A3 = "1003";
const LONG_POLICY = `${"word ".repeat(1200)}end`;
// The recommender's install. Names chosen so NOCASE ordering is visible.
const corpus = [
  app(A1, "beta Reader", { price: 4.99 }),
  app(A2, "Alpha Notes"),
  app(A3, "gamma Cam 📸", { policyUrl: null, developer: null }),
  privacyType("pt-1", A1, "DATA_LINKED_TO_YOU", "Data Linked to You"),
  privacyType("pt-2", A1, "DATA_NOT_LINKED_TO_YOU", "Data Not Linked to You"),
  privacyCategory("pc-1", "pt-1", "CONTACT_INFO", "Contact Info"),
  privacyCategory("pc-2", "pt-1", "LOCATION", "Location"),
  privacyCategory("pc-3", "pt-2", "DIAGNOSTICS", "Diagnostics"),
  privacyType("pt-3", A2, "DATA_NOT_COLLECTED", "Data Not Collected"),
  accessibility("af-1", A1, "VOICEOVER", "VoiceOver"),
  accessibility("af-2", A1, "CAPTIONS", "Captions"),
  analysis(A1, LONG_POLICY),
  annotation("an-1", A1, { tag: "watch" }),
  annotation("an-2", A2, { createdAt: now - 2 * HOUR }),
  annotation("an-private", A1, { visibility: "private" }),
  annotation("an-deleted", A2, { deletedAt: now - HOUR }),
  annotation("an-imported", A2, { source: "imported", sourceName: "Kim" }),
  verdict("v-1", A1, "replace", { rationale: "tracks location" }),
  verdict("v-2", A2, "safe", { updatedAt: now - HOUR }),
  verdict("v-imported", A3, "uninstall", {
    source: "imported",
    sourceName: "Kim",
  }),
];
const lovedOne = [setting("flag.focus.audience", "loved_one")];

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

// ── Projections of the two diagnostics bundles ───────────────────────
const keysOf = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : null;
const PROJECT = {
  "/api/diagnostics/bundle": (b) => ({
    keys: keysOf(b),
    schemaVersion: b.schemaVersion,
    generatedAt: b.generatedAt,
    appKeys: keysOf(b.app),
    hostKeys: keysOf(b.host),
    runtimeIsObject: keysOf(b.runtime) !== null,
    databaseIsObject: keysOf(b.database) !== null,
    diskIsObject: keysOf(b.disk) !== null,
    errorLogKeys: keysOf(b.errorLog),
    backgroundJobs: b.backgroundJobs,
    rateLimits: b.rateLimits,
    featureFlagOverrides: b.featureFlagOverrides,
    deploymentKeys: keysOf(b.deployment),
  }),
  "/api/deployment/support-bundle": (b) => ({
    keys: keysOf(b),
    generatedAt: b.generatedAt,
    diagnosticsKeys: keysOf(b.diagnostics),
    recentErrors: b.recentErrors,
  }),
};

// ── The runner ───────────────────────────────────────────────────────
const cases = [];
let ipCounter = 0;

async function run(name, spec) {
  const {
    route,
    method,
    search = "",
    json: jsonBody,
    raw,
    headers = {},
    setup: extraSetup = [],
    adminToken = null,
    repeat = 1,
    contentLength,
  } = spec;
  const setup = [...BASE, ...extraSetup];
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.8`;
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "bundles-oracle/1.0",
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  db.exec("SAVEPOINT bundles_case");
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
      for (let i = 0; i < repeat; i++) {
        const request = new NextRequest(
          `http://127.0.0.1:3000${route}${search}`,
          { method, headers: sent, body: body === null ? undefined : body }
        );
        try {
          const response = await handlers[route][method](request);
          const text = await response.text();
          expected = {
            status: response.status,
            body: PROJECT[route]
              ? JSON.stringify(PROJECT[route](JSON.parse(text)))
              : text,
            type: response.headers.get("content-type"),
            retryAfter: response.headers.get("retry-after"),
            disposition: response.headers.get("content-disposition"),
            cacheControl: response.headers.get("cache-control"),
          };
        } catch (error) {
          expected = {
            status: 500,
            body: "",
            type: null,
            retryAfter: null,
            disposition: null,
            cacheControl: null,
            thrown: String(error?.message ?? error),
          };
        }
      }
    } finally {
      restore();
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
      search,
      query: [...new URLSearchParams(search)],
      headers: sent,
      body,
      adminToken,
      repeat,
      projected: Boolean(PROJECT[route]),
      setup,
      stream,
      rows,
      expected,
    });
  } finally {
    recording = null;
    db.exec("ROLLBACK TO bundles_case; RELEASE bundles_case");
  }
}

/** What `buildAuditBundle` makes of `rows`, through a JSON round trip. */
function bundleOf(rows, opts = {}) {
  db.exec("SAVEPOINT bundles_build");
  try {
    for (const { sql, params } of [...BASE, ...rows]) {
      db.prepare(sql).run(...params);
    }
    return JSON.parse(JSON.stringify(buildAuditBundle(opts)));
  } finally {
    db.exec("ROLLBACK TO bundles_build; RELEASE bundles_build");
  }
}

const BOUNDARY = "----ptBundleBoundary7MA4YWxkTrZu0gW";
const multipartHeaders = (boundary = BOUNDARY) => ({
  "content-type": `multipart/form-data; boundary=${boundary}`,
});
const filePart = (content, filename = "sam.audit.json") =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n${content}\r\n`;
const fieldPart = (name, value) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const closing = `--${BOUNDARY}--\r\n`;

const admin = {
  adminToken: "secret-token",
  headers: { "x-auditor-admin-token": "secret-token" },
};

try {
  // ── POST /api/export/audit-bundle ────────────────────────────────
  {
    const route = "/api/export/audit-bundle";
    const method = "POST";
    const allowed = [...corpus, ...lovedOne];
    await run("export refused under the default focus", {
      route,
      method,
      setup: corpus,
      json: {},
    });
    await run("export for a loved-one audience", {
      route,
      method,
      setup: allowed,
      json: {},
    });
    await run("export of an empty install", {
      route,
      method,
      setup: lovedOne,
      json: {},
    });
    await run("export allowed by the handoff workflow", {
      route,
      method,
      setup: [...corpus, setting("flag.focus.workflow", "other_handoff")],
      json: {},
    });
    await run("export allowed by a user override", {
      route,
      method,
      setup: [
        ...corpus,
        flagOverride("flag.settings.admin.export.audit_bundle", "on"),
      ],
      json: {},
    });
    await run("export refused by a user override", {
      route,
      method,
      setup: [
        ...allowed,
        flagOverride("flag.settings.admin.export.audit_bundle", "off"),
      ],
      json: {},
    });
    await run("export with no body at all", { route, method, setup: allowed });
    await run("export with a whitespace body", {
      route,
      method,
      setup: allowed,
      raw: " \n\t ",
    });
    for (const [label, recommenderName] of [
      ["a plain name", "Sam"],
      ["a name to slug", "  Sam  O'Neil\tJr. "],
      ["a name that slugs to nothing", "李 📸 !!"],
      ["an accented name", "Zoë Å"],
      ["an empty name", ""],
      ["a null name", null],
    ]) {
      await run(`export under ${label}`, {
        route,
        method,
        setup: allowed,
        json: { recommenderName },
      });
    }
    // The bundle builds — the name rides along as it is — and then the
    // filename helper calls `.trim()` on it and throws, before the
    // last-exported setting is written. Next answers a bare 500.
    await run("export under a name that is not text", {
      route,
      method,
      setup: allowed,
      json: { recommenderName: 5 },
    });
    await run("export without the recommender profile", {
      route,
      method,
      setup: [
        ...allowed,
        setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict)),
      ],
      json: { includeRecommenderProfile: false },
    });
    await run("export names the preset the profile matches", {
      route,
      method,
      setup: [
        ...allowed,
        setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict)),
      ],
      json: { recommenderName: "Sam", includeRecommenderProfile: true },
    });
    await run("export of a custom profile names no preset", {
      route,
      method,
      setup: [
        ...allowed,
        setting(
          "privacy_profile",
          JSON.stringify({ ...PROFILE_PRESETS.strict, LOCATION: "tracking" })
        ),
      ],
      json: { includeRecommenderProfile: "yes" },
    });
    await run("export for a migration", {
      route,
      method,
      setup: allowed,
      json: { migrationFlow: true, recommenderName: "Me" },
    });
    await run("export ignores a migration flag that is not true", {
      route,
      method,
      setup: allowed,
      json: { migrationFlow: "true" },
    });
    await run("export as a guardian", {
      route,
      method,
      setup: [
        ...corpus,
        setting("flag.focus.audience", "guardian"),
        setting("flag.focus.workflow", "other_handoff"),
      ],
      json: {},
    });
    for (const [label, value] of [
      ["an array", []],
      ["a number", 7],
      ["a string", "bundle"],
    ]) {
      await run(`export body is ${label}`, {
        route,
        method,
        setup: allowed,
        json: value,
      });
    }
    await run("export body is null", {
      route,
      method,
      setup: allowed,
      json: null,
    });
    await run("export with invalid json", {
      route,
      method,
      setup: allowed,
      raw: "{not json",
    });
    await run("export declared too large", {
      route,
      method,
      setup: allowed,
      json: {},
      contentLength: 4 * 1024 + 1,
    });
    await run("export streamed too large", {
      route,
      method,
      setup: allowed,
      raw: `{"pad":"${"x".repeat(4 * 1024)}"}`,
    });
    await run("export admin token required", {
      route,
      method,
      setup: allowed,
      adminToken: "secret-token",
      json: {},
    });
    await run("export admin token accepted", {
      route,
      method,
      setup: allowed,
      ...admin,
      json: {},
    });
    await run("export rate limited", {
      route,
      method,
      setup: allowed,
      json: {},
      repeat: 6,
    });
  }

  // ── POST /api/import/audit-bundle ────────────────────────────────
  {
    const route = "/api/import/audit-bundle";
    const method = "POST";
    const bundle = bundleOf(
      [
        ...corpus,
        setting("privacy_profile", JSON.stringify(PROFILE_PRESETS.strict)),
      ],
      { recommenderName: " Sam ", exportedByAudience: "loved_one" }
    );
    const exportedMs = Date.parse(bundle.exported_at);
    // The recipient's install: one app older than the bundle, one newer.
    const recipient = [
      app(A1, "Beta Reader (old)", { lastSynced: now - 30 * DAY }),
      app(A2, "Alpha Notes (mine)", { lastSynced: now + DAY }),
      privacyType("pt-old", A1, "DATA_USED_TO_TRACK_YOU", "Tracking"),
      privacyCategory("pc-old", "pt-old", "IDENTIFIERS", "Identifiers"),
      accessibility("af-old", A1, "LARGER_TEXT", "Larger Text"),
      annotation("an-mine", A1, { content: "my own note" }),
      verdict("v-mine", A1, "safe"),
    ];

    await run("import preview", { route, method, json: bundle });
    await run("import preview of a multipart upload", {
      route,
      method,
      headers: multipartHeaders(),
      raw:
        fieldPart("note", "ignored") +
        filePart(JSON.stringify(bundle)) +
        closing,
    });
    await run("import preview reports an earlier import", {
      route,
      method,
      setup: [importRow(bundle.exported_at, now - 3 * DAY)],
      json: bundle,
    });
    await run("import preview of a bare bundle", {
      route,
      method,
      json: {
        version: 1,
        exported_at: "2026-01-01",
        apps: [],
        annotations: [],
      },
    });
    await run("import onto an empty install", {
      route,
      method,
      search: "?confirm=1",
      json: bundle,
    });
    await run("import of a multipart upload", {
      route,
      method,
      search: "?confirm=1",
      headers: multipartHeaders(),
      raw: filePart(JSON.stringify(bundle)) + closing,
    });
    await run("import merges by last sync", {
      route,
      method,
      search: "?confirm=1",
      setup: recipient,
      json: bundle,
    });
    await run("import refuses a duplicate", {
      route,
      method,
      search: "?confirm=1",
      setup: [importRow(bundle.exported_at, Date.UTC(2026, 0, 5, 0, 5, 9))],
      json: bundle,
    });
    await run("import of a duplicate in the afternoon", {
      route,
      method,
      search: "?confirm=1",
      setup: [importRow(bundle.exported_at, Date.UTC(2026, 10, 25, 13, 45, 0))],
      json: bundle,
    });
    await run("import of a duplicate, allowed", {
      route,
      method,
      search: "?confirm=1&allowDuplicate=1",
      setup: [importRow(bundle.exported_at, now - 3 * DAY)],
      json: bundle,
    });
    await run("import allowDuplicate only counts as 1", {
      route,
      method,
      search: "?confirm=true&allowDuplicate=true",
      json: bundle,
    });
    await run("import twice in a row", {
      route,
      method,
      search: "?confirm=1&allowDuplicate=1",
      json: bundle,
      repeat: 2,
    });

    // Hand-built bundles.
    const bare = (extra = {}) => ({
      version: 2,
      app_version: "9.9.9",
      exported_at: "2026-09-01T00:00:00.000Z",
      exported_by_audience: "self",
      recommender_name: null,
      recommender_profile: null,
      annotations: [],
      apps: [],
      ...extra,
    });
    const bundleApp = (id, extra = {}) => ({
      id,
      name: `Bundle App ${id}`,
      developer: null,
      bundle_id: null,
      url: storeUrl(id),
      icon_url: null,
      current_version: null,
      privacy_policy_url: null,
      has_privacy_details: 1,
      has_accessibility_labels: 0,
      privacy_types: [],
      accessibility_features: [],
      policy_summary: null,
      ...extra,
    });
    await run("import of a newer bundle is refused", {
      route,
      method,
      json: bare({ version: 3 }),
    });
    await run("import of a newer bundle with no app version", {
      route,
      method,
      json: bare({ version: 2.5, app_version: "" }),
    });
    await run("import of a newer bundle, forced", {
      route,
      method,
      search: "?confirm=1&force=1",
      json: bare({ version: 3, apps: [bundleApp("2001")] }),
    });
    await run("import forced past a missing version", {
      route,
      method,
      search: "?force=1",
      json: bare({ version: undefined }),
    });
    for (const [label, payload] of [
      ["null", null],
      ["an array", []],
      ["a string", "bundle"],
      ["a missing version", bare({ version: undefined })],
      ["a string version", bare({ version: "2" })],
      ["a missing exported_at", bare({ exported_at: undefined })],
      ["an empty exported_at", bare({ exported_at: "" })],
      ["a numeric exported_at", bare({ exported_at: 5 })],
      ["missing apps", bare({ apps: undefined })],
      ["apps that are not an array", bare({ apps: {} })],
      ["missing annotations", bare({ annotations: undefined })],
      ["annotations that are not an array", bare({ annotations: "none" })],
      ["an app that is null", bare({ apps: [bundleApp("1"), null] })],
      ["an app that is a string", bare({ apps: ["app"] })],
      ["an app with no id", bare({ apps: [bundleApp("")] })],
      ["an app with a numeric id", bare({ apps: [bundleApp(7)] })],
      ["an app with no name", bare({ apps: [bundleApp("7", { name: "" })] })],
      [
        "an app with no privacy types",
        bare({ apps: [bundleApp("7", { privacy_types: null })] }),
      ],
    ]) {
      await run(`import rejects ${label}`, { route, method, json: payload });
    }

    const crafted = bare({
      recommender_name: "   ",
      recommender_profile: {},
      recommender_profile_preset: "balanced",
      exported_at: "not a date",
      apps: [
        bundleApp("3001", {
          url: "javascript:alert(1)",
          icon_url: "http://169.254.169.254/icon.png",
          privacy_policy_url: "ftp://example.com/policy",
          policy_summary: {
            summary_json: '{"overview":"dropped with its url"}',
            source_text_excerpt: "never stored",
            fetched_at: 0,
            generated_at: 5,
          },
        }),
        bundleApp("3002", {
          url: "https://example.com/not-the-app-store/id3002",
          icon_url: "https://cdn.example.com/icon 2.png",
          privacy_policy_url: "https://example.com/p?a=1#frag",
          has_privacy_details: null,
          price_amount: 1.5,
          price_currency: "AUD",
          price_formatted: "$1.50",
          has_iap: 1,
          privacy_types: [
            {
              identifier: "DATA_LINKED_TO_YOU",
              title: "Data Linked to You",
              categories: [{ identifier: "LOCATION", title: "Location" }],
            },
            { identifier: "DATA_NOT_COLLECTED", title: "Data Not Collected" },
          ],
          accessibility_features: [
            { identifier: "VOICEOVER", title: "VoiceOver", declared: true },
            { identifier: "CAPTIONS", title: "Captions", declared: false },
            {
              identifier: "DARK",
              title: "Dark",
              declared: 1,
              description: "d",
            },
          ],
          policy_summary: {
            summary_json: null,
            source_text_excerpt: "  two\n\twords  ",
            fetched_at: now - HOUR,
            generated_at: null,
          },
        }),
      ],
      annotations: [
        {
          app_id: "3002",
          content: "kept",
          tag: "watch",
          created_at: 5,
          updated_at: 6,
        },
        { app_id: "3002", content: "kept with defaults" },
        { app_id: "missing", content: "dropped" },
      ],
      verdicts: [
        {
          app_id: "3002",
          verdict: "replace",
          rationale: "why",
          set_at: 7,
          updated_at: 8,
        },
        { app_id: "3001", verdict: "safe" },
        { app_id: "3002", verdict: "delete" },
        { app_id: "missing", verdict: "safe" },
      ],
    });
    await run("import sanitises urls and skips what it cannot place", {
      route,
      method,
      search: "?confirm=1",
      json: crafted,
    });
    await run(
      "import replaces an earlier recommendation from the same person",
      {
        route,
        method,
        search: "?confirm=1",
        setup: [
          app("3002", "Already Here", { lastSynced: 1 }),
          verdict("v-earlier", "3002", "safe", {
            source: "imported",
            sourceName: "Sam",
          }),
          verdict("v-own", "3002", "uninstall"),
        ],
        json: bare({
          recommender_name: "Sam",
          apps: [bundleApp("3002")],
          verdicts: [
            { app_id: "3002", verdict: "replace", rationale: "newer" },
          ],
        }),
      }
    );
    await run("import stashes the profile and the migration marker", {
      route,
      method,
      search: "?confirm=1",
      json: bare({
        recommender_name: "Me",
        migration_flow: true,
        recommender_profile: { LOCATION: "not_collected", 10: "odd" },
        apps: [bundleApp("4001")],
      }),
    });
    await run("import ignores a migration flag that is not true", {
      route,
      method,
      search: "?confirm=1",
      json: bare({ migration_flow: 1, recommender_profile: [] }),
    });
    await run("import annotation for an app only the recipient has", {
      route,
      method,
      search: "?confirm=1",
      setup: [app("5001", "Only Mine")],
      json: bare({ annotations: [{ app_id: "5001", content: "for yours" }] }),
    });
    await run("import fails on a value sqlite cannot bind", {
      route,
      method,
      search: "?confirm=1",
      setup: [app("6001", "Survivor")],
      json: bare({ apps: [bundleApp("6002", { developer: { name: "x" } })] }),
    });
    await run("import fails on a boolean sqlite cannot bind", {
      route,
      method,
      search: "?confirm=1",
      setup: [app("6001", "Survivor")],
      json: bare({ apps: [bundleApp("6005", { bundle_id: true })] }),
    });
    // `undefined` binds as NULL, so an app with only the validated fields
    // imports — url "", everything else NULL.
    await run("import of an app carrying only the required fields", {
      route,
      method,
      search: "?confirm=1",
      json: bare({
        apps: [{ id: "6003", name: "Sparse", privacy_types: [] }],
      }),
    });
    await run("import stores numbers as sqlite receives them", {
      route,
      method,
      search: "?confirm=1",
      json: bare({
        apps: [
          bundleApp("6004", {
            developer: 42,
            current_version: 3,
            has_privacy_details: 2.5,
          }),
        ],
      }),
    });

    // The upload itself.
    await run("import with no body", { route, method });
    await run("import with invalid json", { route, method, raw: "{not json" });
    await run("import with a whitespace body", { route, method, raw: "  " });
    await run("import declared too large", {
      route,
      method,
      json: bundle,
      contentLength: 8 * 1024 * 1024 + 1,
    });
    await run("import multipart without a file field", {
      route,
      method,
      headers: multipartHeaders(),
      raw: fieldPart("note", "no file here") + closing,
    });
    await run("import multipart whose file field is text", {
      route,
      method,
      headers: multipartHeaders(),
      raw: fieldPart("file", JSON.stringify(bundle)) + closing,
    });
    await run("import multipart takes the first file field", {
      route,
      method,
      headers: multipartHeaders(),
      raw:
        filePart(
          JSON.stringify(bare({ recommender_name: "First" })),
          "a.json"
        ) +
        filePart(
          JSON.stringify(bare({ recommender_name: "Second" })),
          "b.json"
        ) +
        closing,
    });
    await run("import multipart file that is not json", {
      route,
      method,
      headers: multipartHeaders(),
      raw: filePart("{not json") + closing,
    });
    await run("import multipart file with a byte-order mark", {
      route,
      method,
      headers: multipartHeaders(),
      raw: filePart(`﻿${JSON.stringify(bare())}`) + closing,
    });
    await run("import multipart with nothing but the closing boundary", {
      route,
      method,
      headers: multipartHeaders(),
      raw: closing,
    });
    await run("import multipart that never closes", {
      route,
      method,
      headers: multipartHeaders(),
      raw: filePart(JSON.stringify(bare())),
    });
    await run("import multipart with no boundary parameter", {
      route,
      method,
      headers: { "content-type": "multipart/form-data" },
      raw: filePart(JSON.stringify(bare())) + closing,
    });
    await run("import multipart under another boundary", {
      route,
      method,
      headers: multipartHeaders("somethingElse"),
      raw: filePart(JSON.stringify(bare())) + closing,
    });
    await run("import multipart with a quoted boundary", {
      route,
      method,
      headers: {
        "content-type": `multipart/form-data; charset=utf-8; boundary="${BOUNDARY}"`,
      },
      raw: filePart(JSON.stringify(bare())) + closing,
    });
    await run("import multipart declared too large", {
      route,
      method,
      headers: multipartHeaders(),
      raw: filePart(JSON.stringify(bare())) + closing,
      contentLength: 8 * 1024 * 1024 + 1,
    });
    // A guess at when the bundle's apps were synced that uses exportedMs,
    // so the fixture breaks loudly if the frozen clock stops reaching it.
    if (exportedMs !== now) {
      throw new Error("the bundle was not exported at the frozen clock");
    }
  }

  // ── GET /api/diagnostics/bundle, /api/deployment/support-bundle ──
  {
    const zeroSync = {
      attempted: 0,
      succeeded: 0,
      changes: 0,
      failed: 0,
      rateLimited: 0,
      skipped: 0,
    };
    const busy = [
      ...corpus,
      ...lovedOne,
      setting("flag.focus.goal.monitor", "true"),
      flagOverride("flag.dashboard.stats", "off"),
      flagOverride("flag.global.social_share", "on"),
      // Hard default off, the loved-one audience turns it on, and this
      // override turns it back: it resolves to its default and is listed
      // only because it is overridden at all.
      flagOverride("flag.settings.admin.export.audit_pdf", "off"),
      setting("sync_running", "true"),
      setting(
        "sync_bulk_state",
        JSON.stringify({
          version: 1,
          runId: "run-sync",
          startedAt: now - HOUR,
          initiator: "manual",
          updatedAt: now - 60_000,
          currentAppId: A1,
          queue: [
            { appId: A1, appName: "beta Reader", status: "pending" },
            { appId: A2, appName: "Alpha Notes", status: "done" },
          ],
          totals: zeroSync,
        })
      ),
      setting("rate_limit_search_until", String(now + 90_000)),
      setting("rate_limit_search_reason", "HTTP 429 from iTunes Search"),
      setting("rate_limit_scrape_until", String(now - 1)),
      setting("rate_limit_scrape_reason", "expired"),
      activity("act-1", "sync", "error", { errorMessage: "boom" }, now - HOUR),
      activity(
        "act-2",
        "policy_fetch",
        "error",
        {
          error: "blocked",
          fetchDiagnostics: {
            httpStatus: 403,
            contentType: "text/html",
            origin: "https://example.com",
            networkHint: "captive portal",
            troubleshoot: "try again",
            retryAfterMs: 5000,
            url: "https://example.com/secret/path?token=abc",
            body: "<html>",
          },
        },
        now - 2 * HOUR
      ),
      activity(
        "act-3",
        "sync",
        "error",
        { errorMessage: 5, error: 6, fetchDiagnostics: { url: "only" } },
        now - 3 * HOUR
      ),
      activity("act-4", "sync", "error", null, now - 4 * HOUR),
      activity("act-5", "sync", "ok", { errorMessage: "not an error" }, now),
      activity(
        "act-6",
        "scrape",
        "error",
        { fetchDiagnostics: "text" },
        now - 5 * HOUR
      ),
    ];
    const many = Array.from({ length: 10 }, (_, i) =>
      activity(
        `act-many-${i}`,
        "sync",
        "error",
        { error: `e${i}` },
        now - i * 1000
      )
    );
    for (const route of [
      "/api/diagnostics/bundle",
      "/api/deployment/support-bundle",
    ]) {
      await run(`${route} on a quiet install`, { route, method: "GET" });
      await run(`${route} on a busy install`, {
        route,
        method: "GET",
        setup: busy,
      });
    }
    await run("support bundle keeps the eight newest errors", {
      route: "/api/deployment/support-bundle",
      method: "GET",
      setup: many,
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
  "bundles-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
