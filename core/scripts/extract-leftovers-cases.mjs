/**
 * Leftovers oracle for the Rust server (Phase 4, batch 6).
 *
 * Runs the REAL handlers of the four outbound leftovers — `POST
 * /api/notifications/webhook-test`, `GET /api/update-status`, `GET
 * /api/favicon`, `GET /api/preview` — plus the two places webhook delivery
 * is fired from: `POST /api/dev/seed-notification` (the one caller of
 * `createNotification`, whose fan-out posts an immediate webhook) and the
 * 30-minute summary tick (`maybePostSummaryWebhook`, called directly, as
 * the backup oracle calls the snapshot closure), and the 6-hour update
 * tick (`checkForUpdate()` unforced). Records, per case, the request or
 * the callback, the setup rows, every raw fetch — URL, headers, and for a
 * POST its method and body — every write in order, three tables, and the
 * wire response with the headers these routes set.
 *
 * Two things this fixture must not carry as written. The favicon route
 * answers bytes, so its bodies (replies and responses) are base64. And
 * the update route reports `package.json`'s version, which the release
 * bump changes: it is masked as `<APP_VERSION>` here and substituted
 * back in the replay, so a release does not fail core-parity.
 *
 * Determinism as before: a frozen clock, advanced by the case where a
 * cache has to expire (each case records its own `now`), counted ids, a
 * distinct forwarded address per case, `DEPLOYMENT=node` pinned (the
 * runtime detection reads the environment; cases that test it set their
 * own), foreign keys ON. The immediate webhook is fire-and-forget on
 * Node, so those cases wait a moment after the response for the POST to
 * land in the recording.
 */
process.env.TZ = "UTC";

import nodeCrypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "pt-leftovers-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.NEXT_RUNTIME = "nodejs";
process.env.WORKER_DISABLED = "1";
process.env.DEPLOYMENT = "node";
delete process.env.AUDITOR_ADMIN_TOKEN;
delete process.env.PRIVACYTRACKER_RUNTIME;
delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
delete process.env.HOMEBREW_PREFIX;
delete process.env.HOMEBREW_FORMULA_PATH;

const BASE_NOW = Date.UTC(2026, 8, 15, 12, 34, 56, 789);
let now = BASE_NOW;
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

const handlers = {
  "/api/notifications/webhook-test": (
    await import("../../app/api/notifications/webhook-test/route.ts")
  ).POST,
  "/api/dev/seed-notification": (
    await import("../../app/api/dev/seed-notification/route.ts")
  ).POST,
  "/api/update-status": (await import("../../app/api/update-status/route.ts"))
    .GET,
  "/api/favicon": (await import("../../app/api/favicon/route.ts")).GET,
  "/api/preview": (await import("../../app/api/preview/route.ts")).GET,
};
const { maybePostSummaryWebhook } = await import(
  "../../lib/notification-webhooks.ts"
);
const { checkForUpdate } = await import("../../lib/update-check.ts");
const APP_VERSION = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../../package.json"
    ),
    "utf8"
  )
).version;

for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}

const TABLES = ["notifications", "app_settings", "audit_log"];

// ── Fixture rows ─────────────────────────────────────────────────────
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value
  );
const notification = (id, appName, summary, createdAt) =>
  stmt(
    "INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read) VALUES (?, ?, ?, ?, ?, 0)",
    id,
    "1001",
    appName,
    summary,
    createdAt
  );
const webhook = (url, format = "slack", frequency = "immediate") => [
  setting("notification_webhook_url", url),
  setting("notification_webhook_format", format),
  setting("notification_webhook_frequency", frequency),
];
const HOOK = "https://hooks.example.com/services/T1/B2/x3";
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── Replies ──────────────────────────────────────────────────────────
const reply = (status, body = "", headers = {}) => ({ status, headers, body });
const json = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const binary = (bytes, contentType, status = 200) => ({
  status,
  headers: contentType === null ? {} : { "content-type": contentType },
  bodyBase64: Buffer.from(bytes).toString("base64"),
});
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const ICO = [0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10];
const html = (body) =>
  reply(200, body, { "content-type": "text/html; charset=utf-8" });
const release = (over = {}) =>
  json({
    tag_name: "v9.9.9",
    name: "9.9.9",
    html_url:
      "https://github.com/privacykey/privacytracker/releases/tag/v9.9.9",
    published_at: "2026-09-01T00:00:00Z",
    body: "## Notes\n\n- one\n- two",
    draft: false,
    prerelease: false,
    ...over,
  });
const STORE_URL = "https://apps.apple.com/us/app/id90000001";
const storePage = (types) =>
  html(
    `<meta property="og:title" content=" Preview on the App Store"><meta property="og:image" content="https://example.com/Icon.png"><script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Dev"}}</script><a aria-label="Developer's Privacy Policy" href="https://example.com/privacy">Privacy Policy</a><script id="serialized-server-data">${JSON.stringify([{ data: { shelfMapping: { privacyTypes: { items: types } } } }])}</script>`
  );
const TYPES = [
  {
    identifier: "DATA_LINKED_TO_YOU",
    title: "Data Linked to You",
    detail: "Data Linked to You detail",
    categories: [
      { identifier: "CONTACT_INFO", title: "Contact Info" },
      { identifier: "LOCATION", title: "Location" },
    ],
  },
];

// ── The runner ───────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
const cases = [];
let ipCounter = 0;
const TOKEN = "leftovers-oracle-token";
const mask = (text) => text.replaceAll(APP_VERSION, "<APP_VERSION>");

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
}

async function run(name, spec = {}) {
  const {
    kind = "request",
    callback = null,
    route = null,
    method = "GET",
    search = "",
    json: jsonBody,
    raw,
    headers = {},
    setup = [],
    replies = [],
    adminToken = null,
    env = {},
    advance = 0,
    repeat = 1,
    contentLength,
    settle = false,
  } = spec;
  now += advance;
  ipCounter += 1;
  const ip = `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.6`;
  if (adminToken) {
    process.env.AUDITOR_ADMIN_TOKEN = adminToken;
  } else {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  }
  const body =
    jsonBody === undefined ? (raw ?? null) : JSON.stringify(jsonBody);
  const sent = {
    "x-forwarded-for": ip,
    "user-agent": "leftovers-oracle/1.0",
    ...(adminToken ? { "x-auditor-admin-token": adminToken } : {}),
    ...headers,
  };
  if (contentLength !== undefined) {
    sent["content-length"] = String(contentLength);
  }
  const calls = [];
  let cursor = 0;
  globalThis.fetch = async (target, init) => {
    const call = {
      url: String(target),
      headers: [...new Headers(init?.headers)],
    };
    if (init?.method && init.method !== "GET") {
      call.method = init.method;
      call.body =
        init.body === undefined || init.body === null
          ? null
          : String(init.body);
    }
    calls.push(call);
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply for ${call.url}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    const payload =
      r.bodyBase64 === undefined
        ? r.body === "" && [204, 205, 304].includes(r.status)
          ? null
          : r.body
        : Buffer.from(r.bodyBase64, "base64");
    return new Response(payload, { status: r.status, headers: r.headers });
  };
  const saved = quiet.map((k) => [k, console[k]]);
  db.exec("SAVEPOINT leftovers_case");
  try {
    for (const { sql, params } of setup) {
      db.prepare(sql).run(...params);
    }
    idCounter = 0;
    const stream = [];
    recording = stream;
    let expected;
    for (const k of quiet) {
      console[k] = () => {};
    }
    try {
      await withEnv(env, async () => {
        if (kind === "callback") {
          const returned =
            callback === "webhook-summary"
              ? await maybePostSummaryWebhook()
              : await checkForUpdate();
          expected = {
            returned:
              callback === "webhook-summary"
                ? returned
                : {
                    performed: returned.performed,
                    skipReason: returned.skipReason ?? null,
                    error: returned.error ?? null,
                    status: returned.status,
                  },
          };
          return;
        }
        for (let i = 0; i < repeat; i++) {
          const request = new NextRequest(
            `http://127.0.0.1:3000${route}${search}`,
            { method, headers: sent, body: body === null ? undefined : body }
          );
          try {
            const response = await handlers[route](request);
            const pick = (h) => response.headers.get(h);
            expected = {
              status: response.status,
              type: pick("content-type"),
              headers: {
                "cache-control": pick("cache-control"),
                "x-favicon-cache": pick("x-favicon-cache"),
                "retry-after": pick("retry-after"),
              },
            };
            if (route === "/api/favicon") {
              expected.bodyBase64 = Buffer.from(
                await response.arrayBuffer()
              ).toString("base64");
            } else {
              expected.body = await response.text();
            }
          } catch (error) {
            expected = {
              status: 500,
              body: "",
              type: null,
              headers: {
                "cache-control": null,
                "x-favicon-cache": null,
                "retry-after": null,
              },
              thrown: String(error?.message ?? error),
            };
          }
        }
        if (settle) {
          // The immediate webhook is `void`ed: let the detached POST land.
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      });
    } finally {
      for (const [k, fn] of saved) {
        console[k] = fn;
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
    cases.push(
      JSON.parse(
        mask(
          JSON.stringify({
            name,
            kind,
            callback,
            route,
            method,
            search,
            query: [...new URLSearchParams(search)],
            headers: sent,
            body,
            adminToken,
            env,
            now,
            repeat,
            setup,
            replies,
            calls,
            stream,
            rows,
            expected,
          })
        )
      )
    );
  } finally {
    recording = null;
    db.exec("ROLLBACK TO leftovers_case; RELEASE leftovers_case");
  }
}

const post = (name, route, spec) =>
  run(name, { ...spec, route, method: "POST" });
const get = (name, route, spec) => run(name, { ...spec, route, method: "GET" });
const seed = (name, spec) =>
  post(name, "/api/dev/seed-notification", {
    adminToken: TOKEN,
    settle: true,
    json: {
      appId: "1001",
      appName: "Instagram",
      changes: [
        {
          category: "privacy-label",
          type: "added",
          description: "Now collects Location",
        },
      ],
    },
    ...spec,
  });
const summary = (name, spec) =>
  run(name, { ...spec, kind: "callback", callback: "webhook-summary" });
const updateTick = (name, spec) =>
  run(name, { ...spec, kind: "callback", callback: "update-check" });

try {
  // ── POST /api/notifications/webhook-test ─────────────────────────
  {
    const route = "/api/notifications/webhook-test";
    for (const format of ["slack", "discord", "teams", "generic"]) {
      await post(`webhook test posts a ${format} payload`, route, {
        json: { url: HOOK, format },
        replies: [reply(200, "ok")],
      });
    }
    await post("webhook test defaults to the generic format", route, {
      json: { url: HOOK },
      replies: [reply(200, "ok")],
    });
    await post("webhook test answers 204 as ok", route, {
      json: { url: HOOK, format: "slack" },
      replies: [reply(204)],
    });
    await post("webhook test reports a 500", route, {
      json: { url: HOOK, format: "slack" },
      replies: [reply(500, "nope")],
    });
    await post("webhook test does not follow a redirect", route, {
      json: { url: HOOK, format: "slack" },
      replies: [
        reply(302, "", { location: "https://hooks.example.com/moved" }),
      ],
    });
    await post("webhook test reports a failed request", route, {
      json: { url: HOOK, format: "slack" },
      replies: [{ error: "connect ECONNREFUSED 203.0.113.9:443" }],
    });
    await post("webhook test refuses a loopback url", route, {
      json: { url: "http://127.0.0.1:9/hook", format: "slack" },
    });
    await post("webhook test refuses a metadata host", route, {
      json: { url: "http://169.254.169.254/latest/meta-data", format: "slack" },
    });
    await post("webhook test refuses localhost by name", route, {
      json: { url: "https://localhost/hook", format: "generic" },
    });
    await post("webhook test refuses a url over 512 characters", route, {
      json: {
        url: `https://hooks.example.com/${"x".repeat(520)}`,
        format: "slack",
      },
    });
    await post("webhook test refuses an ftp url", route, {
      json: { url: "ftp://hooks.example.com/hook", format: "slack" },
    });
    await post("webhook test refuses credentials in the url", route, {
      json: {
        url: "https://user:pass@hooks.example.com/hook",
        format: "slack",
      },
    });
    await post("webhook test refuses a url that is not one", route, {
      json: { url: 12_345, format: "slack" },
    });
    await post("webhook test needs a url", route, {
      json: { format: "slack" },
    });
    await post("webhook test needs a url that is not blank", route, {
      json: { url: "   ", format: "slack" },
    });
    await post("webhook test trims the url", route, {
      json: { url: `  ${HOOK}\n`, format: "slack" },
      replies: [reply(200, "ok")],
    });
    await post("webhook test refuses an unknown format", route, {
      json: { url: HOOK, format: "pager" },
    });
    await post("webhook test refuses a format that is not text", route, {
      json: { url: HOOK, format: 42 },
    });
    await post("webhook test refuses a null format as generic", route, {
      json: { url: HOOK, format: null },
      replies: [reply(200, "ok")],
    });
    await post("webhook test with invalid json", route, { raw: "{not json" });
    await post("webhook test with an empty body", route, {});
    await post("webhook test with a whitespace body", route, { raw: "  \n " });
    await post("webhook test with a null body", route, { raw: "null" });
    await post("webhook test with an array body", route, { raw: "[1,2]" });
    await post("webhook test with a string body", route, { raw: '"hook"' });
    await post("webhook test declared too large", route, {
      json: { url: HOOK },
      contentLength: 2049,
    });
    await post("webhook test streamed too large", route, {
      raw: `{"url":"${"x".repeat(2100)}"}`,
    });
  }

  // ── POST /api/dev/seed-notification: the immediate webhook ───────
  await seed("seed notification posts an immediate slack webhook", {
    setup: webhook(HOOK, "slack", "immediate"),
    replies: [reply(200, "ok")],
  });
  await seed("seed notification posts a generic webhook with the row", {
    setup: webhook(HOOK, "generic", "immediate"),
    replies: [reply(200, "ok")],
  });
  await seed("seed notification posts nothing for a daily frequency", {
    setup: webhook(HOOK, "slack", "daily_summary"),
  });
  await seed("seed notification posts nothing when the frequency is off", {
    setup: webhook(HOOK, "slack", "off"),
  });
  await seed("seed notification posts nothing without a url", {
    setup: webhook("   ", "slack", "immediate"),
  });
  await seed(
    "seed notification posts nothing when no webhook is configured",
    {}
  );
  await seed(
    "seed notification reads garbage format and frequency as generic and immediate",
    {
      setup: webhook(HOOK, "carrier-pigeon", "hourly"),
      replies: [reply(200, "ok")],
    }
  );
  await seed("seed notification headline falls back to the count of two", {
    setup: webhook(HOOK, "slack", "immediate"),
    replies: [reply(200, "ok")],
    json: {
      appId: "1001",
      appName: "Instagram",
      changes: [
        { type: "added", description: "" },
        { type: "removed", description: "Dropped Contacts" },
      ],
    },
  });
  await seed("seed notification headline falls back to the count of one", {
    setup: webhook(HOOK, "slack", "immediate"),
    replies: [reply(200, "ok")],
    json: {
      appId: "1001",
      appName: "Instagram",
      changes: [{ type: "added", description: "" }],
    },
  });
  await seed("seed notification survives a failed webhook", {
    setup: webhook(HOOK, "slack", "immediate"),
    replies: [{ error: "connect ETIMEDOUT" }],
  });
  await seed("seed notification survives a webhook that answers 500", {
    setup: webhook(HOOK, "teams", "immediate"),
    replies: [reply(500, "no")],
  });
  await seed("seed notification posts to the trimmed url", {
    setup: webhook(`  ${HOOK}  `, "discord", "immediate"),
    replies: [reply(200, "ok")],
  });
  await seed(
    "seed notification refused by a private webhook url posts nothing",
    {
      setup: webhook("http://10.0.0.7/hook", "slack", "immediate"),
    }
  );
  await seed("seed notification with no changes posts nothing", {
    setup: webhook(HOOK, "slack", "immediate"),
    json: { appId: "1001", appName: "Instagram", changes: [] },
  });

  // ── The summary tick ─────────────────────────────────────────────
  // `app_name` is NOT NULL, so the nameless line the digest can render is
  // the one whose name is the empty string.
  const rowsWithin = (count, offsetMs = HOUR) =>
    Array.from({ length: count }, (_, i) =>
      notification(
        `n-${i}`,
        i % 3 === 2 ? "" : `App ${i}`,
        JSON.stringify([{ type: "added", description: `Change ${i}` }]),
        now - offsetMs - i * 60_000
      )
    );
  await summary("summary tick posts a daily digest of the last day", {
    setup: [
      ...webhook(HOOK, "slack", "daily_summary"),
      ...rowsWithin(3),
      notification("old", "Old App", "[]", now - 2 * DAY),
    ],
    replies: [reply(200, "ok")],
  });
  await summary("summary tick posts a weekly digest since the last one", {
    setup: [
      ...webhook(HOOK, "generic", "weekly_summary"),
      setting("notification_webhook_last_sent", String(now - 8 * DAY)),
      ...rowsWithin(2, 3 * DAY),
      notification("older", "Older", "[]", now - 9 * DAY),
    ],
    replies: [reply(200, "ok")],
  });
  await summary("summary tick posts nothing inside the window", {
    setup: [
      ...webhook(HOOK, "slack", "daily_summary"),
      setting("notification_webhook_last_sent", String(now - HOUR)),
      ...rowsWithin(2),
    ],
  });
  await summary("summary tick moves the cursor over an empty window", {
    setup: [...webhook(HOOK, "slack", "daily_summary")],
  });
  await summary("summary tick posts nothing for an immediate frequency", {
    setup: [...webhook(HOOK, "slack", "immediate"), ...rowsWithin(2)],
  });
  await summary("summary tick posts nothing when off", {
    setup: [...webhook(HOOK, "slack", "off"), ...rowsWithin(2)],
  });
  await summary("summary tick posts nothing without a url", {
    setup: [...webhook("", "slack", "daily_summary"), ...rowsWithin(2)],
  });
  await summary("summary tick keeps the cursor when the post fails", {
    setup: [...webhook(HOOK, "slack", "daily_summary"), ...rowsWithin(2)],
    replies: [{ error: "connect ECONNRESET" }],
  });
  await summary("summary tick moves the cursor even when the post is refused", {
    setup: [...webhook(HOOK, "slack", "daily_summary"), ...rowsWithin(2)],
    replies: [reply(500, "no")],
  });
  await summary("summary tick sends the fifty newest of more", {
    setup: [...webhook(HOOK, "slack", "daily_summary"), ...rowsWithin(55)],
    replies: [reply(200, "ok")],
  });
  await summary("summary tick counts one update", {
    setup: [...webhook(HOOK, "teams", "daily_summary"), ...rowsWithin(1)],
    replies: [reply(200, "ok")],
  });
  await summary("summary tick cuts a discord digest", {
    setup: [
      ...webhook(HOOK, "discord", "daily_summary"),
      ...Array.from({ length: 12 }, (_, i) =>
        notification(`long-${i}`, `App ${i}`, "x".repeat(300), now - HOUR - i)
      ),
    ],
    replies: [reply(200, "ok")],
  });
  await summary("summary tick reads a garbage cursor as never sent", {
    setup: [
      ...webhook(HOOK, "slack", "daily_summary"),
      setting("notification_webhook_last_sent", "yesterday"),
      ...rowsWithin(1),
    ],
    replies: [reply(200, "ok")],
  });
  await summary(
    "summary tick refused by a private webhook url keeps the cursor",
    {
      setup: [
        ...webhook("http://192.168.1.2/hook", "slack", "daily_summary"),
        ...rowsWithin(1),
      ],
    }
  );

  // ── GET /api/update-status ───────────────────────────────────────
  {
    const route = "/api/update-status";
    await get("update status never checked", route, {});
    await get("update status with a newer release cached", route, {
      setup: [
        setting("update_latest_version", "9.9.9"),
        setting("update_last_checked", String(now - HOUR)),
        setting(
          "update_latest_url",
          "https://github.com/privacykey/privacytracker/releases/tag/v9.9.9"
        ),
        setting("update_latest_pub_date", "2026-09-01T00:00:00Z"),
        setting("update_latest_notes", "## Notes"),
      ],
    });
    await get("update status with the current release cached", route, {
      setup: [
        setting("update_latest_version", APP_VERSION),
        setting("update_last_checked", String(now - HOUR)),
      ],
    });
    await get("update status with an older release cached", route, {
      setup: [setting("update_latest_version", "0.0.1")],
    });
    await get(
      "update status with a pre-release of the next version cached",
      route,
      {
        setup: [setting("update_latest_version", "99.0.0-beta.1")],
      }
    );
    await get("update status disabled, with an error", route, {
      setup: [
        setting("update_check_enabled", "false"),
        setting("update_last_error", "GitHub API 503: down"),
      ],
    });
    await get("update status with a garbage last-checked", route, {
      setup: [setting("update_last_checked", "yesterday")],
    });
    await get("update status in docker by the environment", route, {
      env: { DEPLOYMENT: "docker" },
    });
    await get("update status in tauri, spelled loosely", route, {
      env: { DEPLOYMENT: " Tauri " },
    });
    await get("update status under homebrew", route, {
      env: { DEPLOYMENT: null, HOMEBREW_PREFIX: "/opt/homebrew" },
    });
    await get("update status with an unknown deployment word", route, {
      env: { DEPLOYMENT: "vercel" },
    });
    await get("update status refresh spelled true is the cache", route, {
      search: "?refresh=true",
      setup: [setting("update_latest_version", "9.9.9")],
    });
    await get("update refresh while disabled", route, {
      search: "?refresh=1",
      setup: [setting("update_check_enabled", "false")],
    });
    await get("update refresh throttled by a recent forced check", route, {
      search: "?refresh=1",
      setup: [setting("update_last_forced_check", String(now - 60_000))],
    });
    await get("update refresh finds a newer release", route, {
      search: "?refresh=1",
      replies: [release()],
    });
    await get("update refresh past a fresh cache and a backoff", route, {
      search: "?refresh=1",
      setup: [
        setting("update_last_checked", String(now - HOUR)),
        setting("update_last_failed", String(now - 60_000)),
        setting("update_fail_count", "3"),
        setting("update_last_error", "GitHub API 503: down"),
      ],
      replies: [release({ tag_name: "V2.0.0-rc.1+build.5" })],
    });
    await get("update refresh with no releases published", route, {
      search: "?refresh=1",
      replies: [reply(404, "Not Found")],
    });
    await get("update refresh when GitHub answers 500", route, {
      search: "?refresh=1",
      replies: [reply(500, "rate limited")],
    });
    await get("update refresh when GitHub answers 500 with no body", route, {
      search: "?refresh=1",
      setup: [setting("update_fail_count", "2")],
      replies: [reply(500)],
    });
    await get("update refresh when the request fails", route, {
      search: "?refresh=1",
      replies: [{ error: "fetch failed" }],
    });
    await get("update refresh with a pre-release", route, {
      search: "?refresh=1",
      setup: [setting("update_latest_version", "1.0.0")],
      replies: [release({ prerelease: true })],
    });
    await get("update refresh with a draft", route, {
      search: "?refresh=1",
      replies: [release({ draft: true })],
    });
    await get("update refresh with a tag that is not semver", route, {
      search: "?refresh=1",
      replies: [release({ tag_name: "v1.2" })],
    });
    await get("update refresh with an empty tag", route, {
      search: "?refresh=1",
      setup: [setting("update_latest_version", "1.0.0")],
      replies: [release({ tag_name: "  " })],
    });
    await get("update refresh with a missing tag", route, {
      search: "?refresh=1",
      replies: [json({ html_url: "https://example.com" })],
    });
    await get("update refresh cuts the notes at four thousand", route, {
      search: "?refresh=1",
      replies: [release({ body: `${"n".repeat(4500)}!` })],
    });
    await get("update refresh with only a tag", route, {
      search: "?refresh=1",
      replies: [json({ tag_name: "v3.0.0" })],
    });
    await get("update refresh with a stored error to clear", route, {
      search: "?refresh=1",
      setup: [
        setting("update_last_error", "GitHub API 500: earlier"),
        setting("update_last_failed", String(now - 2 * DAY)),
        setting("update_fail_count", "4"),
      ],
      replies: [release()],
    });
  }

  // ── The update tick ──────────────────────────────────────────────
  await updateTick("update tick skips a fresh cache", {
    setup: [setting("update_last_checked", String(now - HOUR))],
  });
  await updateTick("update tick skips inside the backoff", {
    setup: [
      setting("update_last_failed", String(now - 10 * 60_000)),
      setting("update_fail_count", "1"),
    ],
  });
  await updateTick("update tick runs past the backoff", {
    setup: [
      setting("update_last_failed", String(now - 20 * 60_000)),
      setting("update_fail_count", "1"),
    ],
    replies: [release()],
  });
  await updateTick("update tick runs on a stale cache", {
    setup: [setting("update_last_checked", String(now - 25 * HOUR))],
    replies: [release()],
  });
  await updateTick("update tick skips when disabled", {
    setup: [setting("update_check_enabled", "false")],
  });
  await updateTick("update tick records a failure", {
    replies: [reply(502, "bad gateway")],
  });

  // ── GET /api/favicon ─────────────────────────────────────────────
  {
    const route = "/api/favicon";
    await get("favicon without a host", route, {});
    await get("favicon with a blank host", route, { search: "?host=%20%20" });
    await get("favicon for a private address", route, {
      search: "?host=10.1.2.3",
    });
    await get("favicon for localhost", route, { search: "?host=localhost" });
    await get("favicon for an ftp url", route, {
      search: "?host=ftp://example.com",
    });
    await get("favicon for a url with credentials", route, {
      search: "?host=https://u:p@example.com",
    });
    await get("favicon served straight from favicon.ico", route, {
      search: "?host=png.example",
      replies: [binary(PNG, "image/png")],
    });
    await get("favicon served again from the cache", route, {
      search: "?host=png.example",
    });
    await get("favicon host given as a url with a port", route, {
      search: "?host=https://Port.Example:8443/some/page?x=1",
      replies: [binary(ICO, "image/x-icon")],
    });
    await get("favicon host given as scheme-relative", route, {
      search: "?host=//slashes.example",
      replies: [binary(PNG, "image/png")],
    });
    await get("favicon with a bogus type that looks binary", route, {
      search: "?host=bogus.example",
      replies: [binary(PNG, "text/plain")],
    });
    await get("favicon with no type that looks binary", route, {
      search: "?host=untyped.example",
      replies: [binary(PNG, null)],
    });
    // A real .ico begins 00 00 01 00: with no type it does not "look
    // binary" (the first byte is not above 0x7f) and is passed over.
    await get("favicon with no type and an ico is not binary enough", route, {
      search: "?host=untypedico.example",
      replies: [binary(ICO, null), reply(404)],
    });
    await get("favicon type is read without its parameters", route, {
      search: "?host=params.example",
      replies: [binary(PNG, "IMAGE/PNG; charset=binary")],
    });
    await get("favicon found through the site root", route, {
      search: "?host=linked.example",
      replies: [
        reply(404, "<h1>no</h1>", { "content-type": "text/html" }),
        html(
          '<html><head><link rel="icon" href="/static/icon.png"></head></html>'
        ),
        binary(PNG, "image/png"),
      ],
    });
    await get("favicon page instead of an icon falls back to the root", route, {
      search: "?host=htmlico.example",
      replies: [
        html("<html>not an icon</html>"),
        html('<link rel="shortcut icon" href="favicon-32.png">'),
        binary(PNG, "image/png"),
      ],
    });
    await get(
      "favicon prefers icon over shortcut icon over apple-touch-icon",
      route,
      {
        search: "?host=prefers.example",
        replies: [
          reply(404),
          html(
            '<link rel="apple-touch-icon" href="/apple.png"><LINK REL=\'shortcut icon\' HREF=\'/old.ico\'><link rel=icon href=/best.svg type="image/svg+xml"><link rel="icon" href="/second.svg">'
          ),
          binary(PNG, "image/svg+xml"),
        ],
      }
    );
    await get("favicon link resolved against the root's final url", route, {
      search: "?host=moved.example",
      replies: [
        reply(404),
        reply(301, "", { location: "https://www.moved.example/home/" }),
        html('<link rel="icon" href="../assets/i.ico">'),
        binary(ICO, "image/x-icon"),
      ],
    });
    await get("favicon link on another host", route, {
      search: "?host=cdn-linked.example",
      replies: [
        reply(404),
        html('<link rel="icon" href="//cdn.example.net/i.png">'),
        binary(PNG, "image/png"),
      ],
    });
    await get("favicon root without an icon link is a miss", route, {
      search: "?host=nolink.example",
      replies: [reply(404), html("<html><head><title>x</title></head></html>")],
    });
    await get("favicon miss served again from the cache", route, {
      search: "?host=nolink.example",
    });
    await get("favicon root that fails is a miss", route, {
      search: "?host=rootfail.example",
      replies: [reply(404), reply(503, "down")],
    });
    await get("favicon linked icon that is empty is a miss", route, {
      search: "?host=emptyicon.example",
      replies: [
        reply(404),
        html('<link rel="icon" href="/i.png">'),
        binary([], "image/png"),
      ],
    });
    await get("favicon linked icon that is html is a miss", route, {
      search: "?host=htmlicon.example",
      replies: [
        reply(404),
        html('<link rel="icon" href="/i.png">'),
        html("<html>404</html>"),
      ],
    });
    await get("favicon request that fails falls back and misses", route, {
      search: "?host=neterr.example",
      replies: [
        { error: "getaddrinfo ENOTFOUND neterr.example" },
        { error: "getaddrinfo ENOTFOUND neterr.example" },
      ],
    });
    await get("favicon link to a private address is a miss", route, {
      search: "?host=privlink.example",
      replies: [
        reply(404),
        html('<link rel="icon" href="http://127.0.0.1/i.png">'),
      ],
    });
    await get("favicon hit is refetched after a day", route, {
      search: "?host=png.example",
      advance: DAY + 1000,
      replies: [binary(ICO, "image/vnd.microsoft.icon")],
    });
    await get("favicon miss is retried after an hour", route, {
      search: "?host=nolink.example",
      advance: 0,
      replies: [
        reply(404),
        html('<link rel="icon" href="/late.png">'),
        binary(PNG, "image/png"),
      ],
    });
    await get("favicon over http keeps https for the fetch", route, {
      search: "?host=http://plain.example/",
      replies: [binary(PNG, "image/png")],
    });
    await get("favicon over an oversized icon is a miss", route, {
      search: "?host=huge.example",
      replies: [
        reply(200, "", {
          "content-type": "image/png",
          "content-length": "9999999",
        }),
        html("<html></html>"),
      ],
    });
  }

  // ── GET /api/preview ─────────────────────────────────────────────
  {
    const route = "/api/preview";
    await get("preview without a url", route, {});
    await get("preview with an empty url", route, { search: "?url=" });
    await get("preview with a url off the App Store", route, {
      search: "?url=https://example.com/app/id1",
    });
    await get("preview with a url that is not one", route, {
      search: "?url=not%20a%20url",
    });
    await get("preview of a page", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      replies: [storePage(TYPES)],
    });
    await get("preview when Apple rate-limits", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      replies: [reply(429, "", { "retry-after": "30" })],
    });
    await get("preview when Apple answers 500", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      replies: [reply(500, "")],
    });
    await get("preview of a page without the data script", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      replies: [html("<html><body>nothing</body></html>")],
    });
    await get("preview when the request fails", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      replies: [{ error: "connect ECONNRESET" }],
    });
    await get("preview rate limited on the thirty-first request", route, {
      search: `?url=${encodeURIComponent(STORE_URL)}`,
      repeat: 31,
      replies: Array.from({ length: 30 }, () => storePage(TYPES)),
    });
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "tests",
  "fixtures",
  "leftovers-cases.json"
);
writeFileSync(out, `${JSON.stringify({ now: BASE_NOW, cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
process.exit(0);
