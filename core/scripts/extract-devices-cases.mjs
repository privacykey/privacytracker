/** Execute the real Node GET handlers; Rust replays their status + raw bytes. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEVICE_A,
  DEVICE_APP,
  DEVICE_B,
  DEVICE_ECID,
  DEVICE_EMPTY,
  deviceStatements,
} from "../../scripts/parity/devices-fixture.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pt-device-cases-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
const { default: db } = await import("../../lib/db.ts");
const handlers = {};
for (const [op, file] of Object.entries({
  devices: "devices",
  detail: "devices/[id]",
  bundles: "devices/[id]/bundles",
  tracked_apps: "devices/[id]/tracked-apps",
  for_app: "devices/for-app/[appId]",
})) {
  handlers[op] = (await import(`../../app/api/${file}/route.ts`)).GET;
}
const base = deviceStatements();
const cases = [];
const run = async (
  name,
  op,
  id = DEVICE_A,
  query = "",
  changes = [],
  empty = false
) => {
  db.exec("SAVEPOINT device_case");
  try {
    for (const { sql, params } of [...(empty ? [] : base), ...changes]) {
      db.prepare(sql).run(...params);
    }
    const request = new Request(`http://localhost/api/devices${query}`);
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    const response = await handlers[op](request, {
      params: Promise.resolve({ id, appId: id }),
    });
    const body = await response.text();
    if (before !== db.prepare("SELECT total_changes() AS n").get().n) {
      throw new Error(`Device GET unexpectedly wrote: ${name}`);
    }
    cases.push({
      name,
      op,
      id,
      query: [...new URL(request.url).searchParams],
      changes,
      empty,
      status: response.status,
      body,
    });
  } finally {
    db.exec("ROLLBACK TO device_case; RELEASE device_case");
  }
};

const originalError = console.error;
try {
  // Fault injection intentionally exercises console.error branches.
  console.error = () => {};
  for (const [label, query] of [
    ["list", ""],
    ["empty ecid", "?ecid="],
    ["JS whitespace ecid", `?ecid=${encodeURIComponent(" \uFEFF\u00A0")}`],
    ["ECID", `?ecid=${DEVICE_ECID}`],
    [
      "trimmed ECID",
      `?ecid=${encodeURIComponent(`\uFEFF ${DEVICE_ECID}\u00A0`)}`,
    ],
    ["unknown ECID", "?ecid=missing"],
    ["case sensitive", "?ecid=0xABCD1234"],
    ["lowercase distinct device", "?ecid=0xabcd1234"],
    ["no prefix normalisation", "?ecid=AbCd1234"],
    [
      "non-JS whitespace",
      `?ecid=${encodeURIComponent(`\u0085${DEVICE_ECID}`)}`,
    ],
    ["first repeated", `?ecid=missing&ecid=${DEVICE_ECID}`],
    ["first empty repeated", `?ecid=&ecid=${DEVICE_ECID}`],
    ["no history", "?ecid=1234ABCD"],
  ]) {
    await run(label, "devices", DEVICE_A, query);
  }
  for (const op of ["detail", "bundles", "tracked_apps", "for_app"]) {
    const id = op === "for_app" ? DEVICE_APP : DEVICE_A;
    for (const [label, value] of [
      ["populated", id],
      ["missing", "pt-missing-device"],
      ["empty", ""],
      ["blank", " \uFEFF\u00A0"],
      ["trimmed", `\uFEFF ${id}\u00A0`],
      ["non-JS whitespace", `\u0085${id}`],
    ]) {
      await run(`${op} ${label}`, op, value);
    }
  }
  await run("detail no imports", "detail", DEVICE_EMPTY);
  await run("detail another device's imports", "detail", DEVICE_B);
  await run("bundles existing empty device", "bundles", DEVICE_EMPTY);
  await run("tracked existing empty device", "tracked_apps", DEVICE_EMPTY);
  for (const op of Object.keys(handlers)) {
    await run(`${op} empty database`, op, DEVICE_A, "", [], true);
  }
  // These are independent fallbacks: dropping imports must not hide a
  // valid device, while a missing junction fails the full list wholesale.
  const drop = (table) => [{ sql: `DROP TABLE ${table}`, params: [] }];
  await run("list missing devices", "devices", DEVICE_A, "", drop("devices"));
  await run(
    "ECID missing devices",
    "devices",
    DEVICE_A,
    `?ecid=${DEVICE_ECID}`,
    drop("devices")
  );
  await run(
    "list missing junction",
    "devices",
    DEVICE_A,
    "",
    drop("app_devices")
  );
  await run("detail missing devices", "detail", DEVICE_A, "", drop("devices"));
  await run("detail missing imports", "detail", DEVICE_A, "", drop("imports"));
  await run(
    "ECID missing imports",
    "devices",
    DEVICE_A,
    `?ecid=${DEVICE_ECID}`,
    drop("imports")
  );
  for (const op of ["bundles", "tracked_apps", "for_app"]) {
    await run(
      `${op} missing junction`,
      op,
      op === "for_app" ? DEVICE_APP : DEVICE_A,
      "",
      drop("app_devices")
    );
  }
  for (const op of ["bundles", "tracked_apps"]) {
    await run(`${op} missing apps`, op, DEVICE_A, "", drop("apps"));
  }
  await run(
    "for-app missing devices",
    "for_app",
    DEVICE_APP,
    "",
    drop("devices")
  );
  writeFileSync(
    new URL("../tests/fixtures/devices-cases.json", import.meta.url),
    `${JSON.stringify({ base, cases }, null, 2)}\n`
  );
  console.log(
    `devices oracle: ${cases.length} Node GET status/body cases (including database failures), zero writes`
  );
} finally {
  console.error = originalError;
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
