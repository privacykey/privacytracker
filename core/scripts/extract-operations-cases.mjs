/** Execute actual Node GET handlers; expected bytes are never derived in Rust. */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  jobState,
  OPS_APP,
  OPS_FILES,
  OPS_MANUAL,
  operationsStatements,
  setting,
  statement,
  writeOperationsFiles,
} from "../../scripts/parity/operations-fixture.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pt-operations-cases-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.TZ = "UTC";
delete process.env.AUDITOR_ADMIN_TOKEN;
const now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
  static now() {
    return now;
  }
};
globalThis.__pt_csp_ring = [];
const { default: db } = await import("../../lib/db.ts");
const routes = [
  "tasks/active",
  "wayback/import-all",
  "policy/sync-all",
  "rate-limit/status",
  "backup/snapshots",
  "ai/debug-log",
  "csp-report",
  "export",
  "manual-apps/[id]",
];
const handlers = {};
for (const r of routes) {
  handlers[`/api/${r}`] = (await import(`../../app/api/${r}/route.ts`)).GET;
}
for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}
db.pragma("foreign_keys = OFF");
const base = operationsStatements(now);
const cases = [];
async function run(
  name,
  route,
  {
    search = "",
    changes = [],
    empty = false,
    id = OPS_MANUAL,
    reports = [],
    files = OPS_FILES,
    fileMode = "files",
  } = {}
) {
  db.exec("SAVEPOINT operation_case");
  const backupDir = path.join(dir, "backups");
  rmSync(backupDir, { recursive: true, force: true });
  globalThis.__pt_csp_ring.splice(0, Number.POSITIVE_INFINITY, ...reports);
  try {
    for (const s of [...(empty ? [] : base), ...changes]) {
      db.prepare(s.sql).run(...s.params);
    }
    if (fileMode === "files") {
      writeOperationsFiles(dir, files);
    } else if (fileMode === "not-directory") {
      writeFileSync(backupDir, "not a directory");
    } else if (fileMode === "broken-link") {
      mkdirSync(backupDir);
      symlinkSync(
        path.join(dir, "absent"),
        path.join(backupDir, "privacytracker-snapshot-broken.json")
      );
    }
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    let expected;
    try {
      const response = await handlers[route](
        new NextRequest(`http://localhost${route}${search}`),
        { params: Promise.resolve({ id }) }
      );
      expected = {
        status: response.status,
        body: (await response.text()).replaceAll(dir, "<DATA>"),
        type: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
      };
    } catch {
      expected = { status: 500, body: "", type: null, disposition: null };
    }
    const writes = db.prepare("SELECT total_changes() AS n").get().n - before;
    if (writes !== 0) {
      throw new Error(`GET wrote to SQLite in ${name}: ${writes}`);
    }
    cases.push({
      name,
      route,
      query: [...new URLSearchParams(search)],
      changes,
      empty,
      id,
      reports,
      files: files === OPS_FILES ? null : files,
      fileMode,
      expected,
    });
  } finally {
    db.exec("ROLLBACK TO operation_case; RELEASE operation_case");
  }
}
for (const route of Object.keys(handlers)) {
  await run(`${route} empty`, route, { empty: true, fileMode: "absent" });
  await run(`${route} populated`, route);
}
await run("orphan policy run retains a null app name", "/api/tasks/active", {
  changes: [statement("DELETE FROM apps WHERE id=?", OPS_APP)],
});
await run(
  "runner totals use JS Number spelling at exponent and precision boundaries",
  "/api/policy/sync-all",
  {
    changes: [
      setting(
        "policy_bulk_state",
        jobState(now, {
          totals: {
            numbers: [
              1e-7,
              1e-6,
              1e20,
              1e21,
              1e23,
              -1e-7,
              -1e20,
              -1e21,
              1000000000000000100,
              Number("9223372036854775808"),
              1.2345678901234567,
              5e-324,
              1.7976931348623157e308,
            ],
          },
        })
      ),
    ],
  }
);
for (const [key, route] of [
  ["wayback", "/api/wayback/import-all"],
  ["policy", "/api/policy/sync-all"],
  ["sync", "/api/tasks/active"],
]) {
  const mutex = {
    wayback: "wayback_import_running",
    policy: "policy_sync_running",
    sync: "sync_running",
  }[key];
  for (const raw of [
    "",
    "broken",
    "null",
    "[]",
    '{"version":"1","runId":"x","queue":[]}',
    '{"version":9,"runId":"x","queue":[]}',
    '{"version":1,"runId":2,"queue":[]}',
    '{"version":1,"runId":"x","queue":{}}',
  ]) {
    await run(`${key} invalid ${raw}`, route, {
      changes: [setting(`${key}_bulk_state`, raw)],
    });
  }
  for (const held of ["true", "false", "TRUE"]) {
    for (const queue of [
      [],
      [{ status: "done" }, { status: "failed" }],
      [{ status: "pending" }],
    ]) {
      await run(`${key} mutex ${held} queue ${JSON.stringify(queue)}`, route, {
        changes: [
          setting(mutex, held),
          setting(`${key}_bulk_state`, jobState(now, { queue })),
        ],
      });
    }
  }
  for (const extra of [
    { version: 2 },
    { queue: [null] },
    { queue: [false, 0, "string", {}, { status: "future" }] },
    { currentAppId: "missing" },
    { currentAppId: "" },
    {
      currentAppId: 4,
      queue: [
        { appId: "4", appName: "wrong" },
        { appId: 4, appName: false, status: "in_progress" },
      ],
    },
    {
      currentAppId: { id: 1 },
      queue: [{ appId: { id: 1 }, appName: "structural equality is wrong" }],
    },
    {
      currentAppId: "b",
      queue: [
        { appId: "b", appName: "first" },
        { appId: "b", appName: "last" },
      ],
    },
    {
      totals: { 10: "ten", 2: "two", fraction: 1e-7, n: 9007199254740992 },
      initiator: null,
      startedAt: 0,
      updatedAt: null,
    },
  ]) {
    await run(`${key} state ${JSON.stringify(extra)}`, route, {
      changes: [setting(`${key}_bulk_state`, jobState(now, extra))],
    });
  }
  await run(`${key} sparse state omits direct property reads`, route, {
    changes: [
      setting(`${key}_bulk_state`, { version: 1, runId: "", queue: [] }),
    ],
  });
}
for (const status of [
  "running",
  "paused",
  "pause_requested",
  "cancel_requested",
  "future",
  null,
]) {
  for (const route of ["/api/wayback/import-all", "/api/tasks/active"]) {
    await run(`wayback ${status} ${route}`, route, {
      changes: [
        setting(
          "wayback_bulk_state",
          jobState(now, {
            status,
            pausedAt: 0,
            pauseCause: "",
            pauseRequestedAt: 123,
            cancelRequestedAt: 456,
          })
        ),
      ],
    });
  }
}
for (const raw of [
  "",
  "bad",
  "0",
  "-1",
  `${now}`,
  `${now + 1}tail`,
  "\uFEFF +9999999999999.5",
  "0x10",
  "9007199254740993",
  "9223372036854775808",
  "9".repeat(400),
]) {
  await run(`cooldown ${raw}`, "/api/rate-limit/status", {
    changes: [setting("rate_limit_search_until", raw)],
  });
  await run(`backup coercion ${raw}`, "/api/backup/snapshots", {
    changes: [
      setting("backup_snapshot_interval_hours", raw),
      setting("backup_snapshot_retention_count", raw),
      setting("backup_snapshot_last_run_at", raw),
    ],
  });
}
await run("backup enabled exact lowercase", "/api/backup/snapshots", {
  changes: [setting("backup_snapshot_enabled", "TRUE")],
});
for (const fileMode of ["absent", "not-directory", "broken-link"]) {
  await run(`backup ${fileMode}`, "/api/backup/snapshots", { fileMode });
}
const filenameDates = [
  "2026",
  "2026-09",
  "2026-9-2",
  "2026-09-15T03:04:05.006Z",
  "2026-09-15T24-00-00-000Z",
  "2024-02-31",
  "2024-13-01",
  "1",
  "0",
  "99",
  "September 15, 2026 GMT",
  "+010000-01-01",
  "bad",
  "2026-09-15T00-00-00-000Z-2",
];
await run("backup filename date formats", "/api/backup/snapshots", {
  files: filenameDates.map((raw, i) => ({
    name: `privacytracker-snapshot-${raw}.json`,
    text: `data ${i}`,
    mtime: 1700000000 + i,
  })),
});
for (const source of [
  "web_clip",
  "testflight",
  "own_build",
  "sideloaded",
  "",
  "UNKNOWN",
]) {
  await run(`manual source ${source}`, "/api/manual-apps/[id]", {
    changes: [statement("UPDATE manual_apps SET source=?", source)],
  });
}
for (const id of [
  "",
  "missing",
  ` ${OPS_MANUAL}`,
  "a".repeat(128),
  "a".repeat(129),
  "😀".repeat(64),
  "😀".repeat(65),
]) {
  await run(
    `manual ID length ${id.length} ${id.slice(0, 12)}`,
    "/api/manual-apps/[id]",
    { id }
  );
}
await run("manual 200-event cap with timestamp ties", "/api/manual-apps/[id]", {
  changes: Array.from({ length: 205 }, (_, i) =>
    statement(
      "INSERT INTO manual_app_events (id,manual_app_id,event_type,occurred_at,detail) VALUES (?,?,?,?,?)",
      `cap-${i}`,
      OPS_MANUAL,
      "scrape",
      now + 1,
      "null"
    )
  ),
});
await run("manual no history", "/api/manual-apps/[id]", {
  changes: [
    statement("DELETE FROM manual_app_events"),
    statement("DELETE FROM manual_app_policy_versions"),
  ],
});
await run("manual tied versions keep SQL order", "/api/manual-apps/[id]", {
  changes: [
    statement("UPDATE manual_app_policy_versions SET last_fetched_at=?", now),
  ],
});
await run("AI optional null versus empty and zero", "/api/ai/debug-log");
await run("CSP populated ring retains insertion order", "/api/csp-report", {
  reports: [2, 1].map((i) => ({
    receivedAt: now - i,
    directive: "script-src",
    blockedUri: "inline",
    documentUri: `https://example.test/${i}`,
    sample: "λ <script>",
  })),
});
for (const search of [
  "?format=json",
  "?format=json&devices=unattached",
  "?format=JSON",
  "?format=",
  "?format=unknown",
  "?format=json&format=csv",
  "?format=csv&format=json",
]) {
  await run(`export ${search}`, "/api/export", { search });
}
for (const value of [
  "plain",
  "=1+2",
  "+cmd",
  "-2",
  "@sum",
  "＝1",
  "＋1",
  "－1",
  "＠1",
  " \uFEFF=1",
  "\ttext",
  "\rtext",
  "\ntext",
  "\u0001\u007f@cmd",
  "\u0085=not-prefix",
  'comma,quote"\nline',
]) {
  await run(`CSV prefix ${JSON.stringify(value)}`, "/api/export", {
    changes: [statement("UPDATE apps SET name=?", value)],
  });
}
for (const ts of [
  0,
  -1,
  951782400000,
  8640000000000001,
  "2026-09-15",
  "bad date",
]) {
  await run(`CSV timestamp ${ts}`, "/api/export", {
    changes: [statement("UPDATE apps SET lastSynced=?", ts)],
  });
}
for (const [route, table] of [
  ["tasks/active", "privacy_policy_analyses"],
  ["wayback/import-all", "app_settings"],
  ["policy/sync-all", "app_settings"],
  ["rate-limit/status", "app_settings"],
  ["backup/snapshots", "app_settings"],
  ["ai/debug-log", "ai_debug_log"],
  ["export", "apps"],
  ["manual-apps/[id]", "manual_apps"],
  ["manual-apps/[id]", "manual_app_events"],
  ["manual-apps/[id]", "manual_app_policy_versions"],
]) {
  await run(`DB failure ${route} ${table}`, `/api/${route}`, {
    changes: [statement(`ALTER TABLE ${table} RENAME TO missing_table`)],
  });
}

const dateInputs = [
  "",
  "bad",
  "2026",
  "2026-09",
  "2026-9-2",
  "2026-09-15",
  "2024-02-30",
  "2024-02-31",
  "2024-13-01",
  "2024-01-32",
  "2026-09-15T00-00-00-000Z-2",
  "2026-09-15T24:00:00Z",
  "2026-09-15T24:00:01Z",
  "2026-09-15T12:34Z",
  "2026-09-15T12:34:56.1Z",
  "2026-09-15T12:34:56.12345678901Z",
  "2026-09-15T12:34:56+1030",
  "2026-09-15T12:34:56+10:30",
  "2026-09-15T12:34:56+1060",
  "2026-09-15T12:34:56",
  " 2026-09-15 ",
  "2026-9-15 12:34:56",
  "0",
  "1",
  "12",
  "13",
  "31",
  "32",
  "49",
  "50",
  "99",
  "123",
  "0001",
  "+000000-01-01",
  "-000000-01-01",
  "+010000-01-01",
  "-000001-01-01",
  "+275760-09-13",
  "+275760-09-14",
  "September 15, 2026 GMT",
  "15 Sept 2026 1:02 pm GMT",
  "2026 Sep 15 12::30 GMT",
  "Tuesday, 15 September 2026 12:34:56 GMT+10",
  "15 Sep 2026 12:34:56 GMT+10:30",
  "(ignored) 2026-09-15",
  "2026-09-15 (ignored)",
  "word 2026-09-15",
  "word2026-09-15",
  "2026-09-15 garbage",
  "2026-09-15)",
  "2026-09-15Z",
  "2026-09-15 UTC",
  "2026-09-15 GMT",
  "2026-09-15 EST",
  "2026-09-15 12:34:56.001",
  "2026-09-15 12:34:56.0001",
  "2026-09-15 12:34:56.0000000001",
  "2026-10-04T02:30:00",
  "2026-04-05T02:30:00",
  "2026-09-15\u0000garbage",
];
const dates = [];
for (const timezone of ["UTC", "Australia/Melbourne", "America/New_York"]) {
  process.env.TZ = timezone;
  for (const input of dateInputs) {
    const n = Date.parse(input);
    dates.push({ timezone, input, expected: Number.isFinite(n) ? n : null });
  }
}
process.env.TZ = "UTC";
writeFileSync(
  new URL("../tests/fixtures/operations-cases.json", import.meta.url),
  `${JSON.stringify({ now, base, files: OPS_FILES, cases, dates }, null, 2)}\n`
);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  `Generated ${cases.length} operational route cases and ${dates.length} filename date cases; all GETs performed zero SQLite writes.`
);
