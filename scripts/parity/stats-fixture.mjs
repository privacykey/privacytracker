/** Non-vacuous fleet analysis fixtures, applied before the Node DB is copied. */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const STATS_IDS = ["89999001", "89999002", "89999003"];
export const STATS_DEVICE = "pt-stats-device-a";
export const STATS_OTHER_DEVICE = "pt-stats-device-b";
export const STATS_FROM = Date.UTC(2024, 1, 27, 12);
export const STATS_TO = Date.UTC(2024, 2, 4, 10);

// Shared by the live fixture and the fixed-clock Node oracle generator.
export function statsStatements(now) {
  const statements = [];
  const add = (sql, ...params) => statements.push({ sql, params });
  for (const table of [
    "privacy_categories",
    "privacy_types",
    "privacy_snapshots",
    "change_review_actions",
    "notifications",
    "app_verdicts",
    "shortlist_entries",
    "annotations",
    "accessibility_features",
  ]) {
    add(`DELETE FROM ${table} WHERE id LIKE 'pt-stats-%'`);
  }
  for (const id of STATS_IDS) {
    add("DELETE FROM app_devices WHERE app_id = ?", id);
    add("DELETE FROM apps WHERE id = ?", id);
  }
  for (const id of [STATS_DEVICE, STATS_OTHER_DEVICE]) {
    add("DELETE FROM devices WHERE id = ?", id);
    add(
      "INSERT INTO devices (id,name,ecid,created_at,last_synced_at) VALUES (?,?,?,?,?)",
      id,
      id,
      id === STATS_DEVICE ? "0xABC" : "0xDEF",
      now - 1000,
      now - 1000
    );
  }
  for (const [i, id] of STATS_IDS.entries()) {
    add(
      "INSERT INTO apps (id,name,url,firstSeen,lastSynced,changeCount,ageRating,hasAccessibilityLabels,priceFormatted,priceCurrency,hasIap) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id,
      ["Stats Alpha", "stats alpha", "Stats Empty"][i],
      `https://apps.apple.com/us/app/id${id}`,
      STATS_FROM - 86400000,
      i === 0 ? now - 40 * 86400000 : now - 1000,
      i === 0 ? 2 : 0,
      ["Rated +17", "9+", null][i],
      [1, 0, null][i],
      "$2.99",
      "USD",
      1
    );
  }
  for (const [app, device] of [
    [STATS_IDS[0], STATS_DEVICE],
    [STATS_IDS[0], STATS_OTHER_DEVICE],
    [STATS_IDS[1], STATS_OTHER_DEVICE],
  ]) {
    add(
      "INSERT INTO app_devices (app_id,device_id,first_seen_at,last_seen_at) VALUES (?,?,?,?)",
      app,
      device,
      now,
      now
    );
  }
  for (const [i, sev] of [
    "DATA_LINKED_TO_YOU",
    "DATA_USED_TO_TRACK_YOU",
    "DATA_NOT_LINKED_TO_YOU",
  ].entries()) {
    add(
      "INSERT INTO privacy_types (id,app_id,identifier,title) VALUES (?,?,?,?)",
      `pt-stats-type-${i}`,
      STATS_IDS[i === 2 ? 1 : 0],
      sev,
      sev
    );
    for (const [j, cat] of (i === 0
      ? ["CONTACTS", "CONTACT_INFO"]
      : i === 1
        ? ["CONTACTS", "IDENTIFIERS", "2", "10"]
        : ["LOCATION", "NEW_CATEGORY"]
    ).entries()) {
      add(
        "INSERT INTO privacy_categories (id,type_id,identifier,title) VALUES (?,?,?,?)",
        `pt-stats-cat-${i}-${j}`,
        `pt-stats-type-${i}`,
        cat,
        cat
      );
    }
  }
  for (const [i, id] of ["voiceover", "future_feature"].entries()) {
    add(
      "INSERT INTO accessibility_features (id,app_id,identifier,title) VALUES (?,?,?,?)",
      `pt-stats-a11y-${i}`,
      STATS_IDS[0],
      id,
      `Fixture ${id}`
    );
  }
  const mixed = [
    { type: "removed", description: "Removed location" },
    {
      type: "added",
      category: "accessibility",
      description: "Added VoiceOver",
    },
    {
      type: "removed",
      category: "accessibility",
      description: "Removed captions",
    },
    {
      type: "modified",
      category: "accessibility",
      description: "Ignored by timeline",
    },
    {
      type: "policy",
      category: "privacy-policy",
      description: "Policy changed",
    },
    {
      type: "wayback",
      category: "wayback-attempt",
      description: "Archive attempt",
    },
  ];
  for (const [i, ts] of [
    STATS_FROM,
    Date.UTC(2024, 1, 29),
    STATS_TO,
    now - 86400000,
  ].entries()) {
    add(
      "INSERT INTO privacy_snapshots (id,app_id,scraped_at,snapshot_json,changes_detected,changes_summary,source,triggered_by) VALUES (?,?,?,?,?,?,?,?)",
      `pt-stats-snap-${i}`,
      STATS_IDS[0],
      ts,
      "[]",
      1,
      JSON.stringify(mixed),
      i === 1 ? "wayback" : "live",
      i === 1 ? null : "manual"
    );
  }
  add(
    "INSERT INTO change_review_actions (id,app_id,action,acted_at,covered_count) VALUES (?,?,?,?,?)",
    "pt-stats-review",
    STATS_IDS[0],
    "reviewed",
    Date.UTC(2024, 2, 1),
    4
  );
  add(
    "INSERT INTO notifications (id,app_id,app_name,change_summary,created_at,read) VALUES (?,?,?,?,?,?)",
    "pt-stats-notification",
    STATS_IDS[0],
    "Stats Alpha",
    JSON.stringify(mixed),
    now - 86400000,
    0
  );
  for (const [i, app, source, verdict] of [
    [0, STATS_IDS[0], "user", "uninstall"],
    [1, STATS_IDS[0], "imported", "safe"],
    [2, STATS_IDS[1], "imported", "replace"],
    [3, "pt-stats-orphan", "user", "replace"],
  ]) {
    add(
      "INSERT INTO app_verdicts (id,app_id,verdict,rationale,source,source_name,set_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      `pt-stats-verdict-${i}`,
      app,
      verdict,
      null,
      source,
      source === "imported" ? "Fixture recommender" : null,
      now - i * 1000,
      now - i * 1000
    );
  }
  for (const [i, candidate] of [
    STATS_IDS[1],
    STATS_IDS[2],
    "99999000",
  ].entries()) {
    add(
      "INSERT INTO shortlist_entries (id,source_app_id,candidate_apple_id,candidate_name,candidate_store_url,added_at,mode) VALUES (?,?,?,?,?,?,?)",
      `pt-stats-shortlist-${i}`,
      STATS_IDS[0],
      candidate,
      `Candidate ${i}`,
      `https://apps.apple.com/us/app/id${candidate}`,
      now - i * 1000,
      i === 0 ? " accessibility,PRIVACY,accessibility,unknown " : "unknown"
    );
  }
  for (const [i, deleted] of [null, now - 60000, now - 10000].entries()) {
    add(
      "INSERT INTO annotations (id,app_id,content,source,source_name,visibility,tag,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      `pt-stats-note-${i}`,
      STATS_IDS[0],
      `Note ${i}`,
      "user",
      null,
      "private",
      "concern",
      now,
      now,
      deleted
    );
  }
  for (const id of STATS_IDS) {
    add("DELETE FROM privacy_policy_analyses WHERE app_id = ?", id);
  }
  const lenses = [
    { key: "collection_scope", rating: "mixed" },
    { key: "ads_marketing", rating: "concerning" },
    { key: "collection_scope", rating: "unclear" },
    { key: "user_controls", rating: "favorable" },
  ];
  add(
    "INSERT INTO privacy_policy_analyses (app_id,status,summary_json,policy_url,updated_at) VALUES (?,?,?,?,?)",
    STATS_IDS[0],
    "ready",
    JSON.stringify({ lenses }),
    "https://example.com/privacy",
    now
  );
  add(
    "INSERT INTO privacy_policy_analyses (app_id,status,summary_json,policy_url,updated_at) VALUES (?,?,?,?,?)",
    STATS_IDS[1],
    "source_ready",
    "not json",
    "https://example.com/privacy",
    now
  );
  return statements;
}
export function applyStatsFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  // Deliberate legacy orphan verdict exercises the route’s raw-union count.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const { sql, params } of statsStatements(Date.now())) {
        db.prepare(sql).run(...params);
      }
    })();
  } finally {
    db.close();
  }
}

export async function probeStatsReads(nodeBase, rustBase, token) {
  const read = async (base, path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { "x-auditor-admin-token": token },
    });
    return { status: res.status, body: await res.text() };
  };
  let ok = true;
  const check = (claim, pass) => {
    console.log(`  ${pass ? "✔" : "✘"} stats: ${claim}`);
    ok = pass && ok;
  };
  const compare = async (path, predicate) => {
    const [a, b] = await Promise.all([
      read(nodeBase, path),
      read(rustBase, path),
    ]);
    let valid = false;
    try {
      valid =
        a.status === 200 &&
        b.status === 200 &&
        a.body === b.body &&
        predicate(JSON.parse(a.body));
    } catch {}
    if (!valid) {
      console.log(
        `    ${path}: node=${a.status} rust=${b.status}; ${a.body === b.body ? "equal bodies" : "bodies differ"}`
      );
    }
    return valid;
  };
  check(
    "scoped totals, overlapping links, novel accessibility and parsed notifications",
    await compare(
      `/api/stats?devices=${STATS_DEVICE}`,
      (j) =>
        j.totalApps === 1 &&
        j.totalCategories === 6 &&
        j.staleApps === 1 &&
        j.appsWithAccessibilityLabels === 1 &&
        j.accessibilityFeatureFrequency.some(
          (f) => f.identifier === "future_feature" && f.appCount === 1
        ) &&
        j.recentChanges.length > 0
    )
  );
  check(
    "unattached scope and unknown-device fallback",
    (await compare(
      "/api/stats?devices=unattached",
      (j) =>
        j.totalApps > 0 && j.staleAppsList.every((a) => a.id !== STATS_IDS[0])
    )) &&
      (await compare("/api/stats?devices=not-a-device", (j) => j.totalApps > 3))
  );
  check(
    "matrix takes worst severity and enumerates numeric category keys first",
    await compare(
      "/api/stats/matrix",
      (j) =>
        j.cells[STATS_IDS[0]].CONTACTS === "DATA_USED_TO_TRACK_YOU" &&
        Object.keys(j.cells[STATS_IDS[0]]).slice(0, 2).join() === "2,10"
    )
  );
  check(
    "radar duplicate lens wins, fractional score, corrupt and absent summaries",
    await compare(
      `/api/stats/radar?apps=${STATS_IDS.join(",")}`,
      (j) =>
        j.apps.length === 3 &&
        j.apps.find((a) => a.id === STATS_IDS[0]).lenses[0].score === 1.5 &&
        j.apps.filter((a) => !a.hasPolicy).length === 2
    )
  );
  for (const bucket of ["day", "week", "month"]) {
    check(
      `fixed leap-day ${bucket} timeline preserves categories, gap fill, syncs and reviews`,
      await compare(
        `/api/stats/timeline?from=${STATS_FROM}&to=${STATS_TO}&bucket=${bucket}&appId=${STATS_IDS[0]}`,
        (j) =>
          j.total === 12 &&
          j.points.reduce((n, p) => n + p.syncs, 0) === 3 &&
          j.points.reduce((n, p) => n + p.reviews, 0) === 1
      )
    );
  }
  check(
    "triage prioritises added changes and includes all three review categories",
    await compare(
      `/api/triage?devices=${STATS_DEVICE}`,
      (j) =>
        j.totalApps === 1 &&
        j.reviewable[0].topChange === "Added VoiceOver" &&
        j.reviewable[0].categories.length === 3 &&
        j.changesThisWeek === 6
    )
  );
  check(
    "queue includes notes, shortlist modes, advisory verdicts and device ECIDs",
    await compare(
      `/api/review-queue?devices=${STATS_DEVICE}`,
      (j) =>
        j.reviewableCount === 1 &&
        j.rows[0].notes.length === 1 &&
        j.rows[0].notes[0].visibility === "private" &&
        j.rows[0].shortlistCandidates.length === 3 &&
        j.rows[0].shortlistCandidates[0].modes.join() ===
          "privacy,accessibility" &&
        j.sourceDeviceEcids[STATS_IDS[0]].length === 2
    )
  );
  check(
    "queue union counts orphan verdicts separately from tracked rows",
    await compare("/api/review-queue", (j) => j.reviewableCount > j.rowCount)
  );
  check(
    "mismatch data is nonempty and scoped",
    await compare(
      `/api/privacy-profile/mismatches?devices=${STATS_DEVICE}`,
      (j) => j.apps.length === 1 && j.apps[0].mismatch.count > 0
    )
  );
  check(
    "age summary has a saved band and at least one above-band app",
    await compare(
      "/api/age-rating/summary",
      (j) => j.band !== null && j.count > 0
    )
  );
  check(
    "universal feed filters entries before pagination and retains original entry IDs",
    await compare(
      `/api/changelog?appId=${STATS_IDS[0]}&type=added,removed&category=accessibility&limit=1&offset=1`,
      (j) => j.rows.length === 1 && j.total === 8 && j.rows[0].id.endsWith(":2")
    )
  );
  // Each route owns a separate 120/min bucket. Run after all body checks.
  for (const route of [
    "/api/stats",
    "/api/triage",
    "/api/review-queue",
    "/api/privacy-profile/mismatches",
    "/api/age-rating/summary",
  ]) {
    const burst = async (base) => {
      for (let i = 1; i <= 121; i++) {
        const r = await read(base, `${route}?devices=${STATS_DEVICE}&count=1`);
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
      `${route} enforces its own read rate limit`,
      a !== null &&
        b !== null &&
        a.at === b.at &&
        a.body === '{"error":"Rate limit exceeded"}' &&
        a.body === b.body
    );
  }
  return ok;
}
