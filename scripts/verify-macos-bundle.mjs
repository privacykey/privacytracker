import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { minimumMacOSVersions } from "./macos-binary-checks.mjs";
import { readReleaseMetadata } from "./release-metadata.mjs";

// What a release bundle must be: the version, the deployment target, the
// signature and the notarisation, then the things specific to an app that
// serves itself from the Rust core. Nothing of Node may ship: releases up
// to v0.1.2 bundled a Node binary and a standalone Next.js tree, and that
// build was retired ahead of v0.3.0, so this verifier refuses any trace of
// it rather than carrying a second branch for it.
const [appArg, arch] = process.argv.slice(2);
assert.ok(appArg && ["arm64", "x64"].includes(arch));
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

// Nothing of Node may ship: no helper bundle, no interpreter, no tarball.
const resources = path.join(app, "Contents/Resources");
for (const stray of [
  "standalone.tar",
  ".node-helper.app",
  "node",
  "node.exe",
]) {
  assert.ok(
    !existsSync(path.join(resources, stray)),
    `the bundle must not carry ${stray}; the Node build was retired`
  );
}

// The frontend the app serves, staged by scripts/stage-site.mjs.
const site = path.join(resources, "site");
for (const required of [
  ".next/server/app/index.html",
  ".next/server/app/_not-found.html",
  ".next/csp-hashes.json",
  // Screenshot import's OCR worker, engine and model
  // (scripts/stage-ocr-assets.mjs): without them that method cannot run.
  "public/ocr/worker.min.js",
  "public/ocr/tesseract-core-simd-lstm.wasm.js",
  "public/ocr/eng.traineddata.gz",
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

// The notices travel with the app, not only in the repository.
for (const notice of [
  "NOTICE",
  "LICENSE",
  "V8-LICENSE",
  "THIRD-PARTY-RUST.md",
  "THIRD-PARTY-OCR.md",
]) {
  const file = path.join(resources, "third-party", notice);
  assert.ok(existsSync(file), `the bundle is missing ${notice}`);
  assert.ok(statSync(file).size > 0, `${notice} is empty`);
}

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
    `the bundle must not grant ${granted}; it existed for Node's V8`
  );
}

// And the app itself, driven over HTTP through its hidden smoke mode.
execFileSync(process.execPath, ["scripts/smoke-packaged-rust.mjs", app], {
  stdio: "inherit",
  timeout: 120_000,
});
console.log(
  `Verified ${arch} bundle ${metadata.version}, its staged site (${staticFiles} static, ${publicFiles} public files) and its entitlements.`
);
