// Stage Next.js's `output: 'standalone'` tree into a location the Tauri
// bundler can pick up as a resource. Copies `.next/static` and `public/` into
// `.next/standalone/` (Next requires both adjacent to `server.js`), wraps the
// bundled Node in a fake `.app` bundle on macOS to keep it out of the Dock,
// then tars the whole tree into `src-tauri/resources/standalone.tar`.
//
// Run via: `npm run build:standalone`. Idempotent: wipes the destination
// before copying.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const nextStandalone = path.join(repo, ".next", "standalone");
const nextStatic = path.join(repo, ".next", "static");
const publicDir = path.join(repo, "public");

const stagedStatic = path.join(nextStandalone, ".next", "static");
const stagedPublic = path.join(nextStandalone, "public");

const tauriTarget = path.join(repo, "src-tauri", "resources", "standalone");

if (!existsSync(nextStandalone)) {
  console.error(
    "stage-standalone: .next/standalone does not exist. Run `npm run build:standalone`" +
      " (which sets BUILD_STANDALONE=1 so next.config.js emits the standalone tree)" +
      " instead of invoking this script directly."
  );
  process.exit(1);
}

// Idempotency guard for the CI release path. The macos-release workflow
// pre-runs us inside its own step (with the signing keychain set up,
// so codesign can find the cert) and then tauri-action's
// `beforeBuildCommand: pnpm build:standalone` re-invokes us inside
// `tauri build`. That second invocation runs in an environment where
// tauri-action's separate keychain isn't yet visible to codesign,
// which used to fail the build with "item could not be found in the
// keychain". With STANDALONE_PRE_BUILT=1 set on the tauri-action env,
// we honour the pre-built tarball and skip the rebuild. Local
// developers (and the explicit pre-build step itself) leave the env
// unset, so the redundancy only matters in CI.
const tauriTarballPath = path.join(
  repo,
  "src-tauri",
  "resources",
  "standalone.tar"
);
if (process.env.STANDALONE_PRE_BUILT === "1" && existsSync(tauriTarballPath)) {
  console.log(
    `stage-standalone: STANDALONE_PRE_BUILT=1 and ${path.basename(tauriTarballPath)} exists — skipping rebuild`
  );
  process.exit(0);
}

// Copy static + public next to server.js.
if (existsSync(nextStatic)) {
  rmSync(stagedStatic, { recursive: true, force: true });
  mkdirSync(path.dirname(stagedStatic), { recursive: true });
  cpSync(nextStatic, stagedStatic, { recursive: true });
  console.log("stage-standalone: copied .next/static");
} else {
  console.warn("stage-standalone: .next/static missing — first build?");
}

if (existsSync(publicDir)) {
  rmSync(stagedPublic, { recursive: true, force: true });
  cpSync(publicDir, stagedPublic, { recursive: true });
  console.log("stage-standalone: copied public/");
}

// Copy the SQLite write worker into the standalone bundle. Next's file
// tracing only includes static imports/requires, and the worker is loaded
// dynamically via `new Worker(...)` from `lib/db-worker-client.ts`. Without
// this copy, the client silently falls back to inline synchronous execution.
// Mirrors the source layout so the runtime path resolution can find it.
const workerSource = path.join(repo, "lib", "db-worker.cjs");
const workerDest = path.join(nextStandalone, "lib", "db-worker.cjs");
if (existsSync(workerSource)) {
  mkdirSync(path.dirname(workerDest), { recursive: true });
  copyFileSync(workerSource, workerDest);
  console.log("stage-standalone: copied lib/db-worker.cjs (write worker)");
} else {
  console.warn(
    "stage-standalone: lib/db-worker.cjs missing — main thread will block on bulk writes"
  );
}

// Stage the whole thing into the tauri resources tree. The symlinks
// in `.next/standalone/node_modules/` are RELATIVE (e.g. `next ->
// .pnpm/next@.../node_modules/next`), and we deliberately preserve
// them — pnpm's standalone layout depends on Node walking through
// `node_modules/<pkg>` symlinks back into the `.pnpm/<pkg>@<ver>/
// node_modules/` directory, where peer-dep siblings (e.g. @swc/helpers
// next to next) become reachable via Node's module resolution.
//
// We learned the hard way: `dereference: true` materialised every
// symlink into an independent copy, then `tar -h` flattened the
// result so the user's extracted tree had `node_modules/next/` as a
// real directory with NO `node_modules/@swc/` sibling. `node
// server.js` then died with `Cannot find module '@swc/helpers/_/
// _interop_require_default'` — Next's runtime calls into @swc/helpers
// for its compiled-output interop shims, and our flattened tree
// dropped the entire pnpm-flat resolution path. `verbatimSymlinks:
// true` (Node 22.7+) makes cpSync copy symlinks as-is.
rmSync(tauriTarget, { recursive: true, force: true });
mkdirSync(path.dirname(tauriTarget), { recursive: true });
cpSync(nextStandalone, tauriTarget, {
  recursive: true,
  verbatimSymlinks: true,
});
console.log(`stage-standalone: staged to ${tauriTarget}`);

// ── Prune build-time-only deps that survive Next's file tracing ─────
// Next's `output: 'standalone'` walks the import graph but
// over-includes a handful of packages that don't get imported at
// runtime: SWC + esbuild are compile-time only, and sharp would only
// be used by next/image's optimiser (which we disable in next.config
// via images.unoptimized = true). Each of these ships unsigned
// per-platform native binaries (`.node`, `.dylib`) that get tarred
// into standalone.tar and then rejected by Apple's notarytool, since
// notarytool now recurses into archives in `Contents/Resources/`
// while Tauri's signing pass does not unpack them. Confirmed unused
// via `grep -rn "from ['\"]\\(sharp\\|@swc/core\\|esbuild\\)" app
// lib scripts instrumentation.ts` returning nothing.
// Prune patterns are deliberately narrow:
//   - `@swc+core@`  hits @swc/core itself
//   - `@swc+core-`  hits @swc/core-darwin-arm64, -darwin-x64, etc.
//   - We must NOT prune @swc/helpers — it's a runtime helper library
//     that the SWC-compiled production bundle imports
//     (_classCallCheck / _asyncToGenerator / _objectSpread / …). A
//     looser `@swc+` prefix nukes it and the server crashes on first
//     request.
const PRUNE_PNPM_PREFIXES = [
  "@swc+core@", //          @swc/core itself
  "@swc+core-", //          @swc/core-darwin-{arm64,x64}, -linux-*, -win32-*
  "@esbuild+", //           @esbuild/{darwin,linux,win32}-*
  "esbuild@", //            esbuild itself
  "sharp@", //              sharp itself
  "@img+", //               @img/sharp-*, @img/sharp-libvips-*, @img/colour
];
// Top-level node_modules. `@swc/core` is a sub-path under @swc/ so the
// adjacent @swc/helpers tree survives; the others are whole scopes /
// flat dirs that can be removed wholesale.
const PRUNE_TOPLEVEL = ["@swc/core", "@esbuild", "@img", "esbuild", "sharp"];

const pnpmDir = path.join(tauriTarget, "node_modules", ".pnpm");
if (existsSync(pnpmDir)) {
  for (const entry of readdirSync(pnpmDir)) {
    if (PRUNE_PNPM_PREFIXES.some((p) => entry.startsWith(p))) {
      rmSync(path.join(pnpmDir, entry), { recursive: true, force: true });
      console.log(`stage-standalone: pruned .pnpm/${entry}`);
    }
  }
}
const topLevelDir = path.join(tauriTarget, "node_modules");
if (existsSync(topLevelDir)) {
  for (const name of PRUNE_TOPLEVEL) {
    const target = path.join(topLevelDir, name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`stage-standalone: pruned node_modules/${name}`);
    }
  }
}

// ── Wrap the bundled Node in a fake .app bundle (macOS only) ───────
// Launching Node from inside a `.app` with a sibling Info.plist sets
// `LSUIElement=true` early enough to keep the process out of the Dock.
// The leading-dot name hides the helper from Spotlight/Finder.
// Skipped on non-macOS — sidecar.rs falls through to plain Node there.
if (process.platform === "darwin") {
  // Pick the Node binary by TARGET triple, not host arch — required for
  // cross-compiling Intel builds on an arm64 CI runner.
  //
  // Resolution order:
  //   1. TAURI_BUILD_TARGET (explicit env var set by the release workflow)
  //   2. TAURI_ENV_TARGET_TRIPLE (Tauri's own build-script env var)
  //   3. Host arch fallback for local `npm run tauri:build`
  const targetTriple =
    process.env.TAURI_BUILD_TARGET ||
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
  const sourceNode = path.join(
    repo,
    "src-tauri",
    "binaries",
    `node-${targetTriple}`
  );
  if (!existsSync(sourceNode)) {
    console.error(
      `stage-standalone: cannot find Node binary at ${sourceNode}. ` +
        "See https://privacytracker-docs.privacykey.org/develop/tauri for the curl invocation that " +
        "downloads it."
    );
    process.exit(1);
  }

  const helperApp = path.join(tauriTarget, ".node-helper.app");
  const helperContents = path.join(helperApp, "Contents");
  const helperMacOS = path.join(helperContents, "MacOS");
  mkdirSync(helperMacOS, { recursive: true });

  // Copy Node into the helper's MacOS dir.
  const helperNode = path.join(helperMacOS, "node");
  copyFileSync(sourceNode, helperNode);
  // Defensively preserve the executable bit.
  execFileSync("chmod", ["+x", helperNode], { stdio: "inherit" });

  // Info.plist with LSUIElement=true. Inline so the script stays self-contained.
  const helperPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.privacykey.privacytracker.node-helper</string>
  <key>CFBundleName</key>
  <string>privacytracker Node Helper</string>
  <key>CFBundleDisplayName</key>
  <string>privacytracker Node Helper</string>
  <key>CFBundleExecutable</key>
  <string>node</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
  writeFileSync(path.join(helperContents, "Info.plist"), helperPlist);
  console.log(`stage-standalone: wrote helper bundle at ${helperApp}`);
}

// ── Codesign Mach-O binaries that will end up inside standalone.tar ─
// Tauri's bundler signs the outer privacytracker.app and any sibling
// binaries it can see, but treats standalone.tar as one opaque
// resource — anything Mach-O inside the tar stays unsigned unless we
// sign it here, BEFORE the tar is built. Apple's notarytool recurses
// into archives in `Contents/Resources/` and rejects every unsigned
// `.node` / `.dylib` it finds, which used to cascade into hundreds of
// errors (now pruned down to just better-sqlite3 + the bundled Node).
//
// Skipped silently when APPLE_SIGNING_IDENTITY is unset — that's the
// local-dev / unit-test path where we just want a buildable tarball,
// not a notarizable one. The release workflow's tauri-action step
// sets it from secrets.APPLE_SIGNING_IDENTITY before invoking
// `tauri build`, which re-runs this script with the identity in env.
if (process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY) {
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  const entitlements = path.join(repo, "src-tauri", "entitlements.plist");

  /**
   * Recursively walk the staged tree for `.node` and `.dylib` files.
   * Native Node modules ship as Mach-O bundles with `.node` extension
   * on macOS; transitively-linked C libraries land as `.dylib`. Both
   * need the hardened-runtime flag + a secure timestamp; neither
   * needs explicit entitlements because they inherit from the host
   * process that loads them.
   *
   * `statSync` is deliberately preferred over the dirent's
   * `isDirectory()` / `isFile()` so symlinks are followed — pnpm's
   * standalone layout can leave `node_modules/<pkg>` as a symlink
   * into the `.pnpm/` store after Next's file tracing, and the
   * previous lstat-based walk silently skipped those. The result was
   * a sneaky failure mode: codesign ran on the `.pnpm` copy, but
   * `tar -h` later dereferenced the symlink during pack and emitted
   * an UNSIGNED top-level copy into the archive that notarytool then
   * rejected.
   *
   * The visited-set keyed on realpath prevents infinite recursion
   * through any symlink cycle pnpm could conjure, and also avoids
   * redundantly visiting the same inode twice (no behavioural
   * impact since codesign is idempotent under --force, just noise).
   */
  const walkMachOFiles = (dir, visited = new Set()) => {
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch {
      return [];
    }
    if (visited.has(realDir)) {
      return [];
    }
    visited.add(realDir);

    const results = [];
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let stats;
      try {
        stats = statSync(full); // follows symlinks
      } catch {
        continue; // broken / unreadable
      }
      if (stats.isDirectory()) {
        results.push(...walkMachOFiles(full, visited));
      } else if (stats.isFile() && /\.(node|dylib)$/.test(name)) {
        results.push(full);
      }
    }
    return results;
  };

  const machOFiles = walkMachOFiles(tauriTarget);
  for (const file of machOFiles) {
    console.log(
      `stage-standalone: codesigning ${path.relative(tauriTarget, file)}`
    );
    execFileSync(
      "codesign",
      [
        "--force",
        "--sign",
        identity,
        "--timestamp",
        "--options",
        "runtime",
        file,
      ],
      { stdio: "inherit" }
    );
  }

  // The bundled Node helper is a standalone executable, so unlike the
  // `.node` dylibs it needs its OWN entitlements — specifically the
  // JIT + unsigned-executable-memory pair V8 demands under hardened
  // runtime. See src-tauri/entitlements.plist for the rationale per
  // entry.
  const helperNode = path.join(
    tauriTarget,
    ".node-helper.app",
    "Contents",
    "MacOS",
    "node"
  );
  if (existsSync(helperNode)) {
    console.log(
      `stage-standalone: codesigning ${path.relative(tauriTarget, helperNode)} (with entitlements)`
    );
    execFileSync(
      "codesign",
      [
        "--force",
        "--sign",
        identity,
        "--timestamp",
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
        helperNode,
      ],
      { stdio: "inherit" }
    );
  }
}

// Tarball the staged tree into a single file Tauri can bundle as a plain
// resource. Sidesteps Tauri's resource-glob matcher silently dropping files
// inside dotfile-prefixed directories. Uncompressed because the contents
// don't compress well and the Rust extract path stays flate2-free.
//
// Symlinks are packed AS-IS (no `-h`). pnpm's standalone layout uses
// relative symlinks (`node_modules/next -> .pnpm/next@.../node_modules/
// next`), and dereferencing during tar flattens the tree such that
// each package's peer-dep siblings inside `.pnpm/<pkg>@<ver>/
// node_modules/` become unreachable to Node's module resolver — see
// the cpSync block above for the failure mode that bit v0.1.0.
// Modern macOS / Linux tar both preserve relative symlinks correctly
// at extract time, so the user's installed tree mirrors the original
// pnpm layout exactly.
//
// Atomic write via tmp + rename: `tauri dev` runs this script and the
// sidecar boot in parallel, and a partial tarball would make the sidecar
// fail to find `node_modules/next`. POSIX rename is atomic within a
// filesystem so readers always see a complete tarball.
const tauriTarball = path.join(
  repo,
  "src-tauri",
  "resources",
  "standalone.tar"
);
const tauriTarballTmp = `${tauriTarball}.tmp`;
rmSync(tauriTarballTmp, { force: true });
execFileSync("tar", ["-cf", tauriTarballTmp, "-C", tauriTarget, "."], {
  stdio: "inherit",
});
renameSync(tauriTarballTmp, tauriTarball);
console.log(`stage-standalone: tarball at ${tauriTarball} (atomic write)`);

// Drop a freshness marker next to the tarball. The sidecar polls for
// this file at boot (see src-tauri/src/sidecar.rs) to know the tarball
// it's about to read was produced by the CURRENT BeforeDevCommand —
// not a leftover from a prior session, an interrupted build, or a
// different branch. The content is `${size}:${mtimeSeconds}` and
// mirrors the freshness_key shape the sidecar already uses for its
// extraction cache, so the sidecar can cross-check the marker against
// the tarball on disk before extracting.
//
// Atomic write: .ready.tmp → .ready so a reader never sees a partially-
// written marker. ensure-standalone-stub.mjs deletes this marker at
// the start of every `pnpm tauri:dev`, so a non-existent .ready means
// "stale, wait for me to rebuild".
const readyMarker = `${tauriTarball}.ready`;
const readyMarkerTmp = `${readyMarker}.tmp`;
const tarballStat = statSync(tauriTarball);
const tarballMtimeSeconds = Math.floor(tarballStat.mtimeMs / 1000);
const readyKey = `${tarballStat.size}:${tarballMtimeSeconds}`;
rmSync(readyMarkerTmp, { force: true });
writeFileSync(readyMarkerTmp, readyKey);
renameSync(readyMarkerTmp, readyMarker);
console.log(
  `stage-standalone: wrote ${path.basename(readyMarker)} (key ${readyKey})`
);
