/**
 * The Rust core stays out of the NODE builds.
 *
 * Until the desktop cutover this test kept `core/` inert on main: no shipped
 * artifact built, imported or ran it, which is what let the migration land in
 * reviewable pieces instead of on a long-lived branch. Since the cutover the
 * desktop release IS built on the core (`--features rust-backend`, passed by
 * the release workflow and `just tauri-dev`). Two Node builds remain, and this
 * test is what keeps them Node:
 *
 * - the Docker image, which runs `next start` until its own cutover
 *   (Phase 6, batch 6);
 * - the desktop shell built WITHOUT the feature, which spawns the Node
 *   sidecar and is the rollback until 1.0 (`backend: node` in release.yml).
 *
 * A rollback that quietly linked the core would not be a rollback, and a
 * Node server that half-used it would be a third backend nobody tests. So if
 * a file on a Node path starts referencing the core, this fails.
 *
 * The desktop shell gets exactly two allowances, both checked below rather
 * than assumed:
 *
 * 1. `src-tauri/src/embedded.rs` may name the crate, because the file starts
 *    with `#![cfg(feature = "rust-backend")]` and therefore compiles to
 *    nothing without the feature.
 * 2. `src-tauri/Cargo.toml` may declare it, as an OPTIONAL dependency reached
 *    only through that feature, so a build without it neither compiles nor
 *    links it. CI's rust-check builds the shell both ways, which is what makes
 *    the claim more than a comment.
 *
 * Everything else keeps the flat ban, the Dockerfile above all. Batch 6
 * narrows this again when Docker moves; batch 7, which deletes the Node
 * paths, deletes this file.
 *
 * What is NOT a Node build path, and is allowed to reference the core freely:
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

/** The cargo feature the desktop shell's Rust backend lives behind. */
const FEATURE = "rust-backend";
/** The one shipping source allowed to name the core. */
const GATED_SOURCE = path.join("src-tauri", "src", "embedded.rs");
/** Its own first line, which empties the file without the feature. */
const GATE = `#![cfg(feature = "${FEATURE}")]`;
/** And the declaration, which does not compile the file at all without the
 *  feature. The two are independent: controls that removed each one in turn
 *  left a default build compiling, and only removing BOTH broke it. That is
 *  why this guard reads the text instead of trusting the build — either gate
 *  could be dropped silently, leaving the invariant resting on one line. */
const MODULE_OWNER = path.join("src-tauri", "src", "main.rs");
const MODULE_DECLARATION = new RegExp(
  `#\\[cfg\\(feature = "${FEATURE}"\\)\\]\\s*\\n\\s*mod embedded;`
);
/** The manifest that declares it, and what it must say. */
const MANIFEST = path.join("src-tauri", "Cargo.toml");

/** Does this source carry the gate as its first line of code? */
function isGated(source: string): boolean {
  const first = source.split("\n").find((line) => line.trim().length > 0);
  return first?.trim() === GATE;
}

/** Is the module itself declared only under the feature? */
function declaredOnlyByTheFeature(mainRs: string): boolean {
  return MODULE_DECLARATION.test(mainRs);
}

/**
 * Is the dependency optional, reached only through the feature, and is the
 * feature off by default? Anything else — a plain dependency, a feature
 * listed in `default` — puts the core in every build.
 */
function reachedOnlyByTheFeature(manifest: string): boolean {
  const optional =
    /^privacytracker-core\s*=\s*\{[^}\n]*\bpath\s*=\s*"\.\.\/core"[^}\n]*\boptional\s*=\s*true\b[^}\n]*\}/m;
  const fromFeature = new RegExp(
    `^${FEATURE}\\s*=\\s*\\[[^\\]]*"dep:privacytracker-core"[^\\]]*\\]`,
    "m"
  );
  const onByDefault = new RegExp(
    `^default\\s*=\\s*\\[[^\\]]*"${FEATURE}"[^\\]]*\\]`,
    "m"
  );
  return (
    optional.test(manifest) &&
    fromFeature.test(manifest) &&
    !onByDefault.test(manifest)
  );
}

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
      const wiring = findWiring(source);
      if (wiring.length === 0) {
        continue;
      }
      // The desktop shell's two allowances, each checked rather than
      // assumed: the gated module, and the optional dependency it needs.
      if (file === GATED_SOURCE && isGated(source)) {
        continue;
      }
      if (file === MANIFEST && reachedOnlyByTheFeature(source)) {
        continue;
      }
      for (const what of wiring) {
        offenders.push(`${file} references ${what}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "The Rust core must stay out of the Node builds: the Docker image and the desktop rollback.\n\n" +
      `${offenders.join("\n")}\n\n` +
      `The desktop shell is the exception, and only on its terms: name the core from ${GATED_SOURCE}, ` +
      `which starts with ${GATE}, and declare it in ${MANIFEST} as an optional dependency reached ` +
      `through the ${FEATURE} feature. If this is the batch that moves Docker to the Rust backend, ` +
      "narrow this test for the Dockerfile in the same commit; if it deletes the Node paths, delete " +
      "tests/app/rust-core-inert.test.ts, so either change is visible in review."
  );
});

test("the desktop shell reaches the core only behind the cargo feature", () => {
  // The allowance above is worth having only if what it allows is actually
  // gated, so assert the two files say what the allowance assumes.
  const gated = readFileSync(path.join(repoRoot, GATED_SOURCE), "utf8");
  assert.ok(
    isGated(gated),
    `${GATED_SOURCE} must start with ${GATE}, marking it as the feature's`
  );

  const owner = readFileSync(path.join(repoRoot, MODULE_OWNER), "utf8");
  assert.ok(
    declaredOnlyByTheFeature(owner),
    `${MODULE_OWNER} must declare the module under #[cfg(feature = "${FEATURE}")] — ` +
      "that, not the file's own attribute, is what keeps it out of a default build"
  );

  const manifest = readFileSync(path.join(repoRoot, MANIFEST), "utf8");
  assert.ok(
    reachedOnlyByTheFeature(manifest),
    `${MANIFEST} must declare privacytracker-core as optional, reach it from the ` +
      `${FEATURE} feature, and leave that feature out of the default set`
  );

  // Nothing else in the shell may name it, gated or not: one door in.
  const others = walk(path.join("src-tauri", "src"))
    .filter((file) => file !== GATED_SOURCE)
    .filter(
      (file) =>
        findWiring(readFileSync(path.join(repoRoot, file), "utf8")).length > 0
    );
  assert.deepEqual(
    others,
    [],
    `only ${GATED_SOURCE} may name the core; the rest of the shell talks to a base URL`
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

  // The desktop shell's allowances must not be a hole. An ungated module
  // is not covered by the gate...
  assert.ok(!isGated("use privacytracker_core::server::serve_with;"));
  assert.ok(!isGated('// a comment first\n#![cfg(feature = "rust-backend")]'));
  assert.ok(isGated(`\n${GATE}\n//! and then the module.`));

  // ...the declaration that actually gates the module is checked too...
  assert.ok(
    declaredOnlyByTheFeature('#[cfg(feature = "rust-backend")]\nmod embedded;')
  );
  assert.ok(
    !declaredOnlyByTheFeature("mod embedded;"),
    "an ungated declaration compiles the module into every build"
  );
  assert.ok(
    !declaredOnlyByTheFeature('#[cfg(feature = "devtools")]\nmod embedded;'),
    "another feature is not this one"
  );

  // ...and a manifest only passes while the dependency stays optional,
  // reachable through the feature, and out of the default set.
  const good =
    'privacytracker-core = { path = "../core", optional = true }\n' +
    '[features]\nrust-backend = ["dep:privacytracker-core", "dep:tokio"]\n';
  assert.ok(reachedOnlyByTheFeature(good));
  assert.ok(
    !reachedOnlyByTheFeature(good.replace(", optional = true", "")),
    "a plain dependency is in every build"
  );
  assert.ok(
    !reachedOnlyByTheFeature(`${good}default = ["rust-backend"]\n`),
    "a default feature is every build too"
  );
  assert.ok(
    !reachedOnlyByTheFeature(good.replace('"dep:privacytracker-core", ', "")),
    "an optional dependency nothing enables is dead, not gated"
  );
});
