// Stage Next.js's `output: 'standalone'` tree into a location the Tauri
// bundler can pick up as a resource. Copies `.next/static` and `public/` into
// `.next/standalone/` (Next requires both adjacent to `server.js`), wraps the
// bundled Node in a fake `.app` bundle on macOS to keep it out of the Dock,
// then tars the whole tree into `src-tauri/resources/standalone.tar`.
//
// Run via: `npm run build:standalone`. Idempotent: wipes the destination
// before copying.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const nextStandalone = path.join(repo, '.next', 'standalone');
const nextStatic = path.join(repo, '.next', 'static');
const publicDir = path.join(repo, 'public');

const stagedStatic = path.join(nextStandalone, '.next', 'static');
const stagedPublic = path.join(nextStandalone, 'public');

const tauriTarget = path.join(repo, 'src-tauri', 'resources', 'standalone');

if (!existsSync(nextStandalone)) {
  console.error(
    'stage-standalone: .next/standalone does not exist. Run `npm run build:standalone`' +
    ' (which sets BUILD_STANDALONE=1 so next.config.js emits the standalone tree)' +
    ' instead of invoking this script directly.',
  );
  process.exit(1);
}

// Copy static + public next to server.js.
if (existsSync(nextStatic)) {
  rmSync(stagedStatic, { recursive: true, force: true });
  mkdirSync(path.dirname(stagedStatic), { recursive: true });
  cpSync(nextStatic, stagedStatic, { recursive: true });
  console.log('stage-standalone: copied .next/static');
} else {
  console.warn('stage-standalone: .next/static missing — first build?');
}

if (existsSync(publicDir)) {
  rmSync(stagedPublic, { recursive: true, force: true });
  cpSync(publicDir, stagedPublic, { recursive: true });
  console.log('stage-standalone: copied public/');
}

// Copy the SQLite write worker into the standalone bundle. Next's file
// tracing only includes static imports/requires, and the worker is loaded
// dynamically via `new Worker(...)` from `lib/db-worker-client.ts`. Without
// this copy, the client silently falls back to inline synchronous execution.
// Mirrors the source layout so the runtime path resolution can find it.
const workerSource = path.join(repo, 'lib', 'db-worker.cjs');
const workerDest = path.join(nextStandalone, 'lib', 'db-worker.cjs');
if (existsSync(workerSource)) {
  mkdirSync(path.dirname(workerDest), { recursive: true });
  copyFileSync(workerSource, workerDest);
  console.log('stage-standalone: copied lib/db-worker.cjs (write worker)');
} else {
  console.warn('stage-standalone: lib/db-worker.cjs missing — main thread will block on bulk writes');
}

// Stage the whole thing into the tauri resources tree.
rmSync(tauriTarget, { recursive: true, force: true });
mkdirSync(path.dirname(tauriTarget), { recursive: true });
cpSync(nextStandalone, tauriTarget, { recursive: true });
console.log(`stage-standalone: staged to ${tauriTarget}`);

// ── Wrap the bundled Node in a fake .app bundle (macOS only) ───────
// Launching Node from inside a `.app` with a sibling Info.plist sets
// `LSUIElement=true` early enough to keep the process out of the Dock.
// The leading-dot name hides the helper from Spotlight/Finder.
// Skipped on non-macOS — sidecar.rs falls through to plain Node there.
if (process.platform === 'darwin') {
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
    (process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin');
  const sourceNode = path.join(
    repo,
    'src-tauri',
    'binaries',
    `node-${targetTriple}`,
  );
  if (!existsSync(sourceNode)) {
    console.error(
      `stage-standalone: cannot find Node binary at ${sourceNode}. ` +
      'See https://privacytracker-docs.privacykey.org/develop/tauri for the curl invocation that ' +
      'downloads it.',
    );
    process.exit(1);
  }

  const helperApp = path.join(tauriTarget, '.node-helper.app');
  const helperContents = path.join(helperApp, 'Contents');
  const helperMacOS = path.join(helperContents, 'MacOS');
  mkdirSync(helperMacOS, { recursive: true });

  // Copy Node into the helper's MacOS dir.
  const helperNode = path.join(helperMacOS, 'node');
  copyFileSync(sourceNode, helperNode);
  // Defensively preserve the executable bit.
  execFileSync('chmod', ['+x', helperNode], { stdio: 'inherit' });

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
  writeFileSync(path.join(helperContents, 'Info.plist'), helperPlist);
  console.log(`stage-standalone: wrote helper bundle at ${helperApp}`);
}

// Tarball the staged tree into a single file Tauri can bundle as a plain
// resource. Sidesteps Tauri's resource-glob matcher silently dropping files
// inside dotfile-prefixed directories. Uncompressed because the contents
// don't compress well and the Rust extract path stays flate2-free.
//
// Atomic write via tmp + rename: `tauri dev` runs this script and the
// sidecar boot in parallel, and a partial tarball would make the sidecar
// fail to find `node_modules/next`. POSIX rename is atomic within a
// filesystem so readers always see a complete tarball.
const tauriTarball = path.join(repo, 'src-tauri', 'resources', 'standalone.tar');
const tauriTarballTmp = `${tauriTarball}.tmp`;
rmSync(tauriTarballTmp, { force: true });
execFileSync(
  'tar',
  ['-cf', tauriTarballTmp, '-C', tauriTarget, '.'],
  { stdio: 'inherit' },
);
renameSync(tauriTarballTmp, tauriTarball);
console.log(`stage-standalone: tarball at ${tauriTarball} (atomic write)`);
