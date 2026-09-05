import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReleaseMetadata } from "./release-metadata.mjs";

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
  // Only inspect OS load commands, not dylib compatibility/current versions.
  const osCommands = commands
    .split(/Load command \d+/)
    .filter((section) => /LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX/.test(section))
    .join("\n");
  const minimums = [
    ...osCommands.matchAll(/(?:minos|\bversion) (\d+\.\d+(?:\.\d+)?)/g),
  ].map((match) => match[1]);
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
  console.log(
    `Verified ${arch} bundle ${metadata.version}, bundled Node/SQLite and ${nativeFiles} signed native files.`
  );
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
