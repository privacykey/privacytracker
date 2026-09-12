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
  FIXTURES as SINCE_INSTALL_FIXTURES,
  MISSING_ID as SINCE_INSTALL_MISSING_ID,
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

  // Last, because it burns BOTH backends' limiter budget on a route the
  // differ reads.
  console.log(
    "\n── inbound rate limiter (the differ never trips a 120/min limit) ──"
  );
  const rateOk = await probeRateLimiter(rustBase, args.node);

  cleanup();
  const ok = authOk && slashOk && fwdOk && sinceOk && rateOk && diffOk;
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
