/**
 * The Rust core stays out of the Node server.
 *
 * Since the cutovers the desktop app and the Docker image are both built on
 * the core (`core/`), and the desktop app embeds it outright: the Node
 * sidecar was retired ahead of v0.3.0, so `src-tauri/` names the crate
 * freely. What remains Node is the Next.js server itself (`app/`, `lib/`,
 * `proxy.ts` and the rest), which the Node Docker image
 * (`--build-arg BACKEND=node`) still runs as the image's rollback.
 *
 * A rollback that quietly linked the core would not be a rollback, and a
 * Node server that half-used it would be a third backend nobody tests. So if
 * a file on the Node server's path starts referencing the core, this fails.
 *
 * The Dockerfile left the list in Phase 6, batch 6b: it builds the core for
 * its default runtime, and the Node runtime beside it is a separate stage
 * that copies nothing of the core (CI builds and boots both).
 *
 * What is NOT a Node build path, and is allowed to reference the core freely:
 * `src-tauri/**`, `scripts/parity/**` (the harnesses exist to drive it),
 * `core/**` itself, CI workflows, the justfile, and package.json script
 * entries.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Files and trees the Node server ships: the Next.js build the Node Docker
 * image runs. If it runs in that image, it belongs here.
 */
const SHIPPING_PATHS = [
  "app",
  "lib",
  "proxy.ts",
  "next.config.js",
  "instrumentation.ts",
  "i18n.ts",
  "docker-compose.yml",
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

test("no Node server path wires in the Rust core", () => {
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
    "The Rust core must stay out of the Node server, which the Node Docker image still runs as its rollback.\n\n" +
      `${offenders.join("\n")}\n\n` +
      "If this is the change that retires the Node Docker stage, delete " +
      "tests/app/rust-core-inert.test.ts in the same commit, so the removal is visible in review."
  );
});

test("the desktop shell embeds the core as a plain dependency", () => {
  // The other half of retiring the sidecar: the shell must not grow a
  // feature flag back around the core, which is what would let a Node
  // path quietly return.
  const manifest = readFileSync(
    path.join(repoRoot, "src-tauri", "Cargo.toml"),
    "utf8"
  );
  assert.match(
    manifest,
    /^privacytracker-core\s*=\s*\{\s*path\s*=\s*"\.\.\/core"\s*\}/m,
    "src-tauri/Cargo.toml must depend on privacytracker-core unconditionally"
  );
  assert.doesNotMatch(
    manifest,
    /rust-backend/,
    "the rust-backend cargo feature was retired with the Node sidecar"
  );
  const main = readFileSync(
    path.join(repoRoot, "src-tauri", "src", "main.rs"),
    "utf8"
  );
  assert.doesNotMatch(main, /mod sidecar;/, "src-tauri has no sidecar module");
  assert.match(main, /^mod embedded;/m, "the embedded backend is always built");
});
