// Run only the packaged server in a disposable data directory. This never
// opens the desktop UI or an installation's database/settings directory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [node, standalone] = process.argv.slice(2);
assert.ok(
  node && standalone,
  "Specify the bundled Node and extracted server directory"
);
const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-packaged-smoke-"));
const token = randomBytes(32).toString("hex");
let child;
let output = "";
let spawnError;
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
async function start() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
  spawnError = undefined;
  child = spawn(node, [path.join(standalone, "server.js")], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-server",
      BUILD_STANDALONE: "0",
      PRIVACYTRACKER_DATA_DIR: dir,
      PRIVACYTRACKER_BIND_HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AUDITOR_ADMIN_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) {
      throw spawnError;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged server exited: ${output}`);
    }
    try {
      const response = await fetch(`${base}/api/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return base;
      }
    } catch {
      /* startup */
    }
    await delay(200);
  }
  throw new Error(`Packaged server readiness timed out: ${output}`);
}
try {
  // Open the v0.1.2 SQL fixture using the actual packaged SQLite binary.
  execFileSync(node, [
    "-e",
    `const fs=require('node:fs'); const {createRequire}=require('node:module'); const req=createRequire(${JSON.stringify(path.join(standalone, "server.js"))}); const db=req('better-sqlite3')(${JSON.stringify(path.join(dir, "privacy.db"))}); db.exec(fs.readFileSync(${JSON.stringify(path.resolve("tests/fixtures/v0.1.2/database.sql"))},'utf8'));db.close()`,
  ]);
  copyFileSync(
    "tests/fixtures/v0.1.2/backup-signing.key",
    path.join(dir, "backup-signing.key")
  );
  const headers = { "x-auditor-admin-token": token };
  let base = await start();
  assert.equal((await fetch(`${base}/api/apps`)).status, 401);
  const exported = await fetch(`${base}/api/backup/export`, { headers });
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
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(backup),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).trust, "trusted");
  await stop();
  base = await start();
  const after = await fetch(`${base}/api/backup/export`, { headers });
  assert.equal(after.status, 200);
  assert.equal((await after.json()).tables.app_devices.rows.length, 1);
  console.log(
    "Packaged server passed legacy upgrade, authenticated restore, anonymous denial and restart persistence."
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
