/** Shared SQL for the live gate and fixed-clock Node handler oracle. */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const CONTENT_IDS = ["89997001", "89997002", "89997003"];
export const CONTENT_DEVICE = "pt-content-device";
export function contentStatements(now) {
  const statements = [];
  const add = (sql, ...params) => statements.push({ sql, params });
  for (const table of [
    "privacy_categories",
    "privacy_types",
    "shortlist_entries",
    "annotations",
    "activity_log",
    "notifications",
  ]) {
    add(`DELETE FROM ${table} WHERE id LIKE 'pt-content-%'`);
  }
  for (const id of CONTENT_IDS) {
    add("DELETE FROM app_devices WHERE app_id = ?", id);
    add("DELETE FROM apps WHERE id = ?", id);
  }
  add("DELETE FROM devices WHERE id = ?", CONTENT_DEVICE);
  add(
    "INSERT INTO devices (id,name,created_at,last_synced_at) VALUES (?,?,?,?)",
    CONTENT_DEVICE,
    "Content phone",
    now,
    now
  );
  for (const [i, id] of CONTENT_IDS.entries()) {
    add(
      "INSERT INTO apps (id,name,url,developer,iconUrl,firstSeen,lastSynced,priceFormatted,priceCurrency,hasIap) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id,
      ["Content Source", "Content Candidate", "Content Empty"][i],
      `https://apps.apple.com/us/app/id${id}`,
      i ? "" : "Source dev",
      i ? null : "https://example.test/icon.png",
      now,
      now,
      i ? null : "$1.50",
      i ? null : "AUD",
      i ? null : 0
    );
  }
  add(
    "INSERT INTO app_devices (app_id,device_id,first_seen_at,last_seen_at) VALUES (?,?,?,?)",
    CONTENT_IDS[0],
    CONTENT_DEVICE,
    now,
    now
  );
  for (const [i, id] of CONTENT_IDS.slice(0, 2).entries()) {
    add(
      "INSERT INTO privacy_types (id,app_id,identifier,title) VALUES (?,?,?,?)",
      `pt-content-type-${i}`,
      id,
      i ? "DATA_NOT_LINKED_TO_YOU" : "DATA_USED_TO_TRACK_YOU",
      "Type title"
    );
    add(
      "INSERT INTO privacy_categories (id,type_id,identifier,title) VALUES (?,?,?,?)",
      `pt-content-cat-${i}`,
      `pt-content-type-${i}`,
      "CONTACTS",
      "Contacts"
    );
  }
  for (const [i, source, candidate, mode] of [
    [0, 0, 1, "accessibility, PRIVACY,invalid"],
    [1, 2, 0, "accessibility"],
    [2, 0, 2, "invalid"],
    [3, 0, 99, "privacy"],
  ]) {
    add(
      "INSERT INTO shortlist_entries (id,source_app_id,candidate_apple_id,candidate_name,candidate_store_url,candidate_developer,note,added_at,mode) VALUES (?,?,?,?,?,?,?,?,?)",
      `pt-content-shortlist-${i}`,
      CONTENT_IDS[source],
      CONTENT_IDS[candidate] ?? "89997999",
      `Candidate [${i}]`,
      `https://example.test/app/${i}`,
      i ? null : "Candidate dev",
      i ? "" : "First line\nsecond line · λ",
      now - i * 100,
      mode
    );
  }
  for (const [i, deleted] of [
    null,
    now - 30001,
    now - 30000,
    now - 29999,
  ].entries()) {
    add(
      "INSERT INTO annotations (id,app_id,content,source,source_name,visibility,tag,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      `pt-content-note-${i}`,
      CONTENT_IDS[i === 1 ? 1 : 0],
      `Note ${i}`,
      i ? "user" : "imported",
      i ? null : "A friend",
      i ? "export" : "private",
      i ? null : "follow_up",
      now - i,
      now,
      deleted
    );
  }
  const details = [
    '{"10":"ten","2":"two","n":9007199254740993,"tiny":1e-7}',
    "[false,null,2]",
    "broken",
    '"detail"',
    "null",
  ];
  for (let i = 0; i < 5; i++) {
    add(
      "INSERT INTO activity_log (id,type,status,app_id,app_name,summary,detail,started_at,ended_at,duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
      `pt-content-activity-${i}`,
      "dashboard_layout_applied",
      ["ok", "error", "partial", "cancelled", "ok"][i],
      i ? null : CONTENT_IDS[0],
      i ? null : "Content Source",
      `Activity ${i}`,
      details[i],
      now - i * 1000,
      i % 2 ? null : now - i,
      i % 2 ? null : i * 200
    );
  }
  const changes = [
    { type: "changed", category: "privacy-policy", details: [] },
    { type: "added", category: "accessibility", details: [] },
    { type: "added", title: "New type", details: [] },
    { type: "added", title: "New category", details: ["Contacts"] },
  ];
  for (let i = 0; i < 35; i++) {
    add(
      "INSERT INTO notifications (id,app_id,app_name,change_summary,created_at,read,stale,not_before) VALUES (?,?,?,?,?,?,?,?)",
      `pt-content-notification-${i}`,
      i % 2 ? CONTENT_IDS[0] : "__content_synthetic__",
      "Content notification",
      JSON.stringify(i === 0 ? [] : i === 1 ? changes : [changes[i % 4]]),
      now - i * 10,
      i % 5 === 0 ? 1 : 0,
      i % 3 === 0 ? 1 : 0,
      i === 2 ? now + 86400000 : i === 3 ? now : null
    );
  }
  return statements;
}
export function applyContentFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  try {
    db.transaction(() => {
      for (const { sql, params } of contentStatements(Date.now())) {
        db.prepare(sql).run(...params);
      }
    })();
  } finally {
    db.close();
  }
}
