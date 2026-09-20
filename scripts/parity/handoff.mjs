#!/usr/bin/env node
/**
 * The two backends hand one database to each other (Phase 6, batch 4b).
 *
 * The rollback plan rests on this: if a Rust release misbehaves, the next
 * build is a Node one, and it has to open the database the Rust build left
 * behind. `read-parity.mjs` compares the two servers, but always over a
 * COPY of a database Node wrote, with Node's WAL checkpointed into it. This
 * runs the other way as well, and over the DIRECTORY rather than a copy, so
 * what is actually exercised is:
 *
 *   - one backend's `-wal` and `-shm`, left as its process exited, opened by
 *     the other (the two bundle different SQLite versions: rusqlite 3.46,
 *     better-sqlite3 3.53);
 *   - the repairs each one applies when it opens a database (the policy
 *     status repair, the unknown-device backfill, the feature-flag
 *     migration) not fighting each other;
 *   - the writes of one backend reading back identically from the other.
 *
 * Both directions run over their own fresh data directory:
 *
 *   1. Rust serves it, is seeded and mutated, and answers a set of reads.
 *      It stops; Node opens the same directory, and must be ready and give
 *      the same answers.
 *   2. The same with the backends swapped.
 *
 * Usage: node scripts/parity/handoff.mjs
 * Needs `pnpm build` (Node serves it) and a built `pt-core`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { MUTATIONS } from "./manifest.mjs";

const repo = process.cwd();
const ptCore = path.join(repo, "core", "target", "debug", "pt-core");
const TOKEN = "handoff-token";

/**
 * Reads whose answer is a pure function of the database: no "now", no
 * uptime, no port. A difference here is the handoff, not the clock.
 *
 * Each one has to be non-trivial after the writes below, or it compares
 * two empty answers and proves nothing. A control found two that were:
 * `/api/shortlist` (nothing in the manifest's replayable set adds an
 * entry, so this script adds one) and the universal `/api/changelog`,
 * which lists changes and a seeded install has none — the per-app
 * timeline is used instead, since it carries the first-scan row.
 */
const reads = (app) => [
  "/api/apps",
  "/api/apps?limit=250&offset=0&meta=grid",
  "/api/apps?view=grouped",
  "/api/settings",
  "/api/preferences",
  "/api/date-format",
  "/api/locale",
  "/api/privacy-profile",
  "/api/feature-flags",
  "/api/notification-prefs",
  "/api/shortlist",
  "/api/devices",
  `/api/apps/${app}/changelog`,
];

/** Reads that must simply answer: the database is open and usable. */
const ANSWERS = ["/api/ready", "/api/stats", "/api/activity", "/api/triage"];

const headers = (base) => ({
  "x-auditor-admin-token": TOKEN,
  // The CSRF gate wants an Origin that matches the host, or the token.
  // Send both, as a client of either backend would.
  origin: base,
  "content-type": "application/json",
});

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Wait until `/api/ready` answers, or give up. */
async function waitReady(base, what) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/ready`, { headers: headers(base) });
      if (res.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} never became ready at ${base}`);
}

function stopper(child) {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killer);
  };
}

async function startNode(dataDir) {
  const port = await freePort();
  const child = spawn(
    "node",
    ["scripts/start-next.mjs", "start", "-p", String(port)],
    {
      cwd: repo,
      env: {
        ...process.env,
        PRIVACYTRACKER_DATA_DIR: dataDir,
        PRIVACYTRACKER_BIND_HOST: "127.0.0.1",
        AUDITOR_ADMIN_TOKEN: TOKEN,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base, "the Node server");
  return { base, stop: stopper(child) };
}

async function startRust(dataDir) {
  const port = await freePort();
  const child = spawn(ptCore, ["serve", "--port", String(port)], {
    cwd: repo,
    env: {
      ...process.env,
      PRIVACYTRACKER_DATA_DIR: dataDir,
      PRIVACYTRACKER_BIND_HOST: "127.0.0.1",
      AUDITOR_ADMIN_TOKEN: TOKEN,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base, "pt-core");
  return { base, stop: stopper(child) };
}

/** Seed the canned fleet, then replay every manifest mutation whose inputs
 *  this script can supply. Returns how many ran, so a run that silently
 *  stopped writing cannot read as a pass. */
async function mutate(base) {
  const seeded = await fetch(`${base}/api/dev/seed-sample-data?source=canned`, {
    method: "POST",
    headers: headers(base),
  });
  if (!seeded.ok) {
    throw new Error(`seeding ${base} answered ${seeded.status}`);
  }

  const apps = await (
    await fetch(`${base}/api/apps`, { headers: headers(base) })
  ).json();
  const app = apps?.[0]?.id;
  if (!app) {
    throw new Error("the seed left no apps to mutate");
  }

  let ran = 0;
  const skipped = [];
  for (const mutation of MUTATIONS) {
    const filled = JSON.stringify({
      path: mutation.path,
      body: mutation.body ?? null,
    }).replaceAll("{app}", app);
    // Anything still naming a placeholder needs a value only the full
    // harness can capture; leave it to read-parity and say so.
    if (
      /\{(manualApp|device|annotation|actionId|import|[a-z]+Id)\}/.test(filled)
    ) {
      skipped.push(mutation.name);
      continue;
    }
    const { path: url, body } = JSON.parse(filled);
    const res = await fetch(`${base}${url}`, {
      method: mutation.method ?? "POST",
      headers: headers(base),
      body: body === null ? undefined : JSON.stringify(body),
    });
    // A mutation the manifest marks as an error case is still a write the
    // other backend has to survive; only a 5xx is a problem here.
    if (res.status >= 500) {
      throw new Error(`${mutation.name} answered ${res.status} on ${base}`);
    }
    ran += 1;
  }

  // The manifest's replayable set adds no shortlist entry, and an empty
  // read compares equal whatever the handover did. One write fixes that.
  const shortlisted = await fetch(`${base}/api/shortlist`, {
    method: "POST",
    headers: headers(base),
    body: JSON.stringify({
      sourceAppId: app,
      candidateAppleId: "424242424",
      candidateName: "Handoff candidate",
      candidateStoreUrl: "https://apps.apple.com/us/app/id424242424",
    }),
  });
  if (!shortlisted.ok) {
    throw new Error(`the shortlist write answered ${shortlisted.status}`);
  }
  // `ran` counts the manifest's mutations only: this script's own write is
  // not one of them, and a count that included it would read "1 of 58" for
  // a run that replayed nothing.
  return { ran, skipped: skipped.length, app };
}

async function readAll(base, app) {
  const answers = {};
  for (const url of reads(app)) {
    const res = await fetch(`${base}${url}`, { headers: headers(base) });
    answers[url] = { status: res.status, body: await res.text() };
  }
  for (const url of ANSWERS) {
    const res = await fetch(`${base}${url}`, { headers: headers(base) });
    answers[url] = { status: res.status, body: "(not compared)" };
  }
  return answers;
}

function compare(before, after, label, app, report) {
  for (const url of reads(app)) {
    const a = before[url];
    const b = after[url];
    const same = a.status === b.status && a.body === b.body;
    report(`${label}: ${url}`, same, same ? "" : describe(a, b));
  }
  for (const url of ANSWERS) {
    report(
      `${label}: ${url} answers`,
      after[url].status === 200,
      `status ${after[url].status}`
    );
  }
}

function describe(a, b) {
  if (a.status !== b.status) {
    return `status ${a.status} then ${b.status}`;
  }
  const at = a.body;
  const bt = b.body;
  let i = 0;
  while (i < at.length && i < bt.length && at[i] === bt[i]) {
    i += 1;
  }
  return `bodies differ at ${i}: ${JSON.stringify(at.slice(i, i + 80))} vs ${JSON.stringify(bt.slice(i, i + 80))}`;
}

async function direction(from, to, names) {
  const dir = mkdtempSync(path.join(tmpdir(), "pt-handoff-"));
  const results = [];
  const report = (claim, ok, detail = "") => {
    results.push({ claim, ok, detail });
    console.log(
      `  ${ok ? "✔" : "✘"} ${claim}${ok || !detail ? "" : ` — ${detail}`}`
    );
  };
  console.log(`\n── ${names[0]} writes, ${names[1]} reads ──`);
  const first = await from(dir);
  let before;
  let wrote;
  try {
    wrote = await mutate(first.base);
    before = await readAll(first.base, wrote.app);
    // A database with apps and NO devices gains a placeholder device the
    // next time either backend opens it (the unknown-device backfill both
    // of them run). A control showed that firing on the receiving side and
    // changing two of the answers below, so the writes must leave a device
    // behind: what is compared is then the handover, not the backfill.
    const devices = JSON.parse(before["/api/devices"].body);
    report(
      `${names[0]}'s writes left a device, so the backfill cannot fire on handover`,
      (devices?.devices?.length ?? 0) > 0,
      `${devices?.devices?.length ?? "no"} devices`
    );
  } finally {
    await first.stop();
  }
  report(
    `${names[0]} ran the manifest's mutations (${wrote.ran} of ${wrote.ran + wrote.skipped})`,
    wrote.ran > 20,
    `only ${wrote.ran} ran`
  );

  const second = await to(dir);
  try {
    const after = await readAll(second.base, wrote.app);
    // Two equal empty answers would pass every comparison below, so check
    // the handed-over database still holds the fleet that was seeded.
    const fleet = JSON.parse(after["/api/apps"].body);
    report(
      `${names[1]} sees the fleet ${names[0]} wrote`,
      Array.isArray(fleet) && fleet.length > 0,
      `${Array.isArray(fleet) ? fleet.length : "not an array"} apps`
    );
    compare(before, after, names[1], wrote.app, report);
  } finally {
    await second.stop();
  }
  rmSync(dir, { recursive: true, force: true });
  return results;
}

async function main() {
  if (!existsSync(ptCore)) {
    console.error(
      `handoff: no pt-core at ${ptCore}. Build it: cargo build --manifest-path core/Cargo.toml`
    );
    process.exit(2);
  }
  if (!existsSync(path.join(repo, ".next", "BUILD_ID"))) {
    console.error("handoff: no production build. Run `pnpm build` first.");
    process.exit(2);
  }

  const results = [
    ...(await direction(startRust, startNode, ["Rust", "Node"])),
    ...(await direction(startNode, startRust, ["Node", "Rust"])),
  ];
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nhandoff: ${results.length - failed.length} passed, ${failed.length} failed`
  );
  if (failed.length > 0) {
    console.log("HANDOFF FAILED");
    process.exit(1);
  }
  console.log(
    "HANDOFF OK — either backend opens and serves what the other wrote"
  );
}

await main();
