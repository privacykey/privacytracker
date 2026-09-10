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
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import BetterSqlite3 from "better-sqlite3";

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
];

const onlyRe =
  args.only ?? `^(${BATCH_1.map((r) => r.replace(/[/]/g, "\\/")).join("|")})$`;

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

async function main() {
  const nodeData = path.resolve(args["node-data"]);

  console.log(`read-parity: node=${args.node} data=${nodeData}`);
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
  const ok = authOk && rateOk && diffOk;
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
