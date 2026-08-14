#!/usr/bin/env node
/**
 * Backend benchmark harness — the performance half of the Rust-core
 * comparison gates (see core/README.md on the rust-core branch). Run it
 * with identical flags against the Node build and the Rust build and
 * compare the reports.
 *
 * Spawn mode (measures cold start, owns the process tree):
 *
 *   node scripts/bench/bench.mjs \
 *     --label node-main \
 *     --spawn "PRIVACYTRACKER_DATA_DIR=$PWD/.bench-data ./node_modules/.bin/next start -H 127.0.0.1 -p 3101" \
 *     --url http://127.0.0.1:3101 --json bench-node.json
 *
 * Attach mode (server already running; cold start not measured):
 *
 *   node scripts/bench/bench.mjs --url http://127.0.0.1:3001 --pid 12345
 *
 * Metrics:
 *   cold_start_ms   spawn → first `GET /api/ready` 200 (spawn mode only)
 *   idle_rss_kb     process-tree RSS after ready + 5 s settle
 *   loaded_rss_kb   process-tree RSS after the latency mix completes
 *   latency         p50/p95/p99 per route (sequential rounds), plus a
 *                   concurrent burst per route
 *
 * The route mix covers the hot read paths (bare + paginated apps,
 * activity, flags, a stats aggregate) and two HTML pages (dashboard +
 * one app detail) so server-rendering cost is visible on the Node side
 * and static-serving cost on the Rust side.
 *
 * Seeds the canned sample data first (unless --skip-seed) so both
 * backends serve identical content. Results go to stdout as a markdown
 * table and optionally to --json for later comparison; reports are
 * never committed to the repo.
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    spawn: { type: "string" },
    pid: { type: "string" },
    label: { type: "string", default: "backend" },
    json: { type: "string" },
    rounds: { type: "string", default: "50" },
    concurrency: { type: "string", default: "10" },
    "skip-seed": { type: "boolean", default: false },
    token: { type: "string" },
  },
});

if (!args.url) {
  console.error(
    "usage: bench.mjs --url <base> [--spawn <cmd>] [--pid <pid>] [--label <name>] [--json <out>]"
  );
  process.exit(2);
}

const BASE = args.url;
const ROUNDS = Number(args.rounds);
const CONC = Number(args.concurrency);
const TOKEN =
  args.token ??
  process.env.AUDITOR_ADMIN_TOKEN ??
  "privacytracker-playwright-token";
const HEADERS = {
  origin: BASE,
  "x-auditor-admin-token": TOKEN,
  "content-type": "application/json",
};

/** Sum RSS (kB) over a pid and all descendants. macOS + Linux. */
function rssTreeKb(rootPid) {
  const pids = [rootPid];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.pop();
    let out = "";
    try {
      out = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    } catch {
      // no children
    }
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (pid) {
        pids.push(pid);
        queue.push(pid);
      }
    }
  }
  let total = 0;
  for (const pid of pids) {
    try {
      total += Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim()
      );
    } catch {
      // process exited between discovery and measurement
    }
  }
  return total;
}

async function waitReady(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/ready`);
      if (res.status === 200) {
        return Date.now() - start;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never became ready");
}

async function seed() {
  const steps = [
    ["POST", "/api/reset"],
    [
      "POST",
      "/api/focus",
      {
        audience: "self",
        monitor: true,
        cleanup: false,
        minimal: false,
        accessibility: true,
      },
    ],
    ["POST", "/api/dev/seed-sample-data?source=canned"],
  ];
  for (const [method, path, body] of steps) {
    const res = await fetch(BASE + path, {
      method,
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 400) {
      throw new Error(`seed ${method} ${path} -> ${res.status}`);
    }
  }
}

async function instagramId() {
  const res = await fetch(`${BASE}/api/apps`, { headers: HEADERS });
  const apps = await res.json();
  return String((apps.find((a) => a.name === "Instagram") ?? apps[0]).id);
}

function percentile(sorted, p) {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, idx)];
}

async function timeOne(path) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { headers: HEADERS });
  await res.arrayBuffer();
  const ms = performance.now() - t0;
  if (res.status !== 200) {
    throw new Error(`${path} -> ${res.status}`);
  }
  return ms;
}

async function benchRoute(path) {
  for (let i = 0; i < 3; i++) {
    await timeOne(path); // warmup
  }
  const seq = [];
  for (let i = 0; i < ROUNDS; i++) {
    seq.push(await timeOne(path));
  }
  seq.sort((x, y) => x - y);
  const burstT0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, () => timeOne(path)));
  const burstMs = performance.now() - burstT0;
  return {
    p50: percentile(seq, 50),
    p95: percentile(seq, 95),
    p99: percentile(seq, 99),
    burst_total_ms: burstMs,
  };
}

const main = async () => {
  const report = {
    label: args.label,
    url: BASE,
    rounds: ROUNDS,
    concurrency: CONC,
    cold_start_ms: null,
    idle_rss_kb: null,
    loaded_rss_kb: null,
    routes: {},
  };

  let child = null;
  let pid = args.pid ? Number(args.pid) : null;
  if (args.spawn) {
    child = spawn("sh", ["-c", args.spawn], {
      stdio: "ignore",
      detached: false,
    });
    pid = child.pid;
    report.cold_start_ms = await waitReady();
  } else {
    await waitReady(10_000);
  }

  if (!args["skip-seed"]) {
    await seed();
  }
  const app = await instagramId();

  if (pid) {
    await new Promise((r) => setTimeout(r, 5000));
    report.idle_rss_kb = rssTreeKb(pid);
  }

  const MIX = [
    ["ready", "/api/ready"],
    ["apps bare", "/api/apps"],
    ["apps paginated+meta", "/api/apps?limit=250&offset=0&meta=grid"],
    ["activity", "/api/activity"],
    ["feature flags", "/api/feature-flags"],
    ["stats timeline", "/api/stats/timeline"],
    ["html dashboard", "/dashboard"],
    ["html app detail", `/apps/${app}`],
  ];
  for (const [name, path] of MIX) {
    report.routes[name] = await benchRoute(path);
    process.stderr.write(`  benched ${name}\n`);
  }

  if (pid) {
    report.loaded_rss_kb = rssTreeKb(pid);
  }
  if (child) {
    child.kill("SIGTERM");
  }

  const fmt = (v) =>
    v == null ? "—" : typeof v === "number" ? v.toFixed(1) : v;
  console.log(`\n## bench: ${report.label} (${BASE})\n`);
  console.log(
    `cold start: ${fmt(report.cold_start_ms)} ms · idle RSS: ${report.idle_rss_kb ?? "—"} kB · loaded RSS: ${report.loaded_rss_kb ?? "—"} kB\n`
  );
  console.log("| route | p50 ms | p95 ms | p99 ms | burst(" + CONC + ") ms |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const [name, r] of Object.entries(report.routes)) {
    console.log(
      `| ${name} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.burst_total_ms)} |`
    );
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
};

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
