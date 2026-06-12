/**
 * Dependency-free load generator for stress testing the local server.
 *
 * Modes:
 *   endpoints — sweep each hot endpoint with C concurrent closed-loop
 *               workers for D seconds; report latency percentiles + bytes.
 *   viewers   — simulate V concurrent browsing sessions ("devices"), each
 *               reproducing the real client polling cadences (tasks/active
 *               4s, notifications 30s, sync/status 60s) plus a page
 *               navigation every 12s; a low-rate probe measures interactive
 *               latency under that load.
 *   probe     — probe loop only (used alongside the contention writer).
 *
 * Usage:
 *   node scripts/stress/loadtest.mjs --mode endpoints --base http://127.0.0.1:3001 \
 *     --apps 1000 [--duration 10] [--concurrency 4]
 *   node scripts/stress/loadtest.mjs --mode viewers --apps 1000 --viewers 10 --duration 45
 *
 * Prints one JSON object on stdout.
 */

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] !== undefined) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const BASE = arg("base", "http://127.0.0.1:3001");
const MODE = arg("mode", "endpoints");
const APPS = Number.parseInt(arg("apps", "100"), 10);
const DURATION_S = Number.parseFloat(arg("duration", "10"));
const CONCURRENCY = Number.parseInt(arg("concurrency", "4"), 10);
const VIEWERS = Number.parseInt(arg("viewers", "1"), 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(arg("timeout", "60000"), 10);

const appId = (i) => String(1_000_000_000 + (i % APPS));

const ENDPOINTS = [
  { key: "page:dashboard", path: () => "/dashboard" },
  { key: "page:apps-grid", path: () => "/dashboard/apps" },
  { key: "page:app-detail", path: (i) => `/apps/${appId(i * 37)}` },
  { key: "page:changelog", path: () => "/changelog" },
  { key: "page:stats", path: () => "/dashboard/stats" },
  { key: "api:apps", path: () => "/api/apps" },
  {
    // The paginated form the grid actually requests since the
    // pagination work — one 500-row chunk + grid side-band maps,
    // rotating through the fleet's offsets.
    key: "api:apps-page",
    path: (i) => {
      const pages = Math.max(1, Math.ceil(APPS / 500));
      return `/api/apps?limit=500&offset=${(i % pages) * 500}&meta=grid`;
    },
  },
  { key: "api:changelog", path: () => "/api/changelog?limit=50" },
  { key: "api:notifications", path: () => "/api/notifications" },
  { key: "api:tasks-active", path: () => "/api/tasks/active" },
  { key: "api:activity", path: () => "/api/activity" },
  { key: "api:stats-timeline", path: () => "/api/stats/timeline" },
  {
    key: "api:history-stats",
    path: (i) =>
      `/apps/${appId(i * 13)}/history-stats`.replace("/apps/", "/api/apps/"),
  },
];

// The fast subset used as the latency probe while other load runs.
const PROBE_KEYS = [
  "page:dashboard",
  "api:apps",
  "api:notifications",
  "api:tasks-active",
];

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, idx)];
}

function summarize(samples) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
  const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
  return {
    requests: samples.length,
    errors: samples.length - ok.length,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    max: lat.length ? lat[lat.length - 1] : null,
    meanBytes: ok.length
      ? Math.round(ok.reduce((a, s) => a + s.bytes, 0) / ok.length)
      : null,
  };
}

async function timedFetch(path) {
  const startedAt = performance.now();
  try {
    const res = await fetch(BASE + path, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "text/html,application/json" },
    });
    const body = await res.arrayBuffer();
    return {
      ms: performance.now() - startedAt,
      status: res.status,
      bytes: body.byteLength,
    };
  } catch {
    return { ms: performance.now() - startedAt, status: 0, bytes: 0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sweepEndpoint(ep) {
  const samples = [];
  const deadline = performance.now() + DURATION_S * 1000;
  let iter = 0;
  const worker = async () => {
    while (performance.now() < deadline) {
      const i = iter++;
      samples.push(await timedFetch(ep.path(i)));
    }
  };
  // Closed loop: at least one request per worker even if it overruns.
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return summarize(samples);
}

async function runEndpoints() {
  const out = {};
  for (const ep of ENDPOINTS) {
    out[ep.key] = await sweepEndpoint(ep);
  }
  return {
    mode: "endpoints",
    concurrency: CONCURRENCY,
    durationS: DURATION_S,
    endpoints: out,
  };
}

async function runViewers({ probeOnly = false } = {}) {
  const stop = { now: false };
  // Stop-aware sleep: long poll intervals (30/60s) must not pin the phase
  // open past the deadline — check the stop flag every 250ms.
  const napUnlessStopped = async (ms) => {
    const deadline = performance.now() + ms;
    while (!stop.now && performance.now() < deadline) {
      await sleep(Math.min(250, deadline - performance.now()));
    }
  };
  const viewerSamples = new Map(); // label -> samples[]
  const record = (label, sample) => {
    if (!viewerSamples.has(label)) {
      viewerSamples.set(label, []);
    }
    viewerSamples.get(label).push(sample);
  };

  const PAGES = [
    ["page:dashboard", () => "/dashboard"],
    ["page:apps-grid", () => "/dashboard/apps"],
    ["page:app-detail", (n) => `/apps/${appId(n * 7)}`],
    ["page:changelog", () => "/changelog"],
  ];

  async function viewer(v) {
    // Stagger viewer start so polls don't align artificially.
    await sleep((v * 1300) % 4000);
    let navCount = v;
    const loops = [
      // TaskCenter: /api/tasks/active every 4s + /api/sync/status every 60s
      (async () => {
        while (!stop.now) {
          record("api:tasks-active", await timedFetch("/api/tasks/active"));
          await napUnlessStopped(4000);
        }
      })(),
      (async () => {
        while (!stop.now) {
          record("api:sync-status", await timedFetch("/api/sync/status"));
          await napUnlessStopped(60_000);
        }
      })(),
      // NotificationBell: 30s
      (async () => {
        while (!stop.now) {
          record("api:notifications", await timedFetch("/api/notifications"));
          await napUnlessStopped(30_000);
        }
      })(),
      // Page navigation every ~12s, rotating through the main surfaces.
      (async () => {
        while (!stop.now) {
          const [label, pathFn] = PAGES[navCount % PAGES.length];
          navCount++;
          record(label, await timedFetch(pathFn(navCount)));
          await napUnlessStopped(12_000);
        }
      })(),
    ];
    await Promise.all(loops);
  }

  const probeSamples = new Map();
  async function probe() {
    let i = 0;
    while (!stop.now) {
      const key = PROBE_KEYS[i % PROBE_KEYS.length];
      const ep = ENDPOINTS.find((e) => e.key === key);
      const sample = await timedFetch(ep.path(i));
      if (!probeSamples.has(key)) {
        probeSamples.set(key, []);
      }
      probeSamples.get(key).push(sample);
      i++;
      await napUnlessStopped(800);
    }
  }

  const tasks = [probe()];
  if (!probeOnly) {
    for (let v = 0; v < VIEWERS; v++) {
      tasks.push(viewer(v));
    }
  }
  const stopper = (async () => {
    await sleep(DURATION_S * 1000);
    stop.now = true;
  })();
  await Promise.all([...tasks, stopper]);

  const viewerOut = {};
  for (const [label, samples] of viewerSamples) {
    viewerOut[label] = summarize(samples);
  }
  const probeOut = {};
  for (const [label, samples] of probeSamples) {
    probeOut[label] = summarize(samples);
  }
  return {
    mode: probeOnly ? "probe" : "viewers",
    viewers: probeOnly ? 0 : VIEWERS,
    durationS: DURATION_S,
    viewerTraffic: viewerOut,
    probe: probeOut,
  };
}

let result;
if (MODE === "endpoints") {
  result = await runEndpoints();
} else if (MODE === "viewers") {
  result = await runViewers();
} else if (MODE === "probe") {
  result = await runViewers({ probeOnly: true });
} else {
  console.error(`Unknown mode ${MODE}`);
  process.exit(1);
}
console.log(JSON.stringify(result));
