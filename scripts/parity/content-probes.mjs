/** Raw live checks: no generic timestamp/duration normalisation. */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { CONTENT_DEVICE, CONTENT_IDS } from "./content-fixture.mjs";

export async function probeContentReads(
  nodeBase,
  rustBase,
  token,
  nodeData,
  rustData
) {
  const read = async (base, route) => {
    const r = await fetch(`${base}${route}`, {
      headers: { "x-auditor-admin-token": token },
    });
    return {
      status: r.status,
      body: await r.text(),
      type: r.headers.get("content-type"),
      disposition: r.headers.get("content-disposition"),
    };
  };
  let ok = true;
  const check = (claim, pass) => {
    console.log(`  ${pass ? "✔" : "✘"} content: ${claim}`);
    ok = pass && ok;
  };
  const compare = async (route, predicate = () => true, status = 200) => {
    const [a, b] = await Promise.all([
      read(nodeBase, route),
      read(rustBase, route),
    ]);
    let valid = false;
    try {
      valid =
        a.status === status &&
        b.status === status &&
        a.body === b.body &&
        a.type === b.type &&
        a.disposition === b.disposition &&
        predicate(a.body ? JSON.parse(a.body) : null);
    } catch {}
    if (!valid) {
      console.log(
        `    ${route}: node=${JSON.stringify(a)} rust=${JSON.stringify(b)}`
      );
    }
    return valid;
  };
  check(
    "activity preserves numeric detail, null ordering, total and unclamped inputs",
    await compare(
      "/api/activity?type=dashboard_layout_applied&sortBy=duration_ms&sortDir=asc&limit=0&offset=-2",
      (j) =>
        j.total === 5 &&
        j.limit === 0 &&
        j.offset === -2 &&
        j.rows.length === 1 &&
        j.rows[0].detail.n === 9007199254740992 &&
        Object.keys(j.rows[0].detail).slice(0, 2).join() === "2,10"
    )
  );
  check(
    "activity invalid and repeated inputs use the first parsed value",
    await compare(
      "/api/activity?type=dashboard_layout_applied&status=partial&limit=2tail&limit=1&since=bad",
      (j) =>
        j.limit === 2 &&
        j.rows.length === 1 &&
        j.rows[0].detail === null &&
        j.total === 1
    )
  );
  check(
    "annotation count and missing-app validation match",
    (await compare(
      "/api/annotations?countApps=1&appId=",
      (j) => j.appsWithNotes >= 1
    )) &&
      (await compare(
        "/api/annotations?appId=",
        (j) => j.error === "appId is required",
        400
      ))
  );
  check(
    "shortlist scopes sources while retaining global pairs and optional decorations",
    await compare(
      `/api/shortlist?devices=${CONTENT_DEVICE}`,
      (j) =>
        j.groups.length === 1 &&
        j.groups[0].entries.length === 3 &&
        j.total === 3 &&
        j.pairs.length > 3 &&
        j.groups[0].sourceApp.privacyTypes.length === 1 &&
        j.groups[0].sourceApp.profileMismatch.count === 1 &&
        j.groups[0].entries[0].modes.join() === "privacy,accessibility" &&
        j.groups[0].entries[0].profileBadge !== null &&
        j.groups[0].entries[1].profileBadge === null
    )
  );
  check(
    "unattached shortlist keeps source insertion order and null prices",
    await compare("/api/shortlist?devices=unattached", (j) =>
      j.groups.some(
        (g) =>
          g.sourceApp.id === CONTENT_IDS[2] &&
          g.sourceApp.priceFormatted === null &&
          !("privacyTypes" in g.sourceApp)
      )
    )
  );
  const [jsonA, jsonB] = await Promise.all([
    read(
      nodeBase,
      `/api/shortlist/export?format=JSON&devices=${CONTENT_DEVICE}`
    ),
    read(
      rustBase,
      `/api/shortlist/export?format=JSON&devices=${CONTENT_DEVICE}`
    ),
  ]);
  const exported = [jsonA, jsonB].map((r) => {
    try {
      return JSON.parse(r.body);
    } catch {
      return {};
    }
  });
  const validTimes = exported.every(
    (j) =>
      typeof j.exported_at === "string" &&
      new Date(j.exported_at).toISOString() === j.exported_at &&
      Math.abs(Date.now() - Date.parse(j.exported_at)) < 60000
  );
  for (const j of exported) {
    j.exported_at = undefined;
  }
  check(
    "JSON export ignores device scope; only its generated timestamp varies",
    jsonA.status === 200 &&
      jsonB.status === 200 &&
      validTimes &&
      JSON.stringify(exported[0]) === JSON.stringify(exported[1]) &&
      exported[0].groups.some((g) => g.sourceApp.id === CONTENT_IDS[2])
  );
  const [mdA, mdB] = await Promise.all([
    read(nodeBase, "/api/shortlist/export?format=%20json"),
    read(rustBase, "/api/shortlist/export?format=%20json"),
  ]);
  check(
    "Markdown export preserves links, modes, multiline notes and attachment headers",
    mdA.status === 200 &&
      mdA.body === mdB.body &&
      mdA.body.includes("First line\nsecond line · λ") &&
      mdA.body.includes("_(saved for privacy + accessibility)_") &&
      mdA.type === "text/markdown; charset=utf-8" &&
      mdA.type === mdB.type &&
      mdA.disposition === mdB.disposition &&
      mdA.disposition ===
        `attachment; filename="app-shortlist-${new Date().toISOString().split("T")[0]}.md"`
  );
  // Mutate only the two disposable parity DBs, restoring each exact setting.
  const databases = [nodeData, rustData].map(
    (dir) => new BetterSqlite3(path.join(dir, "privacy.db"))
  );
  const keys = [
    "flag.focus.audience",
    "flag.focus.workflow",
    "flag.focus.goal.cleanup",
    "user_tasks_state",
    "task_visit.privacy_map_at",
  ];
  const types = [
    "label_changes",
    "policy_updates",
    "accessibility_changes",
    "new_privacy_types",
  ].map((t) => `flag.notifications.types.${t}`);
  const backups = databases.map((db) => ({
    settings: keys.map((k) => [
      k,
      db.prepare("SELECT value FROM app_settings WHERE key=?").get(k),
    ]),
    flags: types.map((k) => [
      k,
      db
        .prepare("SELECT * FROM feature_flag_overrides WHERE flag_key=?")
        .get(k),
    ]),
  }));
  try {
    for (const db of databases) {
      for (const k of types) {
        db.prepare(
          "INSERT OR REPLACE INTO feature_flag_overrides (flag_key,override_value,set_at) VALUES (?,'on',1)"
        ).run(k);
      }
    }
    check(
      "notification page limit precedes filtering and future quiet-hours rows stay hidden",
      await compare(
        "/api/notifications",
        (j) =>
          j.notifications.length === 30 &&
          j.unreadCount > 0 &&
          !j.notifications.some((n) => n.id === "pt-content-notification-2") &&
          j.notifications.some(
            (n) =>
              n.id === "pt-content-notification-1" &&
              n.change_summary.length === 4
          )
      )
    );
    for (const db of databases) {
      for (const k of types) {
        db.prepare(
          "UPDATE feature_flag_overrides SET override_value='off' WHERE flag_key=?"
        ).run(k);
      }
    }
    check(
      "resolved preferences and notification suppression respect all four flags",
      // `prefs` also carries the seven camelCase keys; the five without a
      // flag come from the legacy blob, so only the flag keys and their two
      // aliases follow the overrides.
      (await compare("/api/notification-prefs", (j) =>
        [
          "label_changes",
          "policy_updates",
          "accessibility_changes",
          "new_privacy_types",
          "labelChanges",
          "policyUpdates",
        ].every((k) => j.prefs[k] === false)
      )) &&
        (await compare(
          "/api/notifications",
          (j) =>
            j.notifications.length > 0 &&
            j.notifications.length < 30 &&
            j.notifications.every((n) => n.change_summary.length === 0)
        ))
    );
    for (const db of databases) {
      const settings = {
        "flag.focus.audience": "loved_one",
        "flag.focus.workflow": "other_handoff",
        "flag.focus.goal.cleanup": "true",
        "task_visit.privacy_map_at": "7tail",
        user_tasks_state: JSON.stringify({
          version: 1,
          tasks: {
            view_privacy_map: { dismissed_at: 7 },
            export_audit_bundle: { opted_in_at: 9 },
          },
        }),
      };
      for (const [k, v] of Object.entries(settings)) {
        db.prepare(
          "INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)"
        ).run(k, v);
      }
      db.prepare(
        "INSERT OR REPLACE INTO annotations (id,app_id,content,created_at,updated_at,deleted_at) VALUES ('pt-content-purge',?,'expired',1,1,1)"
      ).run(CONTENT_IDS[1]);
    }
    check(
      "task completion beats dismissal and handoff opt-in appears",
      await compare(
        "/api/user-tasks",
        (j) =>
          j.tasks.some(
            (t) =>
              t.id === "view_privacy_map" &&
              t.state === "completed" &&
              t.dismissedAt === 7
          ) &&
          j.tasks.some(
            (t) =>
              t.id === "export_audit_bundle" &&
              t.optedInAt === 9 &&
              t.audience === "loved_one"
          )
      )
    );
    const countOk = await compare(
      "/api/annotations?countApps=1",
      (j) => j.appsWithNotes > 0
    );
    const countDidNotSweep = databases.every((db) =>
      db.prepare("SELECT 1 FROM annotations WHERE id='pt-content-purge'").get()
    );
    const listOk = await compare(
      `/api/annotations?appId=${CONTENT_IDS[0]}`,
      (j) =>
        j.annotations.some(
          (n) => n.visibility === "private" && n.sourceName === "A friend"
        )
    );
    check(
      "note counts do not purge; listing retains private notes and globally purges expired deletes",
      countOk &&
        countDidNotSweep &&
        listOk &&
        databases.every(
          (db) =>
            !db
              .prepare("SELECT 1 FROM annotations WHERE id='pt-content-purge'")
              .get()
        )
    );
    const saved = databases.map(
      (db) =>
        db
          .prepare(
            "SELECT change_summary FROM notifications WHERE id='pt-content-notification-1'"
          )
          .get().change_summary
    );
    try {
      for (const db of databases) {
        db.prepare(
          "UPDATE notifications SET change_summary='broken' WHERE id='pt-content-notification-1'"
        ).run();
      }
      check(
        "malformed notification JSON produces the same empty HTTP 500",
        await compare("/api/notifications", (j) => j === null, 500)
      );
    } finally {
      databases.forEach((db, i) => {
        db.prepare(
          "UPDATE notifications SET change_summary=? WHERE id='pt-content-notification-1'"
        ).run(saved[i]);
      });
    }
  } finally {
    databases.forEach((db, i) => {
      for (const [k, row] of backups[i].settings) {
        db.prepare("DELETE FROM app_settings WHERE key=?").run(k);
        if (row) {
          db.prepare("INSERT INTO app_settings (key,value) VALUES (?,?)").run(
            k,
            row.value
          );
        }
      }
      for (const [k, row] of backups[i].flags) {
        db.prepare("DELETE FROM feature_flag_overrides WHERE flag_key=?").run(
          k
        );
        if (row) {
          db.prepare(
            "INSERT INTO feature_flag_overrides (flag_key,override_value,set_at,set_by,previous_focus,quarantined) VALUES (@flag_key,@override_value,@set_at,@set_by,@previous_focus,@quarantined)"
          ).run(row);
        }
      }
      db.close();
    });
  }
  for (const [route, limit] of [
    ["/api/shortlist", 120],
    ["/api/shortlist/export", 30],
  ]) {
    const burst = async (base) => {
      for (let i = 1; i <= limit + 1; i++) {
        const r = await read(base, `${route}?devices=${CONTENT_DEVICE}`);
        if (r.status === 429) {
          return { at: i, body: r.body };
        }
        if (r.status !== 200) {
          return null;
        }
      }
      return null;
    };
    const [a, b] = await Promise.all([burst(nodeBase), burst(rustBase)]);
    check(
      `${route} has an independent ${limit}/minute rate bucket`,
      a !== null &&
        b !== null &&
        a.at === b.at &&
        a.body === b.body &&
        a.body === '{"error":"Rate limit exceeded"}'
    );
  }
  return ok;
}
