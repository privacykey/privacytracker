/**
 * Sync-write contention driver. Replicates the bulk-sync write pattern
 * (delete + re-insert an app's privacy_types tree, append a snapshot, touch
 * apps.lastSynced — one transaction per app) from a SECOND process against
 * the same WAL database, while the server keeps serving reads. This measures
 * the WAL writer-lock interaction a real bulk sync's db-worker produces,
 * without hitting Apple.
 *
 * Usage:
 *   pnpm exec tsx scripts/stress/contention.mts --data-dir /tmp/pt-stress/1000 \
 *     --apps 1000 [--rate 5] [--duration 30]
 *
 * Prints one JSON object on stdout.
 */
import { randomUUID } from "node:crypto";
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
const appCount = Number.parseInt(arg("apps"), 10);
const ratePerSec = Number.parseFloat(arg("rate", "5"));
const durationS = Number.parseFloat(arg("duration", "30"));

process.env.PRIVACYTRACKER_DATA_DIR = dataDir;
const { default: db } = await import("../../lib/db");

const TYPES = [
  { identifier: "DATA_USED_TO_TRACK_YOU", title: "Data Used to Track You" },
  { identifier: "DATA_LINKED_TO_YOU", title: "Data Linked to You" },
  { identifier: "DATA_NOT_LINKED_TO_YOU", title: "Data Not Linked to You" },
];
const CATS = [
  ["LOCATION", "Location"],
  ["IDENTIFIERS", "Identifiers"],
  ["USAGE_DATA", "Usage Data"],
  ["DIAGNOSTICS", "Diagnostics"],
  ["PURCHASES", "Purchases"],
  ["CONTACT_INFO", "Contact Info"],
  ["BROWSING_HISTORY", "Browsing History"],
  ["USER_CONTENT", "User Content"],
];

const deleteTypes = db.prepare("DELETE FROM privacy_types WHERE app_id = ?");
const insertType = db.prepare(
  "INSERT INTO privacy_types (id, app_id, identifier, title, detail) VALUES (?, ?, ?, ?, '')"
);
const insertCategory = db.prepare(
  "INSERT INTO privacy_categories (id, type_id, identifier, title) VALUES (?, ?, ?, ?)"
);
const insertSnapshot = db.prepare(`
  INSERT INTO privacy_snapshots (
    id, app_id, scraped_at, snapshot_json, changes_detected, changes_summary,
    source, triggered_by
  ) VALUES (?, ?, ?, ?, 0, NULL, 'live', 'scheduled')
`);
const touchApp = db.prepare("UPDATE apps SET lastSynced = ? WHERE id = ?");

const appId = (i: number) => String(1_000_000_000 + (i % appCount));

const tree = TYPES.map((t) => ({
  identifier: t.identifier,
  title: t.title,
  categories: CATS.map(([identifier, title]) => ({ identifier, title })),
}));
const treeJson = JSON.stringify(tree);

const syncOneApp = db.transaction((i: number) => {
  const id = appId(i);
  deleteTypes.run(id);
  for (const t of TYPES) {
    const typeId = `${id}_${t.identifier}`;
    insertType.run(typeId, id, t.identifier, t.title);
    for (const [cid, ctitle] of CATS) {
      insertCategory.run(`${typeId}_${cid}`, typeId, cid, ctitle);
    }
  }
  insertSnapshot.run(randomUUID(), id, Date.now(), treeJson);
  touchApp.run(Date.now(), id);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const latencies: number[] = [];
let busyErrors = 0;
let otherErrors = 0;
const interval = 1000 / ratePerSec;
const deadline = performance.now() + durationS * 1000;
let i = Math.floor(Math.random() * appCount);

while (performance.now() < deadline) {
  const t0 = performance.now();
  try {
    syncOneApp(i++);
    latencies.push(performance.now() - t0);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("SQLITE_BUSY")) {
      busyErrors++;
    } else {
      otherErrors++;
    }
  }
  const elapsed = performance.now() - t0;
  if (elapsed < interval) {
    await sleep(interval - elapsed);
  }
}

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies.length
    ? latencies[
        Math.min(
          latencies.length - 1,
          Math.ceil((p / 100) * latencies.length) - 1
        )
      ]
    : null;

console.log(
  JSON.stringify({
    mode: "contention",
    ratePerSec,
    durationS,
    writes: latencies.length,
    busyErrors,
    otherErrors,
    txnP50: pct(50),
    txnP95: pct(95),
    txnMax: latencies.length ? latencies[latencies.length - 1] : null,
  })
);
