import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { minimumMacOSVersions } from "./macos-binary-checks.mjs";
import { readReleaseMetadata } from "./release-metadata.mjs";

// Which backend this bundle ships (Phase 6). `node` bundles the standalone
// tree and a Node binary; `rust` serves the app from the binary itself and
// bundles only the frontend. Everything above the backend split -- the
// version, the deployment target, the signature, the notarisation -- is
// checked the same way for both.
const [appArg, arch, backendArg] = process.argv.slice(2);
const backend = backendArg ?? "node";
assert.ok(appArg && ["arm64", "x64"].includes(arch));
assert.ok(["node", "rust"].includes(backend), `Unknown backend: ${backend}`);
const app = path.resolve(appArg);
const metadata = readReleaseMetadata(process.cwd());
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const plist = path.join(app, "Contents/Info.plist");
assert.equal(
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plist,
  ]),
  metadata.version
);
assert.equal(
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :LSMinimumSystemVersion",
    plist,
  ]),
  metadata.minimumMacOSVersion
);
const expected = arch === "arm64" ? "arm64" : "x86_64";
const verifyNative = (file) => {
  assert.ok(
    run("lipo", ["-archs", file]).split(/\s+/).includes(expected),
    `Wrong architecture: ${file}`
  );
  const commands = run("otool", ["-l", file]);
  const compare = (a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff) {
        return diff;
      }
    }
    return 0;
  };
  const minimums = minimumMacOSVersions(commands);
  assert.ok(minimums.length > 0, `Missing macOS deployment target: ${file}`);
  for (const minimum of minimums) {
    assert.ok(
      compare(minimum, metadata.minimumMacOSVersion) <= 0,
      `${file} requires macOS ${minimum}, higher than advertised ${metadata.minimumMacOSVersion}`
    );
  }
  run("codesign", ["--verify", "--strict", file]);
};
verifyNative(path.join(app, "Contents/MacOS/privacytracker"));
run("codesign", ["--verify", "--deep", "--strict", app]);
if (process.env.RELEASE_DRY_RUN !== "1") {
  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
}
if (backend === "rust") {
  // Nothing of Node may ship: no helper bundle, no interpreter, and a
  // tarball only if it is the 0-byte stub `cargo` needs to exist.
  const resources = path.join(app, "Contents/Resources");
  const tarball = path.join(resources, "standalone.tar");
  if (existsSync(tarball)) {
    assert.equal(
      statSync(tarball).size,
      0,
      "a rust bundle must not carry the Node standalone tree"
    );
  }
  for (const stray of [".node-helper.app", "node", "node.exe"]) {
    assert.ok(
      !existsSync(path.join(resources, stray)),
      `a rust bundle must not carry ${stray}`
    );
  }

  // The frontend the app serves, staged by scripts/stage-site.mjs.
  const site = path.join(resources, "site");
  for (const required of [
    ".next/server/app/index.html",
    ".next/server/app/_not-found.html",
    ".next/csp-hashes.json",
  ]) {
    assert.ok(
      existsSync(path.join(site, required)),
      `the staged site is missing ${required}`
    );
  }
  let staticFiles = 0;
  let publicFiles = 0;
  const countSite = (dir, seen) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        countSite(file, seen);
      } else if (seen === "static") {
        staticFiles++;
      } else {
        publicFiles++;
      }
    }
  };
  countSite(path.join(site, ".next/static"), "static");
  countSite(path.join(site, "public"), "public");
  assert.ok(staticFiles > 0 && publicFiles > 0, "the staged site is empty");

  // The hardened runtime, with none of the entitlements Node needed. On a
  // signed bundle this is the strongest statement the verifier can make
  // about what the app is allowed to do.
  // `--entitlements -` writes to stdout; the older `:-` spelling still
  // works but warns that it will not for much longer.
  const entitlements = run("codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    path.join(app, "Contents/MacOS/privacytracker"),
  ]);
  for (const granted of [
    "allow-jit",
    "allow-unsigned-executable-memory",
    "allow-dyld-environment-variables",
  ]) {
    assert.ok(
      !entitlements.includes(granted),
      `a rust bundle must not grant ${granted}; it exists for Node's V8`
    );
  }

  // And the app itself, driven over HTTP through its hidden smoke mode.
  execFileSync(process.execPath, ["scripts/smoke-packaged-rust.mjs", app], {
    stdio: "inherit",
    timeout: 120_000,
  });
  console.log(
    `Verified ${arch} rust bundle ${metadata.version}, its staged site (${staticFiles} static, ${publicFiles} public files) and its entitlements.`
  );
  process.exit(0);
}

const unpacked = mkdtempSync(
  path.join(tmpdir(), "privacytracker-bundle-check-")
);
try {
  run("tar", [
    "-xf",
    path.join(app, "Contents/Resources/standalone.tar"),
    "-C",
    unpacked,
  ]);
  const node = path.join(unpacked, ".node-helper.app/Contents/MacOS/node");
  verifyNative(node);
  assert.equal(run(node, ["-p", "process.arch"]), arch);
  // The actual shipped Node must load the actual shipped native SQLite addon.
  run(node, [
    "-e",
    `const {createRequire}=require('node:module');const req=createRequire(${JSON.stringify(path.join(unpacked, "server.js"))});const db=req('better-sqlite3')(':memory:');if(db.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);db.close()`,
  ]);
  let nativeFiles = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && /\.(node|dylib)$/.test(entry.name)) {
        verifyNative(file);
        nativeFiles++;
      }
    }
  };
  walk(unpacked);
  assert.ok(nativeFiles > 0, "No native addons in shipped archive");
  execFileSync(
    process.execPath,
    ["scripts/smoke-packaged-server.mjs", node, unpacked],
    { stdio: "inherit", timeout: 90_000 }
  );
  console.log(
    `Verified ${arch} bundle ${metadata.version}, bundled Node/SQLite and ${nativeFiles} signed native files.`
  );
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
