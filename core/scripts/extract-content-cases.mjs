/** Run the actual seven Node handlers, including catches, wire bytes and cleanup. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  CONTENT_DEVICE,
  CONTENT_IDS,
  contentStatements,
} from "../../scripts/parity/content-fixture.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pt-content-cases-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
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
const { default: db } = await import("../../lib/db.ts");
const handlers = {};
for (const route of [
  "activity",
  "notifications",
  "notification-prefs",
  "user-tasks",
  "annotations",
  "shortlist",
  "shortlist/export",
]) {
  handlers[`/api/${route}`] = (
    await import(`../../app/api/${route}/route.ts`)
  ).GET;
}
const stmt = (sql, ...params) => ({ sql, params });
const setting = (key, value) =>
  stmt(
    "INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)",
    key,
    typeof value === "string" ? value : JSON.stringify(value)
  );
const flag = (name, value) =>
  stmt(
    "INSERT OR REPLACE INTO feature_flag_overrides (flag_key,override_value,quarantined,set_at) VALUES (?,?,0,?)",
    `flag.${name}`,
    value,
    now
  );
const base = [
  ...contentStatements(now),
  setting("privacy_profile", { CONTACTS: "not_collected" }),
  setting("flag.focus.goal.monitor", "true"),
];
const cases = [];
for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}
db.pragma("foreign_keys = OFF");
const run = async (name, route, search = "", changes = [], empty = false) => {
  db.exec("SAVEPOINT content_case");
  try {
    for (const { sql, params } of [...(empty ? [] : base), ...changes]) {
      db.prepare(sql).run(...params);
    }
    let expected;
    try {
      const response = await handlers[route](
        new NextRequest(`http://localhost${route}${search}`, {
          headers: { "x-forwarded-for": "127.0.0.1" },
        })
      );
      expected = {
        status: response.status,
        body: await response.text(),
        type: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
      };
    } catch {
      expected = { status: 500, body: "", type: null, disposition: null };
    }
    let survivingNotes = null;
    try {
      survivingNotes = db
        .prepare("SELECT id FROM annotations ORDER BY id")
        .all()
        .map((r) => r.id);
    } catch {}
    cases.push({
      name,
      route,
      search,
      query: [...new URLSearchParams(search)],
      changes,
      empty,
      expected,
      survivingNotes,
    });
  } finally {
    db.exec("ROLLBACK TO content_case; RELEASE content_case");
  }
};
for (const route of Object.keys(handlers)) {
  await run(`${route} empty`, route, "", [], true);
  await run(`${route} populated`, route);
}
for (const search of [
  "?limit=0&offset=-4",
  "?limit=2&offset=1",
  "?limit=999&offset=garbage",
  "?limit=+2tail&limit=4&offset=0x10",
  "?limit=Infinity&offset=1e4",
  "?limit=1&offset=9223372036854775808",
  "?type=dashboard_layout_applied&status=ok",
  "?type=invalid&status=bad&sortBy=no&sortDir=ASC",
  `?since=${now - 3000}&until=${now - 1000}`,
  "?since=-1&until=no",
  "?since=9007199254740993",
]) {
  await run(`activity ${search}`, "/api/activity", search);
}
for (const sort of ["started_at", "ended_at", "duration_ms"]) {
  for (const dir of ["asc", "desc"]) {
    await run(
      `activity ${sort} ${dir}`,
      "/api/activity",
      `?sortBy=${sort}&sortDir=${dir}`
    );
  }
}
const types = [
  "label_changes",
  "policy_updates",
  "accessibility_changes",
  "new_privacy_types",
];
for (const type of types) {
  await run(
    `notifications only ${type}`,
    "/api/notifications",
    "",
    types.map((t) =>
      flag(`notifications.types.${t}`, t === type ? "on" : "off")
    )
  );
}
await run(
  "notifications all off, synthetic rows survive",
  "/api/notifications",
  "",
  types.map((t) => flag(`notifications.types.${t}`, "off"))
);
for (const raw of [
  "broken",
  "null",
  "{}",
  '""',
  '{"length":0}',
  "[null]",
  '[{},0,false,{"type":"added","details":{"length":0}}]',
]) {
  await run(`notifications shape ${raw}`, "/api/notifications", "", [
    stmt(
      "UPDATE notifications SET change_summary=? WHERE id='pt-content-notification-1'",
      raw
    ),
  ]);
}
await run(
  "notifications unread corrupt row outside page",
  "/api/notifications",
  "",
  [
    flag("notifications.types.policy_updates", "off"),
    stmt(
      "UPDATE notifications SET change_summary='broken' WHERE id='pt-content-notification-34'"
    ),
  ]
);
for (const value of ["on", "off"]) {
  await run(
    `prefs all ${value}`,
    "/api/notification-prefs",
    "",
    types.map((t) => flag(`notifications.types.${t}`, value))
  );
}
for (const raw of [
  '{"policyUpdates":false,"bad":true,"labelChanges":true,"aiTimeout":3}',
  "[]",
  "broken",
]) {
  await run(`legacy prefs ${raw}`, "/api/notification-prefs", "", [
    setting("notification_prefs", raw),
    stmt("ALTER TABLE feature_flag_overrides RENAME TO missing_flags"),
  ]);
}
for (const goals of [
  [],
  ["cleanup"],
  ["monitor", "cleanup"],
  ["minimal", "monitor", "cleanup"],
  ["accessibility"],
]) {
  for (const audience of ["self", "guardian", "loved_one"]) {
    await run(`tasks ${audience} ${goals}`, "/api/user-tasks", "", [
      setting("flag.focus.audience", audience),
      ...["monitor", "cleanup", "minimal", "accessibility"].map((g) =>
        setting(`flag.focus.goal.${g}`, String(goals.includes(g)))
      ),
    ]);
  }
}
const ids = [
  "view_privacy_map",
  "open_any_app_detail",
  "create_privacy_profile",
  "review_mismatches",
  "compare_two_apps",
  "import_label_history",
  "setup_background_mode",
  "remove_apps_from_phone",
  "resync_apps_from_device",
  "export_audit_bundle",
];
const blob = (entry) =>
  setting("user_tasks_state", {
    version: 1,
    tasks: Object.fromEntries(ids.map((id) => [id, entry])),
  });
for (const entry of [
  { started_at: now - 1 },
  { started_at: now - 14 * 86400000 },
  { started_at: now + 1 },
  { dismissed_at: now, started_at: now, opted_in_at: now },
  { started_at: 0, dismissed_at: 0, opted_in_at: 0 },
  { started_at: "bad", dismissed_at: [], opted_in_at: -1 },
]) {
  await run(`task state ${JSON.stringify(entry)}`, "/api/user-tasks", "", [
    setting("flag.focus.workflow", "other_handoff"),
    setting("flag.focus.goal.cleanup", "true"),
    blob(entry),
  ]);
}
const complete = [
  ...[
    "task_visit.app_detail_at",
    "task_visit.privacy_map_at",
    "task_visit.compare_at",
    "background_wizard_completed_at",
    "device_resync.last_committed_at",
    "audit_bundle_last_exported_at",
  ].map((k) => setting(k, " +1junk")),
  stmt(
    "INSERT INTO app_verdicts (id,app_id,verdict,source,set_at,updated_at) VALUES ('content-verdict',?,'uninstall','user',?,?)",
    CONTENT_IDS[0],
    now,
    now
  ),
  stmt(
    "INSERT INTO privacy_snapshots (id,app_id,scraped_at,snapshot_json,changes_summary,source) VALUES ('content-wayback',?,?,'[]','[]','wayback')",
    CONTENT_IDS[0],
    now
  ),
];
await run("all completion signals beat dismissal", "/api/user-tasks", "", [
  setting("flag.focus.workflow", "other_handoff"),
  setting("flag.focus.goal.cleanup", "true"),
  blob({ dismissed_at: now, opted_in_at: now }),
  ...complete,
]);
await run(
  "preview resets completed dismissed and opted in",
  "/api/user-tasks",
  "",
  [
    ...complete,
    blob({ dismissed_at: now, opted_in_at: now }),
    flag("devopts.tasks_preview_default", "on"),
  ]
);
for (const raw of [
  "broken",
  '{"version":2,"tasks":{}}',
  '{"version":1,"tasks":[]}',
  '{"version":1,"tasks":{"unknown":{"started_at":1},"view_privacy_map":null}}',
]) {
  await run(`corrupt tasks ${raw}`, "/api/user-tasks", "", [
    setting("user_tasks_state", raw),
  ]);
}
await run("blocked prerequisites without profile", "/api/user-tasks", "", [
  setting("privacy_profile", {}),
  setting("flag.focus.goal.cleanup", "true"),
  blob({ started_at: now, opted_in_at: now }),
]);
await run(
  "schedule completes background without wizard",
  "/api/user-tasks",
  "",
  [setting("sync_schedule", "weekly"), blob({ opted_in_at: now })]
);
for (const search of [
  "?countApps=1",
  `?countApps=1&appId=${CONTENT_IDS[0]}`,
  `?appId=${CONTENT_IDS[0]}`,
  "?appId=missing",
  "?appId=",
  `?appId=&appId=${CONTENT_IDS[0]}`,
]) {
  await run(`annotations ${search}`, "/api/annotations", search);
}
await run(
  "failed global sweep still lists notes",
  "/api/annotations",
  `?appId=${CONTENT_IDS[0]}`,
  [
    stmt(
      "CREATE TRIGGER block_note_delete BEFORE DELETE ON annotations BEGIN SELECT RAISE(FAIL,'blocked'); END"
    ),
  ]
);
for (const devices of [
  CONTENT_DEVICE,
  "unattached",
  "unknown",
  `${CONTENT_DEVICE},unattached`,
]) {
  await run(
    `shortlist scope ${devices}`,
    "/api/shortlist",
    `?devices=${devices}`
  );
}
await run("orphan counts globally but has no group", "/api/shortlist", "", [
  stmt(
    "UPDATE shortlist_entries SET source_app_id='missing' WHERE id='pt-content-shortlist-1'"
  ),
]);
for (const raw of ["", "{}", "broken"]) {
  await run(`shortlist profile ${raw}`, "/api/shortlist", "", [
    setting("privacy_profile", raw),
  ]);
}
await run("shortlist snapshot failure is optional", "/api/shortlist", "", [
  setting("privacy_profile", ""),
  stmt("ALTER TABLE privacy_types RENAME TO missing_types"),
]);
for (const search of [
  "?format=json",
  "?format=JSON",
  "?format=%20json",
  "?format=unknown",
  `?format=json&devices=${CONTENT_DEVICE}`,
  "?format=md&format=json",
]) {
  await run(`export ${search}`, "/api/shortlist/export", search);
}
for (const route of Object.keys(handlers)) {
  await run(
    `DB failure ${route}`,
    route,
    route === "/api/annotations" ? `?appId=${CONTENT_IDS[0]}` : "",
    [
      stmt(
        `ALTER TABLE ${route === "/api/activity" ? "activity_log" : route === "/api/notifications" ? "notifications" : route === "/api/annotations" ? "annotations" : route.startsWith("/api/shortlist") ? "shortlist_entries" : "app_settings"} RENAME TO missing_table`
      ),
    ]
  );
}
await run(
  "annotation count DB failure is zero",
  "/api/annotations",
  "?countApps=1",
  [stmt("ALTER TABLE annotations RENAME TO missing_annotations")]
);
await run(
  "notification resolver failure enables all types",
  "/api/notifications",
  "",
  [stmt("ALTER TABLE feature_flag_overrides RENAME TO missing_flags")]
);

writeFileSync(
  new URL("../tests/fixtures/content-cases.json", import.meta.url),
  `${JSON.stringify({ now, base, cases }, null, 2)}\n`
);
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`Generated ${cases.length} content handler cases.`);
