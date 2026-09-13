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

import {
  applySinceInstallFixture,
  BRIDGED_IDS,
  COLLATION_FIXTURE,
  FLAG_OVERRIDE_FIXTURE,
  INSTAGRAM_ID,
  SETTINGS_FIXTURE,
  FIXTURES as SINCE_INSTALL_FIXTURES,
  MISSING_ID as SINCE_INSTALL_MISSING_ID,
  TIMELINE_ID,
  TREND_ID,
} from "./since-install-fixture.mjs";

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
  },
});

if (!(args.node && args["node-data"])) {
  console.error(
    "usage: read-parity.mjs --node <baseUrl> --node-data <dataDir> [--only <regex>] [--pt-core <bin>]"
  );
  process.exit(2);
}

// The routes the Rust core implements today. Kept here rather than inferred
// so an unimplemented route can never silently drop out of the comparison —
// adding a route to the server means adding it here in the same commit.
const BATCH_1 = [
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
function startRust(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ptCore, ["serve", dbPath], {
      env: { ...process.env, AUDITOR_ADMIN_TOKEN: TOKEN },
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
  const ok =
    rust.firstDenyAt !== null &&
    rust.firstDenyAt === node.firstDenyAt &&
    rust.contiguous &&
    node.contiguous;
  console.log(
    ok
      ? `  ✔ rate limiter: /api/manual-apps denied from request ${rust.firstDenyAt} on both backends`
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
      rows.length === 221 &&
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

async function main() {
  const nodeData = path.resolve(args["node-data"]);

  console.log(`read-parity: node=${args.node} data=${nodeData}`);

  // Applied BEFORE the checkpoint/copy so the Rust side starts on a byte
  // copy holding the same rows: both backends then compute their own answer
  // from identical input. See since-install-fixture.mjs for why the canned
  // seed cannot cover this route.
  const fixture = applySinceInstallFixture(nodeData);
  console.log(
    `since-install fixture: ${fixture.apps} apps / ${fixture.snapshots} snapshots`
  );

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

  const rustBase = await startRust(path.join(rustData, "privacy.db"));
  console.log(`rust=${rustBase}`);

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

  cleanup();
  const ok =
    authOk &&
    slashOk &&
    fwdOk &&
    sinceOk &&
    trendOk &&
    changelogOk &&
    gridOk &&
    detailOk &&
    settingsOk &&
    runtimeOk &&
    rateOk &&
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
