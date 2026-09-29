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
// restart. The rest are specific to this build: the pages come from inside
// the bundle, and the API answers only to this launch's credential. Without
// it every API call is a 401; with it (read from `.desktop-token`, as a
// same-user tool reads it, or carried by the cookie the window's one-time
// link sets) the call goes through. Every launch mints a new one.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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

/** This launch's credential, read the way a same-user tool reads it: from
 *  `.desktop-token` in the data directory, which must be private. */
function launchCredential() {
  const file = path.join(dir, ".desktop-token");
  assert.equal(
    statSync(file).mode & 0o777,
    0o600,
    ".desktop-token is readable by this user only"
  );
  const credential = readFileSync(file, "utf8").trim();
  assert.match(credential, /^[0-9a-f]{64}$/, "32 random bytes, hex-encoded");
  return credential;
}

/** Start the packaged app in its smoke mode and wait for the lines it
 *  prints with its address, its frontend and the window's one-time link. */
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
    const entry = output.match(/smoke server entry (http:\S+)/);
    if (listening && site && entry) {
      return {
        base: listening[1],
        site: site[1].trim(),
        entry: entry[1],
        credential: launchCredential(),
      };
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

  let { base, site, entry, credential } = await start();
  let authorised = { "x-privacytracker-desktop-token": credential };

  assert.ok(
    site.startsWith(path.join(app, "Contents/Resources")),
    `the app served ${site}, which is not inside its own bundle`
  );

  // The page shells are public: the same static files for everyone.
  const page = await fetch(base);
  assert.equal(page.status, 200, "the staged frontend answers");
  assert.ok(
    page.headers.get("content-security-policy")?.includes("ipc:"),
    "pages carry the desktop CSP"
  );

  // The API is not: without this launch's credential every call is
  // refused, public reads included, and a matching Origin is no substitute.
  for (const apiPath of ["/api/apps", "/api/health", "/api/backup/export"]) {
    assert.equal(
      (await fetch(`${base}${apiPath}`)).status,
      401,
      `${apiPath} without the credential`
    );
  }
  assert.equal(
    (
      await fetch(`${base}/api/reset`, {
        method: "POST",
        headers: { origin: base },
      })
    ).status,
    401,
    "a forged Origin is not a credential"
  );
  assert.equal(
    (await fetch(`${base}/api/apps`, { headers: authorised })).status,
    200,
    "the credential from .desktop-token lets a read in"
  );

  // The window's way in: the one-time link sets an HttpOnly session cookie
  // and redirects to the start page, and works once.
  assert.ok(
    entry.startsWith(`${base}/api/desktop/bootstrap?nonce=`),
    `unexpected entry URL ${entry}`
  );
  const signedIn = await fetch(entry, { redirect: "manual" });
  assert.equal(signedIn.status, 303, "the link redirects");
  assert.equal(signedIn.headers.get("location"), "/");
  const setCookie = signedIn.headers.get("set-cookie") ?? "";
  assert.match(
    setCookie,
    /HttpOnly/,
    "the cookie is out of page scripts' reach"
  );
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  assert.equal(
    (await fetch(`${base}/api/apps`, { headers: { cookie } })).status,
    200,
    "the cookie lets the window's reads in"
  );
  assert.equal(
    (await fetch(entry, { redirect: "manual" })).status,
    403,
    "the link works once"
  );

  const exported = await fetch(`${base}/api/backup/export`, {
    headers: authorised,
  });
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
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify(backup),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).trust, "trusted");

  await stop();
  const previous = credential;
  ({ base, credential } = await start());
  assert.notEqual(credential, previous, "every launch mints a new credential");
  assert.equal(
    (
      await fetch(`${base}/api/apps`, {
        headers: { "x-privacytracker-desktop-token": previous },
      })
    ).status,
    401,
    "the last launch's credential no longer works"
  );
  authorised = { "x-privacytracker-desktop-token": credential };
  const after = await fetch(`${base}/api/backup/export`, {
    headers: authorised,
  });
  assert.equal(after.status, 200);
  assert.equal((await after.json()).tables.app_devices.rows.length, 1);

  console.log(
    "Packaged Rust app passed legacy upgrade, staged frontend, launch credential, authenticated restore and restart persistence."
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
