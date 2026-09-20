// Drive a PACKAGED Rust-backend app over HTTP, in a disposable data
// directory. The Node build has `scripts/smoke-packaged-server.mjs`, which
// runs the bundled Node against the extracted standalone tree; this is its
// counterpart for the build where the app IS the server.
//
// It exists because the only thing worth verifying at release time is what
// was actually signed and notarised: the app binary, with the frontend
// staged inside its own bundle. `pt-core` is not in there, and the window
// would need someone to look at it, so the app is asked for its hidden
// `--smoke-server <dir>` mode (src-tauri/src/embedded.rs) and driven over
// loopback.
//
// The checks mirror the Node smoke, because they are about the database
// rather than the backend: a v0.1.2 database opens and migrates, a backup
// exports with every table, a restore is trusted, and the data survives a
// restart. Two are specific to this build: the pages come from inside the
// bundle, and reads are allowed without a token, which is the desktop's
// posture (loopback bind, no token anywhere).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [appArg] = process.argv.slice(2);
assert.ok(appArg, "Specify the .app bundle to smoke");
const app = path.resolve(appArg);
const binary = path.join(app, "Contents/MacOS/privacytracker");
const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-rust-smoke-"));

let child;
let output = "";

async function stop() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/** Start the packaged app in its smoke mode and wait for the line it
 *  prints with its address. */
async function start() {
  output = "";
  child = spawn(binary, ["--smoke-server", dir], {
    // Deliberately not the repository: a packaged app must find its
    // frontend inside its own bundle, and starting here would let a stray
    // build in the working directory stand in for the staged one.
    cwd: path.parse(dir).root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the packaged app exited: ${output}`);
    }
    const listening = output.match(/smoke server listening on (http:\S+)/);
    const site = output.match(/smoke server site (.+)/);
    if (listening && site) {
      return { base: listening[1], site: site[1].trim() };
    }
    await delay(200);
  }
  throw new Error(`the packaged app never reported an address: ${output}`);
}

try {
  // The v0.1.2 database, written with the host's SQLite. What matters is
  // that the SHIPPED one (rusqlite, compiled into the binary) opens and
  // migrates it.
  execFileSync(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');const db=require('better-sqlite3')(${JSON.stringify(path.join(dir, "privacy.db"))});db.exec(fs.readFileSync(${JSON.stringify(path.resolve("tests/fixtures/v0.1.2/database.sql"))},'utf8'));db.close()`,
    ],
    { stdio: "inherit" }
  );
  copyFileSync(
    "tests/fixtures/v0.1.2/backup-signing.key",
    path.join(dir, "backup-signing.key")
  );

  let { base, site } = await start();

  assert.ok(
    site.startsWith(path.join(app, "Contents/Resources")),
    `the app served ${site}, which is not inside its own bundle`
  );

  const page = await fetch(base);
  assert.equal(page.status, 200, "the staged frontend answers");
  assert.ok(
    page.headers.get("content-security-policy")?.includes("ipc:"),
    "pages carry the desktop CSP"
  );

  // No admin token exists on the desktop: the loopback bind is the gate,
  // and a read is expected to answer. (The Node smoke asserts a 401
  // because it gives that server a token.)
  assert.equal((await fetch(`${base}/api/apps`)).status, 200);

  const exported = await fetch(`${base}/api/backup/export`);
  assert.equal(exported.status, 200);
  const backup = await exported.json();
  for (const table of [
    "apps",
    "devices",
    "app_devices",
    "annotations",
    "privacy_snapshots",
    "change_review_actions",
  ]) {
    assert.equal(backup.tables[table].rows.length, 1, table);
  }
  assert.ok(!JSON.stringify(backup).includes("SYNTHETIC-SECRET-NEVER-REAL"));

  const restored = await fetch(`${base}/api/backup/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(backup),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).trust, "trusted");

  await stop();
  ({ base } = await start());
  const after = await fetch(`${base}/api/backup/export`);
  assert.equal(after.status, 200);
  assert.equal((await after.json()).tables.app_devices.rows.length, 1);

  console.log(
    "Packaged Rust app passed legacy upgrade, staged frontend, authenticated restore and restart persistence."
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
