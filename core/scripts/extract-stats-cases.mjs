/** Differential oracle: execute the existing Node readers on fixed-clock databases. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STATS_DEVICE,
  STATS_FROM,
  STATS_IDS,
  STATS_TO,
  statsStatements,
} from "../../scripts/parity/stats-fixture.mjs";
import "./extract-stats-meta.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pt-stats-cases-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
const now = Date.UTC(2026, 8, 15, 12);
Date.now = () => now;
const { default: db } = await import("../../lib/db.ts");
const { getStats } = await import("../../lib/stats.ts");
const { getMatrixData, getRadarData, getTimelineData } = await import(
  "../../lib/stats-views.ts"
);
const { getTriageData } = await import("../../lib/triage.ts");
const { getMismatchedApps } = await import(
  "../../lib/privacy-profile-server.ts"
);
const { scopeFromRequest } = await import("../../lib/device-scope-server.ts");
const { listUniversalChangelog } = await import("../../lib/changelog.ts");
const { parseRatingMinAge } = await import("../../lib/age-rating.ts");
const { GET: queue } = await import("../../app/api/review-queue/route.ts");
const { GET: age } = await import("../../app/api/age-rating/summary/route.ts");
const base = statsStatements(now);
base.push({
  sql: "INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)",
  params: [
    "privacy_profile",
    JSON.stringify({
      CONTACTS: "not_collected",
      CONTACT_INFO: "not_collected",
      IDENTIFIERS: "not_linked",
      LOCATION: "not_collected",
    }),
  ],
});
base.push({
  sql: "INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)",
  params: ["guardian_child_age_band", "9_12"],
});
const cases = [];
const run = async (name, op, args = {}, changes = [], empty = false) => {
  db.pragma("foreign_keys = OFF");
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all()) {
    db.exec(`DELETE FROM "${name}"`);
  }
  const setup = empty ? [] : base;
  for (const { sql, params } of [...setup, ...changes]) {
    db.prepare(sql).run(...params);
  }
  const scope = scopeFromRequest(
    `http://localhost/?devices=${encodeURIComponent(args.devices ?? "all")}`
  );
  const requested = scope.mode === "all" ? undefined : scope;
  let expected = null,
    error = false;
  try {
    let result;
    switch (op) {
      case "summary":
        result = getStats(requested);
        break;
      case "triage":
        result = getTriageData(requested);
        break;
      case "matrix":
        result = getMatrixData();
        break;
      case "radar":
        result = getRadarData(args.ids);
        break;
      case "timeline":
        result = getTimelineData(args.from, args.to, args.bucket, args.appId);
        break;
      case "mismatches":
        result = getMismatchedApps(requested);
        break;
      case "changelog":
        result = listUniversalChangelog(args);
        break;
      case "queue":
        result = await (
          await queue(
            new Request(
              `http://localhost/api/review-queue?devices=${encodeURIComponent(args.devices ?? "all")}&count=${args.count ? 1 : 0}`
            )
          )
        ).json();
        break;
      case "age":
        result = await (
          await age(new Request("http://localhost/api/age-rating/summary"))
        ).json();
        break;
    }
    expected = JSON.stringify(result);
  } catch {
    error = true;
  }
  let annotations = null;
  try {
    annotations = db
      .prepare("SELECT id FROM annotations ORDER BY id")
      .all()
      .map((r) => r.id);
  } catch {}
  cases.push({ name, op, args, changes, empty, expected, error, annotations });
};
const change = (sql, ...params) => ({ sql, params });
for (const op of [
  "summary",
  "triage",
  "matrix",
  "radar",
  "mismatches",
  "queue",
  "age",
  "changelog",
]) {
  await run(`${op}: populated`, op);
  await run(`${op}: empty`, op, {}, [], true);
}
for (const devices of [
  STATS_DEVICE,
  "unattached",
  "missing",
  `${STATS_DEVICE},unattached`,
]) {
  for (const op of ["summary", "triage", "mismatches", "queue"]) {
    await run(`${op}: scope ${devices}`, op, { devices });
  }
}
await run("queue: count does not sweep notes", "queue", { count: true });
await run("queue: each read degrades independently", "queue", {}, [
  change("DROP TABLE shortlist_entries"),
  change("DROP TABLE annotations"),
]);
// Restore dropped tables before subsequent cases; the real Node schema is authoritative.
const schema = (await import("node:fs"))
  .readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8")
  .match(/db\.exec\(`([\s\S]*?)`\);/)[1];
db.exec(schema);
for (const op of ["summary", "mismatches", "queue", "age"]) {
  await run(`${op}: no profile or band`, op, {}, [
    change("DELETE FROM app_settings"),
  ]);
}
for (const band of ["under_9", "13_15", "16_17", "18_plus", "invalid"]) {
  await run(`age: ${band}`, "age", {}, [
    change(
      "UPDATE app_settings SET value=? WHERE key='guardian_child_age_band'",
      band
    ),
  ]);
}
for (const bucket of ["day", "week", "month", null]) {
  await run(`timeline: leap day ${bucket}`, "timeline", {
    from: STATS_FROM,
    to: STATS_TO,
    bucket,
    appId: STATS_IDS[0],
  });
  await run(`timeline: blank December/January ${bucket}`, "timeline", {
    from: Date.UTC(2023, 11, 31, 12),
    to: Date.UTC(2024, 0, 3, 12),
    bucket,
  });
}
for (const days of [14, 14.01, 120, 120.01]) {
  await run(`timeline: automatic threshold ${days}`, "timeline", {
    from: STATS_FROM,
    to: STATS_FROM + days * 86400000,
  });
}
await run("timeline: invalid Dates", "timeline", { from: 9e15, to: 9e15 + 1 });
await run("radar: explicit including null status", "radar", { ids: STATS_IDS });
await run(
  "radar: duplicate-last and unknown rating",
  "radar",
  { ids: [STATS_IDS[0]] },
  [
    change(
      "UPDATE privacy_policy_analyses SET summary_json=? WHERE app_id=?",
      JSON.stringify({
        lenses: [{ key: "collection_scope", rating: "invalid" }],
      }),
      STATS_IDS[0]
    ),
  ]
);
for (const raw of ["not json", "null", "{}", "[null]"]) {
  for (const op of ["triage", "timeline", "changelog"]) {
    await run(
      `${op}: corrupt changes ${raw}`,
      op,
      op === "timeline" ? { from: STATS_FROM, to: now } : {},
      [
        change(
          "UPDATE privacy_snapshots SET changes_summary=? WHERE app_id=?",
          raw,
          STATS_IDS[0]
        ),
      ]
    );
  }
}
await run("summary: malformed notification is fatal", "summary", {}, [
  change("UPDATE notifications SET change_summary='not json'"),
]);
for (const limit of [0, 1, 500, 1000]) {
  await run(`changelog: limit ${limit}`, "changelog", {
    limit,
    offset: 1,
    types: ["added", "removed"],
    categories: ["accessibility"],
  });
}
const ratings = [
  null,
  "4+",
  "+17",
  "Rated 13 +",
  "+ 12",
  "+8 and 13+",
  "0+",
  "100+",
  "١٣+",
  "17\uFEFF+",
  "17\u0085+",
  "+003",
  "none",
].map((raw) => ({ raw, expected: parseRatingMinAge(raw) }));
writeFileSync(
  new URL("../tests/fixtures/stats-cases.json", import.meta.url),
  `${JSON.stringify({ now, base, cases, ratings }, null, 2)}\n`
);
console.log(
  `stats oracle: ${cases.length} database scenarios, ${ratings.length} age coercions`
);
db.close();
rmSync(dir, { recursive: true, force: true });
