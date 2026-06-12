/**
 * Bulk seeder for stress testing. Generates N synthetic apps with realistic
 * privacy-label trees, snapshot history, notifications, devices, and activity
 * rows directly into an ISOLATED SQLite DB (never the developer's real one —
 * --data-dir is mandatory and must not be the repo's ./data).
 *
 * Usage:
 *   pnpm exec tsx scripts/stress/seed.mts --data-dir /tmp/pt-stress/1000 \
 *     --apps 1000 [--snapshots 22] [--unread 2] [--read 2] [--devices 3]
 *
 * Prints a single JSON object with seed stats on stdout.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  if (fallback !== undefined) {
    return fallback;
  }
  console.error(`Missing required arg --${name}`);
  process.exit(1);
}

const dataDir = path.resolve(arg("data-dir"));
const repoData = path.join(process.cwd(), "data");
if (dataDir === repoData) {
  console.error("Refusing to seed into the repo's real ./data directory");
  process.exit(1);
}
const appCount = Number.parseInt(arg("apps"), 10);
const snapshotsPerApp = Number.parseInt(arg("snapshots", "22"), 10);
const unreadPerApp = Number.parseInt(arg("unread", "2"), 10);
const readPerApp = Number.parseInt(arg("read", "2"), 10);
const deviceCount = Number.parseInt(arg("devices", "3"), 10);

fs.mkdirSync(dataDir, { recursive: true });
process.env.PRIVACYTRACKER_DATA_DIR = dataDir;

// Import AFTER setting the env var — lib/db.ts resolves the path at import.
const { default: db } = await import("../../lib/db");

// Deterministic PRNG so repeat runs at the same scale produce identical DBs.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = [
  { identifier: "DATA_USED_TO_TRACK_YOU", title: "Data Used to Track You" },
  { identifier: "DATA_LINKED_TO_YOU", title: "Data Linked to You" },
  { identifier: "DATA_NOT_LINKED_TO_YOU", title: "Data Not Linked to You" },
];

const CATEGORY_POOL = [
  ["CONTACT_INFO", "Contact Info"],
  ["HEALTH_FITNESS", "Health & Fitness"],
  ["FINANCIAL_INFO", "Financial Info"],
  ["LOCATION", "Location"],
  ["SENSITIVE_INFO", "Sensitive Info"],
  ["CONTACTS", "Contacts"],
  ["USER_CONTENT", "User Content"],
  ["BROWSING_HISTORY", "Browsing History"],
  ["SEARCH_HISTORY", "Search History"],
  ["IDENTIFIERS", "Identifiers"],
  ["PURCHASES", "Purchases"],
  ["USAGE_DATA", "Usage Data"],
  ["DIAGNOSTICS", "Diagnostics"],
  ["OTHER_DATA", "Other Data"],
] as const;

const ADJECTIVES = [
  "Swift",
  "Bright",
  "Quiet",
  "Daily",
  "Smart",
  "Simple",
  "Rapid",
  "Cosy",
  "Lunar",
  "Solar",
  "Prime",
  "Vivid",
  "Calm",
  "Bold",
  "Clear",
  "Deep",
];
const NOUNS = [
  "Notes",
  "Budget",
  "Tracker",
  "Camera",
  "Weather",
  "Reader",
  "Fitness",
  "Recipes",
  "Travel",
  "Music",
  "Photos",
  "Tasks",
  "Chat",
  "Maps",
  "News",
  "Habits",
];
const GENRES = [
  [6007, "Productivity"],
  [6013, "Health & Fitness"],
  [6005, "Social Networking"],
  [6015, "Finance"],
  [6008, "Photo & Video"],
  [6003, "Travel"],
] as const;

const FLOOR = Date.parse("2021-02-01T00:00:00Z");
const NOW = Date.now();

const insertApp = db.prepare(`
  INSERT INTO apps (
    id, name, url, iconUrl, bundleId, developer, firstSeen, lastSynced,
    changeCount, currentVersion, versionUpdatedAt, hasPrivacyDetails,
    hasAccessibilityLabels, priceAmount, priceCurrency, priceFormatted,
    hasIap, genreId, genreName, ageRating
  ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'USD', 'Free', ?, ?, ?, ?)
`);
const insertType = db.prepare(
  "INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, '')"
);
const insertCategory = db.prepare(
  "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)"
);
const insertSnapshot = db.prepare(`
  INSERT INTO privacy_snapshots (
    id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
    source, wayback_snapshot_url, triggered_by, app_version, app_version_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertNotification = db.prepare(`
  INSERT INTO notifications (id, app_id, app_name, change_summary, created_at, read, stale)
  VALUES (?, ?, ?, ?, ?, ?, 0)
`);
const insertActivity = db.prepare(`
  INSERT INTO activity_log (id, type, status, app_id, app_name, summary, started_at, ended_at, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertDevice = db.prepare(`
  INSERT INTO devices (id, name, ecid, model, ios_version, device_class, created_at, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertAppDevice = db.prepare(`
  INSERT INTO app_devices (app_id, device_id, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?)
`);
const setSetting = db.prepare(
  "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
);

function appId(i: number): string {
  return String(1_000_000_000 + i);
}

interface TypeTree {
  categories: { identifier: string; title: string }[];
  identifier: string;
  title: string;
}

function buildTree(rand: () => number, drop = -1): TypeTree[] {
  return TYPES.map((t, ti) => {
    const count = 5 + Math.floor(rand() * 5); // 5–9 categories per type
    const cats: TypeTree["categories"] = [];
    const offset = Math.floor(rand() * CATEGORY_POOL.length);
    for (let c = 0; c < count; c++) {
      if (ti === 0 && c === drop) {
        continue; // historical variation: this category "appeared later"
      }
      const [identifier, title] =
        CATEGORY_POOL[(offset + c) % CATEGORY_POOL.length];
      cats.push({ identifier, title });
    }
    return { identifier: t.identifier, title: t.title, categories: cats };
  });
}

const started = Date.now();
let snapshotRows = 0;
let categoryRows = 0;
let notificationRows = 0;

const deviceIds: string[] = [];
db.transaction(() => {
  for (let d = 0; d < deviceCount; d++) {
    const id = `stress-device-${d}`;
    deviceIds.push(id);
    insertDevice.run(
      id,
      d === 0 ? "Family iPhone" : d === 1 ? "Kids iPad" : `Device ${d}`,
      `ECID${1000 + d}`,
      d % 2 === 0 ? "iPhone15,2" : "iPad13,1",
      "18.5",
      d % 2 === 0 ? "iPhone" : "iPad",
      FLOOR,
      NOW
    );
  }

  setSetting.run("welcomed_at", String(FLOOR));
  setSetting.run("sync_schedule", "manual");
  setSetting.run("policy_scrape_disabled", "true");
  setSetting.run("health_check_enabled", "false");
})();

const CHUNK = 250;
for (let start = 0; start < appCount; start += CHUNK) {
  const end = Math.min(start + CHUNK, appCount);
  db.transaction(() => {
    for (let i = start; i < end; i++) {
      const rand = mulberry32(i + 1);
      const id = appId(i);
      const name = `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[Math.floor(i / ADJECTIVES.length) % NOUNS.length]} ${i}`;
      const hasPending = rand() < 0.15;
      const [genreId, genreName] = GENRES[i % GENRES.length];
      insertApp.run(
        id,
        name,
        `https://apps.apple.com/us/app/stress-${i}/id${id}`,
        `com.stress.app${i}`,
        `Stress Labs ${i % 50}`,
        FLOOR + Math.floor(rand() * (NOW - FLOOR) * 0.2),
        NOW - Math.floor(rand() * 86_400_000),
        hasPending ? 1 + Math.floor(rand() * 4) : 0,
        `${1 + Math.floor(rand() * 9)}.${Math.floor(rand() * 20)}.${Math.floor(rand() * 10)}`,
        NOW - Math.floor(rand() * 90 * 86_400_000),
        rand() < 0.3 ? 1 : 0,
        rand() < 0.4 ? 1 : 0,
        genreId,
        genreName,
        ["4+", "9+", "13+", "17+"][Math.floor(rand() * 4)]
      );

      // Current privacy-label tree (what the grid/detail pages read).
      const tree = buildTree(rand);
      for (const t of tree) {
        const typeId = `${id}_${t.identifier}`;
        insertType.run(typeId, id, t.identifier, t.title);
        for (const c of t.categories) {
          insertCategory.run(
            `${typeId}_${c.identifier}`,
            typeId,
            c.identifier,
            c.title
          );
          categoryRows++;
        }
      }

      // Snapshot history: spread from the historical floor to now. Older
      // 60% are wayback imports, the rest scheduled live syncs. ~20% carry
      // a change entry so changelog/timeline queries have real work to do.
      for (let s = 0; s < snapshotsPerApp; s++) {
        const frac = snapshotsPerApp === 1 ? 1 : s / (snapshotsPerApp - 1);
        const scrapedAt = Math.floor(FLOOR + frac * (NOW - FLOOR));
        const isWayback = frac < 0.6;
        const changed = s > 0 && rand() < 0.2;
        const snapTree = buildTree(
          mulberry32(i + 1),
          s < snapshotsPerApp / 2 ? 0 : -1
        );
        const isLast = s === snapshotsPerApp - 1;
        insertSnapshot.run(
          randomUUID(),
          id,
          scrapedAt,
          JSON.stringify(snapTree),
          changed || (isLast && hasPending) ? 1 : 0,
          changed || (isLast && hasPending)
            ? JSON.stringify([
                {
                  category: "privacy-label",
                  description: `Added "Location" to ${TYPES[0].title}`,
                  details: ["Location"],
                },
                ...(rand() < 0.5
                  ? [
                      {
                        category: "privacy-label",
                        description: `Removed "Purchases" from ${TYPES[1].title}`,
                        details: ["Purchases"],
                      },
                    ]
                  : []),
              ])
            : null,
          isWayback ? "wayback" : "live",
          isWayback
            ? `https://web.archive.org/web/20210201000000id_/https://apps.apple.com/us/app/id${id}`
            : null,
          isWayback ? "wayback" : "scheduled",
          isWayback ? null : "1.0.0",
          isWayback ? null : scrapedAt
        );
        snapshotRows++;
      }

      for (let n = 0; n < unreadPerApp + readPerApp; n++) {
        // change_summary holds a JSON ChangeEntry[] — getNotifications
        // JSON.parses every row it returns, so plain text 500s the bell.
        insertNotification.run(
          randomUUID(),
          id,
          name,
          JSON.stringify([
            {
              category: "privacy-label",
              description: 'Added "Location" to Data Used to Track You',
              details: ["Location"],
            },
          ]),
          NOW - Math.floor(rand() * 180 * 86_400_000),
          n < readPerApp ? 1 : 0
        );
        notificationRows++;
      }

      insertAppDevice.run(id, deviceIds[i % deviceIds.length], FLOOR, NOW);
      if (i % 2 === 0 && deviceIds.length > 1) {
        insertAppDevice.run(
          id,
          deviceIds[(i + 1) % deviceIds.length],
          FLOOR,
          NOW
        );
      }
    }
  })();
}

// Activity log at its retention cap (2000), like a long-running install.
db.transaction(() => {
  for (let a = 0; a < 2000; a++) {
    const ts = NOW - a * 3_600_000;
    insertActivity.run(
      randomUUID(),
      a % 3 === 0 ? "bulk_sync" : "sync_app",
      "success",
      appId(a % appCount),
      `App ${a % appCount}`,
      "Synced privacy labels",
      ts,
      ts + 1200,
      1200
    );
  }
})();

db.pragma("wal_checkpoint(TRUNCATE)");

const dbBytes = fs.statSync(path.join(dataDir, "privacy.db")).size;
console.log(
  JSON.stringify({
    dataDir,
    apps: appCount,
    snapshotsPerApp,
    snapshotRows,
    categoryRows,
    notificationRows,
    dbBytes,
    seedMs: Date.now() - started,
  })
);
