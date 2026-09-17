/**
 * The backup family, live on both servers (Rust core Phase 4, batch 5b).
 *
 * The differ cannot gate these routes: the export and the download answer
 * with a file, the preview and the restore need one uploaded, and the
 * restore replaces the database it is pointed at. What the differ can do —
 * the snapshot settings write and the manual snapshot — is in the
 * manifest. This probe does the rest, and the one thing no fixture can:
 * it proves the two backends agree on the SIGNATURE over a real install.
 *
 * The Rust side starts on a byte copy of Node's data directory, so once
 * `primeBackupKey` has made Node mint `backup-signing.key` before the
 * copy, both servers hold the same key. A backup either one exports must
 * then restore as `trusted` on the other; if the canonical form, the
 * number spelling or the key handling differed by one byte, it would come
 * back `untrusted_backup` instead.
 *
 * DESTRUCTIVE, and therefore last: it ends by restoring the same backup
 * into both servers and comparing what each then exports, table by table.
 * The read-parity data directory is disposable by contract.
 */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

const SNAPSHOT_NAME =
  /^privacytracker-snapshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.json$/;
const EXPORT_DISPOSITION =
  /^attachment; filename="privacytracker-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json"$/;

/** Tables each server writes to on its own clock and with its own ids. */
const OWN_ROWS = new Set(["audit_log"]);

/**
 * Make Node mint the signing key, so the copy the Rust side boots from
 * carries it. Call BEFORE the data directory is copied.
 */
export async function primeBackupKey(nodeBase, token) {
  const res = await fetch(`${nodeBase}/api/backup/export`, {
    headers: { "x-auditor-admin-token": token },
  });
  await res.arrayBuffer();
  const pass = res.status === 200;
  console.log(
    `  ${pass ? "✔" : "✘"} backup: Node minted the signing key both servers will share (HTTP ${res.status})`
  );
  return pass;
}

export async function probeBackupRoutes(
  nodeBase,
  rustBase,
  token,
  nodeData,
  rustData
) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} backup: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      cache: res.headers.get("cache-control"),
      version: res.headers.get("x-backup-version"),
    };
  };
  const both = (method, route, body) =>
    Promise.all([
      send(nodeBase, method, route, body),
      send(rustBase, method, route, body),
    ]);
  const short = (r) => JSON.stringify(r).slice(0, 400);

  // ── export ─────────────────────────────────────────────────────────
  const [nodeExport, rustExport] = await both("GET", "/api/backup/export");
  const exportsOk = check(
    "both servers export a signed download with the same headers",
    [nodeExport, rustExport].every(
      (r) =>
        r.status === 200 &&
        r.type === "application/json; charset=utf-8" &&
        r.cache === "no-store" &&
        r.version === "1" &&
        EXPORT_DISPOSITION.test(r.disposition ?? "")
    ),
    `node=${short({ ...nodeExport, text: undefined })} rust=${short({ ...rustExport, text: undefined })}`
  );
  if (!exportsOk) {
    return false;
  }
  const nodeBackup = JSON.parse(nodeExport.text);
  const rustBackup = JSON.parse(rustExport.text);
  check(
    "the Rust export is laid out byte for byte as JSON.stringify(v, null, 2) lays it out",
    rustExport.text === JSON.stringify(rustBackup, null, 2)
  );
  const shape = (b) =>
    JSON.stringify({
      version: b.version,
      appName: b.appName,
      alg: b.signature?.alg,
      macBytes: Buffer.from(b.signature?.mac ?? "", "base64").length,
      tables: Object.entries(b.tables).map(([name, t]) => [name, t.columns]),
    });
  check(
    "both exports carry the same tables, in the same order, with the same columns",
    shape(nodeBackup) === shape(rustBackup),
    `node=${shape(nodeBackup).slice(0, 300)} rust=${shape(rustBackup).slice(0, 300)}`
  );
  const secrets = (b) =>
    b.tables.app_settings.rows
      .filter((r) => ["ai_api_key", "notification_webhook_url"].includes(r.key))
      .every((r) => r.value === "");
  check(
    "neither export carries the AI key or the webhook destination",
    secrets(nodeBackup) && secrets(rustBackup)
  );

  // ── preview: a pure function of the upload ─────────────────────────
  for (const [label, payload] of [
    ["Node's export", nodeExport.text],
    ["Rust's export", rustExport.text],
    ["an empty object", "{}"],
    ["an array", "[]"],
    ["a newer version", '{"version":2,"tables":{}}'],
    ["an unknown table", '{"version":1,"tables":{"zeta":{"rows":[1]}}}'],
    // Past the 2 MiB most frameworks cap a body at by default: these two
    // routes take a hundred, and a quiet lower cap would refuse real backups.
    [
      "a 3 MiB upload",
      `{"version":1,"tables":{"annotations":{"rows":[{"content":"${"x".repeat(3 * 1024 * 1024)}"}]}}}`,
    ],
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
  ]) {
    const [a, b] = await both("POST", "/api/backup/preview", payload);
    check(
      `the preview of ${label} is identical (HTTP ${a.status})`,
      a.status === b.status && a.text === b.text && a.type === b.type,
      `node=${short(a)} rust=${short(b)}`
    );
  }

  // ── snapshots: create, list, download ──────────────────────────────
  const [nodeSnap, rustSnap] = await both("POST", "/api/backup/snapshots");
  const created = [nodeSnap, rustSnap].map((r) => {
    try {
      return JSON.parse(r.text).created;
    } catch {
      return null;
    }
  });
  const snapsOk = check(
    "both servers create a snapshot named by its export time",
    [nodeSnap, rustSnap].every((r) => r.status === 200) &&
      created.every((c) => SNAPSHOT_NAME.test(c?.filename ?? "")),
    `node=${short(nodeSnap)} rust=${short(rustSnap)}`
  );
  if (snapsOk) {
    const downloads = await Promise.all([
      send(nodeBase, "GET", `/api/backup/snapshots/${created[0].filename}`),
      send(rustBase, "GET", `/api/backup/snapshots/${created[1].filename}`),
    ]);
    check(
      "each server downloads its snapshot as an attachment of that name",
      downloads.every(
        (r, i) =>
          r.status === 200 &&
          r.type === "application/json; charset=utf-8" &&
          r.cache === "no-store" &&
          r.disposition === `attachment; filename="${created[i].filename}"` &&
          Buffer.byteLength(r.text) === created[i].sizeBytes
      ),
      `node=${short({ ...downloads[0], text: undefined })} rust=${short({ ...downloads[1], text: undefined })}`
    );
    check(
      "the Rust snapshot file is laid out as JSON.stringify(v, null, 2) lays it out",
      downloads[1].text ===
        JSON.stringify(JSON.parse(downloads[1].text), null, 2)
    );
  }
  for (const [label, name] of [
    ["a snapshot that does not exist", "privacytracker-snapshot-absent.json"],
    ["a file that is not a snapshot", "privacy.db"],
    ["an encoded traversal", "..%2Fprivacy.db"],
    [
      "a traversal wearing the snapshot affixes",
      "privacytracker-snapshot-..%2F..%2Fprivacy.db%00.json",
    ],
  ]) {
    const [a, b] = await both("GET", `/api/backup/snapshots/${name}`);
    check(
      `${label} is the same 404 on both`,
      a.status === 404 && b.status === 404 && a.text === b.text,
      `node=${short(a)} rust=${short(b)}`
    );
  }

  // ── restore: the signature, across backends ────────────────────────
  // The operations fixture leaves no sync running, but a mutation may
  // have; the restore answers 409 while one is, on both servers alike.
  for (const dir of [nodeData, rustData]) {
    const db = new BetterSqlite3(path.join(dir, "privacy.db"));
    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sync_running', 'false')"
    ).run();
    db.close();
  }
  const restored = (r) => {
    const j = JSON.parse(r.text);
    return JSON.stringify({ ...j, restoredAt: "clock" });
  };
  // The restore allows three attempts in ten minutes, so three is what
  // this spends. (The refusals of a tampered, unsigned or foreign-signed
  // backup are pure functions of the upload and the key; the oracle holds
  // them, `allowUntrusted` included.)
  //
  // 1. The fixtures plant a deliberate orphan — a verdict for an app that
  //    does not exist — so an export of this install is a backup the
  //    restore must refuse. Rust's export, uploaded to both: each has to
  //    get PAST the signature gate (an untrusted backup is a 409, and
  //    never reaches the check) and then abort at `foreign_key_check`
  //    with the same count, leaving its rows alone.
  const appCount = () =>
    [nodeData, rustData].map((dir) => {
      const db = new BetterSqlite3(path.join(dir, "privacy.db"), {
        readonly: true,
      });
      const n = db.prepare("SELECT COUNT(*) AS n FROM apps").get().n;
      db.close();
      return n;
    });
  const appsBefore = appCount();
  const [orphanNode, orphanRust] = await both(
    "POST",
    "/api/backup/restore",
    rustExport.text
  );
  check(
    "a backup carrying the fixtures' orphan row passes the signature gate on both servers and is aborted identically at the foreign-key check, with nothing written",
    orphanNode.status === 500 &&
      orphanRust.status === 500 &&
      orphanNode.text === orphanRust.text &&
      /foreign-key violation/.test(orphanNode.text) &&
      JSON.stringify(appCount()) === JSON.stringify(appsBefore) &&
      appsBefore.every((n) => n > 0),
    `node=${short(orphanNode)} rust=${short(orphanRust)}`
  );

  // 2 and 3. With the orphan gone from both databases, each server's
  //    export restored into BOTH: the backend that did not sign it must
  //    still call it trusted.
  const removed = [nodeData, rustData].map((dir) => {
    const db = new BetterSqlite3(path.join(dir, "privacy.db"));
    const orphans = db.prepare("PRAGMA foreign_key_check").all();
    for (const { table, rowid } of orphans) {
      db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(rowid);
    }
    db.close();
    return orphans.length;
  });
  check(
    `the same ${removed[0]} orphan row(s) removed from both databases`,
    removed[0] === removed[1] && removed[0] > 0
  );
  const [nodeClean, rustClean] = await both("GET", "/api/backup/export");
  for (const [label, text] of [
    ["Node's export", nodeClean.text],
    ["Rust's export", rustClean.text],
  ]) {
    const [a, b] = await both("POST", "/api/backup/restore", text);
    let pass = false;
    try {
      pass =
        a.status === 200 &&
        b.status === 200 &&
        JSON.parse(a.text).trust === "trusted" &&
        JSON.parse(b.text).trust === "trusted" &&
        restored(a) === restored(b);
    } catch {
      pass = false;
    }
    check(
      `${label} restores as TRUSTED on both servers, with the same per-table counts`,
      pass,
      `node=${short(a)} rust=${short(b)}`
    );
  }

  // ── round trip: what each server now holds ─────────────────────────
  const [nodeAfter, rustAfter] = await both("GET", "/api/backup/export");
  let diverged = ["(export failed)"];
  if (nodeAfter.status === 200 && rustAfter.status === 200) {
    const a = JSON.parse(nodeAfter.text).tables;
    const b = JSON.parse(rustAfter.text).tables;
    diverged = Object.keys(a).filter(
      (name) =>
        !OWN_ROWS.has(name) &&
        JSON.stringify(a[name].rows) !== JSON.stringify(b[name]?.rows)
    );
  }
  check(
    "after restoring the same backup, both servers export the same rows in every table but the audit log",
    diverged.length === 0,
    `diverged: ${diverged.join(", ")}`
  );
  return ok;
}
