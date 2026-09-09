#!/usr/bin/env node
/**
 * Schema-parity gate for the Rust core migration (Phase 1).
 *
 * Proves that the Rust migrator (`core/`, via the pt-core binary) reproduces
 * the `lib/db.ts` schema + migration contract EXACTLY: for each starting-point
 * database it must leave the schema in a state identical to what importing
 * `lib/db.ts` produces from the same starting point.
 *
 * How it stays honest:
 *  - ONE dumper (schema-dump.mjs, better-sqlite3) reads BOTH sides, so the
 *    comparison can only reflect a migrator difference, never a dumper one.
 *  - The authoritative comparison is the LOGICAL schema (columns, indexes,
 *    foreign keys), because ALTER ADD COLUMN legitimately makes a fresh and
 *    an upgraded database differ in stored SQL text while being identical
 *    tables. Raw CREATE text is compared too, but only as an advisory note.
 *  - Data backfills are checked by aggregate counts, so the non-deterministic
 *    ids they mint (randomblob) never cause a spurious diff.
 *
 * Cases: an empty DB (fresh path), a deliberately old-shaped DB (upgrade
 * path), and a current-schema DB carrying live-ish state (re-open path).
 *
 *   node scripts/parity/schema-parity.mjs
 *   node scripts/parity/schema-parity.mjs --pt-core <path>   # prebuilt binary
 *
 * Exit 0 = every case identical; 1 = a difference; 2 = harness error.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dumpSchema } from "./schema-dump.mjs";
import {
  backfillAggregates,
  buildLegacy,
  injectLiveState,
} from "./schema-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const { values: args } = parseArgs({
  options: { "pt-core": { type: "string" }, verbose: { type: "boolean" } },
});

const ptCore =
  args["pt-core"] ?? path.join(repo, "core", "target", "debug", "pt-core");

const work = mkdtempSync(path.join(tmpdir(), "pt-schema-parity-"));
let failures = 0;

function tsMigrate(dir) {
  // Import lib/db under this data dir → runs open + migrate side effects.
  execFileSync("npx", ["tsx", path.join(here, "ts-migrate.ts")], {
    cwd: repo,
    env: { ...process.env, PRIVACYTRACKER_DATA_DIR: dir },
    stdio: args.verbose ? "inherit" : "pipe",
  });
}

function rustMigrate(file) {
  execFileSync(ptCore, ["migrate", file], {
    stdio: args.verbose ? "inherit" : "pipe",
  });
}

/** Deep structural diff → list of dot-paths that differ. */
function diffPaths(a, b, prefix = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return out;
  }
  const ak = a && typeof a === "object" ? Object.keys(a) : [];
  const bk = b && typeof b === "object" ? Object.keys(b) : [];
  if (ak.length === 0 && bk.length === 0) {
    out.push(prefix);
    return out;
  }
  for (const k of new Set([...ak, ...bk])) {
    const p = prefix ? `${prefix}.${k}` : k;
    const av = a?.[k];
    const bv = b?.[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      if (av && bv && typeof av === "object" && typeof bv === "object") {
        diffPaths(av, bv, p, out);
      } else {
        out.push(p);
      }
    }
  }
  return out;
}

/** Compare only the logical schema (drop raw sql) of every table. */
function logicalOf(dump) {
  const tables = {};
  for (const [name, t] of Object.entries(dump.tables)) {
    tables[name] = {
      columns: t.columns,
      indexes: t.indexes,
      foreignKeys: t.foreignKeys,
    };
  }
  return { tableCount: dump.tableCount, tables };
}

function runCase(name, { startBytes, checkBackfills }) {
  process.stdout.write(`\n── case: ${name} ──\n`);

  const tsDir = path.join(work, `ts-${name}`);
  const rustFile = path.join(work, `rust-${name}.db`);
  mkdirSync(tsDir, { recursive: true });

  if (startBytes) {
    cpSync(startBytes, path.join(tsDir, "privacy.db"));
    cpSync(startBytes, rustFile);
  }

  tsMigrate(tsDir);
  rustMigrate(rustFile);

  const tsDump = dumpSchema(path.join(tsDir, "privacy.db"));
  const rustDump = dumpSchema(rustFile);

  let ok = true;

  // Authoritative: logical schema.
  const logicalDiff = diffPaths(logicalOf(tsDump), logicalOf(rustDump));
  if (logicalDiff.length) {
    ok = false;
    failures++;
    console.log(`  ✘ logical schema differs (${logicalDiff.length} path(s)):`);
    for (const p of logicalDiff.slice(0, 25)) {
      console.log(`      ${p}`);
    }
  } else {
    console.log(
      `  ✔ logical schema identical (${tsDump.tableCount} tables, TS sqlite ${tsDump.sqliteVersion})`
    );
  }

  // Advisory: raw CREATE text per table + index.
  const rawTables = {};
  const rawIdx = {};
  for (const [n, t] of Object.entries(tsDump.tables)) {
    rawTables[n] = t.sql;
  }
  for (const [n, t] of Object.entries(rustDump.tables)) {
    if (rawTables[n] !== t.sql) {
      rawIdx[`table:${n}`] = true;
    }
  }
  const rawIndexDiff = [];
  for (const n of new Set([
    ...Object.keys(tsDump.indexSql),
    ...Object.keys(rustDump.indexSql),
  ])) {
    if (tsDump.indexSql[n]?.sql !== rustDump.indexSql[n]?.sql) {
      rawIndexDiff.push(n);
    }
  }
  const rawTableDiff = Object.keys(rawIdx);
  if (rawTableDiff.length || rawIndexDiff.length) {
    console.log(
      `  ◐ advisory: raw CREATE text differs on ${rawTableDiff.length} table(s), ${rawIndexDiff.length} index(es) — expected when ALTER-appended columns render differently; logical schema is authoritative`
    );
  } else {
    console.log("  ✔ raw CREATE text also byte-identical");
  }

  // Data backfill aggregates.
  if (checkBackfills) {
    const tsAgg = backfillAggregates(path.join(tsDir, "privacy.db"));
    const rustAgg = backfillAggregates(rustFile);
    const aggDiff = diffPaths(tsAgg, rustAgg);
    if (aggDiff.length) {
      ok = false;
      failures++;
      console.log("  ✘ backfill aggregates differ:");
      for (const k of aggDiff) {
        console.log(`      ${k}: TS=${tsAgg[k]} Rust=${rustAgg[k]}`);
      }
    } else {
      console.log(
        `  ✔ backfill aggregates identical (devices=${tsAgg.devices}, app_devices=${tsAgg.appDevices}, pending_search=${tsAgg.importPendingSearch}, policy_versions=${tsAgg.policyVersions}, running→idle ok)`
      );
    }
  }

  return ok;
}

async function main() {
  console.log(`schema-parity: pt-core = ${path.relative(repo, ptCore)}`);

  // Case 1: empty → fresh path.
  runCase("empty", { checkBackfills: true });

  // Case 2: legacy → upgrade path.
  const legacy = path.join(work, "legacy-src.db");
  buildLegacy(legacy);
  runCase("legacy", { startBytes: legacy, checkBackfills: true });

  // Case 3: current schema + live state → re-open/backfill path. Build a
  // current-schema DB with pt-core, then inject the live-ish rows.
  const current = path.join(work, "current-src.db");
  rustMigrate(current);
  injectLiveState(current);
  runCase("current+state", { startBytes: current, checkBackfills: true });

  rmSync(work, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\nSCHEMA PARITY OK — Rust migrator matches lib/db.ts on every case"
      : `\nSCHEMA PARITY FAILED — ${failures} difference group(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
});
