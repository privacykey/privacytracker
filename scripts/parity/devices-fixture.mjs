/** Shared device fixture for live byte parity and the Node route oracle. */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const DEVICE_A = "pt-device-reads-a";
export const DEVICE_B = "pt-device-reads-b";
export const DEVICE_EMPTY = "pt-device-reads-empty";
export const DEVICE_ECID = "0xAbCd1234";
export const DEVICE_APP = "89998001";
export const DEVICE_TIME = Date.UTC(2026, 8, 15, 8);

export function deviceStatements() {
  const statements = [];
  const add = (sql, ...params) => statements.push({ sql, params });
  add("DELETE FROM imports WHERE id LIKE 'pt-device-reads-%'");
  add("DELETE FROM devices WHERE id LIKE 'pt-device-reads-%'");
  for (let i = 1; i <= 6; i++) {
    add("DELETE FROM apps WHERE id = ?", `8999800${i}`);
  }
  for (const [id, name, ecid, label, audience, ack, placeholder, synced] of [
    [
      DEVICE_A,
      "Zulu phone",
      DEVICE_ECID,
      "\uFEFF Mum\u00A0",
      "loved_one",
      DEVICE_TIME,
      0,
      DEVICE_TIME,
    ],
    [DEVICE_B, "Alpha tablet", null, "Leo", "guardian", null, 0, DEVICE_TIME],
    [
      "pt-device-reads-c",
      "alpha tablet",
      "0xabcd1234",
      " \uFEFF\u00A0",
      "unknown",
      null,
      2,
      DEVICE_TIME,
    ],
    [
      "pt-device-reads-unknown",
      "Unknown device",
      null,
      null,
      null,
      null,
      1,
      DEVICE_TIME - 1,
    ],
    [
      DEVICE_EMPTY,
      "Empty phone",
      "1234ABCD",
      "Self",
      "self",
      0,
      0,
      DEVICE_TIME + 1,
    ],
  ]) {
    add(
      `INSERT INTO devices (id,name,ecid,model,ios_version,device_class,
       created_at,last_synced_at,owner_label,owner_audience,permission_acknowledged_at,is_unknown_placeholder)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      name,
      ecid,
      id === DEVICE_A ? "iPhone16,1" : null,
      id === DEVICE_A ? "18.5" : null,
      id === DEVICE_A ? "iPhone" : null,
      DEVICE_TIME - 100,
      synced,
      label,
      audience,
      ack,
      placeholder
    );
  }
  for (const [i, [name, bundle]] of [
    ["zebra", "org.pt.shared"],
    ["Alpha", "org.pt.shared"],
    ["alpha", null],
    ["Éclair", ""],
    ["beta", " "],
    ["Blank", "org.pt.unique"],
  ].entries()) {
    const id = `8999800${i + 1}`;
    add(
      "INSERT INTO apps (id,name,url,bundleId,firstSeen,lastSynced) VALUES (?,?,?,?,?,?)",
      id,
      name,
      `https://apps.apple.com/us/app/id${id}`,
      bundle,
      DEVICE_TIME,
      DEVICE_TIME
    );
    for (const device of i < 2 ? [DEVICE_A, DEVICE_B] : [DEVICE_A]) {
      add(
        "INSERT INTO app_devices (app_id,device_id,first_seen_at,last_seen_at) VALUES (?,?,?,?)",
        id,
        device,
        DEVICE_TIME,
        DEVICE_TIME
      );
    }
  }
  for (const [i, [id, completed, source, imported]] of [
    [DEVICE_A, DEVICE_TIME - 30, "cfgutil", 6],
    [DEVICE_A, DEVICE_TIME - 10, "csv", 0],
    [DEVICE_A, 0, "manual", 0],
    [DEVICE_A, null, "cfgutil", 3],
    [DEVICE_B, DEVICE_TIME + 100, "cfgutil", 2],
  ].entries()) {
    add(
      "INSERT INTO imports (id,created_at,completed_at,source,imported,device_id) VALUES (?,?,?,?,?,?)",
      `pt-device-reads-import-${i}`,
      DEVICE_TIME - 100,
      completed,
      source,
      imported,
      id
    );
  }
  return statements;
}

export function applyDevicesFixture(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      for (const { sql, params } of deviceStatements()) {
        db.prepare(sql).run(...params);
      }
    })();
  } finally {
    db.close();
  }
}

export async function probeDeviceReads(nodeBase, rustBase, token) {
  let ok = true;
  const check = async (label, route, validate, expectedStatus = 200) => {
    const read = async (base) => {
      const r = await fetch(`${base}${route}`, {
        headers: { "x-auditor-admin-token": token },
      });
      return { status: r.status, body: await r.text() };
    };
    const [a, b] = await Promise.all([read(nodeBase), read(rustBase)]);
    const pass =
      a.status === expectedStatus &&
      b.status === expectedStatus &&
      a.body === b.body &&
      validate(JSON.parse(a.body));
    console.log(`  ${pass ? "✔" : "✘"} devices: ${label}`);
    if (!pass) {
      console.log(
        `      node ${a.status}: ${a.body.slice(0, 500)}\n      rust ${b.status}: ${b.body.slice(0, 500)}`
      );
    }
    ok = pass && ok;
  };
  await check(
    "list preserves ownership, strict placeholder flag, counts and timestamp/name order",
    "/api/devices",
    (j) => {
      const d = j.devices.filter((d) => d.id.startsWith("pt-device-reads-"));
      return (
        d.length === 5 &&
        d.map((d) => d.id).join() ===
          [
            DEVICE_EMPTY,
            DEVICE_B,
            DEVICE_A,
            "pt-device-reads-c",
            "pt-device-reads-unknown",
          ].join() &&
        d[2].ownerLabel === "Mum" &&
        d[2].ownerAudience === "loved_one" &&
        d[2].permissionAcknowledgedAt === DEVICE_TIME &&
        d[2].appCount === 6 &&
        d[3].ownerLabel === null &&
        d[3].ownerAudience === null &&
        !d[3].isUnknownPlaceholder &&
        d[4].isUnknownPlaceholder &&
        d[0].appCount === 0
      );
    }
  );
  await check(
    "ECID lookup trims JS whitespace and counts every completed import, including zero",
    `/api/devices?ecid=${encodeURIComponent(`\uFEFF ${DEVICE_ECID}\u00A0`)}`,
    (j) =>
      j.device.id === DEVICE_A &&
      j.importHistory.count === 3 &&
      j.importHistory.lastCompletedAt === DEVICE_TIME - 10 &&
      !("appCount" in j.device)
  );
  await check(
    "ECID matching remains case-sensitive",
    "/api/devices?ecid=0xABCD1234",
    (j) => j.device === null && j.importHistory === null
  );
  await check(
    "the first repeated ECID wins",
    `/api/devices?ecid=missing&ecid=${DEVICE_ECID}`,
    (j) => j.device === null
  );
  await check(
    "empty ECID selects the list branch",
    `/api/devices?ecid=&ecid=${DEVICE_ECID}`,
    (j) => j.devices.length >= 5
  );
  await check(
    "detail preserves owner metadata and import history",
    `/api/devices/${DEVICE_A}`,
    (j) => j.device.ownerLabel === "Mum" && j.importHistory.count === 3
  );
  await check(
    "an existing device with no imports has a zero/null history",
    `/api/devices/${DEVICE_EMPTY}`,
    (j) =>
      j.importHistory.count === 0 && j.importHistory.lastCompletedAt === null
  );
  await check(
    "detail does not trim IDs",
    `/api/devices/%20${DEVICE_A}%20`,
    (j) => j.error === "device not found",
    404
  );
  await check(
    "bundles trim the ID, deduplicate, retain whitespace and omit only null/empty",
    `/api/devices/%20${DEVICE_A}%20/bundles`,
    (j) =>
      j.bundleIds.length === 3 &&
      j.bundleIds.includes(" ") &&
      j.bundleIds.includes("org.pt.shared") &&
      j.bundleIds.includes("org.pt.unique")
  );
  await check(
    "tracked apps retain null/empty bundles and SQLite NOCASE ordering",
    `/api/devices/${DEVICE_A}/tracked-apps`,
    (j) =>
      j.apps.length === 6 &&
      j.apps.map((a) => a.name).join() ===
        "Alpha,alpha,beta,Blank,zebra,Éclair" &&
      j.apps[1].bundleId === null &&
      j.apps[5].bundleId === ""
  );
  await check(
    "reverse app lookup trims and returns every linked device without counts",
    `/api/devices/for-app/%20${DEVICE_APP}%20`,
    (j) =>
      j.devices.length === 2 &&
      j.devices[0].id === DEVICE_B &&
      j.devices[1].id === DEVICE_A &&
      j.devices.every((d) => !("appCount" in d))
  );
  await check(
    "blank app IDs return the exact 400 envelope",
    "/api/devices/for-app/%20",
    (j) => j.devices.length === 0,
    400
  );
  return ok;
}
