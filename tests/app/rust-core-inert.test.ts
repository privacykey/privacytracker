/**
 * The Rust core must stay INERT on main.
 *
 * `core/` is a standalone crate that no shipped artifact builds, imports or
 * runs. That property is what lets the migration land on `main` in reviewable
 * pieces instead of accumulating on a long-lived branch — the design study
 * ranks that divergence ("two brains during the transition") as its #4 debt
 * and says to keep the window short. Merging inert code costs `main` nothing.
 *
 * But inertness is only worth anything if it is enforced. Without this test it
 * is a convention, and conventions erode one innocuous-looking import at a
 * time. So: if any file on a shipping path starts referencing the Rust core,
 * this fails, and whoever did it has to delete the guard deliberately.
 *
 * Deleting it deliberately is exactly what the Phase 6 desktop cutover does —
 * that PR genuinely wires axum in, is genuinely not inert, and belongs on the
 * `rust-core` branch with burn-in rather than going straight to main. At that
 * point remove this file in the same commit that does the wiring, so the
 * removal is visible in review.
 *
 * What is NOT a shipping path, and is allowed to reference the core freely:
 * `scripts/parity/**` (the harnesses exist to drive it), `core/**` itself,
 * CI workflows, the justfile, and package.json script entries.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Files and trees that end up in a shipped artifact — the Docker image, the
 * Tauri desktop bundle, or the Next server. If it runs in production, it
 * belongs here.
 */
const SHIPPING_PATHS = [
  "app",
  "lib",
  "proxy.ts",
  "next.config.js",
  "instrumentation.ts",
  "i18n.ts",
  "src-tauri/src",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "Dockerfile",
  "docker-compose.yml",
  "scripts/stage-standalone.mjs",
  "scripts/start-next.mjs",
];

/**
 * Signals that a file actually WIRES the core in, as opposed to mentioning it
 * in prose. Matching on the bare string "core" would drown in false positives
 * — `@axe-core/playwright`, `core-foundation`, `@swc/core` all appear on
 * shipping paths today and none of them is the Rust crate.
 */
const WIRING_SIGNALS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bpt-core\b/, what: "the pt-core binary" },
  {
    pattern: /privacytracker[_-]core/,
    what: "the privacytracker-core crate",
  },
  { pattern: /\bcore\/target\b/, what: "the core crate's build output" },
  {
    // A cargo path-dependency pointing at ../core from a shipping manifest.
    pattern: /path\s*=\s*["']\.\.\/core["']/,
    what: "a cargo path dependency on ../core",
  },
  {
    // Dockerfile COPY/ADD of the crate.
    pattern: /^\s*(?:COPY|ADD)\s+[^\n]*\bcore\/?\s/m,
    what: "a Dockerfile COPY/ADD of core/",
  },
];

/** Prose references that are explicitly fine — documentation, not wiring. */
const ALLOWED_PROSE = [/core\/README\.md/];

function walk(target: string, acc: string[] = []): string[] {
  const abs = path.join(repoRoot, target);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return acc; // path absent on this branch — nothing to police
  }
  if (st.isFile()) {
    acc.push(target);
    return acc;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target") {
      continue;
    }
    walk(path.join(target, entry.name), acc);
  }
  return acc;
}

/** Strip the prose-only references so they cannot trip a wiring signal. */
function withoutAllowedProse(source: string): string {
  let out = source;
  for (const allowed of ALLOWED_PROSE) {
    out = out.replace(new RegExp(allowed.source, "g"), "");
  }
  return out;
}

function findWiring(source: string): string[] {
  const cleaned = withoutAllowedProse(source);
  return WIRING_SIGNALS.filter((s) => s.pattern.test(cleaned)).map(
    (s) => s.what
  );
}

test("no shipping path wires in the Rust core", () => {
  const offenders: string[] = [];

  for (const shippingPath of SHIPPING_PATHS) {
    for (const file of walk(shippingPath)) {
      // Only text files; skip anything unreadable as UTF-8.
      let source: string;
      try {
        source = readFileSync(path.join(repoRoot, file), "utf8");
      } catch {
        continue;
      }
      for (const what of findWiring(source)) {
        offenders.push(`${file} references ${what}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "The Rust core must stay inert on main — no shipped artifact may build, import or run it.\n\n" +
      `${offenders.join("\n")}\n\n` +
      "If this is the Phase 6 cutover, that is the one PR allowed to break this. " +
      "Delete tests/app/rust-core-inert.test.ts in the same commit that does the wiring, " +
      "so the removal is visible in review — and land it on the rust-core branch with " +
      "burn-in rather than straight to main."
  );
});

test("the guard can actually detect wiring", () => {
  // A guard that cannot fail is worse than no guard, because it reads as
  // coverage. Prove each signal fires on a realistic sample.
  assert.deepEqual(findWiring('spawn("pt-core", ["serve"])'), [
    "the pt-core binary",
  ]);
  assert.deepEqual(findWiring('privacytracker-core = { path = "../core" }'), [
    "the privacytracker-core crate",
    "a cargo path dependency on ../core",
  ]);
  assert.deepEqual(findWiring("core/target/release/x"), [
    "the core crate's build output",
  ]);
  assert.deepEqual(findWiring("COPY core/ /app/core/"), [
    "a Dockerfile COPY/ADD of core/",
  ]);

  // And prove it does NOT fire on the false positives that live on shipping
  // paths today, nor on prose.
  for (const benign of [
    'import { AxeBuilder } from "@axe-core/playwright";',
    'core-foundation = "0.10"',
    '"@swc/core"',
    "// see core/README.md on the rust-core branch",
    'const PRUNE_TOPLEVEL = ["@swc/core", "@esbuild"];',
  ]) {
    assert.deepEqual(findWiring(benign), [], `false positive on: ${benign}`);
  }
});
