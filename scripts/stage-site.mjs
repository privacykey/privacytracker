// Stage the frontend the RUST backend serves into the Tauri bundle's
// Resources (Phase 6, batch 4b). The Node backend has its own staging
// script, `stage-standalone.mjs`, which tars a whole Next.js standalone
// tree plus a Node binary; this one copies far less, because the Rust
// core serves the build directly and reads exactly four things from it
// (`core/src/server/site.rs`):
//
//   .next/server/app        the prerendered pages, their metadata,
//                           RSC payloads and segment files
//   .next/static            the chunks, fonts and media
//   .next/csp-hashes.json   the per-route script hashes the CSP names
//   public/                 everything served from the site root
//
// Nothing else a build leaves behind is copied: no server chunks, no
// cache, no standalone tree, no node_modules. The desktop app never runs
// that code, and what is not shipped cannot be loaded. The staged tree is
// read-only in the bundle and covered by the code signature, which is the
// other half of why nothing is extracted into the data directory any more.
//
// Run via `pnpm stage:site`, or by the Rust bundle's beforeBuildCommand
// (src-tauri/tauri.rust.conf.json). Idempotent: wipes the destination
// first, so a page deleted since the last build cannot linger.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/** The only file kinds under `.next/server/app` the core serves. A build
 *  also writes the route modules (`*.js`, `*.nft.json`) beside them; the
 *  Rust backend never executes those, so they stay out of the bundle. */
const SERVED = new Set([".html", ".meta", ".rsc", ".body"]);

/** A runtime database must never end up inside a signed bundle: it would
 *  ship one user's data to everyone and shadow the real one. Same guard
 *  as stage-standalone.mjs, on a much smaller tree. */
const DB_FILE = /\.db(-wal|-shm)?$/;

/**
 * @param {{ root?: string, into?: string }} [options] `root` is the
 *   directory holding the build (the repository); `into` is where to stage
 *   it, defaulting to the Tauri bundle's resources. The test passes both.
 * @returns {{ target: string, pages: number, files: number, bytes: number,
 *   servedFiles: number, servedBytes: number }}
 */
export function stageSite({ root = repo, into } = {}) {
  const dist = path.join(root, ".next");
  const source = {
    app: path.join(dist, "server", "app"),
    static: path.join(dist, "static"),
    csp: path.join(dist, "csp-hashes.json"),
    public: path.join(root, "public"),
  };
  const target = into ?? path.join(root, "src-tauri", "resources", "site");

  for (const [what, from] of Object.entries(source)) {
    if (!existsSync(from)) {
      throw new Error(
        `stage-site: no ${what} at ${from}. Run \`pnpm build\` first — the Rust backend serves that build, not a standalone tree.`
      );
    }
  }

  rmSync(target, { recursive: true, force: true });
  const stagedApp = path.join(target, ".next", "server", "app");
  mkdirSync(stagedApp, { recursive: true });

  let files = 0;
  let bytes = 0;
  const copyServed = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(dst, { recursive: true });
        copyServed(src, dst);
        continue;
      }
      if (!SERVED.has(path.extname(entry.name))) {
        continue;
      }
      cpSync(src, dst);
      files += 1;
      bytes += statSync(src).size;
    }
  };
  copyServed(source.app, stagedApp);

  for (const [from, to] of [
    [source.static, path.join(target, ".next", "static")],
    [source.csp, path.join(target, ".next", "csp-hashes.json")],
    [source.public, path.join(target, "public")],
  ]) {
    cpSync(from, to, { recursive: true });
  }

  const staged = walk(target);
  for (const file of staged) {
    if (DB_FILE.test(file)) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(
        `stage-site: refusing to stage a database (${path.relative(target, file)}); the bundle must ship no user data`
      );
    }
  }

  // The tree has to be servable, not merely present: the core refuses to
  // load a build with no not-found page, and a site with no chunks or no
  // public files would install and then serve a blank app.
  const pages = staged.filter((f) => f.endsWith(".html"));
  const expected = walk(source.app).filter((f) => f.endsWith(".html")).length;
  const checks = {
    "every page": pages.length === expected,
    "the not-found page": staged.some((f) => f.endsWith("_not-found.html")),
    "the CSP hashes": existsSync(path.join(target, ".next", "csp-hashes.json")),
    "static chunks": staged.some((f) =>
      f.includes(`${path.sep}.next${path.sep}static${path.sep}`)
    ),
    "public files": staged.some((f) =>
      f.includes(`${path.sep}public${path.sep}`)
    ),
  };
  const missing = Object.entries(checks)
    .filter(([, held]) => !held)
    .map(([what]) => what);
  if (missing.length > 0) {
    throw new Error(
      `stage-site: the staged site is missing ${missing.join(", ")} — the build under ${dist} looks incomplete`
    );
  }

  const total = staged.reduce((sum, f) => sum + statSync(f).size, 0);
  return {
    target,
    pages: pages.length,
    files: staged.length,
    bytes: total,
    servedBytes: bytes,
    servedFiles: files,
  };
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

// Only run when invoked directly, so the test can import `stageSite`.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = stageSite();
    console.log(
      `stage-site: ${result.pages} pages, ${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB → ${path.relative(repo, result.target)}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
