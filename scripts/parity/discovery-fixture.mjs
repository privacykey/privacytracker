/** Deterministic library rows for the final two Phase 2 reads. */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { statement as s } from "./operations-fixture.mjs";

export const DISCOVERY_APP = "89995001";
export const DISCOVERY_EMPTY = "pt-discovery-empty";
export const discoveryStatements = [
  s(
    "INSERT OR REPLACE INTO apps (id,name,url,iconUrl,developer,privacyPolicyUrl,hasPrivacyDetails,hasAccessibilityLabels,genreId,genreName,priceAmount,lastSynced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    DISCOVERY_APP,
    "Discovery λ",
    "https://apps.apple.com/us/app/id89995001",
    "icon",
    "Developer",
    "https://example.com/privacy",
    1,
    1,
    6005,
    "Social",
    0,
    0
  ),
  s(
    "INSERT OR REPLACE INTO apps (id,name,url,lastSynced) VALUES (?,?,?,?)",
    DISCOVERY_EMPTY,
    "No stored labels",
    "",
    0
  ),
  s(
    "INSERT OR REPLACE INTO privacy_types (id,app_id,identifier,title) VALUES (?,?,?,?)",
    89995001,
    DISCOVERY_APP,
    "DATA_LINKED_TO_YOU",
    "Linked"
  ),
  s(
    "INSERT OR REPLACE INTO privacy_categories (id,type_id,identifier,title) VALUES (?,?,?,?)",
    89995001,
    89995001,
    "CONTACT_INFO",
    "Contact info"
  ),
  s(
    "INSERT OR REPLACE INTO accessibility_features (id,app_id,identifier,title,description,icon_template) VALUES (?,?,?,?,?,?)",
    "pt-discovery-a11y",
    DISCOVERY_APP,
    "voice_over",
    "VoiceOver",
    "Description",
    "systemimage://voiceover"
  ),
  ...["003", "001", "002"].map((id, i) =>
    s(
      "INSERT OR REPLACE INTO related_apps_observed (source_app_id,related_apple_id,related_name,related_developer,related_icon_url,related_store_url,shelf_type,observed_at) VALUES (?,?,?,?,?,?,?,?)",
      DISCOVERY_APP,
      id,
      `Candidate ${id}`,
      i === 1 ? null : "Developer",
      null,
      `https://apps.apple.com/us/app/id${id}`,
      "may_also_like",
      i === 2 ? 1 : 2
    )
  ),
];
export function applyDiscoveryFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  try {
    db.transaction(() => {
      for (const s of discoveryStatements) {
        db.prepare(s.sql).run(...s.params);
      }
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
