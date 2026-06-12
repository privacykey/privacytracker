/**
 * Docker stress phase: runs the SAME load suite against the production
 * compose stack (1 GB memory / 2 CPU limits from docker-compose.yml) so the
 * report can compare bare-metal vs containerized-with-shipped-limits.
 *
 * Flow per scale: seed locally → compose up → stop web → copy seeded DB into
 * the named volume via a helper container (chown 100:101, matching the
 * non-root `audit` user) → start web → wait ready → endpoint sweep + viewer
 * load → docker stats → compose down -v.
 *
 * Usage: node scripts/stress/run-docker.mjs [--scales 1000:22,2500:22] [--no-build]
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = "http://127.0.0.1:3000";
const STRESS_TMP = "/tmp/pt-stress";
const RESULTS_DIR = path.join(ROOT, "scripts/stress/results");

const scalesArg = (() => {
  const idx = process.argv.indexOf("--scales");
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const SCALES = (scalesArg ?? "1000:22,2500:22").split(",").map((s) => {
  const [apps, snapshots] = s.split(":").map((n) => Number.parseInt(n, 10));
  return { apps, snapshots, label: `docker-${apps}` };
});
const NO_BUILD = process.argv.includes("--no-build");

const SWEEP_S = 10;
const SWEEP_CONC = 4;
const VIEWER_LEVELS = [3, 10];
const VIEWER_S = 45;

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const resultsFile = path.join(RESULTS_DIR, `docker-${Date.now()}.json`);
const results = { startedAt: new Date().toISOString(), scales: [] };
const flush = () =>
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) =>
  console.error(`[docker ${new Date().toISOString()}] ${msg}`);

const sh = (cmd, opts = {}) => {
  const out = execSync(cmd, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return out === null ? "" : out.toString().trim();
};

function runJson(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`));
        return;
      }
      const lines = stdout.trim().split("\n");
      resolve(JSON.parse(lines[lines.length - 1]));
    });
  });
}

async function waitReady(timeoutMs = 180_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) {
        return Math.round(performance.now() - t0);
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return null;
}

function dockerStats() {
  try {
    const line = sh(
      'docker stats --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}" $(docker compose ps -q web)'
    );
    const [mem, cpu] = line.split("|");
    return { memUsage: mem, cpuPerc: cpu };
  } catch (err) {
    return { error: String(err).slice(0, 300) };
  }
}

if (!NO_BUILD) {
  log("building compose image (this takes several minutes)");
  sh("docker compose build", { stdio: ["ignore", "inherit", "inherit"] });
}

for (const scale of SCALES) {
  const entry = { ...scale, phases: {}, errors: [] };
  const dataDir = path.join(STRESS_TMP, scale.label);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    log(`seeding ${scale.apps} apps × ${scale.snapshots} snapshots`);
    entry.seed = await runJson("node_modules/.bin/tsx", [
      "scripts/stress/seed.mts",
      "--data-dir",
      dataDir,
      "--apps",
      String(scale.apps),
      "--snapshots",
      String(scale.snapshots),
    ]);

    log("compose up");
    sh("docker compose up -d", { stdio: ["ignore", "inherit", "inherit"] });
    if ((await waitReady()) === null) {
      throw new Error("compose stack never became ready");
    }

    log("injecting seeded DB into the named volume");
    sh("docker compose stop web");
    const volume = sh("docker volume ls -q")
      .split("\n")
      .find((v) => v.includes("privacytracker-data"));
    if (!volume) {
      throw new Error("could not find privacytracker-data volume");
    }
    sh(
      `docker run --rm -v ${volume}:/data -v ${dataDir}:/seed alpine sh -c ` +
        `"rm -f /data/privacy.db /data/privacy.db-wal /data/privacy.db-shm && ` +
        `cp /seed/privacy.db /data/privacy.db && chown -R 100:101 /data"`
    );
    sh("docker compose start web");
    entry.bootMs = await waitReady();
    if (entry.bootMs === null) {
      throw new Error("web never became ready after DB injection");
    }

    for (const p of ["/dashboard", "/dashboard/apps", "/api/apps"]) {
      await fetch(BASE + p, { signal: AbortSignal.timeout(180_000) }).catch(
        () => {}
      );
    }
    entry.statsAfterWarmup = dockerStats();

    log("endpoint sweep");
    entry.phases.endpoints = await runJson("node", [
      "scripts/stress/loadtest.mjs",
      "--mode",
      "endpoints",
      "--base",
      BASE,
      "--apps",
      String(scale.apps),
      "--duration",
      String(SWEEP_S),
      "--concurrency",
      String(SWEEP_CONC),
      "--timeout",
      "120000",
    ]);
    entry.statsAfterSweep = dockerStats();

    entry.phases.viewers = {};
    for (const v of VIEWER_LEVELS) {
      log(`viewer load: ${v} sessions`);
      await sleep(2000);
      entry.phases.viewers[v] = await runJson("node", [
        "scripts/stress/loadtest.mjs",
        "--mode",
        "viewers",
        "--base",
        BASE,
        "--apps",
        String(scale.apps),
        "--viewers",
        String(v),
        "--duration",
        String(VIEWER_S),
      ]);
      entry[`statsAfterViewers${v}`] = dockerStats();
    }
  } catch (err) {
    entry.errors.push(String(err));
  } finally {
    try {
      sh("docker compose down -v", { stdio: ["ignore", "inherit", "inherit"] });
    } catch {
      // best effort
    }
  }
  results.scales.push(entry);
  flush();
  log(`scale ${scale.label} done (${entry.errors.length} errors)`);
}

results.finishedAt = new Date().toISOString();
flush();
log(`docker phase complete → ${resultsFile}`);
console.log(resultsFile);
