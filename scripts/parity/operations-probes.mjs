/** Raw operational responses, with generated clock values validated separately. */
import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  jobState,
  OPS_APP,
  OPS_FILES,
  OPS_MANUAL,
  setting,
  writeOperationsFiles,
} from "./operations-fixture.mjs";

export async function probeOperationsReads(
  nodeBase,
  rustBase,
  token,
  nodeData,
  rustData
) {
  let ok = true;
  const headers = { "x-auditor-admin-token": token };
  const read = async (base, route, auth = true) => {
    const r = await fetch(`${base}${route}`, { headers: auth ? headers : {} });
    return {
      status: r.status,
      body: await r.text(),
      type: r.headers.get("content-type"),
      disposition: r.headers.get("content-disposition"),
    };
  };
  const check = (claim, pass) => {
    console.log(`  ${pass ? "✔" : "✘"} operations: ${claim}`);
    ok = pass && ok;
  };
  const pair = (route) =>
    Promise.all([read(nodeBase, route), read(rustBase, route)]);
  const compare = async (
    route,
    predicate = () => true,
    status = 200,
    normalize = (v) => v
  ) => {
    const [a, b] = await pair(route);
    let pass = false;
    try {
      const ja = a.body ? JSON.parse(a.body) : null;
      const jb = b.body ? JSON.parse(b.body) : null;
      pass =
        a.status === status &&
        b.status === status &&
        a.type === b.type &&
        a.disposition === b.disposition &&
        predicate(ja) &&
        predicate(jb) &&
        normalize(a.body, nodeData) === normalize(b.body, rustData);
    } catch {}
    if (!pass) {
      console.log(
        `    ${route}: node=${JSON.stringify(a).slice(0, 1800)} rust=${JSON.stringify(b).slice(0, 1800)}`
      );
    }
    return pass;
  };
  const dbs = [nodeData, rustData].map(
    (d) => new BetterSqlite3(path.join(d, "privacy.db"))
  );
  const backupSettings = dbs.map((db) =>
    db
      .prepare(
        "SELECT key,value FROM app_settings WHERE key LIKE 'backup_snapshot_%'"
      )
      .all()
  );
  const apply = (statements) => {
    for (const db of dbs) {
      db.transaction(() => {
        for (const s of statements) {
          db.prepare(s.sql).run(...s.params);
        }
      })();
    }
  };
  try {
    check(
      "paused Wayback, unlocked sync and active policy have distinct running rules",
      await compare(
        "/api/tasks/active",
        (j) =>
          !j.wayback.running &&
          j.wayback.status === "paused" &&
          j.sync.running &&
          !j.sync.mutexHeld &&
          j.policy.running &&
          j.policyRuns.length === 10 &&
          j.policyRuns.some(
            (r) => r.lastPhase === "ai" && r.lastPhaseNote === "last"
          )
      )
    );
    check(
      "job GETs omit queues and retain pause controls and summary counts",
      (await compare(
        "/api/wayback/import-all",
        (j) =>
          j.state.pausedAt > 0 &&
          j.state.pauseCause === "manual" &&
          j.summary.total === 5 &&
          j.summary.remaining === 2 &&
          !Object.hasOwn(j.state, "queue")
      )) &&
        (await compare(
          "/api/policy/sync-all",
          (j) =>
            j.running &&
            j.state.phase === "all" &&
            j.state.force === false &&
            !Object.hasOwn(j.state, "queue")
        ))
    );
    check(
      "manual detail preserves unknown-source fallback, event ties, JSON and current policy",
      await compare(
        `/api/manual-apps/${OPS_MANUAL}`,
        (j) =>
          j.app.source === "sideloaded" &&
          j.events[0].id === "pt-ops-event-3" &&
          j.events[1].detail.n === 9007199254740992 &&
          Object.keys(j.events[1].detail)[0] === "2" &&
          j.currentVersion.id === "pt-ops-version-0" &&
          j.currentVersion.sourceText.includes("\n")
      )
    );
    check(
      "manual IDs use UTF-16 length and keep whitespace",
      (await compare(
        `/api/manual-apps/${"a".repeat(129)}`,
        (j) => j.error === "Invalid id",
        400
      )) &&
        (await compare(
          `/api/manual-apps/${encodeURIComponent("😀".repeat(64))}`,
          (j) => j.error === "Not found",
          404
        )) &&
        (await compare(
          `/api/manual-apps/%20${OPS_MANUAL}`,
          (j) => j.error === "Not found",
          404
        ))
    );
    check(
      "AI log caps at 50 and distinguishes absent fields from empty strings and zero",
      await compare(
        "/api/ai/debug-log",
        (j) =>
          j.rows.length === 50 &&
          j.rows[0].durationMs === 0 &&
          j.rows[0].error === "" &&
          !Object.hasOwn(j.rows[1], "prompt")
      )
    );
    const now = Date.now();
    check(
      "cooldowns preserve the active reason, hide expired reasons and report a fresh clock",
      await compare(
        "/api/rate-limit/status",
        (j) =>
          j.search.active &&
          j.search.reason === "Search 429" &&
          !j.scrape.active &&
          j.scrape.resumeAt === 0 &&
          j.scrape.reason === "" &&
          Math.abs(j.serverNow - now) < 10000,
        200,
        (raw) => {
          const j = JSON.parse(raw);
          j.serverNow = "clock";
          return JSON.stringify(j);
        }
      )
    );
    const [csvA, csvB] = await pair(
      "/api/export?format=JSON&devices=unattached"
    );
    const date = new Date().toISOString().split("T")[0];
    check(
      "CSV preserves formula prefixes, quotes and newlines with exact attachment headers",
      JSON.stringify(csvA) === JSON.stringify(csvB) &&
        csvA.status === 200 &&
        csvA.type === "text/csv; charset=utf-8" &&
        csvA.disposition ===
          `attachment; filename="privacytracker-${date}.csv"` &&
        csvA.body.includes('"\t  =SUM(1,2) ""App""\nλ"') &&
        csvA.body.includes('"\t＝Other"')
    );
    check(
      "JSON export includes the whole install and full privacy trees under device filtering",
      await compare(
        "/api/export?format=json&devices=unattached",
        (j) =>
          j.apps.length > 20 &&
          j.apps.some((a) => a.id === OPS_APP && a.privacyTypes.length === 1) &&
          Math.abs(Date.parse(j.exported_at) - Date.now()) < 10000,
        200,
        (raw) => {
          const j = JSON.parse(raw);
          j.exported_at = "clock";
          return JSON.stringify(j);
        }
      )
    );
    for (const dir of [nodeData, rustData]) {
      writeOperationsFiles(dir);
    }
    apply([
      setting("backup_snapshot_enabled", "true"),
      setting("backup_snapshot_interval_hours", "48tail"),
      setting("backup_snapshot_retention_count", "999"),
      setting("backup_snapshot_last_run_at", "1700000000000"),
    ]);
    check(
      "backup listing preserves settings clamps, filename dates, fallback mtimes, sizes and ordering",
      await compare(
        "/api/backup/snapshots",
        (j) =>
          j.settings.intervalHours === 48 &&
          j.settings.retentionCount === 100 &&
          j.settings.nextRunAt === 1700172800000 &&
          j.snapshots.length === 4 &&
          j.snapshots[0].createdAt === 1789441445006 &&
          j.snapshots[2].createdAt === 1700000002500,
        200,
        (raw, dir) => raw.replaceAll(dir, "<DATA>")
      )
    );
    for (const dir of [nodeData, rustData]) {
      symlinkSync(
        path.join(dir, "absent"),
        path.join(dir, "backups/privacytracker-snapshot-broken.json")
      );
    }
    check(
      "a broken snapshot symlink produces the same empty HTTP 500",
      await compare("/api/backup/snapshots", () => true, 500)
    );
    for (const dir of [nodeData, rustData]) {
      rmSync(path.join(dir, "backups/privacytracker-snapshot-broken.json"));
    }
    for (const status of ["pause_requested", "cancel_requested", "future"]) {
      apply([setting("wayback_bulk_state", jobState(now, { status }))]);
      check(
        `Wayback ${status} reads do not start or heal the run`,
        await compare(
          "/api/wayback/import-all",
          (j) =>
            j.running && j.status === (status === "future" ? "running" : status)
        )
      );
    }
    apply([
      setting("wayback_bulk_state", "broken"),
      setting("policy_bulk_state", jobState(now, { queue: [] })),
    ]);
    check(
      "stale locks remain visible with each runner's existing running flag",
      await compare(
        "/api/tasks/active",
        (j) =>
          !j.wayback.running &&
          j.wayback.stale &&
          j.wayback.status === "stale" &&
          j.policy.running &&
          j.policy.stale
      )
    );
    apply([setting("sync_bulk_state", jobState(now, { queue: [null] }))]);
    check(
      "a null queue entry produces the same empty HTTP 500",
      await compare("/api/tasks/active", () => true, 500)
    );
    apply([setting("sync_bulk_state", "")]);
    check(
      "CSP GET starts with an empty process ring",
      await compare(
        "/api/csp-report",
        (j) => Array.isArray(j.reports) && j.reports.length === 0
      )
    );
    for (const route of ["/api/ai/debug-log", "/api/csp-report"]) {
      const rs = await Promise.all([
        read(nodeBase, route, false),
        read(rustBase, route, false),
      ]);
      check(
        `${route} keeps private reads behind authentication`,
        rs.every(
          (r) =>
            r.status === 401 && r.body === '{"error":"Admin token required"}'
        )
      );
    }
    for (const [route, limit] of [
      ["/api/ai/debug-log", 60],
      [`/api/manual-apps/${OPS_MANUAL}`, 120],
    ]) {
      let first = null;
      let equal = true;
      for (let i = 1; i <= limit + 1; i++) {
        const [a, b] = await pair(route);
        if (a.status !== b.status || a.body !== b.body) {
          equal = false;
          break;
        }
        if (a.status === 429) {
          first = i;
          break;
        }
        if (a.status !== 200) {
          equal = false;
          break;
        }
      }
      check(
        `${route} enforces its own ${limit}/minute read budget`,
        equal && first !== null && first > limit - 15 && first <= limit + 1
      );
    }
  } finally {
    for (const [i, db] of dbs.entries()) {
      // A future server restart must not run an automatic backup merely
      // because this read probe enabled it with an intentionally old date.
      db.prepare(
        "DELETE FROM app_settings WHERE key LIKE 'backup_snapshot_%'"
      ).run();
      for (const row of backupSettings[i]) {
        db.prepare("INSERT INTO app_settings (key,value) VALUES (?,?)").run(
          row.key,
          row.value
        );
      }
      db.close();
    }
    for (const dir of [nodeData, rustData]) {
      for (const name of [
        ...OPS_FILES.map((f) => f.name),
        "privacytracker-snapshot-broken.json",
      ]) {
        rmSync(path.join(dir, "backups", name), { force: true });
      }
    }
  }
  return ok;
}
