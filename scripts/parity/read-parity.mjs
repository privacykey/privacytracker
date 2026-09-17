#!/usr/bin/env node
/**
 * Node-vs-Rust read parity — the Phase 2 gate.
 *
 * Drives the existing dual-live differ (`parity-diff.mjs`) with the Rust core
 * as side B, proving its read responses are byte-identical to the Node
 * server's.
 *
 * The one wrinkle, and why this wrapper exists: `parity-diff.mjs` seeds BOTH
 * sides by POSTing (`/api/reset`, `/api/focus`, `PUT /api/privacy-profile`,
 * `POST /api/dev/seed-sample-data`). The Rust server is read-only until the
 * write batches land, so it cannot be seeded that way. Instead:
 *
 *   1. seed the NODE side normally (it owns the writes),
 *   2. checkpoint its WAL and COPY the whole data dir to a second location,
 *   3. start the Rust server on the copy,
 *   4. run the differ with --skip-seed and --only <batch-1 routes>.
 *
 * The copy — rather than pointing both processes at one file — is deliberate:
 * Node runs background schedulers that would mutate the database underneath
 * the Rust reader mid-run and produce diffs that are races, not bugs. It is
 * scaffolding: it disappears once the write routes land and the differ can
 * seed both sides itself.
 *
 *   node scripts/parity/read-parity.mjs --node http://127.0.0.1:3001 \
 *        --node-data <dir> [--only <regex>]
 *
 * Exit 0 = identical; 1 = a difference; 2 = harness error.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import BetterSqlite3 from "better-sqlite3";
import { applyContentFixture } from "./content-fixture.mjs";
import { probeContentReads } from "./content-probes.mjs";
import { applyDevicesFixture, probeDeviceReads } from "./devices-fixture.mjs";
import {
  validateErrorLog,
  validateRuntimeDiagnostics,
} from "./diagnostics-envelope.mjs";
import { applyDiscoveryFixture } from "./discovery-fixture.mjs";
import { probeDiscoveryReads } from "./discovery-probes.mjs";
import { QUARANTINE, READS, VOLATILE_READS } from "./manifest.mjs";
import {
  applyOperationsFixture,
  primeOperationsAfterBoot,
} from "./operations-fixture.mjs";
import { probeOperationsReads } from "./operations-probes.mjs";
import {
  applySinceInstallFixture,
  BRIDGED_IDS,
  COLLATION_FIXTURE,
  DISK_FIXTURE,
  FLAG_OVERRIDE_FIXTURE,
  INSTAGRAM_ID,
  SETTINGS_FIXTURE,
  FIXTURES as SINCE_INSTALL_FIXTURES,
  MISSING_ID as SINCE_INSTALL_MISSING_ID,
  TIMELINE_ID,
  TREND_ID,
} from "./since-install-fixture.mjs";
import { applyStatsFixture, probeStatsReads } from "./stats-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const { values: args } = parseArgs({
  options: {
    node: { type: "string" },
    "node-data": { type: "string" },
    "pt-core": { type: "string" },
    only: { type: "string" },
    token: { type: "string" },
    keep: { type: "boolean", default: false },
    // Phase 4: also replay the manifest's mutations for the write routes
    // the Rust core implements. Opt-in because it mutates BOTH databases.
    mutate: { type: "boolean", default: false },
  },
});

if (!(args.node && args["node-data"])) {
  console.error(
    "usage: read-parity.mjs --node <baseUrl> --node-data <dataDir> [--only <regex>] [--pt-core <bin>] [--mutate]"
  );
  process.exit(2);
}

// The routes the Rust core implements today. Kept here rather than inferred
// so an unimplemented route can never silently drop out of the comparison —
// adding a route to the server means adding it here in the same commit.
const BATCH_1 = [
  "/api/device-scope",
  "/api/compare",
  "/api/related-apps",
  "/api/tasks/active",
  "/api/wayback/import-all",
  "/api/policy/sync-all",
  "/api/backup/snapshots",
  "/api/rate-limit/status",
  "/api/ai/debug-log",
  "/api/csp-report",
  "/api/export",
  "/api/manual-apps/[id]",
  "/api/devices",
  "/api/devices/[id]",
  "/api/devices/[id]/bundles",
  "/api/devices/[id]/tracked-apps",
  "/api/devices/for-app/[appId]",
  "/api/activity",
  "/api/notifications",
  "/api/notification-prefs",
  "/api/user-tasks",
  "/api/annotations",
  "/api/shortlist",
  "/api/shortlist/export",

  // Database-backed fleet analysis.
  "/api/stats",
  "/api/stats/matrix",
  "/api/stats/radar",
  "/api/stats/timeline",
  "/api/triage",
  "/api/review-queue",
  "/api/age-rating/summary",
  "/api/privacy-profile/mismatches",
  "/api/changelog",

  "/api/health",
  "/api/auth/admin-token/status",
  "/api/locale",
  "/api/date-format",
  "/api/preferences",
  "/api/coachmark-state",
  "/api/dev-menu-state",
  "/api/privacy-profile",
  "/api/accessibility-profile",
  // batch 2
  "/api/focus",
  "/api/imports",
  // batch 3
  "/api/sync/status",
  "/api/verdicts",
  "/api/imports/queue",
  // unblocked by the inbound rate-limiter port
  "/api/manual-apps",
  "/api/import/audit-bundle/recent",
  // The first per-app route. On the CANNED data this is the boring case —
  // every seeded app diffs to nothing — so it is also covered by the fixture
  // probe below and by core/tests/diff_cases.rs.
  "/api/apps/[id]/since-install",
  // Quarterly aggregates. Unlike since-install, the canned seed DOES give
  // this one real data — its history steps differ, so the stored
  // changes_summary blobs carry entries and the totals are non-zero.
  "/api/apps/[id]/history-stats",
  // The per-app timeline. Its kernel is what /api/apps?id=X&changelog=true
  // and /api/apps/[id]/detail will both be assembled from.
  "/api/apps/[id]/changelog",
  // Five responses behind one path. The manifest covers the bare array and
  // the paginated+meta form; the other three GET shapes and both error
  // branches were ungated until the entries added alongside this route.
  "/api/apps",
  // The detail aggregate: its reads are the ones above plus three new
  // ones. The canned seed leaves importProvenance, a11yProfile and
  // childAgeBand null; the fixture and probe cover those.
  "/api/apps/[id]/detail",
  // The settings-backed reads. On the canned seed every secret is unset,
  // every desktop row empty, the layout untouched and no override stored,
  // so the fixture writes real state for all four and probeSettingsReads
  // refuses a run where it did not land. The resolver behind
  // /api/feature-flags is additionally pinned across 39 contexts by
  // core/tests/settings_cases.rs, since one database holds one.
  "/api/settings",
  "/api/settings/desktop",
  "/api/dashboard/layout",
  "/api/feature-flags",
  // The deployment-facing reads: the database file, its directory, the env
  // and the request's forwarded headers. /api/ready and the deployment
  // diagnostics are compared byte for byte (paths and durations masked by
  // normalize()); the three /api/diagnostics/* shape-first, since page and
  // file counts differ between a live database and a checkpointed copy.
  // probeDiagnosticsReads below holds the stable parts to equality.
  "/api/ready",
  "/api/deployment/diagnostics",
  "/api/diagnostics/database",
  "/api/diagnostics/disk",
  "/api/diagnostics/health",
  // The process-introspection reads. Not comparable across backends by
  // design (a V8 heap is not a Rust allocator), so the manifest validates
  // each side against the envelope contract and skips the cross-compare;
  // probeRuntimeEnvelope below holds the Rust body to what it must
  // contain and compares the parts that ARE the same database.
  "/api/diagnostics/runtime",
  "/api/desktop/diagnostics",
  "/api/diagnostics/errors",
];

/**
 * Escape a route for use inside the `--only` regex.
 *
 * Escaping only `/` was enough until the first route with a dynamic
 * segment. `/api/apps/[id]/since-install` contains `[id]`, which a regex
 * reads as a CHARACTER CLASS — so the pattern matched
 * `/api/apps/i/since-install` and never the literal route, the manifest
 * entry silently dropped out of the run, and the gate reported PARITY OK
 * having never compared it.
 */
// The write routes the Rust core implements (Phase 4, batch 1). The
// `--mutate` pass selects the manifest's mutations for exactly these, so a
// mutation on a route whose write is still Node-only cannot fail the run
// on a 405 — and, like BATCH_1, a route is added here in the commit that
// implements it, never inferred.
const WRITE_ROUTES = [
  "/api/date-format",
  "/api/locale",
  "/api/preferences",
  "/api/settings",
  "/api/settings/desktop",
  "/api/notification-prefs",
  "/api/focus",
  "/api/accessibility-profile",
  "/api/privacy-profile",
  "/api/feature-flags/overrides",
  "/api/feature-flags/overrides/[key]",
  "/api/dashboard/layout",
  "/api/dashboard/layout/preset",
  "/api/coachmark-state",
  "/api/dev-menu-state",
  "/api/welcomed-at",
  "/api/migration-flow/consume",
  // Phase 4, batch 2: the library writers.
  "/api/shortlist",
  "/api/verdicts",
  "/api/verdicts/bulk",
  "/api/notifications",
  "/api/annotations",
  "/api/annotations/[id]",
  "/api/apps/[id]/acknowledge",
  "/api/apps/[id]/acknowledge/undo",
  "/api/user-tasks",
  "/api/user-tasks/visit",
  "/api/activity/queue-session",
  "/api/devices",
  "/api/devices/[id]",
  "/api/device-scope",
  "/api/manual-apps",
  "/api/manual-apps/[id]",
  "/api/manual-apps/bulk",
  "/api/manual-apps/[id]/restore",
  // Phase 4, batch 3: the import pipeline's local half. The routes that
  // reach Apple or archive.org stay quarantined and are gated by the
  // oracle alone.
  "/api/imports",
  "/api/imports/items",
  "/api/imports/items/update",
  "/api/imports/queue",
  "/api/imports/complete",
  // Phase 4, batch 4a: the sync runner's stop and the cooldown clear. The
  // trigger re-scrapes the fleet and stays quarantined; the app delete is
  // a teardown entry, gated by the oracle alone.
  "/api/dev/sync-stop",
  "/api/rate-limit/status",
  // Phase 4, batch 5a: the maintenance writes. The wipe, the start-over
  // and the reset are teardown entries, gated by the oracle alone.
  "/api/dev/seed-notification",
  "/api/csp-report",
  "/api/diagnostics/health",
  "/api/diagnostics/database",
  "/api/diagnostics/runtime",
  "/api/diagnostics/errors",
  "/api/ai/debug-log",
  "/api/auth/admin-token/login",
  "/api/auth/admin-token/logout",
  "/api/dev/reset-changelog",
];

const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const onlyRe = args.only ?? `^(${BATCH_1.map(escapeForRegex).join("|")})$`;

const ptCore =
  args["pt-core"] ?? path.join(repo, "core", "target", "debug", "pt-core");
const TOKEN =
  args.token ??
  process.env.AUDITOR_ADMIN_TOKEN ??
  "privacytracker-playwright-token";

const work = mkdtempSync(path.join(tmpdir(), "pt-read-parity-"));
let rust = null;

function cleanup() {
  if (rust && !rust.killed) {
    rust.kill("SIGTERM");
  }
  if (!args.keep) {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The core's import-queue drain fires 20 s after boot and stamps
 * `import_queue_last_run`, and its health check fires at 60 s and stamps
 * `health_check_last_run_at`; once both exist every boot-time healer has
 * had its turn — the same 65 s the Node side is given. Bounded so a core
 * without the tickers still gates.
 */
async function waitForRustBootTimers(dataDir, bootAt) {
  const deadline = Date.now() + 90_000;
  const stamps = ["import_queue_last_run", "health_check_last_run_at"];
  for (;;) {
    const db = new BetterSqlite3(path.join(dataDir, "privacy.db"), {
      readonly: true,
    });
    let pending = [];
    try {
      // The copy carries Node's own stamps; only one newer than the
      // core's boot is the core's.
      pending = stamps.filter((key) => {
        const stampedAt = Number.parseInt(
          db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)
            ?.value ?? "0",
          10
        );
        return stampedAt < bootAt;
      });
    } finally {
      db.close();
    }
    if (pending.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      console.log(
        `  the core never stamped ${pending.join(", ")}; continuing without the boot-timer wait`
      );
      return;
    }
    console.log(
      "  waiting for the core's boot timers before seeding unfinished jobs…"
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

/** Settle the Node side's WAL so the copy is a complete database. */
function checkpoint(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"));
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Refuse to run when copying the database would make the Rust core WRITE to
 * it, producing rows the Node side never had.
 *
 * `lib/db.ts` backfills a placeholder "Unknown device" and links every app
 * to it when the database holds apps but no devices. `core/src/db.rs` ports
 * that faithfully — so the migration the Rust server runs on OPEN is not
 * read-only, and which side ran it first decides what both sides see.
 *
 * The failure mode is silent and timing-dependent. The Node server runs its
 * backfill when it OPENS the database, so:
 *
 *   - boot Node on an empty dir, then seed → apps exist, devices do not;
 *   - read-parity copies that state;
 *   - the Rust server opens the copy, its backfill fires, and it now has a
 *     device and one link per app that Node does not;
 *   - any route reading `app_devices` — `/api/apps?meta=grid` is the first —
 *     reports a difference that is an artefact of boot order, not a bug in
 *     the port.
 *
 * Restarting Node at any point after seeding hides it again, which is
 * exactly what makes it worth asserting rather than remembering. Measured:
 * opening a 22-app copy with 0 devices produced 1 device and 22 links.
 */
function assertBackfillWontFire(dataDir) {
  const db = new BetterSqlite3(path.join(dataDir, "privacy.db"), {
    readonly: true,
  });
  let apps = 0;
  let devices = 0;
  try {
    apps = db.prepare("SELECT COUNT(*) AS n FROM apps").get().n;
    devices = db.prepare("SELECT COUNT(*) AS n FROM devices").get().n;
  } finally {
    db.close();
  }
  if (apps > 0 && devices === 0) {
    throw new Error(
      `the Node database has ${apps} apps and no devices, so the Rust core's ` +
        "unknown-device backfill would fire on the copy and invent rows Node " +
        "does not have.\n" +
        "  The Node server has not opened this database since it was seeded. " +
        "Restart it (its own backfill then runs, and both sides agree) and " +
        "re-run.\n" +
        "  See core/README.md → 'the migration is not read-only'."
    );
  }
  return { apps, devices };
}

/** Start pt-core and resolve with its base URL once it reports listening. */
function startRust(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(ptCore, ["serve"], {
      env: {
        ...process.env,
        AUDITOR_ADMIN_TOKEN: TOKEN,
        // The Rust core resolves its data directory exactly as lib/db.ts
        // does, so the copy is handed over the way the Tauri shell hands
        // Node its directory: through the environment. `next start` sets
        // NODE_ENV=production inside its own process; declare the same so
        // `app.nodeEnv` agrees. Every other PRIVACYTRACKER_* value is
        // inherited from THIS process — run the harness under the Node
        // server's env (PRIVACYTRACKER_BIND_HOST above all), or the
        // deployment diagnostics differ for reasons of env, not port.
        PRIVACYTRACKER_DATA_DIR: dataDir,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    rust = child;
    let out = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(`pt-core did not report listening in 30s. stderr:\n${out}`)
        ),
      30_000
    );
    child.stdout.on("data", (c) => {
      out += c;
      // The server prints its bound address; parse it rather than assuming a
      // port, so the OS can pick a free one.
      const m = out.match(/listening on (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pt-core exited early (code ${code}):\n${out}`));
    });
  });
}

/**
 * The parity differ authenticates every request, so it can never prove the
 * auth gate exists. Probe it directly: a non-public route with NO token must
 * be refused, and a public one must still answer.
 */
async function probeAuthGate(base) {
  const noToken = { origin: base };
  const gated = await fetch(`${base}/api/date-format`, { headers: noToken });
  const publicRead = await fetch(`${base}/api/health`, { headers: noToken });
  const ok = gated.status === 401 && publicRead.status === 200;
  console.log(
    ok
      ? "  ✔ auth gate: /api/date-format without a token → 401, /api/health → 200"
      : `  ✘ auth gate: expected 401/200, got ${gated.status}/${publicRead.status}`
  );
  return ok;
}

/**
 * proxy.ts step 0.5 — the canonical trailing-slash redirect.
 *
 * The differ cannot see this. `parity-diff.mjs` only ever requests the
 * canonical paths in its manifest, so a backend that answered 404 for every
 * `…/` form would pass every check — which is exactly what the first cut of
 * `core/src/server/gate.rs` did, for every path including the per-app routes.
 *
 * Deliberately sends NO token. The redirect sits ABOVE the auth gate in
 * proxy.ts, so an auth-gated path must still answer 308 rather than 401; a
 * backend that ordered those two steps the other way is caught here instead
 * of by inspection.
 *
 * Repeated-slash paths (`/api/health//`) are NOT probed. Next normalises those
 * in its router BEFORE middleware runs, so Node answers a header-less 308 to
 * `/api/health/` and needs a second hop, while the Rust core collapses the
 * whole run at once. Both land on the same canonical path; only the hop count
 * differs, and the Node behaviour there is the header-stripping quirk that
 * `skipTrailingSlashRedirect` exists to avoid — not something to reproduce.
 */
async function probeTrailingSlash(rustBase, nodeBase) {
  const paths = [
    "/api/health/", // a public read
    "/api/date-format/", // auth-gated: proves step 0.5 runs before step 1
    "/api/health/?x=1&y=2", // the query must survive the rewrite
    "/api/health", // control: a canonical path must NOT be redirected
  ];
  const read = async (base, path_) => {
    const res = await fetch(base + path_, {
      headers: { origin: base },
      // Without this, fetch follows the 308 and reports the destination's 200.
      redirect: "manual",
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      cacheControl: res.headers.get("cache-control"),
    };
  };
  const describe = (r) =>
    `${r.status} location=${r.location ?? "-"} cache-control=${r.cacheControl ?? "-"}`;

  let ok = true;
  for (const path_ of paths) {
    const nodeRes = await read(nodeBase, path_);
    const rustRes = await read(rustBase, path_);
    if (
      nodeRes.status !== rustRes.status ||
      nodeRes.location !== rustRes.location ||
      nodeRes.cacheControl !== rustRes.cacheControl
    ) {
      ok = false;
      console.log(
        `  ✘ trailing slash: ${path_}\n      node: ${describe(nodeRes)}\n      rust: ${describe(rustRes)}`
      );
    }
  }
  console.log(
    ok
      ? `  ✔ trailing slash: ${paths.length} paths agree on status, Location and Cache-Control`
      : "  ✘ trailing slash: see the mismatches above"
  );
  return ok;
}

/**
 * One request over plain `node:http`, resolving to its status.
 *
 * Not `fetch`: undici silently DROPS a caller-supplied `Host`, so the
 * spoofed-host case below cannot be expressed through it at all — it would
 * quietly probe the real host and pass.
 */
function rawStatus(base, path_, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path_);
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * `X-Forwarded-Host` and the CSRF origin comparison — the two gate inputs
 * that `PRIVACYTRACKER_TRUST_PROXY` governs.
 *
 * Neither backend is started with that flag, so a forwarded host must be
 * IGNORED on both. The first cut of the Rust gate honoured it
 * unconditionally, which let a client satisfy the host allowlist — and,
 * through the same helper, the CSRF same-origin check — with a header of
 * its choosing. The differ never sends a forwarded header and always sends
 * the canonical Origin, so it could see neither.
 *
 * Each case carries the answer a running Node server gave, and BOTH backends
 * are held to it — two backends agreeing on the wrong answer is not parity.
 * The CSRF cases pin only the gate's decision (403 or not): past the gate the
 * backends legitimately differ, since Node's login route answers the empty
 * body while the Rust core has no such route yet.
 */
async function probeForwardedHost(rustBase, nodeBase) {
  const LOGIN = "/api/auth/admin-token/login";
  const cases = (base) => {
    const real = new URL(base).host;
    return [
      {
        label: "a forwarded host beside a real, allowed Host is ignored",
        path: "/api/health",
        headers: { host: real, "x-forwarded-host": "evil.example" },
        expect: 200,
      },
      {
        label: "a forwarded host cannot rescue a disallowed Host",
        path: "/api/health",
        headers: { host: "evil.example", "x-forwarded-host": real },
        expect: 400,
      },
      {
        label: "CSRF: the exact Origin passes the gate",
        method: "POST",
        path: LOGIN,
        headers: { host: real, origin: base },
        expect: "not 403",
      },
      {
        label: "CSRF: an https Origin on an http server is rejected",
        method: "POST",
        path: LOGIN,
        headers: { host: real, origin: base.replace(/^http:/, "https:") },
        expect: 403,
      },
      {
        label: "CSRF: a trailing-slash Origin is rejected",
        method: "POST",
        path: LOGIN,
        headers: { host: real, origin: `${base}/` },
        expect: 403,
      },
      {
        label: "CSRF: a forged forwarded host + matching Origin is rejected",
        method: "POST",
        path: LOGIN,
        headers: {
          host: real,
          "x-forwarded-host": "evil.example",
          origin: "http://evil.example",
        },
        expect: 403,
      },
    ];
  };
  const fits = (status, expect) =>
    expect === "not 403" ? status !== 403 : status === expect;

  let ok = true;
  const nodeCases = cases(nodeBase);
  const rustCases = cases(rustBase);
  for (let i = 0; i < nodeCases.length; i++) {
    const n = nodeCases[i];
    const r = rustCases[i];
    const nodeStatus = await rawStatus(nodeBase, n.path, n);
    const rustStatus = await rawStatus(rustBase, r.path, r);
    if (!(fits(nodeStatus, n.expect) && fits(rustStatus, n.expect))) {
      ok = false;
      console.log(
        `  ✘ forwarded host / origin: ${n.label}\n      expected ${n.expect}; node: ${nodeStatus}, rust: ${rustStatus}`
      );
    }
  }
  console.log(
    ok
      ? `  ✔ forwarded host / origin: ${nodeCases.length} cases agree with Node's verified answers on both backends`
      : "  ✘ forwarded host / origin: see the mismatches above"
  );
  return ok;
}

/** Hammer one rate-gated route past its limit and report where it gave way. */
async function burstManualApps(base) {
  const headers = { origin: base, "x-auditor-admin-token": TOKEN };
  let denied = 0;
  let firstDenyAt = null;
  let contiguous = true;
  // manual-apps.list is 120/min; 130 requests must trip it.
  for (let i = 0; i < 130; i++) {
    const res = await fetch(`${base}/api/manual-apps`, { headers });
    if (res.status === 429) {
      denied++;
      firstDenyAt ??= i + 1;
    } else if (firstDenyAt !== null) {
      // 130 requests take far less than the 60s window, so nothing can fall
      // out of it mid-burst. A request allowed after a denial means the
      // window is being pruned on the wrong side.
      contiguous = false;
    }
  }
  return { firstDenyAt, denied, contiguous };
}

/**
 * The differ sends one request per route against a 120/min limit, so it can
 * never observe the inbound rate limiter — a backend that omitted it entirely
 * would pass every check. Probe it directly and require a 429.
 *
 * This MUST run AFTER the diff. It deliberately leaves both backends'
 * `manual-apps.list:local` bucket exhausted, and the limiter is per-process,
 * so a probe-first ordering makes the differ's own /api/manual-apps request
 * answer 429 — a harness artefact that looks exactly like a real parity
 * failure.
 */
async function probeRateLimiter(rustBase, nodeBase) {
  // Probe BOTH sides and require them to agree, rather than asserting a
  // hard-coded "first 429 at request 121". The differ has already spent one
  // request of each backend's budget by this point; a fixed constant would
  // bake that in and break the moment the manifest reads the route twice.
  const rust = await burstManualApps(rustBase);
  const node = await burstManualApps(nodeBase);
  // --ids-from=a resolves both sides' placeholders through Node. Each
  // selected manualApp placeholder therefore spends two extra Node list
  // reads; account for actual manifest traffic instead of masking a limit.
  const resolverReads =
    2 *
    [...READS, ...VOLATILE_READS, ...QUARANTINE].filter(
      (entry) =>
        new RegExp(onlyRe).test(entry.route) &&
        [
          entry.path,
          JSON.stringify(entry.body ?? null),
          entry.after ?? "",
        ].some((s) => s?.includes("{manualApp}"))
    ).length;
  const ok =
    rust.firstDenyAt !== null &&
    node.firstDenyAt !== null &&
    rust.firstDenyAt === node.firstDenyAt + resolverReads &&
    rust.contiguous &&
    node.contiguous;
  console.log(
    ok
      ? `  ✔ rate limiter: /api/manual-apps denied at Rust ${rust.firstDenyAt}, Node ${node.firstDenyAt} (${resolverReads} extra Node placeholder reads accounted for)`
      : `  ✘ rate limiter: node first-429 at ${node.firstDenyAt} (contiguous=${node.contiguous}), rust at ${rust.firstDenyAt} (contiguous=${rust.contiguous})`
  );
  return ok;
}

/**
 * Byte-compare `/api/apps/{id}/since-install` across the fixture scenarios.
 *
 * The differ already covers this route, but only against the canned seed —
 * where every app's baseline and latest snapshot hold the same types and
 * categories, so all ten answer `"changes": []`. A Rust `diff_snapshots`
 * that returned an empty vec unconditionally would pass that check, and
 * none of the route's other branches (`baselineIsApprox`,
 * `isSingleSnapshot`, the null response, the empty-string `snapshot_json`
 * trap) is reachable from the seed at all.
 *
 * So this walks the fixture apps written before the copy and compares the
 * two backends' raw response bytes. It also asserts the diff case is
 * genuinely non-empty — otherwise a broken fixture would quietly restore the
 * blindness it exists to remove.
 */
async function probeSinceInstall(rustBase, nodeBase) {
  const fetchBoth = async (id) => {
    const route = `/api/apps/${encodeURIComponent(id)}/since-install`;
    const [ra, rb] = await Promise.all([
      fetch(`${nodeBase}${route}`, {
        headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
      }),
      fetch(`${rustBase}${route}`, {
        headers: { origin: rustBase, "x-auditor-admin-token": TOKEN },
      }),
    ]);
    return {
      node: { status: ra.status, body: await ra.text() },
      rust: { status: rb.status, body: await rb.text() },
    };
  };

  let ok = true;
  const report = (label, pass, detail) => {
    console.log(pass ? `  ✔ ${label}` : `  ✘ ${label}: ${detail}`);
    ok &&= pass;
  };

  for (const fx of SINCE_INSTALL_FIXTURES) {
    const { node, rust } = await fetchBoth(fx.id);
    if (node.status !== rust.status) {
      report(fx.id, false, `HTTP ${node.status} vs ${rust.status}`);
      continue;
    }
    if (node.body !== rust.body) {
      report(
        fx.id,
        false,
        `bodies differ\n      node: ${node.body.slice(0, 400)}\n      rust: ${rust.body.slice(0, 400)}`
      );
      continue;
    }
    report(`${fx.id} (${node.status})`, true);
  }

  // An unknown id must be REFUSED, not answered with a null body.
  const missing = await fetchBoth(SINCE_INSTALL_MISSING_ID);
  report(
    `unknown id → ${missing.node.status}`,
    missing.node.status === 404 &&
      missing.rust.status === 404 &&
      missing.node.body === missing.rust.body,
    `node ${missing.node.status} ${missing.node.body} vs rust ${missing.rust.status} ${missing.rust.body}`
  );

  // The point of the whole fixture: prove the comparison had something to
  // compare. If this ever reads 0, everything above is passing vacuously.
  const diffCase = await fetchBoth("pt-fixture-diff");
  let entries = 0;
  try {
    entries =
      JSON.parse(diffCase.node.body)?.sinceInstall?.changes?.length ?? 0;
  } catch {
    entries = 0;
  }
  report(
    `the diff fixture produced ${entries} change entries`,
    entries >= 4,
    "expected at least 4 (added type, removed type, added category, removed category) — a 0 here means the probe proves nothing"
  );

  return ok;
}

/**
 * Byte-compare `/api/apps/{id}/history-stats` on the trend fixture.
 *
 * The differ DOES exercise this route against the canned seed, and unlike
 * since-install the seed gives it real numbers — but only its `added` arm.
 * Across all ten seeded apps `totalRemoved` is 0, every entry is an untagged
 * privacy-label one, and `changes_detected` is only ever 0 or 1. So a port
 * that dropped the removal arm, ignored the category filter, or relaxed the
 * strict `changes_detected !== 1` would still pass.
 *
 * The bucket BOUNDARIES are invisible to the differ either way: every
 * startMs/endMs is above 1.4e12, which normalize() masks as `~epoch`. The
 * `label` strings are compared, so a whole-quarter slip is caught; a
 * sub-quarter one is not, and is covered by unit tests in core/src/server/trend.rs.
 */
async function probeHistoryStats(rustBase, nodeBase) {
  const route = `/api/apps/${encodeURIComponent(TREND_ID)}/history-stats`;
  const [ra, rb] = await Promise.all([
    fetch(`${nodeBase}${route}`, {
      headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
    }),
    fetch(`${rustBase}${route}`, {
      headers: { origin: rustBase, "x-auditor-admin-token": TOKEN },
    }),
  ]);
  const [nodeBody, rustBody] = await Promise.all([ra.text(), rb.text()]);

  if (ra.status !== rb.status || nodeBody !== rustBody) {
    console.log(
      `  ✘ history-stats fixture: HTTP ${ra.status} vs ${rb.status}\n      node: ${nodeBody.slice(0, 400)}\n      rust: ${rustBody.slice(0, 400)}`
    );
    return false;
  }

  // Prove the comparison had the arms the canned seed cannot reach.
  let trend = null;
  try {
    trend = JSON.parse(nodeBody)?.categoryTrend ?? null;
  } catch {
    trend = null;
  }
  const exercised =
    (trend?.totalRemoved ?? 0) > 0 && (trend?.totalAdded ?? 0) > 0;
  console.log(
    exercised
      ? `  ✔ history-stats fixture: +${trend.totalAdded}/-${trend.totalRemoved} identical on both backends (the seed alone never removes anything)`
      : `  ✘ history-stats fixture: expected both arms exercised, got +${trend?.totalAdded} /-${trend?.totalRemoved} — the fixture has stopped proving anything`
  );
  return exercised;
}

/**
 * Byte-compare `/api/apps/{id}/changelog` on the paths the manifest misses.
 *
 * The manifest hits this route once, on Instagram, with no query string. On
 * that app neither read-time mutation fires and no review row exists, so
 * four things go uncompared: `archive_bridge` (which is where
 * `diffSnapshots` runs on this path), `matches_live_sync`, the
 * `kind: "review"` row shape, and both 400 branches.
 *
 * The two 400s are worth the most per line here, because they are validated
 * by DIFFERENT functions and the asymmetry is easy to miss: `before` goes
 * through `Number()` (so an empty `?before=` is 0 and VALID), `limit`
 * through `parseInt` (so an empty `?limit=` is NaN and rejected, while
 * `?limit=25abc` is accepted as 25).
 */
async function probeChangelog(rustBase, nodeBase) {
  const fetchBoth = async (suffix) => {
    const [ra, rb] = await Promise.all([
      fetch(`${nodeBase}${suffix}`, {
        headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
      }),
      fetch(`${rustBase}${suffix}`, {
        headers: { origin: rustBase, "x-auditor-admin-token": TOKEN },
      }),
    ]);
    const [nodeBody, rustBody] = await Promise.all([ra.text(), rb.text()]);
    return {
      node: { status: ra.status, body: nodeBody },
      rust: { status: rb.status, body: rustBody },
    };
  };

  let ok = true;
  const compare = async (label, suffix, expect) => {
    const { node, rust } = await fetchBoth(suffix);
    if (node.status !== rust.status || node.body !== rust.body) {
      console.log(
        `  ✘ ${label}: HTTP ${node.status} vs ${rust.status}\n      node: ${node.body.slice(0, 300)}\n      rust: ${rust.body.slice(0, 300)}`
      );
      ok = false;
      return null;
    }
    if (expect && !expect(node)) {
      console.log(
        `  ✘ ${label}: both backends agree but the case is not exercising what it claims — ${node.body.slice(0, 300)}`
      );
      ok = false;
      return null;
    }
    console.log(`  ✔ ${label} (${node.status})`);
    return node;
  };

  const rowsOf = (res) => {
    try {
      return JSON.parse(res.body)?.rows ?? [];
    } catch {
      return [];
    }
  };

  // archive_bridge — the only path on which diffSnapshots runs here.
  for (const id of BRIDGED_IDS) {
    await compare(`${id}: archive_bridge`, `/api/apps/${id}/changelog`, (res) =>
      rowsOf(res).some((r) => r.archive_bridge)
    );
  }

  // matches_live_sync + interleaved review rows, including the equal-timestamp
  // tie-break (snapshot before review).
  await compare(
    `${TIMELINE_ID}: matches_live_sync + review rows`,
    `/api/apps/${TIMELINE_ID}/changelog`,
    (res) => {
      const rows = rowsOf(res);
      return (
        rows.some((r) => r.matches_live_sync === true) &&
        rows.some((r) => r.kind === "review")
      );
    }
  );

  // hasMore, which the default page size never reaches on fixture data.
  await compare(
    `${TIMELINE_ID}: hasMore with ?limit=1`,
    `/api/apps/${TIMELINE_ID}/changelog?limit=1`,
    (res) => {
      try {
        const j = JSON.parse(res.body);
        return j.hasMore === true && j.rows.length === 1;
      } catch {
        return false;
      }
    }
  );

  // The validation branches. `?before=` EMPTY is valid (Number("") is 0) and
  // `?limit=25abc` is 25 — both of which a stricter Rust parser rejects.
  await compare(
    "?before=abc → 400",
    `/api/apps/${TIMELINE_ID}/changelog?before=abc`,
    (res) => res.status === 400
  );
  await compare(
    "?before=-1 → 400",
    `/api/apps/${TIMELINE_ID}/changelog?before=-1`,
    (res) => res.status === 400
  );
  await compare(
    "?before= (empty) → 200, Number('') is 0",
    `/api/apps/${TIMELINE_ID}/changelog?before=`,
    (res) => res.status === 200
  );
  await compare(
    "?limit=0 / 201 → 400",
    `/api/apps/${TIMELINE_ID}/changelog?limit=0`,
    (res) => res.status === 400
  );
  await compare(
    "?limit= (empty) → 400, parseInt('') is NaN",
    `/api/apps/${TIMELINE_ID}/changelog?limit=`,
    (res) => res.status === 400
  );
  await compare(
    "?limit=1abc → 200, parseInt is prefix-tolerant",
    `/api/apps/${TIMELINE_ID}/changelog?limit=1abc`,
    (res) => res.status === 200
  );

  return ok;
}

/**
 * `/api/apps?limit=250&offset=0&meta=grid` is byte-compared by the manifest,
 * so this does not compare again. It asserts the comparison was not vacuous:
 * without the fixture profile and verdict, `profileBadges` and `userVerdicts`
 * are `{}` on the canned seed, and a port that never ran the profile engine
 * would pass. It also requires at least one `kind: "mismatches"` badge — a
 * page of nothing but "match" badges never reaches the sort, and therefore
 * never reaches the `localeCompare` tie-break.
 */
async function probeGridMeta(nodeBase) {
  const res = await fetch(`${nodeBase}/api/apps?limit=250&offset=0&meta=grid`, {
    headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
  });
  let meta = null;
  try {
    meta = (await res.json())?.meta ?? null;
  } catch {
    meta = null;
  }
  const badges = Object.values(meta?.profileBadges ?? {});
  const verdicts = Object.keys(meta?.userVerdicts ?? {}).length;
  const mismatched = badges.filter((b) => b?.kind === "mismatches").length;
  // The collation app mismatches CONTACTS and CONTACT_INFO with an EQUAL gap,
  // so worstCategory is decided by localeCompare alone. ICU: CONTACT_INFO.
  // Byte order and insertion order both say CONTACTS.
  const tie = meta?.profileBadges?.[COLLATION_FIXTURE.id];
  const tieOk = tie?.count === 2 && tie?.worstCategory === "CONTACT_INFO";
  const ok = badges.length > 0 && mismatched > 0 && verdicts > 0 && tieOk;
  console.log(
    ok
      ? `  ✔ grid meta: ${badges.length} profile badges (${mismatched} with mismatches), ${verdicts} user verdict(s), and the CONTACT_INFO/CONTACTS tie resolved the ICU way — the engine ran on both sides`
      : `  ✘ grid meta: badges=${badges.length} mismatched=${mismatched} verdicts=${verdicts} tie=${JSON.stringify(tie)} — the meta=grid comparison is passing vacuously`
  );
  return ok;
}

/**
 * `/api/apps/{id}/detail` is byte-compared by the manifest on Instagram. On
 * the canned seed three of its fourteen fields are null — importProvenance,
 * a11yProfile, childAgeBand — so their real shapes were never compared. The
 * fixture writes an import row for Instagram and the two settings; this
 * refuses a run where any of the three is still null.
 *
 * Instagram specifically, because `ID_RE = /^\d{1,20}$/` runs before the
 * existence check and a `pt-fixture-*` id is a 400 on this route.
 */
async function probeDetail(nodeBase) {
  const res = await fetch(`${nodeBase}/api/apps/${INSTAGRAM_ID}/detail`, {
    headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
  });
  let j = null;
  try {
    j = await res.json();
  } catch {
    j = null;
  }
  const nulls = ["importProvenance", "a11yProfile", "childAgeBand"].filter(
    (k) => j?.[k] === null || j?.[k] === undefined
  );
  const ok = res.status === 200 && nulls.length === 0;
  console.log(
    ok
      ? `  ✔ detail: importProvenance (${j.importProvenance?.source}), a11yProfile (${Object.keys(j.a11yProfile ?? {}).length} keys) and childAgeBand (${j.childAgeBand}) all populated — the seed alone leaves all three null`
      : `  ✘ detail: HTTP ${res.status}, still null: ${nulls.join(", ") || "none"} — the comparison never saw their real shapes`
  );
  return ok;
}

/**
 * The four settings-backed reads are byte-compared by the manifest, but on
 * a database the seed leaves nearly empty for them: no API key, no country,
 * no webhook, no `desktop_*` rows, no stored layout, no overrides. So every
 * masked secret was compared as "" against "", every desktop coercion as
 * its default, the layout as the canonical default, and the resolver on one
 * focus. SETTINGS_FIXTURE / FLAG_OVERRIDE_FIXTURE write rows that make each
 * of those real; this refuses a run where Node's answers show they did not
 * land — the comparison itself is the differ's job.
 */
async function probeSettingsReads(nodeBase) {
  const get = async (route) => {
    const res = await fetch(`${nodeBase}${route}`, {
      headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN },
    });
    let j = null;
    try {
      j = await res.json();
    } catch {
      j = null;
    }
    return { status: res.status, j };
  };
  let ok = true;
  const check = (label, pass, detail) => {
    console.log(pass ? `  ✔ ${label}` : `  ✘ ${label}: ${detail}`);
    ok &&= pass;
  };
  const expect = SETTINGS_FIXTURE.expect;

  const s = await get("/api/settings");
  check(
    "settings: API key masked as __SET__, country explicit, webhook masked the Slack way",
    s.status === 200 &&
      s.j?.ai_api_key === "__SET__" &&
      s.j?.ai_api_key_set === true &&
      s.j?.app_country === SETTINGS_FIXTURE.settings.app_country &&
      s.j?.app_country_explicit === true &&
      s.j?.notification_webhook_url === expect.webhookMask &&
      s.j?.notification_webhook_url_set === true,
    `HTTP ${s.status} ${JSON.stringify(s.j)?.slice(0, 300)}`
  );

  const d = await get("/api/settings/desktop");
  const desktopMisses = Object.entries(expect.desktop).filter(
    ([k, v]) => d.j?.[k] !== v
  );
  check(
    "desktop: parseFloat prefix, out-of-range int, uppercase theme and TRUE all coerced as Node does",
    d.status === 200 && desktopMisses.length === 0,
    `HTTP ${d.status}; expected ${JSON.stringify(Object.fromEntries(desktopMisses))} but got ${JSON.stringify(Object.fromEntries(desktopMisses.map(([k]) => [k, d.j?.[k]])))}`
  );

  const l = await get("/api/dashboard/layout");
  const order = l.j?.layout?.order ?? [];
  check(
    "layout: a stored blob with junk was reconciled (18 cards, hidden filtered+sorted, no preset)",
    l.status === 200 &&
      order.length === 18 &&
      new Set(order).size === 18 &&
      order[0] === "task_list" &&
      order[1] === "hero" &&
      JSON.stringify(l.j?.layout?.hidden) === JSON.stringify(expect.hidden) &&
      l.j?.matchedPreset === null,
    `HTTP ${l.status} ${JSON.stringify(l.j)?.slice(0, 300)}`
  );

  const f = await get("/api/feature-flags");
  const rows = f.j?.flags ?? [];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const parent = byKey.get(FLAG_OVERRIDE_FIXTURE.parent);
  const child = byKey.get(FLAG_OVERRIDE_FIXTURE.child);
  const quarantined = byKey.get(FLAG_OVERRIDE_FIXTURE.quarantinedKey);
  // A rule fired somewhere: current differs from the hard default with no
  // override to explain it. Zero here would mean the focus never reached
  // the resolver.
  const ruled = rows.filter(
    (r) => r.override === null && r.currentValue !== r.hardDefault
  ).length;
  const sorted = rows.every(
    (r, i) =>
      i === 0 ||
      (rows[i - 1].surface === r.surface
        ? rows[i - 1].key.localeCompare(r.key)
        : rows[i - 1].surface.localeCompare(r.surface)) < 0
  );
  check(
    `feature flags: ${rows.length} rows, ${ruled} moved by focus rules, parent override collapses, child override escapes (focusValue still off), quarantined and unknown overrides ignored, ICU-sorted`,
    f.status === 200 &&
      rows.length === 222 &&
      ruled > 0 &&
      sorted &&
      parent?.override === "off" &&
      parent?.currentValue === "off" &&
      child?.override === "on" &&
      child?.currentValue === "on" &&
      child?.focusValue === "off" &&
      quarantined?.override === null &&
      !byKey.has(FLAG_OVERRIDE_FIXTURE.unknownKey),
    `HTTP ${f.status} rows=${rows.length} ruled=${ruled} sorted=${sorted} parent=${JSON.stringify(parent)} child=${JSON.stringify(child)} quarantined=${JSON.stringify(quarantined)}`
  );

  return ok;
}

/**
 * `GET /api/settings/desktop` WRITES when the request carries
 * `x-privacytracker-runtime: desktop` (or the process env says so): it
 * upserts `runtime_environment`, which the flag resolver reads back to force
 * two desktop-only flags on. The differ never sends that header, so neither
 * the write nor the rule it feeds is in the comparison. Runs AFTER the
 * differ, because it changes both databases for the rest of the run.
 *
 * Only `flag.desktop.app_section` is required to flip: the other forced
 * flag has a dependency parent that can collapse it straight back, and
 * whether it does is Node's call — the byte comparison covers it.
 */
async function probeDesktopRuntimeMark(rustBase, nodeBase) {
  const fetchBoth = async (route, extra = {}) => {
    const [ra, rb] = await Promise.all([
      fetch(`${nodeBase}${route}`, {
        headers: { origin: nodeBase, "x-auditor-admin-token": TOKEN, ...extra },
      }),
      fetch(`${rustBase}${route}`, {
        headers: { origin: rustBase, "x-auditor-admin-token": TOKEN, ...extra },
      }),
    ]);
    const [nodeBody, rustBody] = await Promise.all([ra.text(), rb.text()]);
    return {
      node: { status: ra.status, body: nodeBody },
      rust: { status: rb.status, body: rustBody },
    };
  };
  const flagValue = (body, key) => {
    try {
      return JSON.parse(body).flags.find((r) => r.key === key)?.currentValue;
    } catch {}
  };
  let ok = true;
  const report = (label, pass, detail) => {
    console.log(pass ? `  ✔ ${label}` : `  ✘ ${label}: ${detail}`);
    ok &&= pass;
  };
  const FORCED = "flag.desktop.app_section";

  const before = await fetchBoth("/api/feature-flags");
  const wasOff = flagValue(before.node.body, FORCED) !== "on";

  const marked = await fetchBoth("/api/settings/desktop", {
    "x-privacytracker-runtime": "desktop",
  });
  report(
    "desktop GET with the runtime header answers identically on both sides",
    marked.node.status === 200 &&
      marked.rust.status === 200 &&
      marked.node.body === marked.rust.body,
    `HTTP ${marked.node.status} vs ${marked.rust.status}\n      node: ${marked.node.body.slice(0, 200)}\n      rust: ${marked.rust.body.slice(0, 200)}`
  );

  const after = await fetchBoth("/api/feature-flags");
  const nowOn = flagValue(after.node.body, FORCED) === "on";
  report(
    `${FORCED} was ${wasOff ? "off" : "already on"} before the mark and is ${nowOn ? "on" : "NOT on"} after it; feature-flag bodies identical`,
    after.node.status === 200 &&
      after.node.body === after.rust.body &&
      wasOff &&
      nowOn,
    wasOff
      ? `HTTP ${after.node.status} vs ${after.rust.status}, bodies ${after.node.body === after.rust.body ? "equal" : "DIFFER"}, node value ${flagValue(after.node.body, FORCED)}`
      : "the flag was on before the write, so this probe cannot see the write happen — the fixture focus must leave it off"
  );

  return ok;
}

/**
 * `/api/diagnostics/health` returns the LAST persisted health-check result,
 * or `{ neverRun: true }` until the 24h ticker has fired once — sixty
 * seconds after boot. A harness run inside that minute would compare
 * `{neverRun:true}` against `{neverRun:true}` and prove nothing about the
 * blob passthrough. Run one on demand BEFORE the checkpoint so both sides
 * read the same real result out of the copy. The POST is rate-limited on
 * Node; a 429 on a quick re-run is fine as long as a result already exists.
 */
async function primeHealthCheck(nodeBase) {
  const headers = { origin: nodeBase, "x-auditor-admin-token": TOKEN };
  const post = await fetch(`${nodeBase}/api/diagnostics/health`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  const res = await fetch(`${nodeBase}/api/diagnostics/health`, { headers });
  let j = null;
  try {
    j = await res.json();
  } catch {
    j = null;
  }
  const stored = res.status === 200 && j?.neverRun !== true;
  console.log(
    stored
      ? `  ✔ health check ${post.ok ? "run on demand" : `not re-run (POST ${post.status})`}; a stored result (${j?.status}, trigger ${j?.trigger}) exists before the copy`
      : `  ✘ POST /api/diagnostics/health → HTTP ${post.status} and GET still says neverRun — the health route would compare {neverRun:true} on both sides`
  );
  return stored;
}

/**
 * The deployment-facing reads, held to equality on the parts the differ
 * blanks or masks. `/api/diagnostics/*` are compared shape-first because
 * page and file counts differ between a live database and its checkpointed
 * copy — but the connection pragmas, the backup fixture and the volume
 * stats must not, and `/api/deployment/diagnostics`' env-derived fields
 * must agree or the differ is comparing two deployments, not two ports.
 */
async function probeDiagnosticsReads(rustBase, nodeBase) {
  const get = async (base, route) => {
    const res = await fetch(`${base}${route}`, {
      headers: { origin: base, "x-auditor-admin-token": TOKEN },
    });
    const body = await res.text();
    let j = null;
    try {
      j = JSON.parse(body);
    } catch {
      j = null;
    }
    return { status: res.status, body, j };
  };
  const both = async (route) => {
    const [node, rust] = await Promise.all([
      get(nodeBase, route),
      get(rustBase, route),
    ]);
    return { node, rust };
  };
  let ok = true;
  const check = (label, pass, detail) => {
    console.log(pass ? `  ✔ ${label}` : `  ✘ ${label}: ${detail}`);
    ok &&= pass;
  };

  const health = await both("/api/diagnostics/health");
  // Each side stores its own manual run (primed after the core's boot
  // timers): the figures that belong to the process and the file, the
  // clock, and the activity count (the core's scheduled tick left a row
  // of its own) are blanked; the verdict, heals, warnings, counts and
  // orphans that derive from the same rows must agree.
  const OWN_FIGURES = new Set([
    "rssMb",
    "heapFractionUsed",
    "eventLoopP99Ms",
    "walBytes",
    "fileBytes",
    "shmBytes",
    "pageCount",
    "freelistCount",
    "utilisationPct",
    "fragmented",
    "startedAt",
    "finishedAt",
    "durationMs",
    "activityLog",
  ]);
  const blankOwnFigures = (v) => {
    if (Array.isArray(v)) {
      return v.map(blankOwnFigures);
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [
          k,
          OWN_FIGURES.has(k) ? "~" : blankOwnFigures(val),
        ])
      );
    }
    return v;
  };
  const realResult = (side) =>
    side.status === 200 && side.j?.neverRun !== true && side.j?.version === 1;
  const comparable = (side) =>
    realResult(side) ? JSON.stringify(blankOwnFigures(side.j)) : side.body;
  check(
    "health: a real stored result on both sides (version 1, not {neverRun:true}), each server's own manual run, identical once the process's own figures are blanked",
    realResult(health.node) &&
      realResult(health.rust) &&
      health.node.j?.trigger === "manual" &&
      health.rust.j?.trigger === "manual" &&
      comparable(health.node) === comparable(health.rust),
    `HTTP ${health.node.status} vs ${health.rust.status}\n      node: ${comparable(health.node).slice(0, 300)}\n      rust: ${comparable(health.rust).slice(0, 300)}`
  );

  const db = await both("/api/diagnostics/database");
  const stable = [
    "journalMode",
    "busyTimeoutMs",
    "foreignKeysEnabled",
    "walAutocheckpoint",
    "pageSize",
  ];
  const dbMiss = stable.filter((k) => db.node.j?.[k] !== db.rust.j?.[k]);
  check(
    `database: the connection pragmas agree on both sides (${db.node.j?.journalMode}, busy ${db.node.j?.busyTimeoutMs}ms, foreign keys ${db.node.j?.foreignKeysEnabled}, autocheckpoint ${db.node.j?.walAutocheckpoint}, page ${db.node.j?.pageSize}) — the numbers the differ blanks`,
    db.node.status === 200 &&
      db.rust.status === 200 &&
      dbMiss.length === 0 &&
      db.node.j?.journalMode === "wal",
    `HTTP ${db.node.status} vs ${db.rust.status}; differing: ${dbMiss.map((k) => `${k} ${JSON.stringify(db.node.j?.[k])} vs ${JSON.stringify(db.rust.j?.[k])}`).join(", ") || "none"}`
  );

  const disk = await both("/api/diagnostics/disk");
  const diskOk = (side) =>
    side.status === 200 &&
    side.j?.backupSnapshotCount === DISK_FIXTURE.jsonCount &&
    side.j?.files?.backups > 0 &&
    side.j?.lastBackupSnapshotAt === DISK_FIXTURE.lastRunAt &&
    side.j?.totalBytes > 0 &&
    side.j?.freePct >= 0 &&
    side.j?.freePct <= 100;
  check(
    `disk: ${disk.node.j?.backupSnapshotCount} backup snapshots (${disk.node.j?.files?.backups} bytes) counted, lastBackupSnapshotAt read back, volume stats present — on both sides`,
    diskOk(disk.node) &&
      diskOk(disk.rust) &&
      disk.node.j?.files?.backups === disk.rust.j?.files?.backups,
    `node: ${disk.node.body.slice(0, 300)}\n      rust: ${disk.rust.body.slice(0, 300)}`
  );

  const dep = await both("/api/deployment/diagnostics");
  const pick = [
    ["app.nodeEnv", (j) => j?.app?.nodeEnv],
    ["app.version", (j) => j?.app?.version],
    ["app.arch", (j) => j?.app?.arch],
    ["app.platform", (j) => j?.app?.platform],
    ["app.runtime", (j) => j?.app?.runtime],
    ["app.containerLikely", (j) => j?.app?.containerLikely],
    ["database.dataDirSource", (j) => j?.database?.dataDirSource],
    ["database.journalMode", (j) => j?.database?.journalMode],
    ["network.proxyDetected", (j) => j?.network?.proxyDetected],
    ["network.protocol", (j) => j?.network?.protocol],
    ["security", (j) => JSON.stringify(j?.security)],
    ["check verdicts", (j) => (j?.checks ?? []).map((c) => c.status).join(",")],
  ];
  const misses = pick
    .filter(([, f]) => f(dep.node.j) !== f(dep.rust.j))
    .map(
      ([name, f]) =>
        `${name}: node ${JSON.stringify(f(dep.node.j))} vs rust ${JSON.stringify(f(dep.rust.j))}`
    );
  check(
    `deployment: env-derived app fields, dataDirSource, security posture and check verdicts agree; proxyDetected is ${dep.node.j?.network?.proxyDetected} on both (next start's forwarded headers, reproduced)`,
    dep.node.status === 200 &&
      dep.rust.status === 200 &&
      misses.length === 0 &&
      dep.node.j?.network?.proxyDetected === true,
    `HTTP ${dep.node.status} vs ${dep.rust.status}; ${misses.join("; ") || "no field differs"} — the Rust server inherits THIS process's PRIVACYTRACKER_* env; run the harness with the values the Node server was started with`
  );

  const ready = await both("/api/ready");
  const readyOk = (side) =>
    side.status === 200 &&
    side.j?.status === "ready" &&
    (side.j?.checks ?? []).length === 5 &&
    side.j.checks.every((c) => c.status === "ok");
  check(
    'ready: both answer 200 "ready" with five ok checks — the readiness contract is exercised, not just compared',
    readyOk(ready.node) && readyOk(ready.rust),
    `node ${ready.node.status} ${ready.node.body.slice(0, 200)}\n      rust ${ready.rust.status} ${ready.rust.body.slice(0, 200)}`
  );

  return ok;
}

/**
 * The runtime envelope on the Rust side. The manifest can only say "each
 * side conforms to the contract"; a Rust body that conformed by reporting
 * every section it could measure as null would pass that. So: the sections
 * the Rust core exists to fill (allocator, tokio, the SQLite counters,
 * lock wait) must be present with live numbers, the sections it has no
 * counterpart for must be null, and the database-derived parts of the
 * desktop payload must EQUAL Node's — both servers read the same copy.
 */
async function probeRuntimeEnvelope(rustBase, nodeBase) {
  const get = async (base, route) => {
    const res = await fetch(`${base}${route}`, {
      headers: { origin: base, "x-auditor-admin-token": TOKEN },
    });
    let j = null;
    try {
      j = await res.json();
    } catch {
      j = null;
    }
    return { status: res.status, j };
  };
  let ok = true;
  const check = (label, pass, detail) => {
    console.log(pass ? `  ✔ ${label}` : `  ✘ ${label}: ${detail}`);
    ok &&= pass;
  };

  // Fill the Rust HTTP ring past the 20-row cap the desktop report
  // applies, so the cap check below is not satisfied by a short ring.
  // `?limit=0` is a 400 from a MATCHED route, and 4xx is always recorded
  // (fast 200s are 1-in-5); neither route is rate-limited.
  for (let i = 0; i < 25; i += 1) {
    await get(rustBase, "/api/apps?limit=0");
  }
  // The sampler ticks every 20 ms and the server has been up for the whole
  // run by now; this is belt-and-braces for a fast machine.
  await new Promise((r) => setTimeout(r, 120));

  const rt = await get(rustBase, "/api/diagnostics/runtime");
  const problems = validateRuntimeDiagnostics(rt.j);
  check(
    "rust runtime envelope validates against the contract",
    rt.status === 200 && problems.length === 0,
    `HTTP ${rt.status}; ${problems.slice(0, 6).join("; ") || "no problems"}`
  );
  const e = rt.j ?? {};
  const live = (v) => typeof v === "number" && v > 0;
  const facts = [
    ["backend is rust", e.backend === "rust"],
    [
      "heap is the counting allocator with live bytes",
      e.heap?.kind === "rust-allocator" &&
        live(e.heap?.allocatedMb) &&
        live(e.heap?.liveAllocations),
    ],
    [
      "scheduler is tokio with workers and a lag histogram that has sampled",
      e.scheduler?.kind === "tokio" &&
        live(e.scheduler?.workers) &&
        live(e.scheduler?.lag?.samples),
    ],
    [
      "sqlite engine is rusqlite behind one mutex",
      e.sqlite?.engine === "rusqlite" &&
        e.sqlite?.connectionModel === "single-mutex" &&
        typeof e.sqlite?.version === "string",
    ],
    [
      "sqlite memory counters are live",
      live(e.sqlite?.memory?.usedMb) && live(e.sqlite?.memory?.schemaKb),
    ],
    ["sqlite page cache has been hit", live(e.sqlite?.cache?.hits)],
    [
      // More samples than the reading handler could produce alone: every
      // handler takes the connection through AppState::db().
      "lock wait has samples from more than this one request",
      e.sqlite?.lockWait?.samples >= 5,
    ],
    [
      "http: this very request is in flight, and the ring holds the 25 4xx",
      live(e.http?.inFlight) &&
        e.http?.totalSinceStart >= 25 &&
        e.http?.recent?.length >= 25,
    ],
    [
      // Labels are matched PATTERNS: no query string, no concrete id.
      "http: every recorded label is a route pattern",
      (e.http?.recent ?? []).length > 0 &&
        (e.http?.recent ?? []).every(
          (r) => r.route.startsWith("/api/") && !r.route.includes("?")
        ),
    ],
    [
      "slow queries: 50ms threshold, profiling on",
      e.slowQueries?.thresholdMs === 50 &&
        e.slowQueries?.profilingEnabled === true,
    ],
    [
      "no db-worker and no scraper: null, not zeros",
      e.dbWorker === null && e.scrapeActivity === null,
    ],
    [
      "inbound limiter reported",
      typeof e.rateLimiter?.trackedKeys === "number" &&
        typeof e.rateLimiter?.denialsSinceStart === "number",
    ],
  ];
  const failed = facts.filter(([, pass]) => !pass).map(([name]) => name);
  check(
    `rust envelope contents: ${facts.length - failed.length}/${facts.length} facts hold`,
    failed.length === 0,
    `failed: ${failed.join("; ")} — body: ${JSON.stringify(e).slice(0, 400)}`
  );

  // The desktop report: the envelope embeds, and the database-derived
  // parts agree with Node because both servers read the same copy.
  const [dn, dr] = await Promise.all([
    get(nodeBase, "/api/desktop/diagnostics"),
    get(rustBase, "/api/desktop/diagnostics"),
  ]);
  const embedded = validateRuntimeDiagnostics(dr.j?.runtime_diagnostics);
  const same = [
    "db.apps",
    "db.snapshots",
    "db.unread_notifications",
    "scheduler.scheduleMode",
    "scheduler.syncRunning",
    "scheduler.lastAutoSync",
    "bulk_runners",
  ]
    .map((p) => [
      p,
      p.split(".").reduce((o, k) => o?.[k], dn.j),
      p.split(".").reduce((o, k) => o?.[k], dr.j),
    ])
    .filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b))
    .map(
      ([p, a, b]) =>
        `${p}: node ${JSON.stringify(a)} vs rust ${JSON.stringify(b)}`
    );
  check(
    `desktop report: embedded envelope validates; db counts (${dr.j?.db?.apps} apps, ${dr.j?.db?.snapshots} snapshots), scheduler/lastAutoSync and runner flags equal Node's; the ${e.http?.recent?.length}-row ring is capped to ${dr.j?.runtime_diagnostics?.http?.recent?.length}; host memory and cpus reported`,
    dn.status === 200 &&
      dr.status === 200 &&
      embedded.length === 0 &&
      same.length === 0 &&
      // Exact, not `<= 20`: the ring was filled past the cap above.
      (dr.j?.runtime_diagnostics?.http?.recent ?? []).length === 20 &&
      live(dr.j?.db?.apps) &&
      typeof dr.j?.host?.cpu_count === "number" &&
      live(dr.j?.host?.total_mem_mb) &&
      live(dr.j?.host?.free_mem_mb),
    `HTTP ${dn.status} vs ${dr.status}; ${embedded.slice(0, 4).join("; ")}${same.length ? `; ${same.join("; ")}` : ""}`
  );

  return ok;
}

/**
 * `/api/diagnostics/errors` on both sides, run AFTER the rate-limiter probe
 * on purpose: a denied request makes both servers warn, so the `?limit`
 * clamp is measured against a ring that has something in it. On an empty
 * ring every `length <= n` assertion passes for the wrong reason.
 *
 * NODE'S RING IS ALWAYS EMPTY IN PRODUCTION, and that is a Node-side bug
 * this probe found rather than a porting gap. `instrumentation.ts` installs
 * the `console.warn` interceptor through `./lib/error-log-ring` while the
 * route reads `@/lib/error-log-ring`; Next gives those two specifiers
 * separate module instances, so the ring that is written to is never the
 * ring that is read. Measured: 109 warnings on stderr since boot — the
 * limiter's DENY among them — and `{"entries":[],"capacity":200}` from the
 * route. So the assertions below require the RUST ring to hold entries and
 * hold each side's clamp to ITS OWN ring length; requiring Node's to be
 * non-empty would fail the gate on a bug that predates this port.
 */
async function probeErrorRing(rustBase, nodeBase) {
  const get = async (base, route) => {
    const res = await fetch(`${base}${route}`, {
      headers: { origin: base, "x-auditor-admin-token": TOKEN },
    });
    let j = null;
    try {
      j = await res.json();
    } catch {
      j = null;
    }
    return { status: res.status, j };
  };
  const routes = [
    "/api/diagnostics/errors",
    "/api/diagnostics/errors?limit=0",
    "/api/diagnostics/errors?limit=abc",
    "/api/diagnostics/errors?limit=2",
    "/api/diagnostics/errors?limit=1&limit=5",
  ];
  const sides = [];
  for (const route of routes) {
    sides.push({
      route,
      node: await get(nodeBase, route),
      rust: await get(rustBase, route),
    });
  }
  const problems = sides.flatMap((s) =>
    [
      ["node", s.node],
      ["rust", s.rust],
    ].flatMap(([who, r]) =>
      r.status === 200
        ? validateErrorLog(r.j).map((p) => `${s.route} (${who}): ${p}`)
        : [`${s.route} (${who}): HTTP ${r.status}`]
    )
  );
  const [full, limit0, limitAbc, limit2, repeated] = sides;
  const nodeFull = full.node.j?.entries.length ?? 0;
  const rustFull = full.rust.j?.entries.length ?? 0;
  // `Math.max(1, Math.min(200, …))` on both: 0 → 1, a non-number → the
  // whole ring, 2 → 2 — each exact against that side's own ring length. A
  // repeated key must not 400 (Node takes one and answers 200).
  const clampOk =
    limit0.node.j?.entries.length === Math.min(1, nodeFull) &&
    limit0.rust.j?.entries.length === Math.min(1, rustFull) &&
    limitAbc.node.j?.entries.length === nodeFull &&
    limitAbc.rust.j?.entries.length === rustFull &&
    limit2.node.j?.entries.length === Math.min(2, nodeFull) &&
    limit2.rust.j?.entries.length === Math.min(2, rustFull) &&
    repeated.node.status === 200 &&
    repeated.rust.status === 200;
  const capacityOk = sides.every(
    (s) => s.node.j?.capacity === 200 && s.rust.j?.capacity === 200
  );
  const ok = problems.length === 0 && clampOk && capacityOk && rustFull > 0;
  console.log(
    ok
      ? `  ✔ error log: the rust ring holds the limiter's denials (${rustFull}), both sides validate at capacity 200, and ?limit=0 / abc / 2 / repeated clamp identically against each side's own length (node reads ${nodeFull} — see this probe's note)`
      : `  ✘ error log: node ${nodeFull} entries, rust ${rustFull}; clamp=${clampOk} capacity=${capacityOk}; ${problems.slice(0, 5).join("; ")}`
  );
  return ok;
}

async function main() {
  const nodeData = path.resolve(args["node-data"]);

  console.log(`read-parity: node=${args.node} data=${nodeData}`);

  // Startup recovery, import draining, backups and the initial health check
  // run 8–60 seconds after Node boots. Let those timers finish BEFORE writing
  // simulated unfinished jobs; otherwise Node resumes the fixture while Rust
  // reads its copy, and the gate measures a race instead of route parity.
  for (;;) {
    const response = await fetch(`${args.node}/api/diagnostics/runtime`, {
      headers: { "x-auditor-admin-token": TOKEN },
    });
    if (!response.ok) {
      throw new Error(`Cannot check Node startup: HTTP ${response.status}`);
    }
    const { uptimeSeconds } = await response.json();
    if (!Number.isFinite(uptimeSeconds)) {
      throw new Error("Node diagnostics omitted uptimeSeconds");
    }
    if (uptimeSeconds >= 65) {
      break;
    }
    console.log(
      `Waiting for Node startup timers before seeding (${uptimeSeconds}s / 65s)`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(15_000, (65 - uptimeSeconds) * 1000))
    );
  }

  // Applied BEFORE the checkpoint/copy so the Rust side starts on a byte
  // copy holding the same rows: both backends then compute their own answer
  // from identical input. See since-install-fixture.mjs for why the canned
  // seed cannot cover this route.
  const fixture = applySinceInstallFixture(nodeData);
  applyStatsFixture(nodeData);
  applyDevicesFixture(nodeData);
  applyContentFixture(nodeData);
  applyDiscoveryFixture(nodeData);
  console.log(
    `since-install fixture: ${fixture.apps} apps / ${fixture.snapshots} snapshots`
  );

  console.log(
    "\n── health check primer (the stored result must exist before the copy) ──"
  );
  const primedOk = await primeHealthCheck(args.node);

  console.log(
    "checkpointing the Node database and copying it for the Rust side…"
  );
  checkpoint(nodeData);
  // Before the copy: opening it is a WRITE on the Rust side under one
  // specific prior state. See the helper.
  const backfill = assertBackfillWontFire(nodeData);
  console.log(
    `  devices=${backfill.devices} apps=${backfill.apps} — the unknown-device backfill will not fire on the copy`
  );
  const rustData = path.join(work, "rust-data");
  cpSync(nodeData, rustData, { recursive: true });

  const rustBootAt = Date.now();
  const rustBase = await startRust(rustData);
  console.log(`rust=${rustBase}`);

  // The core boots the same healers Node does — the Wayback and sync
  // resumes at 8 s and 10 s, the scheduler check at 15 s, the import-queue
  // drain at 20 s — and, like Node's, they must run on a clean database
  // before the simulated unfinished jobs go in, or the core heals a
  // fixture Node never saw at boot. The drain's stamp is the last of them.
  await waitForRustBootTimers(rustData, rustBootAt);

  // The core's own 60 s health check has now overwritten the copied
  // result with a scheduled run of its own, as Node's did at its boot.
  // A manual run on each side, before the simulated unfinished jobs go
  // in, leaves each server its own result over the same rows at the same
  // moment — the stored-result probe compares those with each process's
  // own figures blanked.
  console.log(
    "\n── health check primer, both sides (each server's own result over the same rows) ──"
  );
  const primedBothOk =
    (await primeHealthCheck(args.node)) && (await primeHealthCheck(rustBase));
  const opsNow = Date.now();
  applyOperationsFixture(nodeData, opsNow);
  applyOperationsFixture(rustData, opsNow);
  primeOperationsAfterBoot(nodeData, rustData);

  console.log(
    "\n── auth gate (the differ cannot see this: it always authenticates) ──"
  );
  const authOk = await probeAuthGate(rustBase);

  console.log(
    "\n── trailing-slash redirect (the differ only ever asks for canonical paths) ──"
  );
  const slashOk = await probeTrailingSlash(rustBase, args.node);

  console.log(
    "\n── forwarded host + CSRF origin (the differ never forges either) ──"
  );
  const fwdOk = await probeForwardedHost(rustBase, args.node);

  console.log(
    "\n── since-install fixture (the canned seed diffs to nothing) ──"
  );
  const sinceOk = await probeSinceInstall(rustBase, args.node);
  const trendOk = await probeHistoryStats(rustBase, args.node);

  console.log(
    "\n── changelog paths the manifest's single Instagram request misses ──"
  );
  const changelogOk = await probeChangelog(rustBase, args.node);

  console.log(
    "\n── grid meta (the seed alone leaves two of its four maps empty) ──"
  );
  const gridOk = await probeGridMeta(args.node);

  console.log(
    "\n── detail (three of fourteen fields are null on the canned seed) ──"
  );
  const detailOk = await probeDetail(args.node);

  console.log(
    "\n── settings reads (the seed leaves every secret, desktop row, layout and override empty) ──"
  );
  const settingsOk = await probeSettingsReads(args.node);

  console.log(
    "\n── deployment reads (the differ blanks their numbers and masks their paths) ──"
  );
  const diagOk = await probeDiagnosticsReads(rustBase, args.node);

  console.log(
    "\n── runtime envelope (validated per side; the Rust body's contents held here) ──"
  );
  const envelopeOk = await probeRuntimeEnvelope(rustBase, args.node);

  console.log(`\n── dual-live diff, --only ${onlyRe} ──`);
  let diffOk = true;
  try {
    execFileSync(
      process.execPath,
      [
        path.join(here, "parity-diff.mjs"),
        "--a",
        args.node,
        "--b",
        rustBase,
        "--skip-seed",
        "--skip-coverage",
        "--only",
        onlyRe,
        // The Rust side runs on a COPY of Node's database, so ids are
        // identical by construction — and it may not implement the route a
        // resolver reads (e.g. /api/apps) until a later batch.
        "--ids-from",
        "a",
        "--token",
        TOKEN,
      ],
      { stdio: "inherit" }
    );
  } catch {
    diffOk = false;
  }

  // After the diff, because it WRITES to both databases.
  console.log(
    "\n── desktop runtime marker (a write on GET the differ never triggers) ──"
  );
  const runtimeOk = await probeDesktopRuntimeMark(rustBase, args.node);

  // Last, because it burns BOTH backends' limiter budget on a route the
  // differ reads.
  console.log(
    "\n── inbound rate limiter (the differ never trips a 120/min limit) ──"
  );
  const rateOk = await probeRateLimiter(rustBase, args.node);
  const limiterBurnedAt = Date.now();

  // After the limiter, so both error rings hold its DENY warnings.
  console.log(
    "\n── error ring (empty until something warns — the limiter just did) ──"
  );
  const errorRingOk = await probeErrorRing(rustBase, args.node);

  const devicesOk = await probeDeviceReads(args.node, rustBase, TOKEN);
  const statsOk = await probeStatsReads(args.node, rustBase, TOKEN);
  const contentOk = await probeContentReads(
    args.node,
    rustBase,
    TOKEN,
    nodeData,
    rustData
  );

  const operationsOk = await probeOperationsReads(
    args.node,
    rustBase,
    TOKEN,
    nodeData,
    rustData
  );

  const discoveryOk = await probeDiscoveryReads(args.node, rustBase, TOKEN);
  // The write routes, live: the manifest's mutation entries with their
  // `after` reads, on both servers. LAST, because every mutation lands on
  // BOTH databases with each server's own ids and clock — a probe that
  // reads the activity log afterwards would diff on rows this pass wrote,
  // not on the port.
  let mutateOk = true;
  if (args.mutate) {
    // The limiter probe spent the read buckets the placeholder resolvers
    // need (`/api/manual-apps`); the window is a minute, so wait it out.
    const remaining = 61_000 - (Date.now() - limiterBurnedAt);
    if (remaining > 0) {
      console.log(
        `\n── waiting ${Math.ceil(remaining / 1000)}s for the read rate window to clear ──`
      );
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    const writesRe = `^(${WRITE_ROUTES.map(escapeForRegex).join("|")})$`;
    console.log(`\n── dual-live mutations, --only ${writesRe} ──`);
    try {
      execFileSync(
        process.execPath,
        [
          path.join(here, "parity-diff.mjs"),
          "--a",
          args.node,
          "--b",
          rustBase,
          "--skip-seed",
          "--skip-coverage",
          "--mutate",
          "--skip-reads",
          "--only",
          writesRe,
          "--token",
          TOKEN,
        ],
        { stdio: "inherit" }
      );
    } catch {
      mutateOk = false;
    }
  }

  cleanup();
  const ok =
    discoveryOk &&
    operationsOk &&
    devicesOk &&
    contentOk &&
    statsOk &&
    authOk &&
    slashOk &&
    fwdOk &&
    sinceOk &&
    trendOk &&
    changelogOk &&
    gridOk &&
    detailOk &&
    settingsOk &&
    primedOk &&
    primedBothOk &&
    diagOk &&
    envelopeOk &&
    errorRingOk &&
    runtimeOk &&
    rateOk &&
    mutateOk &&
    diffOk;
  console.log(
    ok
      ? "\nREAD PARITY OK — the Rust core matches Node on every implemented route"
      : "\nREAD PARITY FAILED"
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  cleanup();
  process.exit(2);
});
