/**
 * Stress-test matrix orchestrator.
 *
 * For each scale level: seeds an isolated DB, boots a production server
 * (separate dist dir + data dir, port 3001), sweeps every hot endpoint,
 * simulates concurrent viewer sessions, runs a sync-write contention pass,
 * captures memory / DB / event-loop diagnostics, then tears down.
 *
 * Usage:
 *   node scripts/stress/run-matrix.mjs                 # full matrix
 *   node scripts/stress/run-matrix.mjs --quick         # 1 small scale, short phases
 *   node scripts/stress/run-matrix.mjs --scales 1000:22,5000:22
 *
 * Results stream to scripts/stress/results/matrix-<ts>.json after each scale.
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = 3001;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "stress-test-token";
const STRESS_TMP = "/tmp/pt-stress";
const RESULTS_DIR = path.join(ROOT, "scripts/stress/results");

const QUICK = process.argv.includes("--quick");
const scalesArg = (() => {
  const idx = process.argv.indexOf("--scales");
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const DEFAULT_SCALES = "50:22,250:22,1000:22,2500:22,5000:22,10000:22,1000:120";
const SCALES = (scalesArg ?? (QUICK ? "50:5" : DEFAULT_SCALES))
  .split(",")
  .map((s) => {
    const [apps, snapshots] = s.split(":").map((n) => Number.parseInt(n, 10));
    return {
      apps,
      snapshots,
      label: `${apps}${snapshots > 30 ? "-deep" : ""}`,
    };
  });

const SWEEP_S = QUICK ? 3 : 10;
const SWEEP_CONC = QUICK ? 2 : 4;
const VIEWER_LEVELS = QUICK ? [2] : [1, 3, 10];
const VIEWER_S = QUICK ? 10 : 45;
const CONTENTION_S = QUICK ? 8 : 30;
const CONTENTION_RATE = 5;

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const resultsFile = path.join(RESULTS_DIR, `matrix-${Date.now()}.json`);
const results = {
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    cpus: execSync("sysctl -n machdep.cpu.brand_string").toString().trim(),
    cores: Number.parseInt(execSync("sysctl -n hw.ncpu").toString(), 10),
    memBytes: Number.parseInt(execSync("sysctl -n hw.memsize").toString(), 10),
    node: process.version,
  },
  quick: QUICK,
  scales: [],
};
const flush = () =>
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) =>
  console.error(`[matrix ${new Date().toISOString()}] ${msg}`);

function rssTreeMb(rootPid) {
  try {
    const lines = execSync("ps -axo pid=,ppid=,rss=")
      .toString()
      .trim()
      .split("\n");
    const children = new Map();
    const rss = new Map();
    for (const line of lines) {
      const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
      rss.set(pid, kb);
      if (!children.has(ppid)) {
        children.set(ppid, []);
      }
      children.get(ppid).push(pid);
    }
    let total = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop();
      total += rss.get(pid) ?? 0;
      for (const c of children.get(pid) ?? []) {
        stack.push(c);
      }
    }
    return Math.round((total / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

function runJson(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, ...opts });
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
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited ${code}: ${stderr.slice(-2000)}`
          )
        );
        return;
      }
      const lines = stdout.trim().split("\n");
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        reject(new Error(`Bad JSON from ${cmd}: ${stdout.slice(-500)}`));
      }
    });
  });
}

async function fetchJson(pathname, init = {}) {
  try {
    const res = await fetch(BASE + pathname, {
      signal: AbortSignal.timeout(30_000),
      ...init,
      headers: {
        "x-auditor-admin-token": TOKEN,
        origin: BASE,
        ...init.headers,
      },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

async function waitReady(timeoutMs = 120_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) {
        return performance.now() - t0;
      }
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return null;
}

async function runScale(scale) {
  const entry = { ...scale, phases: {}, errors: [] };
  const dataDir = path.join(STRESS_TMP, scale.label);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const serverLog = fs.openSync(
    path.join(RESULTS_DIR, `server-${scale.label}.log`),
    "w"
  );

  log(
    `=== scale ${scale.label}: seeding ${scale.apps} apps × ${scale.snapshots} snapshots`
  );
  try {
    entry.seed = await runJson("node_modules/.bin/tsx", [
      "scripts/stress/seed.mts",
      "--data-dir",
      dataDir,
      "--apps",
      String(scale.apps),
      "--snapshots",
      String(scale.snapshots),
    ]);
    log(
      `seeded in ${entry.seed.seedMs}ms, db ${(entry.seed.dbBytes / 1e6).toFixed(1)}MB`
    );
  } catch (err) {
    entry.errors.push(`seed: ${err.message}`);
    return entry;
  }

  log("booting server");
  // Next renames its process, so a stale server from an interrupted run
  // survives pkill-by-name — evict whatever holds the port first.
  try {
    execSync(`lsof -nP -tiTCP:${PORT} -sTCP:LISTEN | xargs kill -9`, {
      stdio: "ignore",
    });
    await sleep(500);
  } catch {
    // nothing on the port
  }
  const server = spawn(
    "node_modules/.bin/next",
    ["start", "-p", String(PORT)],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", serverLog, serverLog],
      env: {
        ...process.env,
        NODE_ENV: "production",
        PRIVACYTRACKER_DATA_DIR: dataDir,
        NEXT_DIST_DIR: ".next-stress",
        AUDITOR_ADMIN_TOKEN: TOKEN,
      },
    }
  );
  let rssMax = 0;
  const rssTimer = setInterval(() => {
    const mb = rssTreeMb(server.pid);
    if (mb && mb > rssMax) {
      rssMax = mb;
    }
  }, 2000);

  const teardown = async () => {
    clearInterval(rssTimer);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await sleep(1500);
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // clean exit
    }
    fs.closeSync(serverLog);
  };

  try {
    const bootMs = await waitReady();
    if (bootMs === null) {
      entry.errors.push("server never became ready within 120s");
      await teardown();
      return entry;
    }
    entry.bootMs = Math.round(bootMs);

    // Warmup: touch the main surfaces once so first-hit compilation/caches
    // don't pollute the measured phases.
    for (const p of [
      "/dashboard",
      "/dashboard/apps",
      "/api/apps",
      "/changelog",
    ]) {
      await fetch(BASE + p, { signal: AbortSignal.timeout(180_000) }).catch(
        () => {}
      );
    }
    await sleep(1000);
    entry.rssAfterWarmupMb = rssTreeMb(server.pid);
    log(`ready in ${entry.bootMs}ms, warm RSS ${entry.rssAfterWarmupMb}MB`);

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

    entry.phases.viewers = {};
    for (const v of VIEWER_LEVELS) {
      log(`viewer load: ${v} concurrent session(s)`);
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
    }

    log("sync-write contention");
    await sleep(2000);
    const [contention, probeUnderWrites] = await Promise.all([
      runJson("node_modules/.bin/tsx", [
        "scripts/stress/contention.mts",
        "--data-dir",
        dataDir,
        "--apps",
        String(scale.apps),
        "--rate",
        String(CONTENTION_RATE),
        "--duration",
        String(CONTENTION_S),
      ]),
      runJson("node", [
        "scripts/stress/loadtest.mjs",
        "--mode",
        "probe",
        "--base",
        BASE,
        "--apps",
        String(scale.apps),
        "--duration",
        String(CONTENTION_S),
      ]),
    ]);
    entry.phases.contention = {
      writer: contention,
      probe: probeUnderWrites.probe,
    };

    log("collecting diagnostics");
    entry.dbDiagnostics = (await fetchJson("/api/diagnostics/database")).body;
    entry.healthCheck = (
      await fetchJson("/api/diagnostics/health", { method: "POST" })
    ).body;
    entry.rssMaxMb = rssMax;
    entry.rssFinalMb = rssTreeMb(server.pid);
  } catch (err) {
    entry.errors.push(String(err));
  } finally {
    await teardown();
  }
  return entry;
}

for (const scale of SCALES) {
  const entry = await runScale(scale);
  results.scales.push(entry);
  flush();
  log(`scale ${scale.label} done (${entry.errors.length} errors)`);
}

results.finishedAt = new Date().toISOString();
flush();
log(`all scales complete → ${resultsFile}`);
console.log(resultsFile);
